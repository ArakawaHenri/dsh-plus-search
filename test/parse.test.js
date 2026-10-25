import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildMessagesRequest,
	buildResponsesRequest,
	parseMessagesResponse,
	parseResponsesResponse,
	searchPrompt,
} from '../lib/protocol.js';

const DEFAULTS = {
	maxTokens: 2048,
	maxUses: 3,
	messagesToolType: 'web_search_20250305',
	responsesToolType: 'web_search',
	anthropicVersion: '2023-06-01',
	timeoutMs: 60000,
};

test('searchPrompt formats the query prompt', () => {
	assert.equal(searchPrompt('rust release notes'), 'Perform a web search for the query: rust release notes');
});

test('buildMessagesRequest includes native server tool and default tool_choice', () => {
	const body = buildMessagesRequest({ provider: 'r', model: 'm-1' }, { query: 'q' }, DEFAULTS, 'web_search_20250305');
	assert.equal(body.model, 'm-1');
	assert.equal(body.max_tokens, 2048);
	assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
	assert.deepEqual(body.tool_choice, { type: 'any' });
	assert.equal(body.messages[0].content[0].text, 'Perform a web search for the query: q');
});

test('buildMessagesRequest honors route limits and custom toolChoice', () => {
	const body = buildMessagesRequest(
		{ provider: 'r', model: 'override', maxTokens: 64, maxUses: 1, toolChoice: { type: 'tool', name: 'web_search' } },
		{ query: 'q', model: 'from-request' },
		DEFAULTS,
		'web_search_20250305',
	);
	assert.equal(body.model, 'override');
	assert.equal(body.max_tokens, 64);
	assert.equal(body.tools[0].max_uses, 1);
	assert.deepEqual(body.tool_choice, { type: 'tool', name: 'web_search' });
});

test('parseMessagesResponse extracts deduplicated sources with citation snippets', () => {
	const payload = {
		content: [
			{
				type: 'text',
				text: 'Summary.',
				citations: [
					{ url: 'https://a.example/1', cited_text: 'first cited excerpt' },
					{ url: 'https://b.example/2', cited_text: 'second cited excerpt' },
				],
			},
			{ type: 'server_tool_use', id: 'srv-1', name: 'web_search', input: { query: 'q' } },
			{
				type: 'web_search_tool_result',
				tool_use_id: 'srv-1',
				content: [
					{ type: 'web_search_result', url: 'https://a.example/1', title: 'A', page_age: '2026-01-02T00:00:00Z' },
					{ type: 'web_search_result', url: 'https://b.example/2', title: '', page_age: null },
					{ type: 'web_search_result', url: 'https://a.example/1', title: 'dup', page_age: null },
					{ type: 'web_search_result', url: '' },
				],
			},
		],
	};
	const { sources, toolErrors, searched } = parseMessagesResponse(payload);
	assert.deepEqual(sources, [
		{ url: 'https://a.example/1', title: 'A', snippet: 'first cited excerpt', publishedAt: '2026-01-02T00:00:00Z' },
		{ url: 'https://b.example/2', snippet: 'second cited excerpt' },
	]);
	assert.deepEqual(toolErrors, []);
	assert.equal(searched, true);
});

test('parseMessagesResponse reports server-tool error objects', () => {
	const payload = {
		content: [{
			type: 'web_search_tool_result',
			content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
		}],
	};
	const { sources, toolErrors, searched } = parseMessagesResponse(payload);
	assert.deepEqual(sources, []);
	assert.deepEqual(toolErrors, ['max_uses_exceeded']);
	assert.equal(searched, true);
});

test('parseMessagesResponse flags prose-only responses as not searched', () => {
	const { sources, searched } = parseMessagesResponse({
		content: [{ type: 'text', text: 'I cannot search the web.' }],
	});
	assert.deepEqual(sources, []);
	assert.equal(searched, false);
});

test('parseMessagesResponse handles malformed payloads', () => {
	assert.deepEqual(parseMessagesResponse({}), { sources: [], toolErrors: [], searched: false });
	assert.deepEqual(parseMessagesResponse(null), { sources: [], toolErrors: [], searched: false });
	assert.deepEqual(parseMessagesResponse({ content: 'nope' }), { sources: [], toolErrors: [], searched: false });
});

test('buildResponsesRequest constructs Responses tool payload', () => {
	const body = buildResponsesRequest({ provider: 'r', model: 'gpt-x' }, { query: 'q' }, DEFAULTS, 'web_search');
	assert.equal(body.model, 'gpt-x');
	assert.deepEqual(body.tools, [{ type: 'web_search' }]);
	assert.deepEqual(body.tool_choice, { type: 'web_search' });
	assert.equal(body.max_output_tokens, 2048);
	assert.equal(body.input, 'Perform a web search for the query: q');
});

test('parseResponsesResponse extracts deduplicated URLs from web_search_call actions', () => {
	const payload = {
		output: [
			{ type: 'reasoning', summary: [] },
			{
				type: 'web_search_call',
				status: 'completed',
				action: {
					queries: ['q'],
					sources: [
						{ type: 'url', url: 'https://a.example/1' },
						{ type: 'url', url: 'https://a.example/1' },
						{ type: 'url', url: 'https://b.example/2' },
					],
				},
			},
			{ type: 'message', content: [{ type: 'output_text', text: 'done', annotations: [] }] },
		],
	};
	const { sources, toolErrors, searched } = parseResponsesResponse(payload);
	assert.deepEqual(sources, [{ url: 'https://a.example/1' }, { url: 'https://b.example/2' }]);
	assert.deepEqual(toolErrors, []);
	assert.equal(searched, true);
});

test('parseResponsesResponse extracts url_citation annotations when action sources are absent', () => {
	const payload = {
		output: [{
			type: 'message',
			content: [{
				type: 'output_text',
				text: 'Answer with citations.',
				annotations: [
					{ type: 'url_citation', url: 'https://c.example/doc', title: 'C Doc', start_index: 0, end_index: 5 },
					{ type: 'url_citation', url: 'https://c.example/doc', title: 'C Doc' },
					{ type: 'url_citation', url: 'https://d.example/page' },
				],
			}],
		}],
	};
	const { sources, searched } = parseResponsesResponse(payload);
	assert.deepEqual(sources, [
		{ url: 'https://c.example/doc', title: 'C Doc' },
		{ url: 'https://d.example/page' },
	]);
	assert.equal(searched, true);
});

test('parseResponsesResponse flags non-completed search calls and error envelopes', () => {
	const failed = parseResponsesResponse({ output: [{ type: 'web_search_call', status: 'failed', action: { sources: [] } }] });
	assert.deepEqual(failed.toolErrors, ['failed']);

	const errored = parseResponsesResponse({ error: { message: 'tool unsupported' } });
	assert.deepEqual(errored.toolErrors, ['tool unsupported']);
	assert.equal(errored.searched, false);
});

test('parseResponsesResponse flags prose-only responses as not searched', () => {
	const { sources, searched } = parseResponsesResponse({
		output: [{ type: 'message', content: [{ type: 'output_text', text: 'no tool here', annotations: [] }] }],
	});
	assert.deepEqual(sources, []);
	assert.equal(searched, false);
});

test('parseResponsesResponse handles malformed payloads', () => {
	assert.deepEqual(parseResponsesResponse({}), { sources: [], toolErrors: [], searched: false });
	assert.deepEqual(parseResponsesResponse({ output: [{ type: 'web_search_call' }] }).toolErrors, []);
});

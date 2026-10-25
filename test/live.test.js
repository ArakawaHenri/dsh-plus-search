import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatchNativeSearch } from '../lib/dispatch.js';

const LIVE = process.env.DSH_SEARCH_LIVE === '1';
const BASE = process.env.DSH_SEARCH_LIVE_BASE ?? 'http://127.0.0.1:3425';

const DEFAULTS = {
	maxTokens: 1024,
	maxUses: 2,
	messagesToolType: 'web_search_20250305',
	responsesToolType: 'web_search',
	anthropicVersion: '2023-06-01',
	timeoutMs: 120000,
};

test('live: a Messages route returns structured sources', { skip: !LIVE }, async () => {
	const result = await dispatchNativeSearch({
		ctx: {},
		api: 'messages',
		profile: {
			provider: 'live-messages',
			baseURL: BASE,
			model: process.env.DSH_SEARCH_LIVE_MESSAGES_MODEL ?? 'group/deepseek-v4-1-flash',
		},
		request: { query: 'Model Context Protocol latest specification version' },
		defaults: DEFAULTS,
	});
	assert.ok(result.sources.length > 0, 'expected at least one source');
	for (const source of result.sources) assert.match(source.url, /^https?:\/\//u);
});

test('live: a Responses route returns source URLs', { skip: !LIVE }, async () => {
	const result = await dispatchNativeSearch({
		ctx: {},
		api: 'responses',
		profile: {
			provider: 'live-responses',
			baseURL: `${BASE}/v1`,
			model: process.env.DSH_SEARCH_LIVE_RESPONSES_MODEL ?? 'group/glm-5-3-flash',
		},
		request: { query: 'Model Context Protocol latest specification version' },
		defaults: DEFAULTS,
	});
	assert.ok(result.sources.length > 0, 'expected at least one source');
	for (const source of result.sources) assert.match(source.url, /^https?:\/\//u);
});

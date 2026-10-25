import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatchNativeSearch, SearchProviderError } from '../lib/dispatch.js';

const DEFAULTS = {
	maxTokens: 2048,
	maxUses: 3,
	messagesToolType: 'web_search_20250305',
	responsesToolType: 'web_search',
	anthropicVersion: '2023-06-01',
	timeoutMs: 5000,
};

function ctxWithKey(value) {
	return {
		get: (name) => (name === 'credentials' ? { resolve: async () => ({ value }) } : undefined),
	};
}

function fetchStub(answers) {
	const calls = [];
	const impl = async (url, init) => {
		calls.push({ url, init, body: JSON.parse(init.body) });
		const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
		return {
			ok: answer.status >= 200 && answer.status < 300,
			status: answer.status,
			text: async () => (typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)),
		};
	};
	impl.calls = calls;
	return impl;
}

function rejectWhenAborted(signal) {
	return new Promise((_resolve, reject) => {
		const onAbort = () => {
			clearTimeout(guard);
			reject(signal.reason);
		};
		const guard = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			reject(new Error('the timeout signal did not fire'));
		}, 1000);
		if (signal.aborted) onAbort();
		else signal.addEventListener('abort', onAbort, { once: true });
	});
}

const MESSAGES_OK = {
	status: 200,
	body: {
		content: [
			{ type: 'text', text: 'searching' },
			{
				type: 'web_search_tool_result',
				content: [{ type: 'web_search_result', url: 'https://a.example', title: 'A' }],
			},
		],
	},
};

const RESPONSES_OK = {
	status: 200,
	body: {
		output: [{
			type: 'web_search_call',
			status: 'completed',
			action: { sources: [{ type: 'url', url: 'https://b.example' }] },
		}],
	},
};

test('dispatches a Messages search to the route endpoint with both auth headers', async () => {
	const fetchImpl = fetchStub([MESSAGES_OK]);
	const result = await dispatchNativeSearch({
		ctx: ctxWithKey('sk-test'),
		api: 'messages',
		profile: { provider: 'r', baseURL: 'http://host:3425', apiKeyEnv: 'K', model: 'm' },
		request: { query: 'hello' },
		defaults: DEFAULTS,
		fetchImpl,
	});
	assert.deepEqual(result, { sources: [{ url: 'https://a.example', title: 'A' }], truncated: false });
	assert.equal(fetchImpl.calls[0].url, 'http://host:3425/v1/messages');
	assert.equal(fetchImpl.calls[0].init.headers['x-api-key'], 'sk-test');
	assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer sk-test');
	assert.equal(fetchImpl.calls[0].init.headers['anthropic-version'], '2023-06-01');
	assert.deepEqual(fetchImpl.calls[0].body.tools, [
		{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
	]);
});

test('dispatches a Responses search with a bearer token only', async () => {
	const fetchImpl = fetchStub([RESPONSES_OK]);
	const result = await dispatchNativeSearch({
		ctx: ctxWithKey('sk-test'),
		api: 'responses',
		profile: { provider: 'r', baseURL: 'http://host:3425/v1', apiKeyEnv: 'K', model: 'g' },
		request: { query: 'hello' },
		defaults: DEFAULTS,
		fetchImpl,
	});
	assert.deepEqual(result.sources, [{ url: 'https://b.example' }]);
	assert.equal(fetchImpl.calls[0].url, 'http://host:3425/v1/responses');
	assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer sk-test');
	assert.equal(fetchImpl.calls[0].init.headers['x-api-key'], undefined);
});

test('sends no auth headers when no key resolves and none is required', async () => {
	const fetchImpl = fetchStub([RESPONSES_OK]);
	await dispatchNativeSearch({
		ctx: {},
		api: 'responses',
		profile: { provider: 'r', baseURL: 'http://host/v1', model: 'g' },
		request: { query: 'hello' },
		defaults: DEFAULTS,
		fetchImpl,
	});
	assert.equal(fetchImpl.calls[0].init.headers.authorization, undefined);
});

test('fails with CREDENTIAL_MISSING when the route requires a key', async () => {
	for (const apiKeyEnv of ['MISSING_KEY', '', undefined]) {
		await assert.rejects(
			dispatchNativeSearch({
				ctx: {},
				api: 'responses',
				profile: { provider: 'r', baseURL: 'http://host/v1', model: 'g', apiKeyEnv, requireApiKey: true },
				request: { query: 'hello' },
				defaults: DEFAULTS,
				fetchImpl: fetchStub([RESPONSES_OK]),
			}),
			(error) => error instanceof SearchProviderError && error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING',
		);
	}
});

test('a literal key takes precedence over a credential reference', async () => {
	const fetchImpl = fetchStub([RESPONSES_OK]);
	await dispatchNativeSearch({
		ctx: ctxWithKey('from-store'),
		api: 'responses',
		profile: { provider: 'r', baseURL: 'http://host/v1', model: 'g', apiKey: 'literal', apiKeyEnv: 'K' },
		request: { query: 'hello' },
		defaults: DEFAULTS,
		fetchImpl,
	});
	assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer literal');
});

test('resolves keys from the ambient process environment as a fallback', async () => {
	const previous = process.env.DSH_SEARCH_TEST_KEY;
	process.env.DSH_SEARCH_TEST_KEY = 'from-env';
	try {
		const fetchImpl = fetchStub([RESPONSES_OK]);
		await dispatchNativeSearch({
			ctx: {},
			api: 'responses',
			profile: { provider: 'r', baseURL: 'http://host/v1', model: 'g', apiKeyEnv: 'DSH_SEARCH_TEST_KEY' },
			request: { query: 'hello' },
			defaults: DEFAULTS,
			fetchImpl,
		});
		assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer from-env');
	} finally {
		if (previous === undefined) delete process.env.DSH_SEARCH_TEST_KEY;
		else process.env.DSH_SEARCH_TEST_KEY = previous;
	}
});

test('surfaces a non-2xx answer as PROVIDER_ERROR with the provider message', async () => {
	await assert.rejects(
		dispatchNativeSearch({
			ctx: {},
			api: 'responses',
			profile: { provider: 'r', baseURL: 'http://host/v1', model: 'g' },
			request: { query: 'hello' },
			defaults: DEFAULTS,
			fetchImpl: fetchStub([{ status: 429, body: { error: { message: 'slow down' } } }]),
		}),
		(error) => error instanceof SearchProviderError
			&& error.code === 'WEB_PROVIDER_ERROR'
			&& /slow down/u.test(error.message)
			&& /HTTP 429/u.test(error.message),
	);
});

test('uses an explicitly configured Responses tool type', async () => {
	const fetchImpl = fetchStub([RESPONSES_OK]);
	const result = await dispatchNativeSearch({
		ctx: {},
		api: 'responses',
		profile: { provider: 'r', baseURL: 'http://host/v1', model: 'g', toolType: 'web_search_preview' },
		request: { query: 'hello' },
		defaults: DEFAULTS,
		fetchImpl,
	});
	assert.equal(fetchImpl.calls.length, 1);
	assert.deepEqual(fetchImpl.calls[0].body.tools, [{ type: 'web_search_preview' }]);
	assert.deepEqual(fetchImpl.calls[0].body.tool_choice, { type: 'web_search_preview' });
	assert.equal(result.sources.length, 1);
});

test('maps an unprocessable body to PROVIDER_ERROR', async () => {
	await assert.rejects(
		dispatchNativeSearch({
			ctx: {},
			api: 'responses',
			profile: { provider: 'r', baseURL: 'http://host/v1', model: 'g' },
			request: { query: 'hello' },
			defaults: DEFAULTS,
			fetchImpl: fetchStub([{ status: 200, body: 'not json' }]),
		}),
		(error) => error instanceof SearchProviderError && /unprocessable/u.test(error.message),
	);
});

test('maps a Messages server-tool failure with no sources to PROVIDER_ERROR', async () => {
	await assert.rejects(
		dispatchNativeSearch({
			ctx: {},
			api: 'messages',
			profile: { provider: 'r', baseURL: 'http://host', model: 'm' },
			request: { query: 'hello' },
			defaults: DEFAULTS,
			fetchImpl: fetchStub([{
				status: 200,
				body: {
					content: [{
						type: 'web_search_tool_result',
						content: { type: 'web_search_tool_result_error', error_code: 'unavailable' },
					}],
				},
			}]),
		}),
		(error) => error instanceof SearchProviderError && /unavailable/u.test(error.message),
	);
});

test('a response that never ran a search is an error, not an empty success', async () => {
	for (const body of [
		{ content: [{ type: 'text', text: 'I cannot search the web.' }] },
		{ output: [{ type: 'message', content: [{ type: 'output_text', text: 'no tool here' }] }] },
		{},
	]) {
		await assert.rejects(
			dispatchNativeSearch({
				ctx: {},
				api: body.content ? 'messages' : 'responses',
				profile: { provider: 'r', baseURL: 'http://host/v1', model: 'm' },
				request: { query: 'q' },
				defaults: DEFAULTS,
				fetchImpl: fetchStub([{ status: 200, body }]),
			}),
			(error) => error.code === 'WEB_PROVIDER_ERROR' && /did not run a web search/u.test(error.message),
		);
	}
});

test('a failed Responses envelope is an error, not an empty success', async () => {
	await assert.rejects(
		dispatchNativeSearch({
			ctx: {},
			api: 'responses',
			profile: { provider: 'r', baseURL: 'http://host/v1', model: 'm' },
			request: { query: 'q' },
			defaults: DEFAULTS,
			fetchImpl: fetchStub([{ status: 200, body: { error: { message: 'tool unsupported' } } }]),
		}),
		(error) => error.code === 'WEB_PROVIDER_ERROR' && /tool unsupported/u.test(error.message),
	);
});

test('a search that legitimately found nothing is a successful empty result', async () => {
	const fetchImpl = fetchStub([{
		status: 200,
		body: { output: [{ type: 'web_search_call', status: 'completed', action: { sources: [] } }] },
	}]);
	const result = await dispatchNativeSearch({
		ctx: {},
		api: 'responses',
		profile: { provider: 'r', baseURL: 'http://host/v1', model: 'm' },
		request: { query: 'obscure query' },
		defaults: DEFAULTS,
		fetchImpl,
	});
	assert.deepEqual(result, { sources: [], truncated: false });
});

test('an already-aborted caller never dispatches', async () => {
	const fetchImpl = fetchStub([RESPONSES_OK]);
	const controller = new AbortController();
	controller.abort(new Error('user cancelled'));
	await assert.rejects(
		dispatchNativeSearch({
			ctx: {},
			api: 'responses',
			profile: { provider: 'r', baseURL: 'http://host/v1', model: 'g' },
			request: { query: 'hello' },
			defaults: DEFAULTS,
			signal: controller.signal,
			fetchImpl,
		}),
		(error) => error instanceof SearchProviderError && error.code === 'WEB_ABORTED',
	);
	assert.equal(fetchImpl.calls.length, 0);
});

test('maps a transport failure to PROVIDER_ERROR', async () => {
	await assert.rejects(
		dispatchNativeSearch({
			ctx: {},
			api: 'responses',
			profile: { provider: 'r', baseURL: 'http://host/v1', model: 'g' },
			request: { query: 'hello' },
			defaults: DEFAULTS,
			fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
		}),
		(error) => error instanceof SearchProviderError && /ECONNREFUSED/u.test(error.message),
	);
});

test('fails when a route has no baseURL', async () => {
	await assert.rejects(
		dispatchNativeSearch({
			ctx: {},
			api: 'responses',
			profile: { provider: 'r', model: 'g' },
			request: { query: 'hello' },
			defaults: DEFAULTS,
			fetchImpl: fetchStub([RESPONSES_OK]),
		}),
		(error) => error instanceof SearchProviderError && /baseURL/u.test(error.message),
	);
});

test('fails before dispatch when the session model is missing', async () => {
	for (const model of [undefined, null, '', '   ']) {
		const fetchImpl = fetchStub([RESPONSES_OK]);
		await assert.rejects(
			dispatchNativeSearch({
				ctx: {},
				api: 'responses',
				profile: { provider: 'r', baseURL: 'http://host/v1', model },
				request: { query: 'q' },
				defaults: DEFAULTS,
				fetchImpl,
			}),
			(error) => error.code === 'WEB_PROVIDER_ERROR' && /model/u.test(error.message),
		);
		assert.equal(fetchImpl.calls.length, 0);
	}
});

test('maps a response-body read failure to PROVIDER_ERROR with cause', async () => {
	const failure = new Error('body disconnected');
	await assert.rejects(
		dispatchNativeSearch({
			ctx: {},
			api: 'responses',
			profile: { provider: 'r', baseURL: 'http://host/v1', model: 'm' },
			request: { query: 'q' },
			defaults: DEFAULTS,
			fetchImpl: async () => ({ ok: true, text: async () => { throw failure; } }),
		}),
		(error) => error.code === 'WEB_PROVIDER_ERROR' && error.cause === failure,
	);
});

for (const phase of ['fetch', 'body']) {
	test(`composed timeout during ${phase} is a provider error, not caller cancellation`, async () => {
		await assert.rejects(
			dispatchNativeSearch({
				ctx: {},
				api: 'responses',
				profile: { provider: 'r', baseURL: 'http://host/v1', model: 'm', timeoutMs: 10 },
				request: { query: 'q' },
				defaults: DEFAULTS,
				fetchImpl: async (_url, { signal }) => (phase === 'fetch'
					? rejectWhenAborted(signal)
					: { ok: true, text: () => rejectWhenAborted(signal) }),
			}),
			(error) => error.code === 'WEB_PROVIDER_ERROR'
				&& error.cause?.name === 'TimeoutError'
				&& /exceeded 10ms/u.test(error.message),
		);
	});
}

test('caller cancellation during body reading remains WEB_ABORTED with caller reason', async () => {
	const controller = new AbortController();
	const reason = new Error('user cancelled body read');
	await assert.rejects(
		dispatchNativeSearch({
			ctx: {},
			api: 'responses',
			profile: { provider: 'r', baseURL: 'http://host/v1', model: 'm' },
			request: { query: 'q' },
			defaults: DEFAULTS,
			signal: controller.signal,
			fetchImpl: async (_url, { signal }) => ({
				ok: true,
				text: () => {
					const pending = rejectWhenAborted(signal);
					queueMicrotask(() => controller.abort(reason));
					return pending;
				},
			}),
		}),
		(error) => error.code === 'WEB_ABORTED' && error.cause === reason,
	);
});

test('cancellation while resolving credentials prevents any HTTP request', async () => {
	const controller = new AbortController();
	const fetchImpl = fetchStub([RESPONSES_OK]);
	const ctx = {
		get: (name) => (name === 'credentials'
			? {
				resolve: async () => {
					controller.abort(new Error('cancelled during credentials'));
					return { value: 'key' };
				},
			}
			: undefined),
	};
	await assert.rejects(
		dispatchNativeSearch({
			ctx,
			api: 'responses',
			profile: { provider: 'r', baseURL: 'http://host/v1', model: 'm', apiKeyEnv: 'KEY' },
			request: { query: 'q' },
			defaults: DEFAULTS,
			signal: controller.signal,
			fetchImpl,
		}),
		(error) => error.code === 'WEB_ABORTED',
	);
	assert.equal(fetchImpl.calls.length, 0);
});

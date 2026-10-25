import test from 'node:test';
import assert from 'node:assert/strict';
import { format } from 'node:util';

import { NativePreferringSearchProvider, PROVIDER_ID } from '../lib/provider.js';
import { resolveConfig } from '../lib/config.js';
import { PI_AI_PLUGIN } from '../lib/routes.js';

const ENABLED = { routes: { gw: { models: { 'native-model': { nativeSearch: true } } } } };
const DISABLED = { routes: { gw: { models: { 'native-model': { nativeSearch: false } } } } };
const MESSAGES_OK = {
	content: [{
		type: 'web_search_tool_result',
		content: [{ type: 'web_search_result', url: 'https://native.example', title: 'Native' }],
	}],
};
const RESPONSES_OK = {
	output: [{
		type: 'web_search_call',
		status: 'completed',
		action: { sources: [{ url: 'https://native.example', title: 'Native' }] },
	}],
};

function makeProvider({
	context = { provider: 'gw', model: 'native-model' },
	providers = { gw: { api: 'anthropic-messages', baseURL: 'http://host' } },
	config = {},
	answer = { status: 200, body: MESSAGES_OK },
	fetchImpl,
	standardSearch,
} = {}) {
	let currentContext = context;
	const standardCalls = [];
	const nativeCalls = [];
	const logs = [];
	const standard = {
		id: 'deepseek-official',
		available: () => true,
		search: async (request, signal) => {
			standardCalls.push({ request, signal });
			if (standardSearch) return standardSearch(request, signal);
			return { sources: [{ url: 'https://standard.example' }], truncated: false };
		},
	};
	const ctx = {
		get: (name) => {
			if (name === 'loader') {
				return { entries: () => [{ options: { name: PI_AI_PLUGIN, config: { providers } } }] };
			}
			if (name === 'agents') {
				return {
					currentInitiator: () => (currentContext === null
						? undefined
						: { session: { requestContext: () => currentContext } }),
				};
			}
			return undefined;
		},
		web: { searchProviders: new Map([['deepseek-official', standard]]) },
		logger: { info: (...args) => logs.push(format(...args)) },
	};
	const provider = new NativePreferringSearchProvider(ctx, resolveConfig({ timeoutMs: 5000, ...config }), {
		fetchImpl: async (url, init) => {
			nativeCalls.push({ url, init, body: JSON.parse(init.body) });
			if (fetchImpl) return fetchImpl(url, init);
			return {
				ok: answer.status >= 200 && answer.status < 300,
				status: answer.status,
				text: async () => (typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)),
			};
		},
	});
	return {
		provider,
		ctx,
		standardCalls,
		nativeCalls,
		logs,
		setContext: (value) => { currentContext = value; },
	};
}

test('defaults to native search on a supported route', async () => {
	const { provider, nativeCalls, standardCalls } = makeProvider();
	assert.equal(provider.id, PROVIDER_ID);
	await provider.search({ query: 'q' });
	assert.equal(nativeCalls.length, 1);
	assert.equal(nativeCalls[0].body.model, 'native-model');
	assert.equal(standardCalls.length, 0);
});

for (const [api, body, endpoint] of [
	['anthropic-messages', MESSAGES_OK, 'http://host/v1/messages'],
	['openai-responses', RESPONSES_OK, 'http://host/v1/responses'],
]) {
	test(`default-enabled ${api} model sends session model and returns native sources`, async () => {
		const { provider, nativeCalls, standardCalls, logs } = makeProvider({
			providers: { gw: { api, baseURL: 'http://host/v1' } },
			config: { debug: true },
			answer: { status: 200, body },
		});
		const result = await provider.search({ query: 'q', model: 'not-the-session-model' });
		assert.deepEqual(result, {
			sources: [{ url: 'https://native.example', title: 'Native' }],
			truncated: false,
		});
		assert.equal(nativeCalls.length, 1);
		assert.equal(nativeCalls[0].url, endpoint);
		assert.equal(nativeCalls[0].body.model, 'native-model');
		assert.equal(standardCalls.length, 0);
		assert.deepEqual(logs, []);
	});
}

test('two models on the same provider choose independently and explicit false uses standard search', async () => {
	const config = {
		routes: {
			gw: { models: { 'native-model': { nativeSearch: true }, ordinary: { nativeSearch: false } } },
		},
	};
	const { provider, setContext, nativeCalls, standardCalls } = makeProvider({ config });
	await provider.search({ query: 'native' });
	setContext({ provider: 'gw', model: 'ordinary' });
	await provider.search({ query: 'ordinary' });
	setContext({ provider: 'gw', model: 'unconfigured' });
	await provider.search({ query: 'default' });
	assert.equal(nativeCalls.length, 2);
	assert.deepEqual(nativeCalls.map(({ body }) => body.model), ['native-model', 'unconfigured']);
	assert.deepEqual(standardCalls.map(({ request }) => request.query), ['ordinary']);
});

test('a route-wide opt-out uses standard search for every model', async () => {
	const { provider, setContext, nativeCalls, standardCalls, logs } = makeProvider({
		config: { debug: true, routes: { gw: { nativeSearch: false } } },
	});
	setContext({ provider: 'gw', model: 'native-model' });
	await provider.search({ query: 'q' });
	assert.equal(nativeCalls.length, 0);
	assert.equal(standardCalls.length, 1);
	assert.equal(logs.length, 1);
	assert.match(logs[0], /\[model-disabled\]/u);
	assert.doesNotMatch(logs[0], /native-failed/u);
});

test('an explicit api override upgrades a chat-completions route to native search', async () => {
	const { provider, nativeCalls, standardCalls } = makeProvider({
		providers: { gw: { api: 'openai-completions', baseURL: 'http://host/v1' } },
		config: { routes: { gw: { api: 'messages', baseURL: 'http://other' } } },
		answer: { status: 200, body: MESSAGES_OK },
	});
	await provider.search({ query: 'q' });
	assert.equal(nativeCalls.length, 1);
	assert.equal(nativeCalls[0].url, 'http://other/v1/messages');
	assert.equal(standardCalls.length, 0);
});

test('a chat-completions route without an override uses standard search', async () => {
	const { provider, nativeCalls, standardCalls } = makeProvider({
		providers: { gw: { api: 'openai-completions', baseURL: 'http://host/v1' } },
		config: { routes: { gw: { models: { 'native-model': {} } } } },
	});
	await provider.search({ query: 'q' });
	assert.equal(nativeCalls.length, 0);
	assert.equal(standardCalls.length, 1);
});

for (const [label, overrides] of [
	['HTTP failure', { answer: { status: 503, body: { error: 'overloaded' } } }],
	['rejected Responses tool', {
		providers: { gw: { api: 'openai-responses', baseURL: 'http://host/v1' } },
		answer: { status: 400, body: { error: { message: 'unknown tool type web_search' } } },
	}],
	['invalid JSON', { answer: { status: 200, body: 'invalid json' } }],
	['tool failure', { answer: { status: 200, body: { content: [{ type: 'web_search_tool_result', content: { error_code: 'unavailable' } }] } } }],
	['search never ran', { answer: { status: 200, body: { content: [{ type: 'text', text: 'I cannot search.' }] } } }],
	['error envelope', {
		providers: { gw: { api: 'openai-responses', baseURL: 'http://host/v1' } },
		answer: { status: 200, body: { error: { message: 'tool unsupported' } } },
	}],
	['transport failure', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }],
	['body timeout', { fetchImpl: async () => ({ ok: true, text: async () => { throw new DOMException('timed out', 'TimeoutError'); } }) }],
]) {
	test(`native ${label} falls back to standard provider`, async () => {
		const { provider, nativeCalls, standardCalls, logs } = makeProvider(overrides);
		const request = { query: 'q', maxResults: 4 };
		const signal = new AbortController().signal;
		assert.deepEqual(await provider.search(request, signal), {
			sources: [{ url: 'https://standard.example' }],
			truncated: false,
		});
		assert.equal(nativeCalls.length, 1);
		assert.equal(standardCalls.length, 1);
		assert.equal(standardCalls[0].request, request);
		assert.equal(standardCalls[0].signal, signal);
		assert.deepEqual(logs, []);
	});
}

test('debug logs native HTTP failures with route, model, fallback provider, and error details', async () => {
	const { provider, standardCalls, logs } = makeProvider({
		config: { debug: true },
		answer: { status: 503, body: { error: { message: 'search temporarily unavailable' } } },
	});
	await provider.search({ query: 'q' });
	assert.equal(standardCalls.length, 1);
	assert.equal(logs.length, 1);
	for (const detail of [
		'route "gw"', 'model "native-model"', 'ordinary search "deepseek-official"',
		'[native-failed]', 'http://host/v1/messages', 'HTTP 503',
		'search temporarily unavailable', 'WEB_PROVIDER_ERROR',
	]) {
		assert.ok(logs[0].includes(detail), `missing log detail: ${detail}`);
	}
});

test('debug preserves the underlying transport cause behind fetch failed', async () => {
	const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3425'), { code: 'ECONNREFUSED' });
	const { provider, logs } = makeProvider({
		config: { debug: true },
		fetchImpl: async () => { throw new TypeError('fetch failed', { cause }); },
	});
	await provider.search({ query: 'q' });
	assert.equal(logs.length, 1);
	assert.match(logs[0], /fetch failed/u);
	assert.match(logs[0], /connect ECONNREFUSED 127\.0\.0\.1:3425/u);
});

test('debug retains the native failure when the standard provider is missing', async () => {
	const { provider, ctx, logs } = makeProvider({
		config: { debug: true },
		answer: { status: 429, body: { error: 'rate limited' } },
	});
	ctx.web.searchProviders.clear();
	await assert.rejects(provider.search({ query: 'q' }), (error) => error.code === 'WEB_PROVIDER_CONFIGURED_MISSING');
	assert.equal(logs.length, 1);
	assert.match(logs[0], /HTTP 429/u);
	assert.match(logs[0], /rate limited/u);
});

for (const phase of ['fetch', 'body']) {
	test(`native ${phase} timeout falls back with the original un-aborted caller signal`, async () => {
		const caller = new AbortController();
		let nativeSignal;
		const { provider, nativeCalls, standardCalls } = makeProvider({
			config: { timeoutMs: 10 },
			fetchImpl: async (_url, { signal }) => {
				nativeSignal = signal;
				const pending = () => new Promise((_resolve, reject) => {
					const guard = setTimeout(() => reject(new Error('timeout signal did not fire')), 1000);
					const onAbort = () => {
						clearTimeout(guard);
						reject(signal.reason);
					};
					if (signal.aborted) onAbort();
					else signal.addEventListener('abort', onAbort, { once: true });
				});
				return phase === 'fetch' ? pending() : { ok: true, text: pending };
			},
		});
		const result = await provider.search({ query: 'q' }, caller.signal);
		assert.deepEqual(result.sources, [{ url: 'https://standard.example' }]);
		assert.equal(nativeSignal.aborted, true);
		assert.equal(nativeSignal.reason.name, 'TimeoutError');
		assert.equal(caller.signal.aborted, false);
		assert.equal(nativeCalls.length, 1);
		assert.equal(standardCalls.length, 1);
		assert.equal(standardCalls[0].signal, caller.signal);
	});
}

for (const aborted of [
	new DOMException('cancelled during credential resolution', 'AbortError'),
	Object.assign(new Error('cancelled by a host service'), { code: 'WEB_ABORTED' }),
]) {
	test(`native ${aborted.code === 'WEB_ABORTED' ? aborted.code : aborted.name} propagates without fallback`, async () => {
		const { provider, ctx, nativeCalls, standardCalls } = makeProvider({
			config: { routes: { gw: { apiKeyEnv: 'KEY' } } },
		});
		const previousGet = ctx.get;
		ctx.get = (name) => (name === 'credentials'
			? { resolve: async () => { throw aborted; } }
			: previousGet(name));
		await assert.rejects(provider.search({ query: 'q' }), (error) => error === aborted);
		assert.equal(nativeCalls.length, 0);
		assert.equal(standardCalls.length, 0);
	});
}

test('standard provider failure after native failure propagates without retry', async () => {
	const failure = new Error('ordinary provider failed');
	const { provider, nativeCalls, standardCalls } = makeProvider({
		answer: { status: 503, body: 'native unavailable' },
		standardSearch: async () => { throw failure; },
	});
	await assert.rejects(provider.search({ query: 'q' }), (error) => error === failure);
	assert.equal(nativeCalls.length, 1);
	assert.equal(standardCalls.length, 1);
});

test('empty native result from a completed search is returned without fallback', async () => {
	const { provider, standardCalls } = makeProvider({
		answer: { status: 200, body: { output: [{ type: 'web_search_call', status: 'completed', action: { sources: [] } }] } },
		providers: { gw: { api: 'openai-responses', baseURL: 'http://host/v1' } },
	});
	assert.deepEqual(await provider.search({ query: 'q' }), { sources: [], truncated: false });
	assert.equal(standardCalls.length, 0);
});

test('enabled route with missing endpoint falls back to standard search', async () => {
	const { provider, nativeCalls, standardCalls } = makeProvider({
		config: ENABLED,
		providers: { gw: { api: 'anthropic-messages' } },
	});
	assert.deepEqual((await provider.search({ query: 'q' })).sources, [{ url: 'https://standard.example' }]);
	assert.equal(nativeCalls.length, 0);
	assert.equal(standardCalls.length, 1);
});

for (const [mode, config] of [['native', {}], ['ordinary', DISABLED]]) {
	test(`pre-cancelled ${mode} search calls neither provider`, async () => {
		const { provider, nativeCalls, standardCalls } = makeProvider({ config });
		const controller = new AbortController();
		controller.abort(new Error('cancelled'));
		await assert.rejects(
			provider.search({ query: 'q' }, controller.signal),
			(error) => error.code === 'WEB_ABORTED',
		);
		assert.equal(nativeCalls.length, 0);
		assert.equal(standardCalls.length, 0);
	});
}

test('cancellation during native dispatch propagates without fallback', async () => {
	const controller = new AbortController();
	const reason = new Error('cancelled during request');
	const { provider, nativeCalls, standardCalls, logs } = makeProvider({
		config: { ...ENABLED, debug: true },
		fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
			signal.addEventListener('abort', () => reject(signal.reason), { once: true });
			queueMicrotask(() => controller.abort(reason));
		}),
	});
	await assert.rejects(
		provider.search({ query: 'q' }, controller.signal),
		(error) => error.code === 'WEB_ABORTED' && error.cause === reason,
	);
	assert.equal(nativeCalls.length, 1);
	assert.equal(standardCalls.length, 0);
	assert.deepEqual(logs, []);
});

for (const [label, context] of [
	['no session', null],
	['missing model', { provider: 'gw' }],
	['unknown route', { provider: 'unknown', model: 'm' }],
]) {
	test(`${label} selects standard search`, async () => {
		const { provider, nativeCalls, standardCalls } = makeProvider({ context, config: ENABLED });
		await provider.search({ query: 'q' });
		assert.equal(nativeCalls.length, 0);
		assert.equal(standardCalls.length, 1);
	});
}

test('standard search forwards original request and signal and propagates errors', async () => {
	const failure = new Error('ordinary provider failure');
	const { provider, nativeCalls, standardCalls } = makeProvider({
		config: DISABLED,
		standardSearch: async () => { throw failure; },
	});
	const request = { query: 'q', maxResults: 3 };
	const signal = new AbortController().signal;
	await assert.rejects(provider.search(request, signal), (error) => error === failure);
	assert.equal(nativeCalls.length, 0);
	assert.equal(standardCalls[0].request, request);
	assert.equal(standardCalls[0].signal, signal);
});

test('selects configured standardProvider by id', async () => {
	const { provider, ctx } = makeProvider({ config: { ...DISABLED, standardProvider: 'custom' } });
	ctx.web.searchProviders.set('custom', {
		search: async () => ({ sources: [{ url: 'https://custom.example' }], truncated: false }),
	});
	assert.deepEqual((await provider.search({ query: 'q' })).sources, [{ url: 'https://custom.example' }]);
});

test('availability reflects the current session plan when no standard provider exists', () => {
	const { provider, ctx } = makeProvider({ config: ENABLED });
	ctx.web.searchProviders.clear();
	assert.equal(provider.available(), true);
	provider.config.routes.gw.models['native-model'].nativeSearch = false;
	assert.equal(provider.available(), false);
});

test('availability includes automatically discovered current model without explicit routes', async () => {
	for (const [api, body] of [['anthropic-messages', MESSAGES_OK], ['openai-responses', RESPONSES_OK]]) {
		const { provider, ctx, nativeCalls, standardCalls } = makeProvider({
			providers: { gw: { api, baseURL: 'http://host/v1' } },
			answer: { status: 200, body },
		});
		ctx.web.searchProviders.clear();
		assert.deepEqual(provider.config.routes, {});
		assert.equal(provider.available(), true);
		await provider.search({ query: 'q' });
		assert.equal(nativeCalls.length, 1);
		assert.equal(standardCalls.length, 0);
	}
});

test('unsupported or missing current model is not available without a standard provider', () => {
	for (const options of [
		{ context: null },
		{ context: { provider: 'gw' } },
		{ context: { provider: 'unknown', model: 'm' } },
		{ providers: { gw: { api: 'openai-completions', baseURL: 'http://host/v1' } } },
		{ providers: { gw: { baseURL: 'http://host' } } },
	]) {
		const { provider, ctx } = makeProvider(options);
		ctx.web.searchProviders.clear();
		assert.equal(provider.available(), false);
	}
});

test('standard provider makes an explicitly disabled model available', () => {
	assert.equal(makeProvider({ config: DISABLED }).provider.available(), true);
});

test('missing or self-referential standard providers fail with WEB_PROVIDER_CONFIGURED_MISSING', async () => {
	for (const standardProvider of ['missing', 'native-preferring']) {
		const { provider, nativeCalls } = makeProvider({ config: { ...DISABLED, standardProvider } });
		await assert.rejects(
			provider.search({ query: 'q' }),
			(error) => error.code === 'WEB_PROVIDER_CONFIGURED_MISSING',
		);
		assert.equal(nativeCalls.length, 0);
	}
});

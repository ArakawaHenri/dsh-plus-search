import test from 'node:test';
import assert from 'node:assert/strict';

import { endpointFor, planSearch, resolveRouteProfile, routeFromLoader, STANDARD_REASONS } from '../lib/routes.js';
import { PI_AI_PLUGIN } from '../lib/routes.js';

const CONTEXT = { provider: 'gw', model: 'enabled' };

function ctxFor(providers = {}) {
	return {
		get: (name) => (name === 'loader'
			? { entries: () => [{ options: { name: PI_AI_PLUGIN, config: { providers } } }] }
			: undefined),
	};
}

test('loader routes map pi-ai protocols to canonical apis', () => {
	for (const [api, expected] of [
		['anthropic-messages', 'messages'],
		['openai-responses', 'responses'],
		['azure-openai-responses', 'responses'],
		['openai-codex-responses', 'responses'],
		['openai-completions', 'chat-completions'],
		['mistral-conversations', undefined],
		[undefined, undefined],
		['', undefined],
	]) {
		assert.equal(routeFromLoader(ctxFor({ r: { api } }), 'r').api, expected);
	}
});

test('routeFromLoader reads api, baseURL, apiKeyEnv, and headers', () => {
	const ctx = ctxFor({
		gw: { api: 'anthropic-messages', baseURL: 'http://127.0.0.1:3425', apiKeyEnv: 'GATEWAY_KEY', headers: { 'x-tag': '1' } },
	});
	assert.deepEqual(routeFromLoader(ctx, 'gw'), {
		api: 'messages',
		baseURL: 'http://127.0.0.1:3425',
		apiKeyEnv: 'GATEWAY_KEY',
		headers: { 'x-tag': '1' },
	});
	assert.equal(routeFromLoader(ctx, 'unknown'), undefined);
	assert.equal(routeFromLoader({}, 'gw'), undefined);
});

test('routeFromLoader tolerates an absent or throwing loader', () => {
	assert.equal(routeFromLoader({}, 'x'), undefined);
	assert.equal(routeFromLoader({ get: () => undefined }, 'x'), undefined);
	const throwing = { get: () => ({ entries: () => { throw new Error('boom'); } }) };
	assert.equal(routeFromLoader(throwing, 'x'), undefined);
});

test('endpointFor derives protocol endpoints from base URLs', () => {
	assert.equal(endpointFor('messages', 'http://127.0.0.1:3425'), 'http://127.0.0.1:3425/v1/messages');
	assert.equal(endpointFor('messages', 'https://api.deepseek.com/anthropic/v1'), 'https://api.deepseek.com/anthropic/v1/messages');
	assert.equal(endpointFor('responses', 'http://127.0.0.1:3425/v1'), 'http://127.0.0.1:3425/v1/responses');
	assert.equal(endpointFor('responses', 'https://api.openai.com'), 'https://api.openai.com/v1/responses');
	assert.equal(endpointFor('responses', 'http://127.0.0.1:3425/v1/'), 'http://127.0.0.1:3425/v1/responses');
	assert.equal(endpointFor('messages', 'http://host/base', '/custom/messages'), 'http://host/base/custom/messages');
	assert.equal(endpointFor('messages', ''), undefined);
});

test('resolveRouteProfile merges explicit config over discovered fields', () => {
	const ctx = ctxFor({ gw: { api: 'anthropic-messages', baseURL: 'http://host' } });
	const discovered = resolveRouteProfile(ctx, { autoResolve: true, routes: {} }, 'gw');
	assert.equal(discovered.api, 'messages');
	assert.equal(discovered.baseURL, 'http://host');

	const overridden = resolveRouteProfile(
		ctx,
		{ autoResolve: true, routes: { gw: { toolType: 'web_search_20250305', timeoutMs: 5000 } } },
		'gw',
	);
	assert.equal(overridden.api, 'messages');
	assert.equal(overridden.toolType, 'web_search_20250305');
	assert.equal(overridden.timeoutMs, 5000);
});

test('autoResolve: false disables discovery; explicit api wins', () => {
	const ctx = ctxFor({ gw: { api: 'openai-completions', baseURL: 'http://host/v1' } });
	assert.equal(resolveRouteProfile(ctx, { autoResolve: false, routes: {} }, 'gw'), undefined);

	const explicit = resolveRouteProfile(
		ctx,
		{ autoResolve: false, routes: { gw: { api: 'responses', baseURL: 'http://other' } } },
		'gw',
	);
	assert.equal(explicit.api, 'responses');
	assert.equal(explicit.baseURL, 'http://other');
});

test('a discovered chat-completions route can be overridden to a native protocol', () => {
	const ctx = ctxFor({ gw: { api: 'openai-completions', baseURL: 'http://host/v1' } });
	const plan = planSearch(ctx, {
		routes: { gw: { api: 'messages', baseURL: 'http://other' } },
	}, CONTEXT);
	assert.equal(plan.kind, 'native');
	assert.equal(plan.api, 'messages');
	assert.equal(plan.profile.baseURL, 'http://other');
});

test('non-pi-ai routes can use an explicit protocol', () => {
	const plan = planSearch({}, {
		autoResolve: false,
		routes: { gw: { api: 'responses', baseURL: 'http://host/v1' } },
	}, CONTEXT);
	assert.equal(plan.kind, 'native');
	assert.equal(plan.profile.model, 'enabled');
});

for (const [wireApi, api] of [['anthropic-messages', 'messages'], ['openai-responses', 'responses']]) {
	test(`${wireApi} defaults to native while preserving model opt-outs`, () => {
		const ctx = ctxFor({ gw: { api: wireApi, baseURL: 'http://host/v1' } });
		const config = { routes: { gw: { models: { disabled: { nativeSearch: false } } } } };
		for (const model of ['enabled', 'unconfigured']) {
			const plan = planSearch(ctx, config, { ...CONTEXT, model });
			assert.equal(plan.kind, 'native');
			assert.equal(plan.api, api);
			assert.equal(plan.profile.model, model);
		}
		assert.equal(planSearch(ctx, config, { provider: 'gw', model: 'disabled' }).reason, STANDARD_REASONS.MODEL_DISABLED);
	});
}

test('route-wide opt-out disables native search for the whole route', () => {
	const ctx = ctxFor({ gw: { api: 'openai-responses', baseURL: 'http://host/v1' } });
	const plan = planSearch(ctx, { routes: { gw: { nativeSearch: false } } }, CONTEXT);
	assert.equal(plan.kind, 'standard');
	assert.equal(plan.reason, STANDARD_REASONS.MODEL_DISABLED);
});

test('unsupported or missing protocols select standard search', () => {
	for (const api of ['openai-completions', undefined, 'mistral-conversations']) {
		const plan = planSearch(ctxFor({ gw: { api, baseURL: 'http://host' } }), {}, CONTEXT);
		assert.equal(plan.kind, 'standard');
		assert.equal(plan.reason, STANDARD_REASONS.UNSUPPORTED_PROTOCOL);
	}
});

test('missing session, model, or route selects standard search', () => {
	const ctx = ctxFor({ gw: { api: 'anthropic-messages', baseURL: 'http://host' } });
	for (const context of [undefined, {}, { provider: '' }]) {
		assert.equal(planSearch(ctx, {}, context).reason, STANDARD_REASONS.NO_SESSION);
	}
	for (const model of [undefined, null, '', '   ']) {
		assert.equal(planSearch(ctx, {}, { provider: 'gw', model }).reason, STANDARD_REASONS.NO_MODEL);
	}
	assert.equal(planSearch(ctxFor(), {}, { provider: 'unknown', model: 'm' }).reason, STANDARD_REASONS.UNMAPPED_ROUTE);
});

test('supported route with missing endpoint still plans as native so dispatch reports it', () => {
	const plan = planSearch(ctxFor({ gw: { api: 'openai-responses' } }), {}, CONTEXT);
	assert.equal(plan.kind, 'native');
	assert.equal(plan.profile.baseURL, undefined);
});

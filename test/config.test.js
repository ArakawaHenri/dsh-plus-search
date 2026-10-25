import test from 'node:test';
import assert from 'node:assert/strict';

import { Config, DEFAULTS, nativeSearchEnabled, resolveConfig } from '../lib/config.js';
import { apply, inject, name, PROVIDER_ID } from '../index.js';

function fakeCtx() {
	const registered = [];
	return {
		registered,
		get: () => undefined,
		web: {
			searchProviders: new Map(),
			registerSearchProvider: (provider) => {
				registered.push(provider);
				return () => {};
			},
		},
	};
}

test('declares seam dependency and stable identifiers', () => {
	assert.deepEqual(inject, ['web']);
	assert.equal(name, 'dshplus-native-search');
	assert.equal(PROVIDER_ID, 'native-preferring');
});

test('empty configuration fills defaults', () => {
	assert.deepEqual(resolveConfig(undefined), { ...DEFAULTS, routes: {} });
	assert.deepEqual(resolveConfig({}), { ...DEFAULTS, routes: {} });
});

test('resolves scalar and route configuration', () => {
	const resolved = resolveConfig({
		standardProvider: 'custom',
		routes: {
			gateway: {
				baseURL: 'http://127.0.0.1:3425',
				api: 'responses',
				timeoutMs: 12000,
				models: { on: { nativeSearch: true }, off: { nativeSearch: false }, omitted: {} },
			},
		},
	});
	assert.equal(resolved.standardProvider, 'custom');
	assert.equal(resolved.routes.gateway.api, 'responses');
	assert.equal(resolved.routes.gateway.baseURL, 'http://127.0.0.1:3425');
	assert.equal(resolved.routes.gateway.timeoutMs, 12000);
	assert.equal(resolved.routes.gateway.nativeSearch, true);
	assert.deepEqual(resolved.routes.gateway.models, {
		on: { nativeSearch: true },
		off: { nativeSearch: false },
		omitted: { nativeSearch: true },
	});
});

test('rejects invalid values', () => {
	assert.throws(() => resolveConfig({ maxTokens: 'many' }), /number/u);
	assert.throws(() => resolveConfig({ timeoutMs: 0 }), />= 1/u);
	assert.throws(() => resolveConfig({ routes: { r: { api: 'grpc' } } }), /grpc/u);
	assert.throws(() => resolveConfig({ routes: { r: { timeoutMs: 0 } } }), />= 1/u);
	assert.throws(() => resolveConfig({ routes: { r: { models: { m: { nativeSearch: 'true' } } } } }), /boolean/u);
});

test('nativeSearchEnabled honors route and model opt-outs', () => {
	const routes = resolveConfig({
		routes: {
			gw: { models: { off: { nativeSearch: false } } },
			blocked: { nativeSearch: false, models: { on: { nativeSearch: true } } },
		},
	}).routes;
	assert.equal(nativeSearchEnabled(routes, 'gw', 'off'), false);
	assert.equal(nativeSearchEnabled(routes, 'gw', 'other'), true);
	assert.equal(nativeSearchEnabled(routes, 'missing', 'any'), true);
	// An explicit route-wide opt-out wins over a model-level true.
	assert.equal(nativeSearchEnabled(routes, 'blocked', 'on'), false);
});

test('apply registers the search provider with resolved config', () => {
	const ctx = fakeCtx();
	apply(ctx, { routes: { gw: { models: { m: { nativeSearch: false } } } } });
	assert.equal(ctx.registered.length, 1);
	const provider = ctx.registered[0];
	assert.equal(provider.id, PROVIDER_ID);
	assert.equal(provider.config.routes.gw.models.m.nativeSearch, false);
});

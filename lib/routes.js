import { API_KINDS, nativeSearchEnabled } from './config.js';

export const PI_AI_PLUGIN = '@deepseek-ai/dsh-llm-pi-ai';

export const STANDARD_REASONS = Object.freeze({
	NO_SESSION: 'no-session',
	NO_MODEL: 'no-model',
	UNMAPPED_ROUTE: 'unmapped-route',
	MODEL_DISABLED: 'model-disabled',
	UNSUPPORTED_PROTOCOL: 'unsupported-protocol',
});

const PI_AI_APIS = {
	'anthropic-messages': 'messages',
	'openai-responses': 'responses',
	'azure-openai-responses': 'responses',
	'openai-codex-responses': 'responses',
	'openai-completions': 'chat-completions',
};

export function supportsNativeSearch(api) {
	return API_KINDS.includes(api);
}

function loaderEntries(ctx) {
	const loader = typeof ctx?.get === 'function' ? ctx.get('loader') : ctx?.loader;
	if (typeof loader?.entries !== 'function') return [];
	try {
		return [...loader.entries()];
	} catch {
		return [];
	}
}

export function routeFromLoader(ctx, provider) {
	if (typeof provider !== 'string' || !provider) return undefined;
	for (const entry of loaderEntries(ctx)) {
		const options = entry?.options;
		if (options?.name !== PI_AI_PLUGIN) continue;
		const declared = options.config?.providers?.[provider];
		if (!declared || typeof declared !== 'object') continue;
		return {
			api: PI_AI_APIS[declared.api],
			baseURL: typeof declared.baseURL === 'string' && declared.baseURL.length > 0 ? declared.baseURL : undefined,
			apiKeyEnv: typeof declared.apiKeyEnv === 'string' && declared.apiKeyEnv.length > 0 ? declared.apiKeyEnv : undefined,
			headers: declared.headers && typeof declared.headers === 'object' ? { ...declared.headers } : undefined,
		};
	}
	return undefined;
}

export function resolveRouteProfile(ctx, config, provider) {
	if (typeof provider !== 'string' || !provider) return undefined;
	const discovered = config?.autoResolve === false ? undefined : routeFromLoader(ctx, provider);
	const explicit = config?.routes?.[provider];
	if (!discovered && !explicit) return undefined;
	return {
		...discovered,
		...explicit,
		provider,
	};
}

export function endpointFor(api, baseURL, path) {
	if (typeof baseURL !== 'string' || !baseURL) return undefined;
	const base = baseURL.replace(/\/+$/u, '');
	if (typeof path === 'string' && path.length > 0) {
		return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
	}
	const versioned = /\/v\d+$/u.test(base);
	if (api === 'messages') return versioned ? `${base}/messages` : `${base}/v1/messages`;
	if (api === 'responses') return versioned ? `${base}/responses` : `${base}/v1/responses`;
	return undefined;
}

export function planSearch(ctx, config, requestContext) {
	const providerId = requestContext?.provider;
	const model = requestContext?.model;
	if (typeof providerId !== 'string' || !providerId.trim()) {
		return { kind: 'standard', reason: STANDARD_REASONS.NO_SESSION };
	}
	if (typeof model !== 'string' || !model.trim()) {
		return { kind: 'standard', reason: STANDARD_REASONS.NO_MODEL, providerId };
	}
	const profile = resolveRouteProfile(ctx, config, providerId);
	if (!profile) {
		return { kind: 'standard', reason: STANDARD_REASONS.UNMAPPED_ROUTE, providerId, model };
	}
	if (!supportsNativeSearch(profile.api)) {
		return { kind: 'standard', reason: STANDARD_REASONS.UNSUPPORTED_PROTOCOL, providerId, model };
	}
	if (!nativeSearchEnabled(config?.routes, providerId, model)) {
		return { kind: 'standard', reason: STANDARD_REASONS.MODEL_DISABLED, providerId, model };
	}
	return { kind: 'native', api: profile.api, profile: { ...profile, model }, providerId, model };
}

import Schema from '@deepseek-ai/schemastery';

export const API_KINDS = Object.freeze(['messages', 'responses']);
export const DEFAULT_NATIVE_SEARCH = true;

export const DEFAULTS = Object.freeze({
	standardProvider: 'deepseek-official',
	autoResolve: true,
	maxTokens: 2048,
	maxUses: 3,
	timeoutMs: 60000,
	anthropicVersion: '2023-06-01',
	messagesToolType: 'web_search_20250305',
	responsesToolType: 'web_search',
	debug: false,
});

const positiveInteger = () => Schema.number().min(1).step(1);

const modelSchema = Schema.object({
	nativeSearch: Schema.boolean()
		.default(DEFAULT_NATIVE_SEARCH)
		.description("Use this model's native search on Messages or Responses; fall back to standard search on failure."),
});

const routeSchema = Schema.object({
	api: Schema.union(API_KINDS),
	nativeSearch: Schema.boolean().default(DEFAULT_NATIVE_SEARCH),
	baseURL: Schema.string(),
	path: Schema.string(),
	apiKey: Schema.string().role('secret'),
	apiKeyEnv: Schema.string().role('credential-ref'),
	requireApiKey: Schema.boolean(),
	headers: Schema.dict(Schema.string()).role('secret'),
	maxTokens: positiveInteger(),
	maxUses: positiveInteger(),
	timeoutMs: positiveInteger(),
	toolType: Schema.string(),
	toolChoice: Schema.any(),
	anthropicVersion: Schema.string(),
	models: Schema.dict(modelSchema).default({}),
});

export const Config = Schema.object({
	standardProvider: Schema.string().default(DEFAULTS.standardProvider),
	autoResolve: Schema.boolean().default(DEFAULTS.autoResolve),
	maxTokens: positiveInteger().default(DEFAULTS.maxTokens),
	maxUses: positiveInteger().default(DEFAULTS.maxUses),
	timeoutMs: positiveInteger().default(DEFAULTS.timeoutMs),
	anthropicVersion: Schema.string().default(DEFAULTS.anthropicVersion),
	messagesToolType: Schema.string().default(DEFAULTS.messagesToolType),
	responsesToolType: Schema.string().default(DEFAULTS.responsesToolType),
	debug: Schema.boolean().default(DEFAULTS.debug),
	routes: Schema.dict(routeSchema).default({}),
});

export function resolveConfig(raw) {
	return Config(raw == null ? {} : structuredClone(raw));
}

export function nativeSearchEnabled(routes, provider, model) {
	const route = routes?.[provider];
	if (route?.nativeSearch === false) return false;
	if (route?.models?.[model]?.nativeSearch === false) return false;
	return DEFAULT_NATIVE_SEARCH;
}

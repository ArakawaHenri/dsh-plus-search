import { buildMessagesRequest, parseMessagesResponse, buildResponsesRequest, parseResponsesResponse } from './protocol.js';
import { endpointFor } from './routes.js';

export const ERROR_CODES = Object.freeze({
	CREDENTIAL_MISSING: 'WEB_PROVIDER_CREDENTIAL_MISSING',
	ABORTED: 'WEB_ABORTED',
	PROVIDER_ERROR: 'WEB_PROVIDER_ERROR',
	STANDARD_MISSING: 'WEB_PROVIDER_CONFIGURED_MISSING',
});

export class SearchProviderError extends Error {
	constructor(message, code, options = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'SearchProviderError';
		this.code = code;
	}
}

export function isAbortError(error) {
	return error?.code === ERROR_CODES.ABORTED || error?.name === 'AbortError';
}

export function abortedError(signal) {
	return new SearchProviderError('web search aborted', ERROR_CODES.ABORTED, {
		cause: signal?.reason,
	});
}

export function throwIfAborted(signal) {
	if (signal?.aborted) throw abortedError(signal);
}

function launchEnvironment(ctx) {
	const service = typeof ctx?.get === 'function' ? ctx.get('launchEnvironment') : undefined;
	if (typeof service?.get === 'function') return service;
	return {
		get: (name) => (process.env[name] === undefined ? undefined : { value: process.env[name] }),
	};
}

export async function resolveApiKey(ctx, route, signal) {
	throwIfAborted(signal);
	if (typeof route.apiKey === 'string' && route.apiKey.length > 0) return route.apiKey;

	const reference = typeof route.apiKeyEnv === 'string' ? route.apiKeyEnv.trim() : '';
	if (reference) {
		const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined;
		if (typeof credentials?.resolve === 'function') {
			const resolved = await credentials.resolve(reference);
			throwIfAborted(signal);
			if (typeof resolved?.value === 'string' && resolved.value.length > 0) {
				return resolved.value;
			}
		}
		const ambient = launchEnvironment(ctx).get(reference);
		if (typeof ambient?.value === 'string' && ambient.value.length > 0) {
			return ambient.value;
		}
	}

	if (route.requireApiKey === true) {
		const detail = reference ? ` "${reference}"` : '';
		throw new SearchProviderError(
			`web search route "${route.provider}" requires credential${detail}, which was not found in credentials or environment`,
			ERROR_CODES.CREDENTIAL_MISSING,
		);
	}
	return undefined;
}

export function authHeaders(api, apiKey) {
	if (!apiKey) return {};
	if (api === 'messages') return { 'x-api-key': apiKey, authorization: `Bearer ${apiKey}` };
	return { authorization: `Bearer ${apiKey}` };
}

function composeSignal(signal, timeoutMs) {
	const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
	if (!signal) return timeout;
	if (!timeout) return signal;
	return AbortSignal.any([signal, timeout]);
}

function httpError(endpoint, status, body) {
	let detail = '';
	try {
		const parsed = JSON.parse(body);
		detail = typeof parsed?.error === 'string'
			? parsed.error
			: parsed?.error?.message ?? parsed?.message ?? '';
	} catch {
		detail = body.slice(0, 300);
	}
	const suffix = detail ? `: ${detail}` : '';
	return new SearchProviderError(
		`native web search failed at ${JSON.stringify(endpoint)} (HTTP ${status})${suffix}`,
		ERROR_CODES.PROVIDER_ERROR,
	);
}

export async function dispatchNativeSearch(options) {
	const { ctx, api, profile, request, defaults, signal, fetchImpl = globalThis.fetch } = options;
	throwIfAborted(signal);
	if (typeof profile.model !== 'string' || !profile.model.trim()) {
		throw new SearchProviderError('native web search requires the initiating session model', ERROR_CODES.PROVIDER_ERROR);
	}
	const endpoint = endpointFor(api, profile.baseURL, profile.path);
	if (!endpoint) {
		throw new SearchProviderError(
			`web search route "${profile.provider}" has no usable endpoint; set routes.${profile.provider}.baseURL`,
			ERROR_CODES.PROVIDER_ERROR,
		);
	}
	if (typeof fetchImpl !== 'function') {
		throw new SearchProviderError('native web search needs a fetch implementation', ERROR_CODES.PROVIDER_ERROR);
	}

	const apiKey = await resolveApiKey(ctx, profile, signal);
	const timeoutMs = profile.timeoutMs ?? defaults.timeoutMs;
	const composed = composeSignal(signal, timeoutMs);
	const toolType = profile.toolType ?? (api === 'messages' ? defaults.messagesToolType : defaults.responsesToolType);
	const body = api === 'messages'
		? buildMessagesRequest(profile, request, defaults, toolType)
		: buildResponsesRequest(profile, request, defaults, toolType);
	const headers = {
		'content-type': 'application/json',
		accept: 'application/json',
		...authHeaders(api, apiKey),
		...(api === 'messages' ? { 'anthropic-version': profile.anthropicVersion ?? defaults.anthropicVersion } : {}),
		...profile.headers,
	};
	let response;
	let text;
	try {
		throwIfAborted(signal);
		composed?.throwIfAborted();
		response = await fetchImpl(endpoint, {
			method: 'POST',
			redirect: 'error',
			headers,
			body: JSON.stringify(body),
			signal: composed,
		});
		text = await response.text();
		throwIfAborted(signal);
		composed?.throwIfAborted();
	} catch (error) {
		if (signal?.aborted) throw abortedError(signal);
		if (composed?.aborted || error?.name === 'TimeoutError') {
			throw new SearchProviderError(
				`native web search at ${JSON.stringify(endpoint)} exceeded ${timeoutMs}ms`,
				ERROR_CODES.PROVIDER_ERROR,
				{ cause: error },
			);
		}
		throw new SearchProviderError(
			`native web search request to ${JSON.stringify(endpoint)} failed: ${error}`,
			ERROR_CODES.PROVIDER_ERROR,
			{ cause: error },
		);
	}
	if (!response.ok) throw httpError(endpoint, response.status, text);
	let payload;
	try {
		payload = JSON.parse(text);
	} catch (error) {
		throw new SearchProviderError(
			`native web search at ${JSON.stringify(endpoint)} returned an unprocessable body`,
			ERROR_CODES.PROVIDER_ERROR,
			{ cause: error },
		);
	}
	const parsed = api === 'messages'
		? parseMessagesResponse(payload)
		: parseResponsesResponse(payload);
	if (parsed.toolErrors.length > 0 && parsed.sources.length === 0) {
		throw new SearchProviderError(
			`native web search at ${JSON.stringify(endpoint)} reported a tool failure: ${parsed.toolErrors.join(', ')}`,
			ERROR_CODES.PROVIDER_ERROR,
		);
	}
	if (!parsed.searched) {
		throw new SearchProviderError(
			`native web search at ${JSON.stringify(endpoint)} did not run a web search`,
			ERROR_CODES.PROVIDER_ERROR,
		);
	}
	return { sources: parsed.sources, truncated: false };
}

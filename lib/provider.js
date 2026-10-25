import { inspect } from 'node:util';

import { dispatchNativeSearch, ERROR_CODES, SearchProviderError, abortedError, isAbortError, throwIfAborted } from './dispatch.js';
import { planSearch } from './routes.js';

export const PROVIDER_ID = 'native-preferring';

export class NativePreferringSearchProvider {
	id = PROVIDER_ID;

	constructor(ctx, config, options = {}) {
		this.ctx = ctx;
		this.config = config;
		this.fetchImpl = options.fetchImpl;
	}

	available() {
		if (this.resolveStandard() !== undefined) return true;
		return planSearch(this.ctx, this.config, this.currentRequestContext()).kind === 'native';
	}

	resolveStandard() {
		const registry = this.ctx.web?.searchProviders;
		if (!(registry instanceof Map)) return undefined;
		const id = this.config.standardProvider;
		if (typeof id !== 'string' || !id || id === PROVIDER_ID) return undefined;
		const provider = registry.get(id);
		if (!provider || provider === this) return undefined;
		return provider;
	}

	currentRequestContext() {
		const agents = typeof this.ctx.get === 'function' ? this.ctx.get('agents') : this.ctx.agents;
		return agents?.currentInitiator?.()?.session?.requestContext?.();
	}

	async search(request, signal) {
		throwIfAborted(signal);
		const plan = planSearch(this.ctx, this.config, this.currentRequestContext());
		if (plan.kind === 'standard') return this.standardSearch(request, signal, plan);
		try {
			return await dispatchNativeSearch({
				ctx: this.ctx,
				api: plan.api,
				profile: plan.profile,
				request,
				defaults: this.config,
				signal,
				fetchImpl: this.fetchImpl,
			});
		} catch (error) {
			if (signal?.aborted) throw abortedError(signal);
			if (isAbortError(error)) throw error;
			return this.standardSearch(request, signal, {
				providerId: plan.providerId,
				model: plan.model,
				reason: 'native-failed',
				error,
			});
		}
	}

	async standardSearch(request, signal, plan) {
		if (this.config.debug === true && typeof this.ctx.logger?.info === 'function') {
			this.ctx.logger.info(
				'dshplus-native-search: route "%s" model "%s" selected ordinary search "%s" [%s]%s',
				plan.providerId ?? 'unknown',
				plan.model ?? 'unknown',
				this.config.standardProvider,
				plan.reason,
				plan.reason === 'native-failed' ? `: ${inspect(plan.error, { colors: false })}` : '',
			);
		}
		const provider = this.resolveStandard();
		if (!provider) {
			throw new SearchProviderError(
				`no ordinary web search provider is registered as "${this.config.standardProvider}"`,
				ERROR_CODES.STANDARD_MISSING,
			);
		}
		return provider.search(request, signal);
	}
}

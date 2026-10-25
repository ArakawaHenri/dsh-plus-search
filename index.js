import { Config, resolveConfig } from './lib/config.js';
import { NativePreferringSearchProvider, PROVIDER_ID } from './lib/provider.js';

export { Config, PROVIDER_ID, NativePreferringSearchProvider, resolveConfig };

export const name = 'dshplus-native-search';
export const inject = ['web'];

export function apply(ctx, rawConfig) {
	ctx.web.registerSearchProvider(new NativePreferringSearchProvider(ctx, resolveConfig(rawConfig)));
}

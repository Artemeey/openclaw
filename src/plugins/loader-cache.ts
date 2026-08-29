import { PluginLoaderCacheState } from "./loader-cache-state.js";
import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import { getPluginRegistryState } from "./runtime-state.js";

const MAX_PLUGIN_REGISTRY_CACHE_ENTRIES = 128;

export const pluginLoaderCacheState = new PluginLoaderCacheState<PluginRegistry>(
  MAX_PLUGIN_REGISTRY_CACHE_ENTRIES,
);

export function setCachedPluginRegistry(cacheKey: string, registry: PluginRegistry): void {
  pluginLoaderCacheState.set(cacheKey, registry);
}

export function getReusableCachedPluginRegistry(cacheKey: string): PluginRegistry | undefined {
  const registry = pluginLoaderCacheState.get(cacheKey);
  // Both replacement and terminal cleanup retire registrations. Never reactivate
  // their closed resources from a cache hit; the loader must register fresh ones.
  return registry && !isPluginRegistryRetired(registry) ? registry : undefined;
}

/** Registry reuse is off for explicit opt-outs and for raw env-substituted config loads. */
export function isPluginRegistryCacheEnabled(options: PluginLoadOptions): boolean {
  return options.cache !== false && options.resolveRawConfigEnvVars !== true;
}

export function clearPluginRegistryLoadCache(): void {
  // Only the active registry may rebind artifacts; other retained registries stay pinned.
  getPluginRegistryState()?.activeRegistry?.pluginRuntimeArtifacts.clear();
  pluginLoaderCacheState.clearCachedRegistries();
}

export function resolvePluginRegistryLoadCacheKey(options: PluginLoadOptions = {}): string {
  return resolvePluginLoadCacheContext(options).cacheKey;
}

export function isPluginRegistryLoadInFlight(options: PluginLoadOptions = {}): boolean {
  return pluginLoaderCacheState.isLoadInFlight(resolvePluginRegistryLoadCacheKey(options));
}

/** Returns the exact active registry without activating plugins on a cache miss. */
export function resolveCompatibleRuntimePluginRegistry(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  const state = getPluginRegistryState();
  const activeRegistry = state?.activeRegistry ?? undefined;
  if (!activeRegistry || options === undefined) {
    return activeRegistry;
  }
  const activeCacheKey = state?.key;
  if (!activeCacheKey) {
    return undefined;
  }
  return resolvePluginLoadCacheContext(options).cacheKey === activeCacheKey
    ? activeRegistry
    : undefined;
}

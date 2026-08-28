// Reads provider thinking policy from the scoped or active runtime registry.
import { matchesProviderPluginRef } from "./provider-registry-shared.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "./provider-thinking.types.js";
import { PLUGIN_REGISTRY_STATE } from "./runtime-state-key.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

type ActiveThinkingProvider = {
  id: string;
  aliases?: string[];
  hookAliases?: string[];
  resolveThinkingProfile?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => ProviderThinkingProfile | null | undefined;
};

type ActiveThinkingRegistryState = {
  activeRegistry?: {
    providers?: Array<{
      provider: ActiveThinkingProvider;
    }>;
  } | null;
};

type ThinkingHookParams<TContext> = {
  provider: string;
  context: TContext;
};

function resolveActiveThinkingProvider(providerId: string): ActiveThinkingProvider | undefined {
  const state = (
    globalThis as typeof globalThis & {
      [PLUGIN_REGISTRY_STATE]?: ActiveThinkingRegistryState;
    }
  )[PLUGIN_REGISTRY_STATE];
  const registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? state?.activeRegistry;
  return registry?.providers?.find((entry) => matchesProviderPluginRef(entry.provider, providerId))
    ?.provider;
}

export function resolveActiveProviderThinkingProfile(
  params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>,
) {
  return resolveActiveThinkingProvider(params.provider)?.resolveThinkingProfile?.(params.context);
}

// Model auth status methods report provider credential health, profile expiry,
// usage windows, cleanup actions, and auth-state refreshes.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  ErrorCodes,
  errorShape,
  validateModelsAuthCooldownClearParams,
  validateModelsAuthLogoutParams,
  validateModelsAuthOrderSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { type AuthHealthSummary, buildAuthHealthSummary } from "../../agents/auth-health.js";
import {
  type AuthProfileStore,
  clearAuthProfileCooldownAcrossOwnerStoresResult,
  ensureAuthProfileStoreWithoutExternalProfiles,
  externalCliDiscoveryForConfigStatus,
  getRuntimeInheritedAuthProfileOrder,
  getRuntimeLocalAuthProfileOrderProviders,
  listProfilesForProvider,
  removeAuthProfilesAcrossOwnerStoresResult,
} from "../../agents/auth-profiles.js";
import { getRuntimeExternalCliProfileIds } from "../../agents/auth-profiles/runtime-external-profile-references.js";
import {
  isNonSecretApiKeyMarker,
  NON_ENV_SECRETREF_MARKER,
} from "../../agents/model-auth-markers.js";
import { resolveProviderEntryApiKeyProfileReference } from "../../agents/model-auth.js";
import {
  clearCurrentProviderAuthState,
  warmCurrentProviderAuthStateOffMainThread,
} from "../../agents/model-provider-auth.js";
import {
  type ProviderAuthAliasLookupParams,
  resolveProviderIdForAuth,
} from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { hasConfiguredSecretInput } from "../../config/types.secrets.js";
import { resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { refreshActiveProviderAuthRuntimeSnapshot } from "../../secrets/runtime.js";
import { abortChatRunsForProvider } from "../chat-abort.js";
import { loadDeferredCatalog, readPreparedCatalog } from "../server-model-catalog-auth.js";
import { formatForLog } from "../ws-log.js";
import { modelAuthAgentScopeError, resolveModelAuthAgentScope } from "./model-auth-agent-scope.js";
import { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";
import {
  createAuthLogoutAbortOps,
  readLogoutProfileSelection,
  removeProviderAuthProfilesAcrossOwnerStoresResult,
} from "./models-auth-logout.js";
import { runModelAuthProfileMutation, updateModelAuthProfileOrder } from "./models-auth-order.js";
import { resolveProviderApiKeys } from "./models-auth-status-api-keys.js";
import {
  attachAliasProfileOrders,
  mapModelAuthStatusProvider,
  mapModelAuthUsage,
} from "./models-auth-status-profiles.js";
import {
  clearModelAuthStatusUsageCache,
  loadProfileUsageStaleWhileRevalidate,
  readProviderUsageStaleWhileRevalidate,
} from "./models-auth-status-usage-cache.js";
import type {
  ModelAuthLogoutResult,
  ModelAuthStatusProvider,
  ModelAuthStatusResult,
  ModelProviderCapability,
} from "./models-auth-status.types.js";
import { getProviderUsageRuntimeSnapshot } from "./provider-usage-runtime.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

export type {
  ModelAuthExpiry,
  ModelAuthLogoutResult,
  ModelAuthStatusProfile,
  ModelAuthStatusProvider,
  ModelAuthStatusResult,
  ModelProviderCapability,
} from "./models-auth-status.types.js";
export { aggregateRefreshableAuthStatus } from "./models-auth-status-profiles.js";

const log = createSubsystemLogger("models-auth-status");
type PreparedAuthMetadataLookupParams = ProviderAuthAliasLookupParams & {
  metadataSnapshot: NonNullable<
    Awaited<ReturnType<typeof readPreparedCatalog>>
  >["metadataSnapshot"];
};

async function readPreparedAuthMutationOwner(context: GatewayRequestContext, agentId: string) {
  const prepared =
    (await readPreparedCatalog(context, agentId)) ??
    (await loadDeferredCatalog(context, agentId, { readOnly: true }));
  if (!prepared) {
    throw new Error(`prepared model auth owner is unavailable (${agentId})`);
  }
  const authAliasLookupParams: PreparedAuthMetadataLookupParams = {
    config: prepared.config,
    workspaceDir: prepared.workspaceDir,
    metadataSnapshot: prepared.metadataSnapshot,
    includeUntrustedWorkspacePlugins: false,
  };
  return { prepared, authAliasLookupParams };
}

function buildProviderCapabilities(params: {
  config: OpenClawConfig;
  workspaceDir: string;
  metadataSnapshot: NonNullable<
    Awaited<ReturnType<typeof readPreparedCatalog>>
  >["metadataSnapshot"];
}): ModelProviderCapability[] {
  return resolveModelProviderCapabilities(params).capabilities;
}

function resolveAuthRefreshScope(cfg: OpenClawConfig): {
  providerIds: string[];
  profileIds?: string[];
} {
  const discovery = externalCliDiscoveryForConfigStatus({ cfg });
  if (discovery.mode !== "scoped") {
    return { providerIds: [] };
  }
  const providerIds = [...(discovery.providerIds ?? [])];
  const profileIds = [...(discovery.profileIds ?? [])];
  return {
    providerIds,
    ...(profileIds.length > 0 ? { profileIds } : {}),
  };
}

async function refreshModelAuthAfterLogout(context: GatewayRequestContext): Promise<void> {
  invalidateModelAuthStatusCache();
  await refreshActiveProviderAuthRuntimeSnapshot();
  void warmCurrentProviderAuthStateOffMainThread(context.getRuntimeConfig()).catch(
    (err: unknown) => {
      log.warn(`provider auth state rewarm after logout failed: ${formatForLog(err)}`);
    },
  );
}

/**
 * Invalidate auxiliary usage and prepared provider-auth state after an auth
 * mutation. Auth health itself is rebuilt on every request; only outbound
 * usage enrichment is cached.
 */
export function invalidateModelAuthStatusCache(): void {
  clearModelAuthStatusUsageCache();
  // The prepared provider-auth map (model-provider-auth.ts) was built from
  // the pre-mutation auth state, so it must be invalidated alongside this
  // cache whenever an auth-profile mutation lands (logout, login, token
  // rotation, etc.). Without this, `/models` and pickers keep advertising
  // providers the running gateway can no longer authenticate.
  clearCurrentProviderAuthState();
}

async function refreshModelAuthStatusRuntimeState(): Promise<void> {
  // Durable and CLI auth refresh into the transient prepared owner below. Do not clear the
  // process-wide warmed auth state for a read; mutations still invalidate it explicitly.
  try {
    await refreshActiveProviderAuthRuntimeSnapshot();
  } catch (err) {
    log.warn(`runtime auth snapshot refresh before auth status failed: ${formatForLog(err)}`);
  }
}

function readProviderParam(params: Record<string, unknown>): string | null {
  const raw = params.provider;
  if (typeof raw !== "string") {
    return null;
  }
  const provider = normalizeProviderId(raw);
  return provider || null;
}

function resolveConfigBoundProfiles(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): { profileIds: Set<string>; providers: Set<string> } {
  const profileIds = new Set<string>();
  const providers = new Set<string>();
  for (const provider of Object.keys(cfg.models?.providers ?? {})) {
    const reference = resolveProviderEntryApiKeyProfileReference({
      cfg,
      authAliasLookupParams,
      provider,
      store,
    });
    if (reference.kind === "profile" || reference.kind === "profile-incompatible") {
      profileIds.add(reference.profileId);
      providers.add(normalizeProviderId(provider));
    }
  }
  return { profileIds, providers };
}

function resolveConfiguredProviders(
  cfg: OpenClawConfig,
  apiKeys: ReadonlyMap<string, ModelAuthStatusProvider["apiKey"]>,
): {
  providers: string[];
  expectsOAuth: Set<string>;
} {
  const out = new Set<string>();
  const expectsOAuth = new Set<string>();
  for (const [id, provider] of Object.entries(cfg.models?.providers ?? {})) {
    const normalized = normalizeProviderId(id);
    if (!normalized) {
      continue;
    }
    const rawKey = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
    const hasApiKey =
      hasConfiguredSecretInput(provider?.apiKey, cfg.secrets?.defaults) &&
      (rawKey === NON_ENV_SECRETREF_MARKER ||
        !isNonSecretApiKeyMarker(rawKey, { includeEnvVarName: false }));
    const mode = provider?.auth;
    if (mode !== "oauth" && mode !== "token" && !hasApiKey) {
      continue;
    }
    if (apiKeys.has(normalized)) {
      continue;
    }
    out.add(normalized);
    if (mode === "oauth") {
      expectsOAuth.add(normalized);
    }
  }
  // auth.profiles opt in via `mode: oauth | token`; API-key profiles have no lifecycle.
  for (const profile of Object.values(cfg.auth?.profiles ?? {})) {
    const provider = profile?.provider;
    const mode = profile?.mode;
    if (
      typeof provider !== "string" ||
      provider.length === 0 ||
      (mode !== "oauth" && mode !== "token")
    ) {
      continue;
    }
    const normalized = normalizeProviderId(provider);
    if (!normalized) {
      continue;
    }
    if (apiKeys.has(normalized)) {
      continue;
    }
    out.add(normalized);
    if (mode === "oauth") {
      expectsOAuth.add(normalized);
    }
  }
  return { providers: Array.from(out), expectsOAuth };
}

export const modelsAuthStatusHandlers: GatewayRequestHandlers = {
  "models.authOrderSet": async ({ params, respond, context }) => {
    if (!validateModelsAuthOrderSetParams(params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid auth order"));
      return;
    }
    const provider = readProviderParam(params);
    const profileIds = Array.isArray(params.profileIds)
      ? normalizeUniqueTrimmedStringList(params.profileIds)
      : null;
    const expectedProfileIds = Array.isArray(params.expectedProfileIds)
      ? normalizeUniqueTrimmedStringList(params.expectedProfileIds)
      : params.expectedProfileIds === null
        ? null
        : undefined;
    const expectedProfileMembership = Array.isArray(params.expectedProfileMembership)
      ? normalizeUniqueTrimmedStringList(params.expectedProfileMembership)
      : undefined;
    if (!provider || (profileIds !== null && profileIds.length === 0)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid auth order"));
      return;
    }
    try {
      const runtimeConfig = context.getRuntimeConfig();
      const scope = resolveModelAuthAgentScope(runtimeConfig, params.agentId);
      if (!scope.ok) {
        respond(false, undefined, modelAuthAgentScopeError(scope));
        return;
      }
      const { prepared, authAliasLookupParams } = await readPreparedAuthMutationOwner(
        context,
        scope.agentId,
      );
      const cfg = prepared.config;
      const authProvider = resolveProviderIdForAuth(provider, authAliasLookupParams);
      const result = await updateModelAuthProfileOrder({
        agentDir: prepared.agentDir,
        agentId: prepared.agentId,
        authProvider,
        authAliasLookupParams,
        cfg,
        expectedProfileIds: Object.hasOwn(params, "expectedProfileIds")
          ? expectedProfileIds
          : undefined,
        expectedProfileMembership,
        profileIds,
        provider,
      });
      if (!result.ok) {
        const invalidProfiles = result.reason === "invalid-profiles";
        const message = invalidProfiles
          ? "profileIds contain unavailable auth profiles"
          : result.reason === "conflict"
            ? "profile order changed; refresh and retry"
            : "failed to update auth profile order";
        respond(
          false,
          undefined,
          errorShape(
            invalidProfiles ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
            message,
          ),
        );
        return;
      }
      invalidateModelAuthStatusCache();
      respond(true, { provider, profileIds }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "models.authCooldownClear": async ({ params, respond, context }) => {
    if (!validateModelsAuthCooldownClearParams(params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid cooldown clear"));
      return;
    }
    const provider = readProviderParam(params);
    const profileId = typeof params.profileId === "string" ? params.profileId.trim() : "";
    if (!provider || !profileId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "provider and profileId are required"),
      );
      return;
    }
    try {
      const runtimeConfig = context.getRuntimeConfig();
      const scope = resolveModelAuthAgentScope(runtimeConfig, params.agentId);
      if (!scope.ok) {
        respond(false, undefined, modelAuthAgentScopeError(scope));
        return;
      }
      const { prepared, authAliasLookupParams } = await readPreparedAuthMutationOwner(
        context,
        scope.agentId,
      );
      const store = ensureAuthProfileStoreWithoutExternalProfiles(prepared.agentDir);
      const credential = store.profiles[profileId];
      if (
        !credential ||
        resolveProviderIdForAuth(credential.provider, authAliasLookupParams) !==
          resolveProviderIdForAuth(provider, authAliasLookupParams)
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "profile is unavailable for this provider"),
        );
        return;
      }
      const cleared = clearAuthProfileCooldownAcrossOwnerStoresResult({
        store,
        profileId,
        agentDir: prepared.agentDir,
      });
      if (cleared.committed) {
        invalidateModelAuthStatusCache();
      }
      if (!cleared.ok) {
        throw new Error("Could not update account availability. Try again.");
      }
      respond(true, { provider, profileId }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "models.authLogout": async ({ params, respond, context }) => {
    const provider = readProviderParam(params);
    if (!provider) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "provider is required"));
      return;
    }
    const selection = readLogoutProfileSelection(params);
    if (!selection.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selection.message));
      return;
    }
    if (!validateModelsAuthLogoutParams(params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid auth logout"));
      return;
    }
    try {
      const runtimeConfig = context.getRuntimeConfig();
      const scope = resolveModelAuthAgentScope(runtimeConfig, params.agentId);
      if (!scope.ok) {
        respond(false, undefined, modelAuthAgentScopeError(scope));
        return;
      }
      const { prepared, authAliasLookupParams } = await readPreparedAuthMutationOwner(
        context,
        scope.agentId,
      );
      const cfg = prepared.config;
      const { agentDir } = prepared;
      const authProvider = resolveProviderIdForAuth(provider, authAliasLookupParams);
      const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
      const availableProfiles = listProfilesForProvider(store, authProvider, authAliasLookupParams);
      const removedProfiles = selection.profileIds ?? availableProfiles;
      if (
        selection.profileIds &&
        selection.profileIds.some((profileId) => {
          const profile = store.profiles[profileId];
          return (
            !availableProfiles.includes(profileId) ||
            (profile?.type !== "oauth" && profile?.type !== "token")
          );
        })
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "profileIds contain unavailable auth profiles"),
        );
        return;
      }
      const configBoundProfiles = selection.profileIds
        ? resolveConfigBoundProfiles(cfg, store, authAliasLookupParams)
        : null;
      if (
        selection.profileIds?.some((profileId) => configBoundProfiles?.profileIds.has(profileId))
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "profileIds contain config-bound auth profiles"),
        );
        return;
      }
      const removed = await runModelAuthProfileMutation(authProvider, async () =>
        selection.profileIds
          ? await removeAuthProfilesAcrossOwnerStoresResult({
              agentDir,
              profileIds: removedProfiles,
            })
          : removeProviderAuthProfilesAcrossOwnerStoresResult({
              provider: authProvider,
              agentDir,
              profileIds: removedProfiles,
              authAliasLookupParams,
            }),
      );
      if (removed.ok || removed.committed) {
        await refreshModelAuthAfterLogout(context);
      }
      if (!removed.ok) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `failed to remove saved auth profiles for provider ${provider}`,
          ),
        );
        return;
      }
      // A provider-wide abort would terminate runs using credentials this
      // logout preserved (other profiles, tokens, or the config API key). Abort
      // entries do not carry the profile id, so a targeted logout cannot scope
      // the abort and instead leaves in-flight runs to fail on their next
      // request; only a full-provider logout revokes everything and aborts.
      const { runIds: abortedRunIds } = selection.profileIds
        ? { runIds: [] as string[] }
        : abortChatRunsForProvider(createAuthLogoutAbortOps(context), {
            cfg,
            providerId: authProvider,
            agentId: prepared.agentId,
            stopReason: "auth-revoked",
          });
      const result: ModelAuthLogoutResult = {
        provider,
        removedProfiles,
        abortedRunIds,
      };
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "models.authStatus": async ({ params, respond, context }) => {
    const now = Date.now();
    const refreshRequested = Boolean(params.refresh);
    const resolveScope = (cfg: OpenClawConfig) =>
      resolveModelAuthAgentScope(
        cfg,
        params.agentId === undefined || params.agentId === ""
          ? tryResolveAmbientOwnerAgentId(cfg)
          : params.agentId,
      );
    try {
      let cfg = context.getRuntimeConfig();
      let scope = resolveScope(cfg);
      if (!scope.ok) {
        respond(false, undefined, modelAuthAgentScopeError(scope));
        return;
      }
      if (refreshRequested) {
        await refreshModelAuthStatusRuntimeState();
        cfg = context.getRuntimeConfig();
        scope = resolveScope(cfg);
        if (!scope.ok) {
          respond(false, undefined, modelAuthAgentScopeError(scope));
          return;
        }
      }
      const preparedSnapshot = refreshRequested
        ? await loadDeferredCatalog(context, scope.agentId, {
            readOnly: true,
            authScope: resolveAuthRefreshScope(cfg),
            refreshAuth: true,
          })
        : await readPreparedCatalog(context, scope.agentId);
      if (!preparedSnapshot) {
        throw new Error(`prepared model auth owner is unavailable (${scope.agentId})`);
      }
      cfg = preparedSnapshot.config;
      const { agentId, agentDir, authStore: store, workspaceDir } = preparedSnapshot;
      // Generic auth helpers may consult provider metadata indirectly. Carry this owner's exact
      // snapshot through them so a global miss cannot rediscover plugins on the event loop.
      const authAliasLookupParams: PreparedAuthMetadataLookupParams = {
        config: cfg,
        workspaceDir,
        metadataSnapshot: preparedSnapshot.metadataSnapshot,
        includeUntrustedWorkspacePlugins: false,
      };
      const apiKeys = resolveProviderApiKeys(cfg, store, authAliasLookupParams);
      const configured = resolveConfiguredProviders(cfg, apiKeys);
      const statusProviderIds = new Set(configured.providers);
      for (const provider of apiKeys.keys()) {
        statusProviderIds.add(provider);
      }
      for (const profile of Object.values(store.profiles)) {
        const provider = normalizeProviderId(profile.provider);
        if (provider) {
          statusProviderIds.add(provider);
        }
      }
      const authHealth: AuthHealthSummary = buildAuthHealthSummary({
        store,
        cfg,
        providers: statusProviderIds.size > 0 ? [...statusProviderIds] : undefined,
        allowKeychainPrompt: false,
        authAliasLookupParams,
      });

      const providerUsageRuntime = getProviderUsageRuntimeSnapshot({
        config: cfg,
        agentId,
        agentDir,
        store,
      });
      const registeredUsageProviders = new Set(providerUsageRuntime.providerIds);

      const profileUsageTargets = authHealth.profiles.flatMap((profile) => {
        if (profile.type !== "oauth" && profile.type !== "token") {
          return [];
        }
        const directProviderId = resolveUsageProviderId(profile.provider, {
          credentialType: profile.type,
        });
        const providerId =
          directProviderId && registeredUsageProviders.has(directProviderId)
            ? directProviderId
            : resolveUsageProviderId(
                resolveProviderIdForAuth(profile.provider, authAliasLookupParams),
                { credentialType: profile.type },
              );
        return providerId && registeredUsageProviders.has(providerId)
          ? [{ profileId: profile.profileId, providerId }]
          : [];
      });
      // Account quota is loaded by exact profile below. Provider-wide hooks
      // independently discover admin/API-key billing credentials, including
      // providers that have no model credential and therefore no auth row.
      const usageProviderIds = providerUsageRuntime.providerIds;
      const profileUsage = await loadProfileUsageStaleWhileRevalidate({
        agentId,
        agentDir,
        workspaceDir,
        authStore: providerUsageRuntime.store,
        configRef: cfg,
        forceRefresh: refreshRequested,
        targets: profileUsageTargets,
        now,
      });
      const usageByProfile = profileUsage.usageByProfile;
      const providerUsageRead = readProviderUsageStaleWhileRevalidate({
        agentId,
        agentDir,
        authStore: providerUsageRuntime.store,
        configRef: cfg,
        credentialKey: providerUsageRuntime.credentialKey,
        forceRefresh: refreshRequested,
        providerIds: usageProviderIds,
        providerWideAuthOnly: true,
        now,
      });
      const usageByProvider = providerUsageRead.usageByProvider;

      const externalProfileIds = new Set(store.runtimeExternalProfileIds ?? []);
      const externalCliProfileIds = new Set(getRuntimeExternalCliProfileIds(store));
      const logoutProfileIds = new Set(
        Object.entries(store.profiles)
          .filter(
            ([profileId, profile]) =>
              !externalProfileIds.has(profileId) &&
              (profile.type === "oauth" || profile.type === "token"),
          )
          .map(([profileId]) => profileId),
      );
      const configBoundProfiles = resolveConfigBoundProfiles(cfg, store, authAliasLookupParams);
      const localOrderProviders = getRuntimeLocalAuthProfileOrderProviders(store);
      const inheritedOrder = getRuntimeInheritedAuthProfileOrder(store);
      const providers = authHealth.providers.map((prov) =>
        mapModelAuthStatusProvider({
          provider: prov,
          config: cfg,
          authAliasLookupParams,
          usageByProfile,
          usageByProvider,
          expectsOAuth: configured.expectsOAuth,
          apiKeys,
          logoutProfileIds,
          configBoundProfileIds: configBoundProfiles.profileIds,
          configBoundProviders: configBoundProfiles.providers,
          externalCliProfileIds,
          ...(localOrderProviders ? { localOrderProviders } : {}),
          ...(inheritedOrder ? { inheritedOrder } : {}),
          store,
        }),
      );
      attachAliasProfileOrders(providers);
      const providerUsage = providerUsageRuntime.descriptors.flatMap((descriptor) => {
        const usage = usageByProvider.get(descriptor.provider);
        return usage
          ? [
              {
                ...mapModelAuthUsage(descriptor.provider, usage),
                displayName: descriptor.displayName,
              },
            ]
          : [];
      });
      const providerCapabilities = buildProviderCapabilities({
        config: cfg,
        workspaceDir,
        metadataSnapshot: preparedSnapshot.metadataSnapshot,
      });
      const result: ModelAuthStatusResult = {
        ts: now,
        providers,
        providerUsage,
        providerCapabilities,
        ...(profileUsage.refreshPending || providerUsageRead.refreshPending
          ? { usageRefreshPending: true }
          : {}),
      };
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};

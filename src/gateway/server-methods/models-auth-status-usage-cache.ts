// Stale-while-revalidate cache for models.authStatus provider usage enrichment.
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveProviderProfileUsageAuth } from "../../infra/provider-usage.auth.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.load.js";
import { PROVIDER_USAGE_TIMEOUT_MS, raceUsageTimeout } from "../../infra/provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageSummary,
} from "../../infra/provider-usage.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatForLog } from "../ws-log.js";
import {
  clearProviderUsageRuntimeSnapshot,
  getProviderUsageRuntimeSnapshot,
} from "./provider-usage-runtime.js";

const log = createSubsystemLogger("provider-usage-cache");
const USAGE_CACHE_TTL_MS = 60_000;

export type ProviderUsageStatus = Pick<
  ProviderUsageSnapshot,
  "windows" | "summary" | "plan" | "billing" | "accountEmail"
>;

type ProviderUsageCacheEntry = {
  agentDir: string;
  configRef: OpenClawConfig;
  credentialKey: string;
  providerKey: string;
  refreshedAt: number;
  summary: UsageSummary;
  usageByProvider: Map<string, ProviderUsageStatus>;
};

type ProviderUsageRefresh = {
  agentDir: string;
  configRef: OpenClawConfig;
  credentialKey: string;
  providerKey: string;
  promise: Promise<UsageSummary>;
};

const usageCacheByAgentId = new Map<string, ProviderUsageCacheEntry>();
const usageRefreshByAgentId = new Map<string, ProviderUsageRefresh>();
type ProfileUsageCacheEntry = {
  agentDir: string;
  workspaceDir: string;
  configRef: OpenClawConfig;
  credentialKey: string;
  profileKey: string;
  refreshedAt: number;
  usageByProfile: Map<string, ProviderUsageStatus>;
  refresh?: Promise<Map<string, ProviderUsageStatus>>;
};
const profileUsageCacheByAgentId = new Map<string, ProfileUsageCacheEntry>();
let cacheGeneration = 0;

export function clearModelAuthStatusUsageCache(): void {
  cacheGeneration += 1;
  usageCacheByAgentId.clear();
  usageRefreshByAgentId.clear();
  profileUsageCacheByAgentId.clear();
  clearProviderUsageRuntimeSnapshot();
}

export type ProfileUsageTarget = {
  profileId: string;
  providerId: UsageProviderId;
};

function profileUsageKey(targets: readonly ProfileUsageTarget[]): string {
  return targets
    .map(({ profileId, providerId }) => `${profileId}\0${providerId}`)
    .toSorted()
    .join("\0");
}

function snapshotUsage(snapshot: ProviderUsageSnapshot): ProviderUsageStatus {
  return {
    windows: snapshot.windows,
    ...(snapshot.summary ? { summary: snapshot.summary } : {}),
    ...(snapshot.plan ? { plan: snapshot.plan } : {}),
    ...(snapshot.billing?.length ? { billing: snapshot.billing } : {}),
    ...(snapshot.accountEmail ? { accountEmail: snapshot.accountEmail } : {}),
  };
}

/** Account-scoped quota snapshots; cold reads wait, warm reads refresh in the background. */
export async function loadProfileUsageStaleWhileRevalidate(params: {
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  authStore: AuthProfileStore;
  configRef: OpenClawConfig;
  credentialKey: string;
  forceRefresh?: boolean;
  targets: ProfileUsageTarget[];
  now: number;
}): Promise<Map<string, ProviderUsageStatus>> {
  if (params.targets.length === 0) {
    profileUsageCacheByAgentId.delete(params.agentId);
    return new Map();
  }
  const profileKey = profileUsageKey(params.targets);
  const cached = profileUsageCacheByAgentId.get(params.agentId);
  let entry =
    cached?.agentDir === params.agentDir &&
    cached.workspaceDir === params.workspaceDir &&
    cached.configRef === params.configRef &&
    cached.credentialKey === params.credentialKey &&
    cached.profileKey === profileKey
      ? cached
      : undefined;
  if (!entry) {
    entry = {
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      configRef: params.configRef,
      credentialKey: params.credentialKey,
      profileKey,
      refreshedAt: 0,
      usageByProfile: new Map(),
    };
    profileUsageCacheByAgentId.set(params.agentId, entry);
  }
  const needsRefresh =
    params.forceRefresh === true ||
    entry.refreshedAt === 0 ||
    params.now - entry.refreshedAt >= USAGE_CACHE_TTL_MS;
  if (!needsRefresh) {
    return entry.usageByProfile;
  }

  if (!entry.refresh) {
    const refresh = Promise.all(
      params.targets.map(async (target) => {
        try {
          const auth = await resolveProviderProfileUsageAuth({
            provider: target.providerId,
            profileId: target.profileId,
            store: params.authStore,
            agentDir: params.agentDir,
            config: params.configRef,
          });
          if (!auth) {
            return undefined;
          }
          const summary = await loadProviderUsageSummary({
            auth: [auth],
            agentDir: params.agentDir,
            authStore: params.authStore,
            config: params.configRef,
            workspaceDir: params.workspaceDir,
            timeoutMs: PROVIDER_USAGE_TIMEOUT_MS,
          });
          const snapshot = summary.providers[0];
          return snapshot ? ([target.profileId, snapshotUsage(snapshot)] as const) : undefined;
        } catch (error) {
          log.debug(
            `profile usage refresh failed: profile=${target.profileId} error=${formatForLog(error)}`,
          );
          return undefined;
        }
      }),
    ).then((entries) => {
      const usageByProfile = new Map(entry.usageByProfile);
      for (const result of entries) {
        if (result) {
          usageByProfile.set(...result);
        }
      }
      if (profileUsageCacheByAgentId.get(params.agentId) === entry) {
        entry.usageByProfile = usageByProfile;
        entry.refreshedAt = Date.now();
        entry.refresh = undefined;
      }
      return usageByProfile;
    });
    entry.refresh = refresh;
  }
  if (entry.refreshedAt > 0) {
    return entry.usageByProfile;
  }
  // Give fast account endpoints a chance to fill the first response without
  // letting quota telemetry hold credential management hostage.
  return await raceUsageTimeout(entry.refresh, 250, new Map());
}

function providerUsageCacheKey(providerIds: readonly UsageProviderId[]): string {
  return providerIds.toSorted().join("\0");
}

function scopeProviderUsageCredentialKey(
  credentialKey: string,
  providerIds: readonly UsageProviderId[],
): string {
  // models.authStatus fingerprints every direct provider. Scope that evidence to
  // this fetch set so usage.status can share the same credential-bound snapshot.
  try {
    // Produced only by fingerprintProviderUsageCredentials below, which always
    // stringifies an object with a `direct` array; a parse failure returns the input.
    // SAFETY: in-module producer guarantees this shape, and `direct` is re-checked.
    const parsed = JSON.parse(credentialKey) as {
      direct?: Array<[string, string | null]>;
      [key: string]: unknown;
    };
    if (!Array.isArray(parsed.direct)) {
      return credentialKey;
    }
    const providers = new Set(providerIds);
    return JSON.stringify({
      ...parsed,
      direct: parsed.direct.filter(
        ([provider, fingerprint]) => providers.has(provider) && fingerprint !== null,
      ),
    });
  } catch {
    return credentialKey;
  }
}

function mapProviderUsage(usage: Awaited<ReturnType<typeof loadProviderUsageSummary>>) {
  const usageByProvider = new Map<string, ProviderUsageStatus>();
  for (const snap of usage.providers) {
    usageByProvider.set(snap.provider, snapshotUsage(snap));
  }
  return usageByProvider;
}

function retainLastGoodOnTimeout(
  summary: UsageSummary,
  lastGood: UsageSummary | undefined,
): UsageSummary {
  if (!lastGood) {
    return summary;
  }
  const lastGoodByProvider = new Map(
    lastGood.providers
      .filter((provider) => provider.error === undefined)
      .map((provider) => [provider.provider, provider]),
  );
  const retainedLastGood = summary.providers.some(
    (provider) => provider.error === "Timeout" && lastGoodByProvider.has(provider.provider),
  );
  return {
    ...summary,
    updatedAt: retainedLastGood ? lastGood.updatedAt : summary.updatedAt,
    providers: summary.providers.map((provider) =>
      provider.error === "Timeout"
        ? (lastGoodByProvider.get(provider.provider) ?? provider)
        : provider,
    ),
  };
}

function scheduleProviderUsageRefresh(params: {
  agentId: string;
  agentDir: string;
  authStore?: AuthProfileStore;
  configRef: OpenClawConfig;
  credentialKey: string;
  providerIds: UsageProviderId[];
  providerKey: string;
  lastGood?: UsageSummary;
}): Promise<UsageSummary> {
  const active = usageRefreshByAgentId.get(params.agentId);
  if (
    active?.agentDir === params.agentDir &&
    active.configRef === params.configRef &&
    active.credentialKey === params.credentialKey &&
    active.providerKey === params.providerKey
  ) {
    return active.promise;
  }
  const publishGeneration = cacheGeneration;
  const promise = loadProviderUsageSummary({
    providers: params.providerIds,
    agentDir: params.agentDir,
    authStore: params.authStore,
    config: params.configRef,
    timeoutMs: PROVIDER_USAGE_TIMEOUT_MS,
  })
    .then((freshUsage) => {
      const usage = retainLastGoodOnTimeout(freshUsage, params.lastGood);
      if (
        publishGeneration === cacheGeneration &&
        usageRefreshByAgentId.get(params.agentId) === refresh
      ) {
        usageCacheByAgentId.set(params.agentId, {
          agentDir: params.agentDir,
          configRef: params.configRef,
          credentialKey: params.credentialKey,
          providerKey: params.providerKey,
          refreshedAt: Date.now(),
          summary: usage,
          usageByProvider: mapProviderUsage(usage),
        });
      }
      return usage;
    })
    .catch((err: unknown) => {
      // Usage is auxiliary and stale data remains valid. A failed refresh
      // publishes nothing, so a capable client keeps seeing the incomplete
      // marker and reports it once its retry budget is spent.
      log.debug(
        `usage refresh failed: providers=${params.providerIds.join(",")} error=${formatForLog(err)}`,
      );
      throw err;
    })
    .finally(() => {
      if (usageRefreshByAgentId.get(params.agentId) === refresh) {
        usageRefreshByAgentId.delete(params.agentId);
      }
    });
  const refresh: ProviderUsageRefresh = {
    agentDir: params.agentDir,
    configRef: params.configRef,
    credentialKey: params.credentialKey,
    providerKey: params.providerKey,
    promise,
  };
  usageRefreshByAgentId.set(params.agentId, refresh);
  return promise;
}

type ProviderUsageCacheParams = {
  agentId: string;
  agentDir: string;
  authStore?: AuthProfileStore;
  configRef: OpenClawConfig;
  credentialKey: string;
  coldRead?: "refresh-marker";
  forceRefresh?: boolean;
  providerIds: UsageProviderId[];
  now: number;
};

function resolveProviderUsageCacheRead(params: ProviderUsageCacheParams) {
  const providerIds = params.providerIds.toSorted();
  const providerKey = providerUsageCacheKey(providerIds);
  const credentialKey = scopeProviderUsageCredentialKey(params.credentialKey, providerIds);
  const cached = usageCacheByAgentId.get(params.agentId);
  const matching =
    cached?.agentDir === params.agentDir &&
    cached.configRef === params.configRef &&
    cached.credentialKey === credentialKey &&
    cached.providerKey === providerKey
      ? cached
      : undefined;
  const needsRefresh =
    params.forceRefresh === true ||
    !matching ||
    params.now - matching.refreshedAt >= USAGE_CACHE_TTL_MS;
  return { credentialKey, matching, needsRefresh, providerIds, providerKey };
}

export function readProviderUsageStaleWhileRevalidate(
  params: ProviderUsageCacheParams,
): Map<string, ProviderUsageStatus> {
  if (params.providerIds.length === 0) {
    usageCacheByAgentId.delete(params.agentId);
    return new Map();
  }
  const { credentialKey, matching, needsRefresh, providerIds, providerKey } =
    resolveProviderUsageCacheRead(params);
  if (needsRefresh) {
    // Never couple the RPC deadline to provider HTTP. A cold call returns auth
    // without usage; stale calls return the last snapshot while one refresh runs.
    void scheduleProviderUsageRefresh({
      agentId: params.agentId,
      agentDir: params.agentDir,
      authStore: params.authStore,
      configRef: params.configRef,
      credentialKey,
      providerIds,
      providerKey,
      lastGood: matching?.summary,
    }).catch(() => {});
  }
  return matching?.usageByProvider ?? new Map();
}

/** Returns cached provider usage while network refreshes run in the background for capable clients. */
async function loadProviderUsageSummaryStaleWhileRevalidate(
  params: ProviderUsageCacheParams,
): Promise<UsageSummary> {
  if (params.providerIds.length === 0) {
    usageCacheByAgentId.delete(params.agentId);
    return { updatedAt: params.now, providers: [] };
  }
  const { credentialKey, matching, needsRefresh, providerIds, providerKey } =
    resolveProviderUsageCacheRead(params);
  if (matching && !needsRefresh) {
    return matching.summary;
  }
  const refresh = scheduleProviderUsageRefresh({
    agentId: params.agentId,
    agentDir: params.agentDir,
    authStore: params.authStore,
    configRef: params.configRef,
    credentialKey,
    providerIds,
    providerKey,
    lastGood: matching?.summary,
  });
  if (matching) {
    void refresh.catch(() => {});
    return matching.summary;
  }
  if (params.coldRead !== "refresh-marker") {
    return await refresh;
  }
  void refresh.catch(() => {});
  return { updatedAt: params.now, providers: [], refreshing: true };
}

/** Shares the models.authStatus cache contract with the unscoped usage.status RPC. */
export async function loadUsageStatusStaleWhileRevalidate(params: {
  config: OpenClawConfig;
  coldRead?: "refresh-marker";
  now?: number;
}): Promise<UsageSummary> {
  const snapshot = getProviderUsageRuntimeSnapshot({ config: params.config });
  return await loadProviderUsageSummaryStaleWhileRevalidate({
    agentId: snapshot.agentId,
    agentDir: snapshot.agentDir,
    authStore: snapshot.store,
    configRef: snapshot.configRef,
    credentialKey: snapshot.credentialKey,
    providerIds: snapshot.providerIds,
    coldRead: params.coldRead,
    now: params.now ?? Date.now(),
  });
}

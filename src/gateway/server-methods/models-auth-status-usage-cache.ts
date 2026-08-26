// Stale-while-revalidate cache for models.authStatus provider usage enrichment.
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintAuthProfileOwnerShape,
} from "../../agents/execution-auth-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveProviderProfileUsageAuth } from "../../infra/provider-usage.auth.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.load.js";
import {
  PROVIDER_USAGE_TIMEOUT_MS,
  providerUsageLabel,
  raceUsageTimeout,
} from "../../infra/provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageSummary,
} from "../../infra/provider-usage.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { formatForLog } from "../ws-log.js";
import {
  clearProviderUsageRuntimeSnapshot,
  getProviderUsageRuntimeSnapshot,
} from "./provider-usage-runtime.js";

const log = createSubsystemLogger("provider-usage-cache");
const USAGE_CACHE_TTL_MS = 60_000;
const PROFILE_USAGE_REFRESH_CONCURRENCY = 3;

export type ProviderUsageStatus = Pick<
  ProviderUsageSnapshot,
  "windows" | "summary" | "plan" | "billing" | "costHistory" | "accountEmail" | "error"
> & { providerId: UsageProviderId };

type ProfileUsageCacheResult = {
  usageByProfile: Map<string, ProviderUsageStatus>;
  refreshPending: boolean;
};

type ProviderUsageCacheResult = {
  usageByProvider: Map<string, ProviderUsageStatus>;
  refreshPending: boolean;
};

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

type ProfileUsageTarget = {
  profileId: string;
  providerId: UsageProviderId;
};

function profileUsageKey(targets: readonly ProfileUsageTarget[]): string {
  return targets
    .map(({ profileId, providerId }) => `${profileId}\0${providerId}`)
    .toSorted()
    .join("\0");
}

function profileUsageCredentialKey(
  store: AuthProfileStore,
  targets: readonly ProfileUsageTarget[],
): string {
  return targets
    .map(({ profileId }) => {
      const credential = store.profiles[profileId];
      const fingerprint = credential
        ? fingerprintAuthProfileCredential({ profileId, credential })
        : undefined;
      return (
        fingerprint ??
        fingerprintAuthProfileOwnerShape({ profileId, credential }) ??
        `${profileId}:missing`
      );
    })
    .toSorted()
    .join("\0");
}

function snapshotUsage(
  providerId: UsageProviderId,
  snapshot: ProviderUsageSnapshot,
): ProviderUsageStatus {
  return {
    providerId,
    windows: snapshot.windows,
    ...(snapshot.summary ? { summary: snapshot.summary } : {}),
    ...(snapshot.plan ? { plan: snapshot.plan } : {}),
    ...(snapshot.billing?.length ? { billing: snapshot.billing } : {}),
    ...(snapshot.costHistory ? { costHistory: snapshot.costHistory } : {}),
    ...(snapshot.accountEmail ? { accountEmail: snapshot.accountEmail } : {}),
    ...(snapshot.error ? { error: snapshot.error } : {}),
  };
}

function retainLastGoodProfileUsage(
  fresh: ProviderUsageStatus,
  previous: ProviderUsageStatus | undefined,
): ProviderUsageStatus {
  return fresh.error === "Timeout" && previous && previous.error === undefined ? previous : fresh;
}

/** Account-scoped quota snapshots; cold reads wait, warm reads refresh in the background. */
export async function loadProfileUsageStaleWhileRevalidate(params: {
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  authStore: AuthProfileStore;
  configRef: OpenClawConfig;
  forceRefresh?: boolean;
  targets: ProfileUsageTarget[];
  now: number;
}): Promise<ProfileUsageCacheResult> {
  if (params.targets.length === 0) {
    profileUsageCacheByAgentId.delete(params.agentId);
    return { usageByProfile: new Map(), refreshPending: false };
  }
  const profileKey = profileUsageKey(params.targets);
  const credentialKey = profileUsageCredentialKey(params.authStore, params.targets);
  const cached = profileUsageCacheByAgentId.get(params.agentId);
  let entry =
    cached?.agentDir === params.agentDir &&
    cached.workspaceDir === params.workspaceDir &&
    cached.configRef === params.configRef &&
    cached.credentialKey === credentialKey &&
    cached.profileKey === profileKey
      ? cached
      : undefined;
  if (!entry) {
    entry = {
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      configRef: params.configRef,
      credentialKey,
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
    return { usageByProfile: entry.usageByProfile, refreshPending: Boolean(entry.refresh) };
  }

  if (!entry.refresh) {
    const previousUsageByProfile = entry.usageByProfile;
    // Warm refreshes publish atomically so readers keep the complete stale snapshot
    // until every account finishes. Cold refreshes still expose fast partial results.
    const refreshedUsageByProfile =
      entry.refreshedAt > 0 ? new Map(previousUsageByProfile) : previousUsageByProfile;
    const refresh = runTasksWithConcurrency({
      tasks: params.targets.map((target) => async () => {
        const previous = previousUsageByProfile.get(target.profileId);
        try {
          const auth = await resolveProviderProfileUsageAuth({
            provider: target.providerId,
            profileId: target.profileId,
            store: params.authStore,
            agentDir: params.agentDir,
            config: params.configRef,
          });
          if (!auth) {
            refreshedUsageByProfile.delete(target.profileId);
            return;
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
          if (snapshot) {
            refreshedUsageByProfile.set(
              target.profileId,
              retainLastGoodProfileUsage(snapshotUsage(target.providerId, snapshot), previous),
            );
          } else {
            refreshedUsageByProfile.delete(target.profileId);
          }
        } catch (error) {
          const message = formatForLog(error);
          refreshedUsageByProfile.set(
            target.profileId,
            retainLastGoodProfileUsage(
              {
                providerId: target.providerId,
                windows: [],
                error: message,
              },
              previous,
            ),
          );
          log.debug(`profile usage refresh failed: profile=${target.profileId} error=${message}`);
        }
      }),
      limit: PROFILE_USAGE_REFRESH_CONCURRENCY,
    }).then(() => {
      if (profileUsageCacheByAgentId.get(params.agentId) === entry) {
        entry.usageByProfile = refreshedUsageByProfile;
        entry.refreshedAt = Date.now();
        entry.refresh = undefined;
      }
      return refreshedUsageByProfile;
    });
    entry.refresh = refresh;
  }
  if (entry.refreshedAt > 0) {
    return { usageByProfile: entry.usageByProfile, refreshPending: true };
  }
  // Give fast account endpoints a chance to fill the first response without
  // letting quota telemetry hold credential management hostage.
  return await raceUsageTimeout(
    entry.refresh.then((usageByProfile) => ({ usageByProfile, refreshPending: false })),
    250,
    { usageByProfile: entry.usageByProfile, refreshPending: true },
  );
}

function providerUsageCacheKey(providerIds: readonly UsageProviderId[]): string {
  return providerIds.toSorted().join("\0");
}

function providerUsageOwnerKey(agentId: string, providerWideAuthOnly: boolean): string {
  return `${agentId}\0${providerWideAuthOnly ? "provider" : "all"}`;
}

function scopeProviderUsageCredentialKey(
  credentialKey: string,
  providerIds: readonly UsageProviderId[],
): string {
  // models.authStatus fingerprints every direct provider. Scope that evidence to
  // this fetch set so usage.status can share the same credential-bound snapshot.
  try {
    const parsed = asRecord(JSON.parse(credentialKey));
    if (!Array.isArray(parsed.direct)) {
      return credentialKey;
    }
    const providers = new Set<string>(providerIds);
    const direct = parsed.direct.flatMap((entry): Array<[string, string | null]> => {
      if (
        !Array.isArray(entry) ||
        typeof entry[0] !== "string" ||
        (entry[1] !== null && typeof entry[1] !== "string")
      ) {
        return [];
      }
      return [[entry[0], entry[1]]];
    });
    return JSON.stringify({
      ...parsed,
      direct: direct.filter(
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
    usageByProvider.set(snap.provider, snapshotUsage(snap.provider, snap));
  }
  return usageByProvider;
}

function providerUsageFailureSummary(
  providerIds: readonly UsageProviderId[],
  error: string,
): UsageSummary {
  return {
    updatedAt: Date.now(),
    providers: providerIds.map((provider) => ({
      provider,
      displayName: providerUsageLabel(provider) ?? provider,
      windows: [],
      error,
    })),
  };
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
  providerWideAuthOnly?: boolean;
  lastGood?: UsageSummary;
}): Promise<UsageSummary> {
  const ownerKey = providerUsageOwnerKey(params.agentId, params.providerWideAuthOnly === true);
  const active = usageRefreshByAgentId.get(ownerKey);
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
    providerWideAuthOnly: params.providerWideAuthOnly === true,
  })
    .then((freshUsage) => retainLastGoodOnTimeout(freshUsage, params.lastGood))
    .catch((err: unknown) => {
      // A failed auxiliary refresh must still settle the cache. Otherwise every
      // polling read is another cold miss and retries the provider indefinitely.
      const error = formatErrorMessage(err).trim() || "Fetch failed";
      log.debug(
        `usage refresh failed: providers=${params.providerIds.join(",")} error=${formatForLog(err)}`,
      );
      return params.lastGood ?? providerUsageFailureSummary(params.providerIds, error);
    })
    .then((usage) => {
      if (
        publishGeneration === cacheGeneration &&
        usageRefreshByAgentId.get(ownerKey) === refresh
      ) {
        usageCacheByAgentId.set(ownerKey, {
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
    .finally(() => {
      if (usageRefreshByAgentId.get(ownerKey) === refresh) {
        usageRefreshByAgentId.delete(ownerKey);
      }
    });
  const refresh: ProviderUsageRefresh = {
    agentDir: params.agentDir,
    configRef: params.configRef,
    credentialKey: params.credentialKey,
    providerKey: params.providerKey,
    promise,
  };
  usageRefreshByAgentId.set(ownerKey, refresh);
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
  providerWideAuthOnly?: boolean;
  now: number;
};

function resolveProviderUsageCacheRead(params: ProviderUsageCacheParams) {
  const providerIds = params.providerIds.toSorted();
  const providerWideAuthOnly = params.providerWideAuthOnly === true;
  const ownerKey = providerUsageOwnerKey(params.agentId, providerWideAuthOnly);
  const providerKey = providerUsageCacheKey(providerIds);
  const credentialKey = scopeProviderUsageCredentialKey(params.credentialKey, providerIds);
  const cached = usageCacheByAgentId.get(ownerKey);
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
): ProviderUsageCacheResult {
  if (params.providerIds.length === 0) {
    usageCacheByAgentId.delete(
      providerUsageOwnerKey(params.agentId, params.providerWideAuthOnly === true),
    );
    return { usageByProvider: new Map(), refreshPending: false };
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
      providerWideAuthOnly: params.providerWideAuthOnly,
      lastGood: matching?.summary,
    }).catch(() => {});
  }
  return {
    usageByProvider: matching?.usageByProvider ?? new Map(),
    refreshPending:
      needsRefresh ||
      usageRefreshByAgentId.has(
        providerUsageOwnerKey(params.agentId, params.providerWideAuthOnly === true),
      ),
  };
}

/** Returns cached provider usage while network refreshes run in the background for capable clients. */
async function loadProviderUsageSummaryStaleWhileRevalidate(
  params: ProviderUsageCacheParams,
): Promise<UsageSummary> {
  if (params.providerIds.length === 0) {
    usageCacheByAgentId.delete(
      providerUsageOwnerKey(params.agentId, params.providerWideAuthOnly === true),
    );
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
    providerWideAuthOnly: params.providerWideAuthOnly,
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

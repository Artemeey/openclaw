import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  type AuthProfileHealthStatus,
  type AuthProviderHealth,
  type AuthProviderHealthStatus,
  formatRemainingShort,
} from "../../agents/auth-health.js";
import { type AuthProfileStore, resolveAuthProfileMetadata } from "../../agents/auth-profiles.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { providerUsageLabel, resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import { resolveModelAuthProfileOrder } from "./models-auth-order.js";
import type { ProviderUsageStatus } from "./models-auth-status-usage-cache.js";
import type {
  ModelAuthExpiry,
  ModelAuthStatusProfile,
  ModelAuthStatusProvider,
  ModelAuthUsage,
} from "./models-auth-status.types.js";

type ModelAuthStatusRollup = {
  status: AuthProviderHealthStatus;
  expiresAt?: number;
  remainingMs?: number;
};

function buildExpiry(
  remainingMs: number | undefined,
  expiresAt: number | undefined,
): ModelAuthExpiry | undefined {
  const normalizedExpiresAt = asDateTimestampMs(expiresAt);
  if (normalizedExpiresAt === undefined || typeof remainingMs !== "number") {
    return undefined;
  }
  return { at: normalizedExpiresAt, remainingMs, label: formatRemainingShort(remainingMs) };
}

function providerDisplayName(provider: string): string {
  const usageId = resolveUsageProviderId(provider);
  return (usageId ? providerUsageLabel(usageId) : undefined) ?? provider;
}

function mapUsage(providerId: ModelAuthUsage["providerId"], usage: ProviderUsageStatus) {
  return {
    providerId,
    windows: usage.windows,
    ...(usage.summary ? { summary: usage.summary } : {}),
    ...(usage.plan ? { plan: usage.plan } : {}),
    ...(usage.billing?.length ? { billing: usage.billing } : {}),
    ...(usage.costHistory ? { costHistory: usage.costHistory } : {}),
    ...(usage.accountEmail ? { accountEmail: usage.accountEmail } : {}),
    ...(usage.error ? { error: usage.error } : {}),
  } satisfies ModelAuthUsage;
}

function aggregateProfileStatus(
  profiles: AuthProviderHealth["profiles"],
  now: number,
): ModelAuthStatusRollup {
  const statuses = new Set<AuthProfileHealthStatus>(profiles.map((profile) => profile.status));
  const status = (["expired", "missing", "expiring", "ok", "static"] as const).find((candidate) =>
    statuses.has(candidate),
  );
  const expirable = profiles
    .map((profile) => profile.expiresAt)
    .filter((value): value is number => asDateTimestampMs(value) !== undefined);
  const expiresAt = expirable.length > 0 ? Math.min(...expirable) : undefined;
  return {
    status: status ?? "static",
    expiresAt,
    remainingMs: expiresAt !== undefined ? expiresAt - now : undefined,
  };
}

/** Aggregate the effective refreshable credential status for the dashboard. */
export function aggregateRefreshableAuthStatus(
  provider: AuthProviderHealth,
  now: number = Date.now(),
  expectsOAuth = false,
): ModelAuthStatusRollup {
  const profiles = provider.effectiveProfiles ?? provider.profiles;
  const oauth = profiles.filter((profile) => profile.type === "oauth");
  if (oauth.length > 0) {
    return aggregateProfileStatus(oauth, now);
  }
  const tokens = profiles.filter((profile) => profile.type === "token");
  if (tokens.length > 0) {
    return aggregateProfileStatus(tokens, now);
  }
  if (expectsOAuth) {
    return { status: "missing" };
  }
  return {
    status: provider.status,
    expiresAt: provider.expiresAt,
    remainingMs: provider.remainingMs,
  };
}

export function mapModelAuthStatusProvider(params: {
  provider: AuthProviderHealth;
  config: OpenClawConfig;
  usageByProvider: Map<string, ProviderUsageStatus>;
  usageByProfile: Map<string, ProviderUsageStatus>;
  expectsOAuth: ReadonlySet<string>;
  apiKeys: ReadonlyMap<string, ModelAuthStatusProvider["apiKey"]>;
  logoutProfileIds: ReadonlySet<string>;
  configBoundProfileIds: ReadonlySet<string>;
  externalCliProfileIds: ReadonlySet<string>;
  store: AuthProfileStore;
}): ModelAuthStatusProvider {
  const { provider, config, store } = params;
  const usageProfile =
    provider.profiles.find((profile) => profile.type === "oauth" || profile.type === "token") ??
    provider.profiles.find((profile) => profile.type === "api_key");
  const usageKey = resolveUsageProviderId(provider.provider, {
    credentialType: usageProfile?.type,
  });
  const usage = usageKey
    ? (params.usageByProvider.get(usageKey) ??
      (usageProfile ? params.usageByProfile.get(usageProfile.profileId) : undefined))
    : undefined;
  const rawRollup = aggregateRefreshableAuthStatus(
    provider,
    Date.now(),
    params.expectsOAuth.has(provider.provider),
  );
  const effectiveProfiles = provider.effectiveProfiles ?? provider.profiles;
  const refreshableProfiles = effectiveProfiles.filter(
    (profile) => profile.type === "oauth" || profile.type === "token",
  );
  // External CLI access tokens rotate without operator action. Keep their raw
  // profile expiry diagnostic, but do not turn it into a provider login warning.
  const externalCliOwnsOAuthRefresh =
    refreshableProfiles.length > 0 &&
    refreshableProfiles.every(
      (profile) => profile.type === "oauth" && params.externalCliProfileIds.has(profile.profileId),
    );
  const rollup: ModelAuthStatusRollup =
    externalCliOwnsOAuthRefresh &&
    (rawRollup.status === "expired" || rawRollup.status === "expiring")
      ? { status: "ok" }
      : rawRollup;
  const apiKey = params.apiKeys.get(normalizeProviderId(provider.provider));
  const hasRefreshableProfile = provider.profiles.some(
    (profile) => profile.type === "oauth" || profile.type === "token",
  );
  const authProvider = resolveProviderIdForAuth(provider.provider, { config });
  const { effective: profileOrder } = resolveModelAuthProfileOrder(
    config,
    store,
    provider.provider,
    authProvider,
  );
  return {
    provider: provider.provider,
    authProvider,
    displayName: providerDisplayName(provider.provider),
    status:
      apiKey && !hasRefreshableProfile && rollup.status === "missing" ? "static" : rollup.status,
    expiry: buildExpiry(rollup.remainingMs, rollup.expiresAt),
    profiles: provider.profiles.map((profile) => {
      const metadata = resolveAuthProfileMetadata({
        cfg: config,
        store,
        profileId: profile.profileId,
      });
      const usageStats = store.usageStats?.[profile.profileId];
      const statusProfile: ModelAuthStatusProfile = {
        profileId: profile.profileId,
        type: profile.type,
        status: profile.status,
        reasonCode: profile.reasonCode,
        expiry: buildExpiry(profile.remainingMs, profile.expiresAt),
      };
      if (metadata.displayName) {
        statusProfile.displayName = metadata.displayName;
      }
      if (metadata.email) {
        statusProfile.email = metadata.email;
      }
      if (usageStats?.lastUsed) {
        statusProfile.lastUsedAt = usageStats.lastUsed;
      }
      if (usageStats?.cooldownUntil) {
        statusProfile.cooldownUntil = usageStats.cooldownUntil;
        statusProfile.cooldownReason = usageStats.cooldownReason;
      }
      if (usageStats?.disabledUntil) {
        statusProfile.disabledUntil = usageStats.disabledUntil;
        statusProfile.disabledReason = usageStats.disabledReason;
      }
      if (usageStats?.blockedUntil) {
        statusProfile.blockedUntil = usageStats.blockedUntil;
        statusProfile.blockedReason = usageStats.blockedReason;
      }
      const profileUsage = params.usageByProfile.get(profile.profileId);
      const profileUsageProvider = resolveUsageProviderId(profile.provider, {
        credentialType: profile.type,
      });
      if (profileUsage && profileUsageProvider) {
        statusProfile.usage = mapUsage(profileUsageProvider, profileUsage);
      }
      if (
        (profile.type === "oauth" || profile.type === "token") &&
        params.logoutProfileIds.has(profile.profileId) &&
        !params.configBoundProfileIds.has(profile.profileId)
      ) {
        statusProfile.logoutSupported = true;
      }
      return statusProfile;
    }),
    ...(profileOrder !== undefined ? { profileOrder } : {}),
    ...(apiKey ? { apiKey } : {}),
    usage: usage && usageKey ? mapUsage(usageKey, usage) : undefined,
  };
}

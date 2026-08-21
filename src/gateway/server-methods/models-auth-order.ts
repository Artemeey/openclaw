import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  ensureAuthProfileStore,
  externalCliDiscoveryForConfigStatus,
  setAuthProfileOrder,
  type AuthProfileStore,
} from "../../agents/auth-profiles.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";

const modelAuthMutationQueue = new KeyedAsyncQueue();

export function runModelAuthProfileMutation<T>(
  authProvider: string,
  mutation: () => Promise<T>,
): Promise<T> {
  return modelAuthMutationQueue.enqueue(authProvider, mutation);
}

type ModelAuthProfileOrder = {
  configured: string[] | undefined;
  effective: string[] | undefined;
  expectedMatches?: boolean;
  stored: string[] | undefined;
  orderProvider: string;
};

function resolveOrderForProvider(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
  orderProvider: string,
  authProvider: string,
): ModelAuthProfileOrder {
  const stored = findNormalizedProviderValue(store.order, orderProvider);
  const configured = findNormalizedProviderValue(cfg.auth?.order, orderProvider);
  const raw = stored ?? configured;
  const effective = raw
    ? uniqueStrings(
        raw.filter((profileId) => {
          const credential = store.profiles[profileId];
          return (
            credential !== undefined &&
            resolveProviderIdForAuth(credential.provider, { config: cfg }) === authProvider
          );
        }),
      )
    : raw;
  const repairedEffective =
    stored !== undefined &&
    stored.length > 0 &&
    effective?.length === 0 &&
    stored.every((profileId) => store.profiles[profileId] === undefined)
      ? undefined
      : effective;
  return { configured, effective: repairedEffective, stored, orderProvider };
}

function listModelAuthOrderProviders(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
  provider: string,
  authProvider: string,
): string[] {
  return uniqueStrings([
    authProvider,
    provider,
    ...Object.keys(store.order ?? {}),
    ...Object.keys(cfg.auth?.order ?? {}),
  ])
    .filter((candidate) => resolveProviderIdForAuth(candidate, { config: cfg }) === authProvider)
    .toSorted((left, right) => {
      const rank = (candidate: string) =>
        candidate === authProvider ? 0 : candidate === provider ? 1 : 2;
      return rank(left) - rank(right) || left.localeCompare(right);
    });
}

export function resolveModelAuthProfileOrder(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
  provider: string,
  authProvider: string,
): ModelAuthProfileOrder {
  const canonical = resolveOrderForProvider(cfg, store, authProvider, authProvider);
  if (canonical.stored !== undefined || provider === authProvider) {
    return canonical;
  }
  const alias = resolveOrderForProvider(cfg, store, provider, authProvider);
  if (alias.stored !== undefined) {
    return alias;
  }
  return canonical.configured !== undefined ? canonical : alias;
}

function resolveModelAuthProfileOrderMutationBaseline(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
  provider: string,
  authProvider: string,
  expected: readonly string[] | null | undefined,
): ModelAuthProfileOrder {
  if (expected === undefined) {
    return {
      ...resolveModelAuthProfileOrder(cfg, store, provider, authProvider),
      expectedMatches: true,
    };
  }
  const authoritative = resolveModelAuthProfileOrder(cfg, store, provider, authProvider);
  if (modelAuthProfileOrdersEqual(expected, authoritative.effective)) {
    return { ...authoritative, expectedMatches: true };
  }
  // Canonical persisted state supersedes aliases. Falling back after a mismatch
  // would let an older alias overwrite a concurrent canonical save.
  if (authoritative.orderProvider === authProvider && authoritative.stored !== undefined) {
    return { ...authoritative, expectedMatches: false };
  }
  for (const candidate of listModelAuthOrderProviders(cfg, store, provider, authProvider)) {
    const order = resolveOrderForProvider(cfg, store, candidate, authProvider);
    if (modelAuthProfileOrdersEqual(expected, order.effective)) {
      return { ...order, expectedMatches: true };
    }
  }
  return {
    ...resolveOrderForProvider(cfg, store, authProvider, authProvider),
    expectedMatches: false,
  };
}

function listModelAuthProfileIds(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
  authProvider: string,
  persistedOnly: boolean,
): string[] {
  const externalProfileIds = new Set(store.runtimeExternalProfileIds ?? []);
  return Object.entries(store.profiles)
    .flatMap(([profileId, credential]) =>
      (!persistedOnly || !externalProfileIds.has(profileId)) &&
      resolveProviderIdForAuth(credential.provider, { config: cfg }) === authProvider
        ? [profileId]
        : [],
    )
    .toSorted();
}

export async function updateModelAuthProfileOrder(params: {
  agentDir: string;
  agentId: string;
  authProvider: string;
  cfg: OpenClawConfig;
  expectedProfileIds: string[] | null | undefined;
  expectedProfileMembership: string[] | undefined;
  profileIds: string[];
  provider: string;
}): Promise<{ ok: true } | { ok: false; reason: "invalid-profiles" | "conflict" | "store" }> {
  return runModelAuthProfileMutation(params.authProvider, async () => {
    const externalCli = externalCliDiscoveryForConfigStatus({ cfg: params.cfg });
    const store = ensureAuthProfileStore(params.agentDir, {
      externalCli,
    });
    if (
      params.expectedProfileMembership &&
      !modelAuthProfileMembershipsEqual(
        params.expectedProfileMembership,
        listModelAuthProfileIds(params.cfg, store, params.authProvider, false),
      )
    ) {
      return { ok: false, reason: "conflict" };
    }
    const valid = params.profileIds.every((profileId) => {
      const credential = store.profiles[profileId];
      return (
        credential !== undefined &&
        resolveProviderIdForAuth(credential.provider, { config: params.cfg }) ===
          params.authProvider
      );
    });
    if (!valid) {
      return { ok: false, reason: "invalid-profiles" };
    }
    const orderState = resolveModelAuthProfileOrderMutationBaseline(
      params.cfg,
      store,
      params.provider,
      params.authProvider,
      params.expectedProfileIds,
    );
    if (!orderState.expectedMatches) {
      return { ok: false, reason: "conflict" };
    }
    const expectedProfileIdsProvided = params.expectedProfileIds !== undefined;
    const updated = await setAuthProfileOrder({
      agentDir: params.agentDir,
      provider: params.authProvider,
      order: params.profileIds,
      authAliasLookupParams: { config: params.cfg },
      expectedProviderProfileIds: listModelAuthProfileIds(
        params.cfg,
        store,
        params.authProvider,
        false,
      ),
      externalCli,
      ...(expectedProfileIdsProvided
        ? {
            expectedOrder: orderState.stored ?? null,
            expectedOrderProvider: orderState.orderProvider,
          }
        : {}),
    });
    return updated.ok
      ? { ok: true }
      : { ok: false, reason: updated.error === "conflict" ? "conflict" : "store" };
  });
}

function modelAuthProfileMembershipsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = uniqueStrings(left).toSorted();
  const normalizedRight = uniqueStrings(right).toSorted();
  return modelAuthProfileOrdersEqual(normalizedLeft, normalizedRight);
}

function modelAuthProfileOrdersEqual(
  left: readonly string[] | null | undefined,
  right: readonly string[] | null | undefined,
): boolean {
  const normalizedLeft = left ?? null;
  const normalizedRight = right ?? null;
  return (
    normalizedLeft === normalizedRight ||
    (normalizedLeft !== null &&
      normalizedRight !== null &&
      normalizedLeft.length === normalizedRight.length &&
      normalizedLeft.every((profileId, index) => profileId === normalizedRight[index]))
  );
}

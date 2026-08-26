import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  ensureAuthProfileStore,
  externalCliDiscoveryForConfigStatus,
  setAuthProfileOrder,
  type AuthProfileStore,
} from "../../agents/auth-profiles.js";
import {
  type ProviderAuthAliasLookupParams,
  resolveProviderIdForAuth,
} from "../../agents/provider-auth-aliases.js";
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
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
  source: "effective" | "configured" = "effective",
): ModelAuthProfileOrder {
  const stored =
    source === "effective" ? findNormalizedProviderValue(store.order, orderProvider) : undefined;
  const configured = findNormalizedProviderValue(cfg.auth?.order, orderProvider);
  const raw = stored ?? configured;
  const effective = raw
    ? uniqueStrings(
        raw.filter((profileId) => {
          const credential = store.profiles[profileId];
          return (
            credential !== undefined &&
            resolveProviderIdForAuth(
              credential.provider,
              authAliasLookupParams ?? { config: cfg },
            ) === authProvider
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

function listModelAuthOrderProviders(provider: string, authProvider: string): string[] {
  // Match runtime selection exactly: canonical auth owner first, then only the
  // requested provider route. A sibling alias can have a different valid order.
  return uniqueStrings([authProvider, provider]);
}

export function resolveModelAuthProfileOrder(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
  provider: string,
  authProvider: string,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): ModelAuthProfileOrder {
  const configured = listModelAuthOrderProviders(provider, authProvider)
    .map((orderProvider) =>
      resolveOrderForProvider(
        cfg,
        store,
        orderProvider,
        authProvider,
        authAliasLookupParams,
        "configured",
      ),
    )
    .find((order) => order.configured !== undefined);
  const canonical = resolveOrderForProvider(
    cfg,
    store,
    authProvider,
    authProvider,
    authAliasLookupParams,
  );
  if (canonical.stored !== undefined) {
    return { ...canonical, configured: configured?.configured };
  }
  const alias =
    provider === authProvider
      ? canonical
      : resolveOrderForProvider(cfg, store, provider, authProvider, authAliasLookupParams);
  if (provider !== authProvider && alias.stored !== undefined) {
    return { ...alias, configured: configured?.configured };
  }
  return configured ?? alias;
}

function resolveModelAuthProfileOrderMutationBaseline(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
  provider: string,
  authProvider: string,
  expected: readonly string[] | null | undefined,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): ModelAuthProfileOrder {
  if (expected === undefined) {
    return {
      ...resolveModelAuthProfileOrder(cfg, store, provider, authProvider, authAliasLookupParams),
      expectedMatches: true,
    };
  }
  const authoritative = resolveModelAuthProfileOrder(
    cfg,
    store,
    provider,
    authProvider,
    authAliasLookupParams,
  );
  if (modelAuthProfileOrdersEqual(expected, authoritative.effective)) {
    return { ...authoritative, expectedMatches: true };
  }
  // Canonical persisted state supersedes aliases. Falling back after a mismatch
  // would let an older alias overwrite a concurrent canonical save.
  if (authoritative.orderProvider === authProvider && authoritative.stored !== undefined) {
    return { ...authoritative, expectedMatches: false };
  }
  for (const candidate of listModelAuthOrderProviders(provider, authProvider)) {
    const order = resolveOrderForProvider(
      cfg,
      store,
      candidate,
      authProvider,
      authAliasLookupParams,
    );
    if (modelAuthProfileOrdersEqual(expected, order.effective)) {
      return { ...order, expectedMatches: true };
    }
  }
  return {
    ...resolveOrderForProvider(cfg, store, authProvider, authProvider, authAliasLookupParams),
    expectedMatches: false,
  };
}

function listModelAuthProfileIds(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
  authProvider: string,
  persistedOnly: boolean,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): string[] {
  const externalProfileIds = new Set(store.runtimeExternalProfileIds ?? []);
  return Object.entries(store.profiles)
    .flatMap(([profileId, credential]) =>
      (!persistedOnly || !externalProfileIds.has(profileId)) &&
      resolveProviderIdForAuth(credential.provider, authAliasLookupParams ?? { config: cfg }) ===
        authProvider
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
  profileIds: string[] | null;
  provider: string;
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
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
        listModelAuthProfileIds(
          params.cfg,
          store,
          params.authProvider,
          false,
          params.authAliasLookupParams,
        ),
      )
    ) {
      return { ok: false, reason: "conflict" };
    }
    const valid =
      params.profileIds === null ||
      params.profileIds.every((profileId) => {
        const credential = store.profiles[profileId];
        return (
          credential !== undefined &&
          resolveProviderIdForAuth(
            credential.provider,
            params.authAliasLookupParams ?? { config: params.cfg },
          ) === params.authProvider
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
      params.authAliasLookupParams,
    );
    if (!orderState.expectedMatches) {
      return { ok: false, reason: "conflict" };
    }
    const expectedProfileIdsProvided = params.expectedProfileIds !== undefined;
    const updated = await setAuthProfileOrder({
      agentDir: params.agentDir,
      provider: params.authProvider,
      order: params.profileIds,
      authAliasLookupParams: params.authAliasLookupParams ?? { config: params.cfg },
      expectedProviderProfileIds: listModelAuthProfileIds(
        params.cfg,
        store,
        params.authProvider,
        false,
        params.authAliasLookupParams,
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

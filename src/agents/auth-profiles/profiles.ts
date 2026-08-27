/**
 * Auth profile mutation helpers.
 * Updates profile order, last-good state, usage stats, and provider profile
 * records through locked or immediate store writes.
 */
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { Result } from "@openclaw/normalization-core/result";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  type ProviderAuthAliasLookupParams,
  resolveProviderIdForAuth,
} from "../provider-auth-aliases.js";
import { normalizeAuthProfileCredential } from "./credential-normalize.js";
import type { ExternalCliAuthDiscovery } from "./external-cli-discovery.js";
import { dedupeProfileIds, listProfilesForProvider } from "./profile-list.js";
import {
  getRuntimeExternalCliProfileIds,
  getRuntimeLocalProfileIds,
  removeRuntimeExternalProfileReferences,
  setRuntimeExternalCliProfileIds,
  setRuntimeLocalProfileIds,
} from "./runtime-external-profile-references.js";
import { notifyRuntimeAuthProfileSelectionMutation } from "./runtime-snapshots.js";
import {
  ensureAuthProfileStoreForLocalUpdate,
  resolvePersistedAuthProfileOwnerAgentDirs,
  saveAuthProfileStore,
  type AuthProfileStoresUpdateResult,
  updateAuthProfileStoresWithLocks,
  updateAuthProfileStoreWithLock,
} from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
import { resetAuthProfileFailureState } from "./usage-state.js";
import { clearAuthProfileCooldownFromStore } from "./usage.js";
export {
  dedupeProfileIds,
  listProfilesForProvider,
  resolveSubscriptionAuthModeForProfiles,
} from "./profile-list.js";
export {
  upsertAuthProfileAfterLoginWithLockOrThrow,
  upsertAuthProfileWithLock,
  upsertAuthProfileWithLockOrThrow,
} from "./upsert-with-lock.js";

const authProfileProfilesLog = createSubsystemLogger("agent/embedded");

function listProviderAuthStateEntries<T>(
  entries: Record<string, T> | undefined,
  provider: string,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): Array<[string, T]> {
  const canonicalProvider = resolveProviderIdForAuth(provider, authAliasLookupParams);
  return Object.entries(entries ?? {})
    .filter(([key]) => resolveProviderIdForAuth(key, authAliasLookupParams) === canonicalProvider)
    .toSorted(([left], [right]) => left.localeCompare(right));
}

export function resolveProviderAuthStateEntry<T>(
  entries: Record<string, T> | undefined,
  provider: string,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): { provider: string; value: T } | undefined {
  const canonicalProvider = resolveProviderIdForAuth(provider, authAliasLookupParams);
  const matches = listProviderAuthStateEntries(entries, canonicalProvider, authAliasLookupParams);
  const match =
    matches.find(([key]) => normalizeProviderId(key) === canonicalProvider) ?? matches[0];
  return match ? { provider: match[0], value: match[1] } : undefined;
}

function readProviderAuthState<T>(
  entries: Record<string, T> | undefined,
  provider: string,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): T | undefined {
  return resolveProviderAuthStateEntry(entries, provider, authAliasLookupParams)?.value;
}

function replaceProviderAuthState<T>(
  entries: Record<string, T> | undefined,
  provider: string,
  value?: T,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): Record<string, T> | undefined {
  const canonicalProvider = resolveProviderIdForAuth(provider, authAliasLookupParams);
  const next = Object.fromEntries(
    Object.entries(entries ?? {}).filter(
      ([key]) => resolveProviderIdForAuth(key, authAliasLookupParams) !== canonicalProvider,
    ),
  );
  if (value !== undefined) {
    next[canonicalProvider] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function readExactProviderAuthState<T>(
  entries: Record<string, T> | undefined,
  provider: string,
): T | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  return Object.entries(entries ?? {}).find(
    ([key]) => normalizeProviderId(key) === normalizedProvider,
  )?.[1];
}

function removeExactProviderAuthState<T>(
  entries: Record<string, T> | undefined,
  provider: string,
): Record<string, T> | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  const next = Object.fromEntries(
    Object.entries(entries ?? {}).filter(
      ([key]) => normalizeProviderId(key) !== normalizedProvider,
    ),
  );
  return Object.keys(next).length > 0 ? next : undefined;
}
function updateSuccessfulUsageStatsEntry(
  store: AuthProfileStore,
  profileId: string,
  lastUsed: number,
): void {
  store.usageStats = store.usageStats ?? {};
  store.usageStats[profileId] = resetAuthProfileFailureState(store.usageStats[profileId] ?? {}, {
    lastUsed,
  });
}

/** Sets or clears explicit auth profile order for a provider. */
export async function setAuthProfileOrder(params: {
  agentDir?: string;
  provider: string;
  order?: string[] | null;
  expectedOrder?: string[] | null;
  expectedOrderProvider?: string;
  expectedProviderProfileIds?: string[];
  externalCli?: ExternalCliAuthDiscovery;
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
}): Promise<Result<AuthProfileStore, "conflict" | "store-update-failed">> {
  const providerKey = resolveProviderIdForAuth(params.provider, params.authAliasLookupParams);
  const expectedOrderProviderKey = normalizeProviderId(
    params.expectedOrderProvider ?? params.provider,
  );
  const expectedOrderProviderProvided = Object.hasOwn(params, "expectedOrderProvider");
  const expectedOrderUsesCanonicalProvider = expectedOrderProviderKey === providerKey;
  const sanitized =
    params.order && Array.isArray(params.order) ? normalizeStringEntries(params.order) : [];
  const deduped = dedupeProfileIds(sanitized);
  const expectedOrderProvided = Object.hasOwn(params, "expectedOrder");
  const expectedOrder =
    params.expectedOrder === null
      ? null
      : dedupeProfileIds(normalizeStringEntries(params.expectedOrder));
  const expectedProviderProfileIds = params.expectedProviderProfileIds
    ? dedupeProfileIds(normalizeStringEntries(params.expectedProviderProfileIds)).toSorted()
    : undefined;
  let orderChanged = false;
  let profileMembershipChanged = false;

  const updated = await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    lockInheritedProfileMembership: expectedProviderProfileIds !== undefined,
    effectiveExternalCli: params.externalCli,
    // Preserve requested IDs that the agent inherits (not owns) so the local
    // save path does not prune them from the order. Without this, a secondary
    // agent's `models auth order set --agent` accepts an inherited profile ID
    // (validated against the merged store) but drops it while persisting, so
    // `order get` falls back to the inherited main order — the CLI reports a
    // switch that never happened (issue #119233). Mirrors the adjacent
    // promoteAuthProfileInOrder preservation contract; the clear-order path
    // (deduped.length === 0) must not preserve anything.
    ...(deduped.length > 0 ? { saveOptions: { preserveOrderProfileIds: deduped } } : {}),
    updater: (store, effectiveStore = store) => {
      if (expectedProviderProfileIds) {
        const currentProviderProfileIds = listProfilesForProvider(
          effectiveStore,
          providerKey,
          params.authAliasLookupParams,
        ).toSorted();
        const exactMembershipChanged =
          currentProviderProfileIds.length !== expectedProviderProfileIds.length ||
          currentProviderProfileIds.some(
            (profileId, index) => profileId !== expectedProviderProfileIds[index],
          );
        // The membership check shares the credential-store lock with the order
        // write. Otherwise a stale reorder can exclude a new login or restore a
        // profile removed while the request was in flight.
        if (exactMembershipChanged) {
          profileMembershipChanged = true;
          return false;
        }
      }
      // An explicit provider names the exact key the caller observed. When it
      // is omitted, preserve the normal alias-aware provider lookup.
      const readExpectedOrder = (candidate: AuthProfileStore) =>
        (expectedOrderProviderProvided
          ? readExactProviderAuthState(candidate.order, expectedOrderProviderKey)
          : readProviderAuthState(candidate.order, providerKey, params.authAliasLookupParams)) ??
        null;
      const localOrder = readExpectedOrder(store);
      const currentOrder = localOrder ?? readExpectedOrder(effectiveStore);
      const canonicalOrderAppeared =
        expectedOrderProvided &&
        !expectedOrderUsesCanonicalProvider &&
        (readExactProviderAuthState(store.order, providerKey) !== undefined ||
          readExactProviderAuthState(effectiveStore.order, providerKey) !== undefined);
      // Compare beneath the same store lock as the write. Otherwise a login
      // promotion can be overwritten by an order built from an older snapshot.
      if (
        canonicalOrderAppeared ||
        (expectedOrderProvided &&
          (currentOrder === null || expectedOrder === null
            ? currentOrder !== expectedOrder
            : currentOrder.length !== expectedOrder.length ||
              currentOrder.some((profileId, index) => profileId !== expectedOrder[index])))
      ) {
        orderChanged = true;
        return false;
      }
      if (deduped.length === 0) {
        if (
          listProviderAuthStateEntries(store.order, providerKey, params.authAliasLookupParams)
            .length === 0
        ) {
          return false;
        }
        store.order = replaceProviderAuthState(
          store.order,
          providerKey,
          undefined,
          params.authAliasLookupParams,
        );
        return true;
      }
      if (!expectedOrderUsesCanonicalProvider) {
        store.order = removeExactProviderAuthState(store.order, expectedOrderProviderKey);
      }
      store.order = replaceProviderAuthState(
        store.order,
        providerKey,
        deduped,
        params.authAliasLookupParams,
      );
      return true;
    },
  });
  if (orderChanged || profileMembershipChanged) {
    return { ok: false, error: "conflict" };
  }
  return updated ? { ok: true, value: updated } : { ok: false, error: "store-update-failed" };
}

/** Promotes one auth profile to the front of a provider order. */
export async function promoteAuthProfileInOrder(params: {
  agentDir?: string;
  provider: string;
  profileId: string;
  createIfMissing?: boolean;
  createFromOrder?: string[];
}): Promise<AuthProfileStore | null> {
  const providerKey = resolveProviderIdForAuth(params.provider);
  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    ...(params.createFromOrder
      ? { saveOptions: { preserveOrderProfileIds: params.createFromOrder } }
      : {}),
    updater: (store) => {
      const profile = store.profiles[params.profileId];
      if (!profile || resolveProviderIdForAuth(profile.provider) !== providerKey) {
        return false;
      }
      const matchingOrderEntries = listProviderAuthStateEntries(store.order, providerKey);
      const existing = readProviderAuthState(store.order, providerKey);
      if (!existing || existing.length === 0) {
        if (!params.createIfMissing) {
          return false;
        }
        const providerProfiles = dedupeProfileIds(
          params.createFromOrder !== undefined
            ? params.createFromOrder
            : listProfilesForProvider(store, providerKey),
        );
        const next = dedupeProfileIds([
          params.profileId,
          ...providerProfiles.filter((profileId) => profileId !== params.profileId),
        ]);
        store.order = replaceProviderAuthState(store.order, providerKey, next);
        return true;
      }
      const next = dedupeProfileIds([
        params.profileId,
        ...existing.filter((profileId) => profileId !== params.profileId),
      ]);
      if (
        next.length === existing.length &&
        next.every((profileId, idx) => profileId === existing[idx]) &&
        matchingOrderEntries.length === 1 &&
        matchingOrderEntries[0]?.[0] === providerKey
      ) {
        return false;
      }
      store.order = replaceProviderAuthState(store.order, providerKey, next);
      return true;
    },
  });
}

/** Upserts an auth profile immediately into the local store. */
export function upsertAuthProfile(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): void {
  const credential = normalizeAuthProfileCredential(params.credential);
  const store = ensureAuthProfileStoreForLocalUpdate(params.agentDir);
  store.profiles[params.profileId] = credential;
  saveAuthProfileStore(store, params.agentDir, {
    filterExternalAuthProfiles: false,
    sharedStoreWrite: true,
    syncExternalCli: false,
  });
}

/** Removes all auth profiles and related state for a provider. */
function removeProviderAuthProfilesFromStore(
  store: AuthProfileStore,
  provider: string,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): boolean {
  const providerKey = resolveProviderIdForAuth(provider, authAliasLookupParams);
  const profileIds = listProfilesForProvider(store, provider, authAliasLookupParams);
  let changed = removeAuthProfilesFromStore(store, new Set(profileIds));
  if (listProviderAuthStateEntries(store.order, providerKey, authAliasLookupParams).length > 0) {
    store.order = replaceProviderAuthState(
      store.order,
      providerKey,
      undefined,
      authAliasLookupParams,
    );
    changed = true;
  }
  if (listProviderAuthStateEntries(store.lastGood, providerKey, authAliasLookupParams).length > 0) {
    store.lastGood = replaceProviderAuthState(
      store.lastGood,
      providerKey,
      undefined,
      authAliasLookupParams,
    );
    changed = true;
  }
  if (store.usageStats && Object.keys(store.usageStats).length === 0) {
    store.usageStats = undefined;
  }
  return changed;
}

export async function removeProviderAuthProfilesWithLock(params: {
  provider: string;
  agentDir?: string;
  profileIds?: readonly string[];
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
}): Promise<AuthProfileStore | null> {
  if (params.profileIds) {
    return await removeAuthProfilesWithLock({
      agentDir: params.agentDir,
      profileIds: params.profileIds,
    });
  }
  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) =>
      removeProviderAuthProfilesFromStore(store, params.provider, params.authAliasLookupParams),
  });
}

/** Removes selected auth profiles and every state pointer that references them. */
function removeAuthProfilesFromStore(
  store: AuthProfileStore,
  profileIds: ReadonlySet<string>,
): boolean {
  const next = removeRuntimeExternalProfileReferences({ store, profileIds });
  if (isDeepStrictEqual(store, next)) {
    return false;
  }
  Object.assign(store, {
    profiles: next.profiles,
    order: next.order,
    lastGood: next.lastGood,
    usageStats: next.usageStats,
    runtimePersistedProfileIds: next.runtimePersistedProfileIds,
    runtimeExternalProfileIds: next.runtimeExternalProfileIds,
    runtimeExternalProfileIdsAuthoritative: next.runtimeExternalProfileIdsAuthoritative,
  });
  setRuntimeLocalProfileIds(store, getRuntimeLocalProfileIds(next));
  setRuntimeExternalCliProfileIds(store, getRuntimeExternalCliProfileIds(next));
  return true;
}

export async function removeAuthProfilesWithLock(params: {
  profileIds: readonly string[];
  agentDir?: string;
}): Promise<AuthProfileStore | null> {
  const profileIds = new Set(dedupeProfileIds([...params.profileIds]));
  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => removeAuthProfilesFromStore(store, profileIds),
  });
}

/**
 * Removes profiles from every store that owns them. Auth profiles can be
 * adopted by a provider-specific owner agent dir, so removing only the caller's
 * store lets the profile reappear on the next status read and auth warmup.
 */
export async function removeAuthProfilesAcrossOwnerStoresResult(params: {
  agentDir?: string;
  profileIds: readonly string[];
}): Promise<AuthProfileStoresUpdateResult> {
  const profilesByOwner = new Map<string | undefined, Set<string>>();
  for (const profileId of params.profileIds) {
    const ownerAgentDirs = resolvePersistedAuthProfileOwnerAgentDirs({
      agentDir: params.agentDir,
      profileId,
    });
    for (const ownerAgentDir of ownerAgentDirs) {
      const ownerProfiles = profilesByOwner.get(ownerAgentDir) ?? new Set<string>();
      ownerProfiles.add(profileId);
      profilesByOwner.set(ownerAgentDir, ownerProfiles);
    }
  }
  return updateAuthProfileStoresWithLocks({
    updates: [...profilesByOwner].map(([agentDir, profileIds]) => ({
      agentDir,
      updater: (store) => removeAuthProfilesFromStore(store, profileIds),
    })),
  });
}

export async function removeAuthProfilesAcrossOwnerStores(
  params: Parameters<typeof removeAuthProfilesAcrossOwnerStoresResult>[0],
): Promise<boolean> {
  return (await removeAuthProfilesAcrossOwnerStoresResult(params)).ok;
}

/** Clear availability state from the selected profile's persisted owners. */
export function clearAuthProfileCooldownAcrossOwnerStoresResult(params: {
  store: AuthProfileStore;
  agentDir: string;
  profileId: string;
}): AuthProfileStoresUpdateResult {
  let cleared = false;
  const ownerAgentDirs = resolvePersistedAuthProfileOwnerAgentDirs({
    agentDir: params.agentDir,
    profileId: params.profileId,
  });
  const updated = updateAuthProfileStoresWithLocks({
    updates: ownerAgentDirs.map((agentDir) => ({
      agentDir,
      updater: (store: AuthProfileStore) => {
        const changed = clearAuthProfileCooldownFromStore(store, params.profileId);
        cleared ||= changed;
        return changed;
      },
    })),
  });
  if (updated.committed) {
    notifyRuntimeAuthProfileSelectionMutation(ownerAgentDirs);
  }
  if (!updated.ok || !cleared) {
    return { ok: false, committed: updated.committed };
  }
  clearAuthProfileCooldownFromStore(params.store, params.profileId);
  return updated;
}

export function clearAuthProfileCooldownAcrossOwnerStores(
  params: Parameters<typeof clearAuthProfileCooldownAcrossOwnerStoresResult>[0],
): boolean {
  return clearAuthProfileCooldownAcrossOwnerStoresResult(params).ok;
}

/** Removes a provider from every store that owns one of its selected profiles. */
export function removeProviderAuthProfilesAcrossOwnerStoresResult(params: {
  provider: string;
  agentDir: string;
  profileIds: readonly string[];
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
}): AuthProfileStoresUpdateResult {
  const ownerAgentDirs = new Set<string | undefined>([params.agentDir]);
  for (const profileId of params.profileIds) {
    for (const ownerAgentDir of resolvePersistedAuthProfileOwnerAgentDirs({
      agentDir: params.agentDir,
      profileId,
    })) {
      ownerAgentDirs.add(ownerAgentDir);
    }
  }
  return updateAuthProfileStoresWithLocks({
    updates: [...ownerAgentDirs].map((agentDir) => ({
      agentDir,
      updater: (store) =>
        removeProviderAuthProfilesFromStore(store, params.provider, params.authAliasLookupParams),
    })),
  });
}

export function removeProviderAuthProfilesAcrossOwnerStores(
  params: Parameters<typeof removeProviderAuthProfilesAcrossOwnerStoresResult>[0],
): boolean {
  return removeProviderAuthProfilesAcrossOwnerStoresResult(params).ok;
}

/** Clear the last-good profile pointer for a provider under the store lock. */
export async function clearLastGoodProfileWithLock(params: {
  provider: string;
  profileId: string;
  agentDir?: string;
}): Promise<AuthProfileStore | null> {
  const providerKey = resolveProviderIdForAuth(params.provider);
  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
      const matches = listProviderAuthStateEntries(store.lastGood, providerKey);
      if (!matches.some(([, profileId]) => profileId === params.profileId)) {
        return false;
      }
      store.lastGood = replaceProviderAuthState(store.lastGood, providerKey);
      return true;
    },
  });
}

/** Mark a profile as successfully used and update ordering/usage metadata. */
export async function markAuthProfileSuccess(params: {
  store: AuthProfileStore;
  provider: string;
  profileId: string;
  agentDir?: string;
}): Promise<void> {
  const { store, provider, profileId, agentDir } = params;
  const providerKey = resolveProviderIdForAuth(provider);
  const lastUsed = Date.now();
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      const profile = freshStore.profiles[profileId];
      if (!profile || resolveProviderIdForAuth(profile.provider) !== providerKey) {
        return false;
      }
      freshStore.lastGood = replaceProviderAuthState(freshStore.lastGood, providerKey, profileId);
      updateSuccessfulUsageStatsEntry(freshStore, profileId, lastUsed);
      return true;
    },
  });
  if (updated) {
    store.lastGood = updated.lastGood;
    store.usageStats = updated.usageStats;
    return;
  }
  if (updated === null) {
    authProfileProfilesLog.warn(
      "dropped auth profile bookkeeping after locked store update failed",
      {
        event: "auth_profile_bookkeeping_dropped",
        kind: "success",
        profileId,
        tags: ["auth_profiles", "persistence"],
      },
    );
  }
}

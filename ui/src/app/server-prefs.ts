// Profile-backed UI preferences are canonical for identified users; config ui.prefs supplies the
// inherited defaults. The localStorage mirror gives instant boot and stays authoritative when this
// browser has no durable identity, is read-only, or is offline. Pending local intent shadows remote
// snapshots until its per-key users.prefs.set acknowledgement.
import type { UsersPrefsGetResult, UsersPrefsSetResult } from "@openclaw/gateway-protocol";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import {
  extractServerUiPrefs,
  prefValuesEqual,
  resolveServerUiPrefStateFromSnapshot,
  serverPrefsLocalPatch,
  SYNCED_PREF_KEYS,
  SYNCED_PREFS,
  type ResettableServerUiPrefKey,
  type ServerUiPrefs,
  type ServerUiPrefState,
  type SyncedPrefKey,
  type SyncedPrefValue,
} from "./server-prefs-state.ts";
import { loadSettings, patchSettings, type UiSettings } from "./settings.ts";
import type { ThemeName } from "./theme.ts";

type ServerUiPrefsWriter = {
  readonly canPatch?: boolean;
  readonly state: {
    readonly client: GatewayBrowserClient | null;
    readonly connected: boolean;
  };
};
type ServerUiPrefsLoadHooks = {
  scope: string;
  onLoaded: (snapshot: unknown) => void;
};
export type { ServerUiPrefProvenance, ServerUiPrefState } from "./server-prefs-state.ts";

export function resolveServerUiPrefState<K extends SyncedPrefKey>(
  configObject: unknown,
  key: K,
  scope = "",
  settings = loadSettings(),
  options: { canSync?: boolean | null } = {},
): ServerUiPrefState<SyncedPrefValue<K>> {
  const shadowPrefs =
    scope === pendingScope ? pendingPrefs : parseStoredPrefs(readStorage(PENDING_KEY, scope));
  return resolveServerUiPrefStateFromSnapshot(
    loadedSnapshots.get(scope) ?? configObject,
    key,
    shadowPrefs,
    settings,
    options.canSync,
  );
}
/** Synced-key delta between two local settings snapshots, for the push path. */
export function changedServerUiPrefs(previous: UiSettings, next: UiSettings): ServerUiPrefs | null {
  const prefs: ServerUiPrefs = {};
  for (const key of SYNCED_PREF_KEYS) {
    if (requestedDeviceLocalPrefResets.delete(key)) {
      continue;
    }
    if (requestedServerUiPrefResets.delete(key)) {
      (prefs as Record<string, unknown>)[key] = null;
      continue;
    }
    const specification = SYNCED_PREFS[key];
    const previousValue = specification.local(previous);
    const nextValue = specification.local(next);
    if (prefValuesEqual(previousValue, nextValue)) {
      continue;
    }
    if (nextValue === undefined) {
      // JSON merge patch removes keys via explicit null.
      if (specification.clearable) {
        (prefs as Record<string, unknown>)[key] = null;
      }
      continue;
    }
    (prefs as Record<string, unknown>)[key] = nextValue;
  }
  return Object.keys(prefs).length > 0 ? prefs : null;
}
// Last remote value this client reconciled against, persisted per gateway/profile scope. Applying only on
// a server delta keeps an unpushable local edit (viewer scope) from being reverted by every later
// snapshot, including the first snapshot after reload or reconnect carrying the same old value.
const LAST_SEEN_KEY = "openclaw.control.serverPrefs.v1";
// Pending keys are local edits not yet acknowledged by the gateway. They shadow reconciliation so
// snapshots cannot revert unacked edits, and persist so offline edits replay after reload/reconnect.
const PENDING_KEY = "openclaw.control.serverPrefs.pending.v1";
// Connected read-only edits never enter the replay outbox. Retain only their keys until the next
// snapshot establishes a LAST_SEEN baseline, then normal server-delta reconciliation resumes.
const RETAINED_LOCAL_KEY = "openclaw.control.serverPrefs.retained-local.v1";
const USER_PREF_PREFIX = "ui.";
const USER_PREF_MIGRATION_KEY = "ui.migratedFromConfigPrefsV1";
const USER_PREF_KEYS = SYNCED_PREF_KEYS.map((key) => `${USER_PREF_PREFIX}${key}`);
const requestedServerUiPrefResets = new Set<SyncedPrefKey>();
const requestedDeviceLocalPrefResets = new Set<SyncedPrefKey>();
let applyingServerPrefs = false;
let pendingScope = "";
let pendingPrefs: ServerUiPrefs | null = null;
let pendingPersistedKeys = new Set<SyncedPrefKey>();
let pushWriter: ServerUiPrefsWriter | null = null;
let pushScope = "";
let pushCanSync = true;
let pushDraining = false;
let drainRequested = false;
let pushEpoch = 0;
const loadedSnapshots = new Map<string, unknown>();
let loadEpoch = 0;
let lastLoadKey = "";
function readStorageState(
  root: string,
  scope: string,
): { available: boolean; value: string | null } {
  try {
    const storage = globalThis.localStorage;
    if (!storage) {
      return { available: false, value: null };
    }
    return { available: true, value: storage.getItem(`${root}:${scope}`) };
  } catch {
    return { available: false, value: null };
  }
}
function readStorage(root: string, scope: string): string | null {
  return readStorageState(root, scope).value;
}
function writeStorage(root: string, scope: string, value: string | null): boolean {
  try {
    const storage = globalThis.localStorage;
    if (!storage) {
      return false;
    }
    const key = `${root}:${scope}`;
    if (value === null) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, value);
    }
    return true;
  } catch {
    // Quota/security failures degrade to in-memory tracking for this session.
    return false;
  }
}
function parseStoredPrefs(raw: string | null): ServerUiPrefs | null {
  try {
    const prefs = asRecord(JSON.parse(raw ?? "null"));
    return prefs && Object.keys(prefs).length ? (prefs as ServerUiPrefs) : null;
  } catch {
    return null;
  }
}
function readStoredPrefs(
  root: string,
  scope: string,
): { available: boolean; prefs: ServerUiPrefs | null } {
  const stored = readStorageState(root, scope);
  return {
    available: stored.available,
    prefs: parseStoredPrefs(stored.value),
  };
}
function readRetainedLocalKeys(scope: string): Set<SyncedPrefKey> {
  const stored = parseStoredPrefs(readStorage(RETAINED_LOCAL_KEY, scope));
  return new Set(
    stored
      ? (Object.keys(stored).filter((key) => Object.hasOwn(SYNCED_PREFS, key)) as SyncedPrefKey[])
      : [],
  );
}
function writeRetainedLocalKeys(scope: string, keys: ReadonlySet<SyncedPrefKey>): void {
  writeStorage(
    RETAINED_LOCAL_KEY,
    scope,
    keys.size ? JSON.stringify(Object.fromEntries([...keys].map((key) => [key, true]))) : null,
  );
}
function updateRetainedLocalKeys(
  scope: string,
  keys: readonly SyncedPrefKey[],
  retained: boolean,
): void {
  const stored = readRetainedLocalKeys(scope);
  for (const key of keys) {
    if (retained) {
      stored.add(key);
    } else {
      stored.delete(key);
    }
  }
  writeRetainedLocalKeys(scope, stored);
}
function adoptPendingScope(scope: string, force = false): void {
  if (!force && scope === pendingScope) {
    return;
  }
  pendingScope = scope;
  const stored = readStoredPrefs(PENDING_KEY, scope);
  pendingPrefs = stored.prefs;
  pendingPersistedKeys = new Set(
    stored.available && stored.prefs ? (Object.keys(stored.prefs) as SyncedPrefKey[]) : [],
  );
}
function writePendingStorage(prefs: ServerUiPrefs | null): void {
  const persisted = writeStorage(PENDING_KEY, pendingScope, prefs ? JSON.stringify(prefs) : null);
  if (persisted) {
    pendingPersistedKeys = new Set(
      pendingPrefs ? (Object.keys(pendingPrefs) as SyncedPrefKey[]) : [],
    );
  } else {
    pendingPersistedKeys.clear();
  }
}
function cancelPendingKeys(scope: string, keys: readonly SyncedPrefKey[]): void {
  if (scope === pendingScope) {
    reconcilePersistedPendingPrefs();
  }
  const active = scope === pendingScope ? pendingPrefs : null;
  const remaining = {
    ...parseStoredPrefs(readStorage(PENDING_KEY, scope)),
    ...active,
  };
  for (const key of keys) {
    delete remaining[key];
  }
  const next = Object.keys(remaining).length ? remaining : null;
  if (scope === pendingScope) {
    pendingPrefs = next;
    writePendingStorage(next);
    return;
  }
  writeStorage(PENDING_KEY, scope, next ? JSON.stringify(next) : null);
}
// localStorage pending is a cross-tab merged pool per gateway/profile. Per-key read-merge-write prevents
// one tab from clobbering sibling offline intent; its ms-scale race is accepted because storage has
// no CAS and the drain converges through profile-store LWW.
function mergePendingIntoStorage(): void {
  const stored = parseStoredPrefs(readStorage(PENDING_KEY, pendingScope)) ?? {};
  const merged = { ...stored, ...pendingPrefs };
  writePendingStorage(Object.keys(merged).length ? merged : null);
}
function settlePendingStorage(ackedBatch: ServerUiPrefs): void {
  const stored = { ...parseStoredPrefs(readStorage(PENDING_KEY, pendingScope)) };
  for (const key of Object.keys(ackedBatch) as SyncedPrefKey[]) {
    if (prefValuesEqual(stored[key], ackedBatch[key])) {
      delete stored[key];
    }
  }
  const merged = { ...stored, ...pendingPrefs };
  writePendingStorage(Object.keys(merged).length ? merged : null);
}
// Only persisted keys participate in cross-tab reconciliation. An in-memory-only key means
// localStorage was unavailable, so absence from storage cannot be interpreted as cancellation.
function reconcilePersistedPendingPrefs(): void {
  if (!pendingPrefs || pendingPersistedKeys.size === 0) {
    return;
  }
  const stored = readStoredPrefs(PENDING_KEY, pendingScope);
  if (!stored.available) {
    return;
  }
  const current = stored.prefs ?? {};
  for (const key of pendingPersistedKeys) {
    if (!Object.hasOwn(current, key)) {
      delete pendingPrefs[key];
      pendingPersistedKeys.delete(key);
      continue;
    }
    const storedValue = current[key];
    if (!prefValuesEqual(pendingPrefs[key], storedValue)) {
      (pendingPrefs as Record<string, unknown>)[key] = storedValue;
    }
  }
  if (!Object.keys(pendingPrefs).length) {
    pendingPrefs = null;
  }
}
function batchIsCurrent(batch: ServerUiPrefs): boolean {
  const current = pendingPrefs;
  return Boolean(
    current &&
    (Object.keys(batch) as SyncedPrefKey[]).every(
      (key) => Object.hasOwn(current, key) && prefValuesEqual(current[key], batch[key]),
    ),
  );
}
export function resetServerUiPrefsSync() {
  applyingServerPrefs = pushDraining = drainRequested = false;
  pendingScope = "";
  pendingPrefs = pushWriter = null;
  pendingPersistedKeys.clear();
  pushScope = "";
  pushCanSync = true;
  loadedSnapshots.clear();
  loadEpoch += 1;
  lastLoadKey = "";
  requestedServerUiPrefResets.clear();
  requestedDeviceLocalPrefResets.clear();
}

export function resetServerUiPref<K extends ResettableServerUiPrefKey>(
  key: K,
  state?: ServerUiPrefState<SyncedPrefValue<K>>,
  scope = pendingScope,
): UiSettings {
  const specification = SYNCED_PREFS[key];
  const reset = specification.reset;
  if (!reset) {
    throw new Error(`Server UI preference is not resettable: ${key}`);
  }
  if (state?.provenance === "device-local") {
    const write = specification.write as
      | ((value: SyncedPrefValue<K> | undefined) => Partial<UiSettings>)
      | undefined;
    if (!write) {
      throw new Error(`Server UI preference cannot restore a retained local value: ${key}`);
    }
    cancelPendingKeys(scope, [key]);
    updateRetainedLocalKeys(scope, [key], false);
    requestedDeviceLocalPrefResets.add(key);
    return patchSettings(write(state.resetValue));
  }
  requestedServerUiPrefResets.add(key);
  return patchSettings(reset(loadSettings()));
}

function decodeUserUiPrefs(entries: Record<string, unknown>): ServerUiPrefs {
  const prefs = Object.fromEntries(
    SYNCED_PREF_KEYS.map((key) => [key, entries[`${USER_PREF_PREFIX}${key}`]]),
  );
  return extractServerUiPrefs({ ui: { prefs } });
}

function encodeUserUiPrefs(prefs: ServerUiPrefs): Record<string, unknown> {
  return Object.fromEntries(
    // SAFETY: ServerUiPrefs is closed over SyncedPrefKey, preserving its entry pairs.
    (Object.entries(prefs) as Array<[SyncedPrefKey, ServerUiPrefs[SyncedPrefKey]]>).map(
      ([key, value]) => [`${USER_PREF_PREFIX}${key}`, value],
    ),
  );
}

/** Loads one profile's overrides and merges them over the gateway-configured defaults. */
export function refreshServerUiPrefs(
  writer: ServerUiPrefsWriter,
  configObject: unknown,
  hooks: ServerUiPrefsLoadHooks,
  options: { canSync?: boolean; force?: boolean } = {},
): Promise<void> {
  adoptPushWriter(writer, hooks.scope);
  pushCanSync = options.canSync ?? writer.canPatch !== false;
  const defaults = extractServerUiPrefs(configObject);
  const loadKey = hooks.scope + JSON.stringify(defaults);
  if (!options.force && lastLoadKey === loadKey) {
    return Promise.resolve();
  }
  lastLoadKey = loadKey;
  const epoch = ++loadEpoch;
  const client = writer.state.client;
  if (!writer.state.connected || !client) {
    return Promise.resolve();
  }
  const load = (async () => {
    const result = await client.request<UsersPrefsGetResult>("users.prefs.get", {
      keys: [...USER_PREF_KEYS, USER_PREF_MIGRATION_KEY],
    });
    if (epoch !== loadEpoch || result.status !== "ok") {
      return;
    }
    let userPrefs = decodeUserUiPrefs(result.entries);
    if (result.entries[USER_PREF_MIGRATION_KEY] !== true) {
      const migration = await client.request<UsersPrefsSetResult>("users.prefs.set", {
        entries: {
          ...encodeUserUiPrefs(defaults),
          [USER_PREF_MIGRATION_KEY]: true,
        },
      });
      if (epoch !== loadEpoch || migration.status !== "ok") {
        return;
      }
      userPrefs = defaults;
    }
    const snapshot = {
      ui: { prefs: { ...defaults, ...userPrefs }, prefDefaults: defaults, userPrefs },
    };
    loadedSnapshots.set(hooks.scope, snapshot);
    hooks.onLoaded(snapshot);
    if (pushWriter === writer && pendingScope === hooks.scope) {
      startPendingDrain(writer);
    }
  })().catch(() => undefined);
  return load;
}

export function applyServerUiPrefs(
  configObject: unknown,
  hooks: {
    scope?: string;
    onApplied: (patch: Partial<UiSettings>) => void;
    onThemeChanged?: (theme: ThemeName | null) => void;
  },
): boolean {
  const scope = hooks.scope ?? "";
  const shadowPrefs =
    scope === pendingScope ? pendingPrefs : parseStoredPrefs(readStorage(PENDING_KEY, scope));
  const retainedLocalKeys = readRetainedLocalKeys(scope);
  const prefs = extractServerUiPrefs(configObject);
  const key = JSON.stringify(prefs);
  const lastSeenRaw = readStorage(LAST_SEEN_KEY, scope);
  if (key === lastSeenRaw) {
    if (retainedLocalKeys.size) {
      updateRetainedLocalKeys(scope, [...retainedLocalKeys], false);
    }
    return false;
  }
  const lastSeen = parseStoredPrefs(lastSeenRaw) ?? {};
  const changed: ServerUiPrefs = {};
  // Apply per field: only keys whose server value changed since last seen. Reapplying unchanged
  // fields would revert unpushable local edits whenever any other server field moves.
  for (const prefKey of Object.keys(prefs) as Array<keyof ServerUiPrefs>) {
    if (
      !(shadowPrefs && prefKey in shadowPrefs) &&
      !retainedLocalKeys.has(prefKey) &&
      (lastSeenRaw === null || !prefValuesEqual(prefs[prefKey], lastSeen[prefKey]))
    ) {
      (changed as Record<string, unknown>)[prefKey] = prefs[prefKey];
    }
  }
  for (const prefKey of Object.keys(lastSeen) as Array<keyof ServerUiPrefs>) {
    if (
      !(prefKey in prefs) &&
      !(shadowPrefs && prefKey in shadowPrefs) &&
      !retainedLocalKeys.has(prefKey) &&
      SYNCED_PREFS[prefKey]?.clearable
    ) {
      (changed as Record<string, unknown>)[prefKey] = null;
    }
  }
  writeStorage(LAST_SEEN_KEY, scope, key);
  if (retainedLocalKeys.size) {
    updateRetainedLocalKeys(scope, [...retainedLocalKeys], false);
  }
  if (Object.hasOwn(changed, "theme")) {
    hooks.onThemeChanged?.(changed.theme ?? null);
  }
  const patch = serverPrefsLocalPatch(changed, loadSettings());
  if (!patch) {
    return false;
  }
  applyingServerPrefs = true;
  try {
    patchSettings(patch);
  } finally {
    applyingServerPrefs = false;
  }
  hooks.onApplied(patch);
  return true;
}
export function isApplyingServerUiPrefs(): boolean {
  return applyingServerPrefs;
}
function adoptPushWriter(writer: ServerUiPrefsWriter, requestedScope?: string): void {
  const scope = requestedScope ?? writer.state.client?.gatewayUrl ?? "";
  if (requestedScope === undefined) {
    loadedSnapshots.set(scope, loadedSnapshots.get(scope) ?? null);
  }
  if (pushWriter === writer && pushScope === scope) {
    return;
  }
  // Reconcile the scope being left before moving pre-connection intent forward.
  // Otherwise another tab can cancel storage while this realm later resurrects its stale memory.
  reconcilePersistedPendingPrefs();
  const unscopedPending =
    pendingScope === ""
      ? {
          ...parseStoredPrefs(readStorage(PENDING_KEY, "")),
          ...pendingPrefs,
        }
      : null;
  pushEpoch += 1;
  pushWriter = writer;
  pushScope = scope;
  pushDraining = false;
  adoptPendingScope(scope, true);
  if (scope && unscopedPending && Object.keys(unscopedPending).length) {
    // A preference can be edited before the first gateway client is adopted.
    // Move only that unscoped intent forward; preferences from one real
    // gateway must never bleed into another gateway's scope.
    pendingPrefs = { ...pendingPrefs, ...unscopedPending };
    mergePendingIntoStorage();
    writeStorage(PENDING_KEY, "", null);
  }
}
function removeBatch(batch: ServerUiPrefs): void {
  if (!pendingPrefs) {
    return;
  }
  for (const key of Object.keys(batch) as SyncedPrefKey[]) {
    if (prefValuesEqual(pendingPrefs[key], batch[key])) {
      delete pendingPrefs[key];
      pendingPersistedKeys.delete(key);
    }
  }
  if (!Object.keys(pendingPrefs).length) {
    pendingPrefs = null;
  }
}
async function drainPendingPrefs(writer: ServerUiPrefsWriter, epoch: number): Promise<void> {
  while (pendingPrefs) {
    if (pushWriter !== writer || pushEpoch !== epoch) {
      return;
    }
    reconcilePersistedPendingPrefs();
    if (!pendingPrefs) {
      return;
    }
    const batch = { ...pendingPrefs };
    const client = writer.state.client;
    if (!writer.state.connected || !client || !pushCanSync) {
      return;
    }
    reconcilePersistedPendingPrefs();
    if (!batchIsCurrent(batch)) {
      continue;
    }
    let result: UsersPrefsSetResult;
    try {
      result = await client.request<UsersPrefsSetResult>("users.prefs.set", {
        entries: encodeUserUiPrefs(batch),
      });
    } catch (error) {
      if (pushWriter !== writer || pushEpoch !== epoch) {
        return;
      }
      const rejected =
        error instanceof GatewayRequestError &&
        (error.gatewayCode === "INVALID_REQUEST" || error.gatewayCode === "FORBIDDEN");
      if (!rejected) {
        return;
      }
      removeBatch(batch);
      settlePendingStorage(batch);
      return;
    }
    if (pushWriter !== writer || pushEpoch !== epoch) {
      return;
    }
    removeBatch(batch);
    settlePendingStorage(batch);
    if (result.status === "no_durable_identity") {
      return;
    }
  }
}
function startPendingDrain(writer: ServerUiPrefsWriter): void {
  if (pushDraining) {
    drainRequested = true;
    return;
  }
  if (!pendingPrefs) {
    return;
  }
  if (!loadedSnapshots.has(pendingScope)) {
    return;
  }
  if (writer.state.connected && !pushCanSync) {
    return;
  }
  pushDraining = true;
  const epoch = pushEpoch;
  void drainPendingPrefs(writer, epoch)
    .catch(() => undefined)
    .finally(() => {
      if (pushWriter === writer && pushEpoch === epoch) {
        pushDraining = false;
        if (drainRequested) {
          drainRequested = false;
          startPendingDrain(writer);
        }
      }
    });
}
export function pushServerUiPrefs(
  writer: ServerUiPrefsWriter,
  prefs: ServerUiPrefs,
  hooks: {
    canSync?: boolean;
    scope?: string;
  } = {},
): void {
  adoptPushWriter(writer, hooks.scope);
  pushCanSync = hooks.canSync ?? writer.canPatch !== false;
  if (writer.state.connected && !pushCanSync) {
    // A connected read-only edit is intentionally browser-local. Supersede only
    // same-key offline intent so a later authorization cannot replay stale input.
    const keys = Object.keys(prefs) as SyncedPrefKey[];
    cancelPendingKeys(pendingScope, keys);
    updateRetainedLocalKeys(pendingScope, keys, true);
    return;
  }
  reconcilePersistedPendingPrefs();
  pendingPrefs = { ...pendingPrefs, ...prefs };
  mergePendingIntoStorage();
  startPendingDrain(writer);
}
export function flushServerUiPrefs(
  writer: ServerUiPrefsWriter,
  hooks: {
    canSync?: boolean;
    scope?: string;
  } = {},
): void {
  adoptPushWriter(writer, hooks.scope);
  pushCanSync = hooks.canSync ?? writer.canPatch !== false;
  pushEpoch += 1;
  pushDraining = drainRequested = false;
  startPendingDrain(writer);
}

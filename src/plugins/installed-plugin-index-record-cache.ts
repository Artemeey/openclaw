// Caches installed plugin index records for current process lookups.
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";

/** Cached installed plugin records for one store/recovery key. */
type InstallRecordsCacheEntry = {
  records: Record<string, PluginInstallRecord>;
};

// Metadata owners cross ESM/require bridges; their source cache and generation
// must share one process lifetime too.
const state = resolveGlobalSingleton(
  Symbol.for("openclaw.installedPluginIndexInstallRecordsCache"),
  () => ({
    records: new Map<string, InstallRecordsCacheEntry>(),
    generation: 0,
    openedDatabases: new WeakSet<OpenClawStateDatabase>(),
  }),
);

/** Returns cached installed plugin records for a store/recovery key. */
export function getInstalledPluginIndexInstallRecordsCache(
  key: string,
): InstallRecordsCacheEntry | undefined {
  return state.records.get(key);
}

/** Stores cached installed plugin records for a store/recovery key. */
export function setInstalledPluginIndexInstallRecordsCache(
  key: string,
  entry: InstallRecordsCacheEntry,
): void {
  state.records.set(key, entry);
}

/** Current cache generation used to detect concurrent clears during async loads. */
export function getInstalledPluginIndexInstallRecordsCacheGeneration(): number {
  return state.generation;
}

/** Clears cached installed plugin records and advances the cache generation. */
export function clearLoadInstalledPluginIndexInstallRecordsCache(): void {
  state.generation += 1;
  state.records.clear();
}

// Earlier read-only preparation may have seen an unmigrated index. Registration
// replays open handles, so duplicate module instances must invalidate each only once.
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened" || state.openedDatabases.has(event.database)) {
    return;
  }
  state.openedDatabases.add(event.database);
  clearLoadInstalledPluginIndexInstallRecordsCache();
});

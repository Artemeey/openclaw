import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { getPluginCache, getProcessPluginCache } from "./plugin-cache.js";

// The revision fences unpublished metadata across source/ESM readers; facts live in PluginCache.
const sourceState = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginInstallRecordsSourceRevision"),
  () => ({ generation: 0, openedDatabases: new WeakSet<OpenClawStateDatabase>() }),
);

export function getInstalledPluginIndexInstallRecordsCacheGeneration(): number {
  return sourceState.generation;
}

/** Explicit ledger writes/reloads leave the Gateway's embedded boot snapshot unchanged. */
export function clearLoadInstalledPluginIndexInstallRecordsCache(): void {
  sourceState.generation += 1;
  for (const cache of new Set([getPluginCache(), getProcessPluginCache()])) {
    cache.installRecords.clear();
    cache.persistedInstalledIndex.clear();
    if (cache.metadata.current.owner !== "gateway") {
      cache.metadata.collectionOwner?.invalidatePreparation();
    }
  }
}

// Read-only preflight can precede database initialization. Opening an authoritative
// database invalidates that preparation once, including replay through a second module instance.
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened" || sourceState.openedDatabases.has(event.database)) {
    return;
  }
  sourceState.openedDatabases.add(event.database);
  clearLoadInstalledPluginIndexInstallRecordsCache();
});

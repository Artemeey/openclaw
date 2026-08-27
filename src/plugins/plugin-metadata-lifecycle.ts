/** Coordinates plugin metadata snapshot and process memo cache lifecycle resets. */
import {
  clearCurrentPluginMetadataSnapshot,
  getCurrentPluginMetadataOwner,
} from "./current-plugin-metadata-state.js";
import type { PluginMetadataOwner } from "./plugin-metadata-collection.js";

const pluginMetadataProcessMemoClears = new Set<() => void>();

/** Registers a process-local plugin metadata memo clear hook. */
export function registerPluginMetadataProcessMemoLifecycleClear(
  clearProcessMemo: () => void,
): void {
  pluginMetadataProcessMemoClears.add(clearProcessMemo);
}

/** Clears plugin metadata snapshots and registered process memo caches. */
export function clearPluginMetadataLifecycleCaches(
  owner: PluginMetadataOwner | undefined = getCurrentPluginMetadataOwner(),
): void {
  if (owner) {
    // An install invalidates preparation, not the immutable graph still serving
    // requests. Replacement publication or shutdown retires that graph.
    owner.invalidatePreparation();
  } else {
    clearCurrentPluginMetadataSnapshot();
  }
  for (const clearProcessMemo of pluginMetadataProcessMemoClears) {
    clearProcessMemo();
  }
}

import {
  getCurrentPluginMetadataSnapshot,
  isCurrentPluginMetadataSnapshotRuntimeGeneration,
} from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  createPluginMetadataOwner,
  getCurrentPluginMetadataOwner,
  getScopedPluginMetadata,
  projectConfigWidePluginMetadata,
  type PreparedPluginMetadata,
} from "../plugins/plugin-metadata-collection.js";
import { resolvePluginMetadataEnvFingerprint } from "../plugins/plugin-metadata-env.js";
import { projectPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshotPluginIdScope } from "../plugins/plugin-metadata-snapshot.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type ResolveConfigWidePluginMetadataParams = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  allowCurrent?: boolean;
  pluginIds?: readonly string[];
  pluginIdScope?: PluginMetadataSnapshotPluginIdScope;
  metadata?: PreparedPluginMetadata;
};

export function resolveConfigWidePluginManifestRegistry(
  params: ResolveConfigWidePluginMetadataParams,
): PluginManifestRegistry {
  const canUsePrepared = params.allowCurrent !== false && params.stateDir === undefined;
  const supplied = params.metadata;
  if (
    canUsePrepared &&
    supplied &&
    supplied.envFingerprint !== resolvePluginMetadataEnvFingerprint(params.env)
  ) {
    throw new Error("Config plugin metadata was prepared for a different environment");
  }
  if (canUsePrepared && !supplied) {
    // A retained run's metadata is paired with its executable registry. An ordinary
    // candidate scope may override that run, but a global union must never widen it.
    const current = getCurrentPluginMetadataSnapshot({
      env: params.env,
      allowScopedSnapshot: true,
      allowWorkspaceScopedSnapshot: true,
    });
    if (current && isCurrentPluginMetadataSnapshotRuntimeGeneration(current)) {
      return (
        params.pluginIds !== undefined || params.pluginIdScope !== undefined
          ? projectPluginMetadataSnapshot(current, params)
          : current
      ).manifestRegistry;
    }
  }
  const scoped = canUsePrepared ? (supplied ?? getScopedPluginMetadata(params.env)) : undefined;
  if (scoped) {
    return projectConfigWidePluginMetadata(scoped, params).manifestRegistry;
  }
  const owner = canUsePrepared ? getCurrentPluginMetadataOwner() : undefined;
  if (owner) {
    if (params.config) {
      const prepared = owner.readConfigWide({ ...params, config: params.config });
      if (prepared) {
        return prepared.manifestRegistry;
      }
    } else {
      const active = owner.getActive();
      if (active && active.envFingerprint === resolvePluginMetadataEnvFingerprint(params.env)) {
        return projectConfigWidePluginMetadata(active, params).manifestRegistry;
      }
    }
    throw new Error("Config plugin metadata must be prepared before runtime lookup");
  }
  const metadata = createPluginMetadataOwner().prepare({ ...params, config: params.config ?? {} });
  return projectConfigWidePluginMetadata(metadata, params).manifestRegistry;
}

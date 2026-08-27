import {
  getCurrentPluginMetadataSnapshot,
  isCurrentPluginMetadataSnapshotRuntimeGeneration,
} from "../plugins/current-plugin-metadata-snapshot.js";
import {
  getCurrentPluginMetadataOwner,
  getPluginMetadataWorkspaceSnapshot,
  preparePluginMetadata,
} from "../plugins/plugin-metadata-collection.js";
import { projectPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  resolvePluginRuntimeLoadContext,
  type PluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import { createAgentRuntimeMetadataPluginIdScope } from "./harness/runtime-plugin-load-plan.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

const preparedPluginRuntimeLoadContext = Symbol("preparedPluginRuntimeLoadContext");

type PreparedPluginRegistry = PluginRegistry & {
  [preparedPluginRuntimeLoadContext]?: PluginRuntimeLoadContext;
};

function setPreparedPluginRuntimeLoadContext(
  registry: PluginRegistry,
  context: PluginRuntimeLoadContext,
): void {
  (registry as PreparedPluginRegistry)[preparedPluginRuntimeLoadContext] = context;
}

/** Resolves and attaches the plugin facts owned by one prepared workspace generation. */
export function prepareOwnedPluginLoadContext(
  input: PreparedModelRuntimeInput,
  env: NodeJS.ProcessEnv,
  registry: PluginRegistry | undefined,
  preparedMetadataSnapshot?: PluginMetadataSnapshot,
  preferBuiltPluginArtifacts = false,
): PluginMetadataSnapshot {
  const metadataSnapshot = preparedMetadataSnapshot ?? prepareOperationMetadataSnapshot(input, env);
  if (registry) {
    setPreparedPluginRuntimeLoadContext(
      registry,
      resolvePluginRuntimeLoadContext({
        config: input.config,
        env,
        workspaceDir: metadataSnapshot.workspaceDir ?? input.workspaceDir,
        metadataSnapshot,
        preferBuiltPluginArtifacts,
      }),
    );
  }
  return metadataSnapshot;
}

function prepareOperationMetadataSnapshot(
  input: PreparedModelRuntimeInput,
  env: NodeJS.ProcessEnv,
): PluginMetadataSnapshot {
  const inherited = getCurrentPluginMetadataSnapshot({
    config: input.config,
    env,
    workspaceDir: input.workspaceDir,
    allowScopedSnapshot: true,
    allowWorkspaceScopedSnapshot: true,
  });
  // A nested runtime carries executable authority for one immutable graph.
  // Operation preparation must not replace it with another workspace's inventory.
  if (inherited && isCurrentPluginMetadataSnapshotRuntimeGeneration(inherited)) {
    return inherited;
  }
  const scope =
    input.loadRuntimePlugins && input.runtimePluginSelections && input.workspaceDir
      ? {
          pluginIdScope: createAgentRuntimeMetadataPluginIdScope({
            config: input.config,
            workspaceDir: input.workspaceDir,
            selections: input.runtimePluginSelections,
          }),
        }
      : {};
  if (inherited && inherited.pluginIds === undefined) {
    return projectPluginMetadataSnapshot(inherited, scope);
  }
  const prepared = getCurrentPluginMetadataOwner()?.readSnapshot({
    config: input.config,
    env,
    workspaceDir: input.workspaceDir,
    allowWorkspaceScopedCurrent: true,
    ...scope,
  });
  if (prepared) {
    return prepared;
  }
  const metadata = preparePluginMetadata({
    config: input.config,
    env,
    workspaceDir: input.workspaceDir,
  });
  return getPluginMetadataWorkspaceSnapshot(metadata, {
    workspaceDir: input.workspaceDir,
    ...scope,
  });
}

/** Reads plugin facts carried by a lifecycle-owned prepared runtime snapshot. */
export const getPreparedPluginRuntimeLoadContext = (
  registry: PluginRegistry | undefined,
): PluginRuntimeLoadContext | undefined =>
  (registry as PreparedPluginRegistry | undefined)?.[preparedPluginRuntimeLoadContext];

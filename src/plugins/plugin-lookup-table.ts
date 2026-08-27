/** Builds plugin lookup tables keyed by manifest ids, channels, providers, and commands. */
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createGatewayStartupMetadataPluginIdScope,
  resolveGatewayStartupPluginPlanFromRegistry,
  type GatewayStartupPluginPlan,
} from "./channel-plugin-ids.js";
import {
  isPluginMetadataSnapshotCompatible,
  projectPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import type { PluginRegistrySnapshot } from "./plugin-registry-snapshot.js";
import { normalizeWorkerProviderIds } from "./worker-provider-id.js";

type PluginLookUpTableMetrics = PluginMetadataSnapshot["metrics"] & {
  startupPlanMs: number;
  startupPluginCount: number;
};

export type PluginLookUpTable = PluginMetadataSnapshot & {
  startup: GatewayStartupPluginPlan;
  workerProviderIds: readonly string[];
  metrics: PluginLookUpTableMetrics;
};

type LoadPluginLookUpTableParams = {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  index?: PluginRegistrySnapshot;
  metadataSnapshot?: PluginMetadataSnapshot;
  workerProviderIds?: readonly string[];
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
};

const lookupTableMemoBySnapshot = new WeakMap<
  PluginMetadataSnapshot,
  Map<string, PluginLookUpTable>
>();
export function loadPluginLookUpTable(params: LoadPluginLookUpTableParams): PluginLookUpTable {
  const requestedSnapshotConfig = params.activationSourceConfig ?? params.config;
  const workerProviderIds = normalizeWorkerProviderIds(params.workerProviderIds ?? []);
  const pluginIdScope = createGatewayStartupMetadataPluginIdScope({
    config: params.config,
    ...(params.activationSourceConfig !== undefined
      ? { activationSourceConfig: params.activationSourceConfig }
      : {}),
    env: params.env,
    workerProviderIds,
    ambientEnvTriggers: params.ambientEnvTriggers,
  });
  const requestedPluginIds = params.metadataSnapshot
    ? pluginIdScope.resolve({ index: params.metadataSnapshot.index })
    : undefined;
  const sourceSnapshot =
    params.metadataSnapshot &&
    isPluginMetadataSnapshotCompatible({
      snapshot: params.metadataSnapshot,
      config: requestedSnapshotConfig,
      env: params.env,
      allowScopedSnapshot: true,
      workspaceDir: params.workspaceDir,
      index: params.index,
    }) &&
    (params.metadataSnapshot.pluginIds === undefined ||
      (requestedPluginIds !== undefined &&
        requestedPluginIds.every((pluginId) =>
          params.metadataSnapshot!.pluginIds!.includes(pluginId),
        )))
      ? params.metadataSnapshot
      : resolvePluginMetadataSnapshot({
          config: requestedSnapshotConfig,
          workspaceDir: params.workspaceDir,
          env: params.env,
          allowWorkspaceScopedCurrent: params.workspaceDir === undefined,
          ...(params.index ? { index: params.index } : {}),
          pluginIdScope,
        });
  const memoKey = pluginIdScope.key;
  const memo = lookupTableMemoBySnapshot.get(sourceSnapshot)?.get(memoKey);
  if (memo) {
    return memo;
  }
  const metadataSnapshot = projectPluginMetadataSnapshot(sourceSnapshot, { pluginIdScope });
  const { index, manifestRegistry } = metadataSnapshot;
  const startupPlanStartedAt = performance.now();
  const startup = resolveGatewayStartupPluginPlanFromRegistry({
    config: params.config,
    ...(params.activationSourceConfig !== undefined
      ? { activationSourceConfig: params.activationSourceConfig }
      : {}),
    env: params.env,
    index,
    manifestRegistry,
    workerProviderIds,
    ambientEnvTriggers: params.ambientEnvTriggers,
  });
  const startupPlanMs = performance.now() - startupPlanStartedAt;

  const table: PluginLookUpTable = {
    ...metadataSnapshot,
    startup,
    workerProviderIds,
    metrics: {
      ...metadataSnapshot.metrics,
      startupPlanMs,
      totalMs: metadataSnapshot.metrics.totalMs + startupPlanMs,
      startupPluginCount: startup.pluginIds.length,
    },
  };
  let memoByKey = lookupTableMemoBySnapshot.get(sourceSnapshot);
  if (!memoByKey) {
    memoByKey = new Map();
    lookupTableMemoBySnapshot.set(sourceSnapshot, memoByKey);
  }
  memoByKey.set(memoKey, table);
  return table;
}

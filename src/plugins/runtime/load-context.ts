// Plugin runtime load context helpers resolve agent and workspace facts for runtime activation.
import { getRuntimeConfig } from "../../config/config.js";
import { resolveConfigWidePluginManifestRegistry } from "../../config/io.plugin-metadata.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { createSubsystemLogger } from "../../logging.js";
import { resolvePluginActivationSourceConfig } from "../activation-source-config.js";
import { resolvePluginControlPlaneWorkspace } from "../control-plane-workspace.js";
import {
  getCurrentPluginMetadataSnapshot,
  isScopedPluginMetadataSnapshotRuntimeGeneration,
} from "../current-plugin-metadata-snapshot.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../installed-plugin-index-install-records.js";
import type { PluginLoadOptions } from "../loader.js";
import type { PluginManifestRegistry } from "../manifest-registry.js";
import {
  getCurrentPluginMetadataOwner,
  getPluginMetadataWorkspaceSnapshot,
  getScopedPluginMetadata,
  preparePluginMetadata,
  withPluginMetadataCollectionScope,
} from "../plugin-metadata-collection.js";
import {
  projectPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
} from "../plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../registry-types.js";
import type { PluginLogger } from "../types.js";

const log = createSubsystemLogger("plugins");

/** Resolved plugin runtime load context shared by runtime loader callers. */
export type PluginRuntimeLoadContext = {
  rawConfig: OpenClawConfig;
  config: OpenClawConfig;
  activationSourceConfig: OpenClawConfig;
  autoEnabledReasons: Readonly<Record<string, string[]>>;
  workspaceDir: string | undefined;
  env: NodeJS.ProcessEnv;
  logger: PluginLogger;
  manifestRegistry?: PluginManifestRegistry;
  metadataSnapshot?: PluginMetadataSnapshot;
  installRecords?: Record<string, PluginInstallRecord>;
  preferBuiltPluginArtifacts?: boolean;
};

// Source and built consumers must read the same facts from the owning registry.
const pluginRuntimeLoadContext = Symbol.for("openclaw.pluginRuntimeLoadContext");
type RuntimeContextRegistry = PluginRegistry & {
  [pluginRuntimeLoadContext]?: PluginRuntimeLoadContext;
};

export function setPluginRuntimeLoadContext(
  registry: PluginRegistry,
  context: PluginRuntimeLoadContext,
): void {
  // SAFETY: Internal registries are extensible; this module owns the optional symbol slot.
  (registry as RuntimeContextRegistry)[pluginRuntimeLoadContext] = context;
}

/** Reads load facts carried by an exact lifecycle-owned registry. */
export const getPluginRuntimeLoadContext = (
  registry: PluginRegistry | undefined,
): PluginRuntimeLoadContext | undefined =>
  // SAFETY: Only the setter above writes this optional registry-owned symbol slot.
  (registry as RuntimeContextRegistry | undefined)?.[pluginRuntimeLoadContext];

/** Runtime load option values that can be passed directly to plugin loading. */
type PluginRuntimeResolvedLoadValues = Pick<
  PluginLoadOptions,
  | "config"
  | "activationSourceConfig"
  | "autoEnabledReasons"
  | "workspaceDir"
  | "env"
  | "logger"
  | "manifestRegistry"
  | "installRecords"
  | "preferBuiltPluginArtifacts"
>;

/** Options accepted while resolving plugin runtime load context. */
type PluginRuntimeLoadContextOptions = {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  onlyPluginIds?: readonly string[];
  logger?: PluginLogger;
  manifestRegistry?: PluginManifestRegistry;
  metadataSnapshot?: PluginMetadataSnapshot;
  preferBuiltPluginArtifacts?: boolean;
};

/** Creates the default plugin runtime loader logger. */
export function createPluginRuntimeLoaderLogger(): PluginLogger {
  return {
    info: (message) => log.info(message),
    warn: (message) => log.warn(message),
    error: (message) => log.error(message),
    debug: (message) => log.debug(message),
  };
}

/** Resolves config, manifests, install records, and auto-enable state for runtime loads. */
export function resolvePluginRuntimeLoadContext(
  options?: PluginRuntimeLoadContextOptions,
): PluginRuntimeLoadContext {
  const env = options?.env ?? process.env;
  const rawConfig = options?.config ?? getRuntimeConfig();
  const workspaceDir = resolvePluginControlPlaneWorkspace({
    config: rawConfig,
    env,
    workspaceDir: options?.workspaceDir,
  }).workspaceDir;
  const ownsPreparation = !options?.metadataSnapshot && !options?.manifestRegistry;
  const current = ownsPreparation
    ? getCurrentPluginMetadataSnapshot({
        config: rawConfig,
        env,
        workspaceDir,
        allowScopedSnapshot: true,
        allowWorkspaceScopedSnapshot: true,
      })
    : undefined;
  const runtimeScoped =
    current !== undefined && isScopedPluginMetadataSnapshotRuntimeGeneration(current);
  const operationMetadata =
    ownsPreparation && !runtimeScoped && !getCurrentPluginMetadataOwner()
      ? (getScopedPluginMetadata(env) ??
        preparePluginMetadata({ config: rawConfig, env, workspaceDir }))
      : undefined;
  const metadataSnapshot =
    options?.metadataSnapshot ??
    (runtimeScoped && current
      ? options?.onlyPluginIds !== undefined
        ? projectPluginMetadataSnapshot(current, options.onlyPluginIds)
        : current
      : undefined) ??
    (operationMetadata
      ? getPluginMetadataWorkspaceSnapshot(operationMetadata, {
          workspaceDir,
          pluginIds: options?.onlyPluginIds,
        })
      : undefined) ??
    (options?.manifestRegistry === undefined
      ? resolvePluginMetadataSnapshot({
          config: rawConfig,
          env,
          workspaceDir,
          allowWorkspaceScopedCurrent: true,
          ...(options?.onlyPluginIds !== undefined ? { pluginIds: options.onlyPluginIds } : {}),
        })
      : undefined);
  const manifestRegistry = options?.manifestRegistry ?? metadataSnapshot?.manifestRegistry;
  // Config-wide policy may inspect all configured workspaces, but execution keeps
  // the exact workspace inventory. Auto-enable never changes discovery roots.
  const autoEnableManifestRegistry =
    options?.workspaceDir === undefined && ownsPreparation && !runtimeScoped
      ? resolveConfigWidePluginManifestRegistry({
          config: rawConfig,
          env,
          metadata: operationMetadata,
          ...(options?.onlyPluginIds !== undefined ? { pluginIds: options.onlyPluginIds } : {}),
        })
      : manifestRegistry;
  const activationSourceConfig = resolvePluginActivationSourceConfig({
    config: rawConfig,
    activationSourceConfig: options?.activationSourceConfig,
  });
  const applyAutoEnable = () =>
    applyPluginAutoEnable({
      config: rawConfig,
      env,
      manifestRegistry: autoEnableManifestRegistry,
      discovery: metadataSnapshot?.discovery,
    });
  const autoEnabled = operationMetadata
    ? withPluginMetadataCollectionScope(operationMetadata, applyAutoEnable, {
        config: rawConfig,
        env,
        workspaceDir,
      })
    : applyAutoEnable();
  const config = autoEnabled.config;
  const installRecords = metadataSnapshot
    ? extractPluginInstallRecordsFromInstalledPluginIndex(metadataSnapshot.index)
    : undefined;
  return {
    rawConfig,
    config,
    activationSourceConfig,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir,
    env,
    logger: options?.logger ?? createPluginRuntimeLoaderLogger(),
    ...(manifestRegistry ? { manifestRegistry } : {}),
    ...(metadataSnapshot ? { metadataSnapshot } : {}),
    installRecords,
    preferBuiltPluginArtifacts: options?.preferBuiltPluginArtifacts === true,
  };
}

/** Builds plugin load options from a resolved runtime load context. */
export function buildPluginRuntimeLoadOptions(
  context: PluginRuntimeLoadContext,
  overrides?: Partial<PluginLoadOptions>,
): PluginLoadOptions {
  return buildPluginRuntimeLoadOptionsFromValues(context, overrides);
}

/** Builds plugin load options from explicit runtime load values. */
export function buildPluginRuntimeLoadOptionsFromValues(
  values: PluginRuntimeResolvedLoadValues,
  overrides?: Partial<PluginLoadOptions>,
): PluginLoadOptions {
  return {
    config: values.config,
    activationSourceConfig: values.activationSourceConfig,
    autoEnabledReasons: values.autoEnabledReasons,
    workspaceDir: values.workspaceDir,
    env: values.env,
    logger: values.logger,
    manifestRegistry: values.manifestRegistry,
    installRecords: values.installRecords,
    preferBuiltPluginArtifacts: values.preferBuiltPluginArtifacts,
    ...overrides,
  };
}

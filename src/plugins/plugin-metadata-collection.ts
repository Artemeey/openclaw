import { AsyncLocalStorage } from "node:async_hooks";
import {
  listAgentEntries,
  tryResolveAmbientOwnerAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope-config.js";
import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { readBundledDiscoveryMode } from "./bundled-discovery-state.js";
import type { PreparedPluginChannelCatalog } from "./channel-catalog-registry.js";
import { resolvePluginControlPlaneWorkspace } from "./control-plane-workspace.js";
import {
  setCurrentPluginMetadataSnapshot,
  withPluginMetadataSnapshotScope,
} from "./current-plugin-metadata-snapshot.js";
import {
  clearCurrentPluginMetadataSnapshot,
  getCurrentPluginMetadataOwner,
  getCurrentPluginMetadataSnapshotState,
  registerCurrentPluginChannelCatalogReader,
} from "./current-plugin-metadata-state.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { resolveInstalledPluginIndexStorePath } from "./installed-plugin-index-store-path.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { preparePluginChannelCatalogs } from "./plugin-metadata-catalog.js";
import {
  buildPluginMetadataOwnerMaps,
  freezePluginMetadataValue,
  isPluginMetadataSnapshotCompatible,
  loadPluginMetadataSnapshot,
  projectPluginMetadataSnapshot,
  resolvePluginMetadataEnvFingerprint,
} from "./plugin-metadata-snapshot.js";
import type {
  PluginMetadataSnapshot,
  PluginMetadataSnapshotPluginIdScope,
  ResolvePluginMetadataSnapshotParams,
} from "./plugin-metadata-snapshot.types.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";
import { serializePluginIdScope } from "./plugin-scope.js";

export {
  getCurrentPluginMetadataOwner,
  installPluginMetadataOwner,
} from "./current-plugin-metadata-state.js";

export type ConfigWidePluginMetadataView = Pick<
  PluginMetadataSnapshot,
  "manifestRegistry" | "plugins" | "byPluginId" | "owners" | "diagnostics"
>;

/** Config-wide metadata has no single executable index or workspace identity. */
export type PreparedPluginMetadata = ConfigWidePluginMetadataView & {
  readonly workspaces: ReadonlyMap<string | undefined, PluginMetadataSnapshot>;
  readonly configWorkspaceDirs: readonly (string | undefined)[];
  readonly envFingerprint: string;
  readonly bundledDiscoveryMode?: "compat" | "allowlist";
  readonly selectedSnapshot: PluginMetadataSnapshot;
  readonly channelCatalog: PreparedPluginChannelCatalog;
};

const scopedMetadata = resolveGlobalSingleton<AsyncLocalStorage<PreparedPluginMetadata>>(
  Symbol.for("openclaw.scopedPluginMetadataCollection"),
  () => new AsyncLocalStorage(),
);

export function getScopedPluginMetadata(
  env: NodeJS.ProcessEnv = process.env,
): PreparedPluginMetadata | undefined {
  const metadata = scopedMetadata.getStore();
  return metadata?.envFingerprint === resolvePluginMetadataEnvFingerprint(env)
    ? metadata
    : undefined;
}

registerCurrentPluginChannelCatalogReader(
  () =>
    scopedMetadata.getStore()?.channelCatalog ??
    getCurrentPluginMetadataOwner()?.getActive()?.channelCatalog,
);

/** Keeps control-plane callbacks on their prepared union and exact workspace graph. */
export function withPluginMetadataCollectionScope<T>(
  metadata: PreparedPluginMetadata,
  run: () => T,
  params: {
    config: OpenClawConfig;
    compatibleConfigs?: readonly OpenClawConfig[];
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
  },
): T {
  const snapshot = getPluginMetadataWorkspaceSnapshot(metadata, params);
  return scopedMetadata.run(metadata, () =>
    withPluginMetadataSnapshotScope(snapshot, run, {
      ...params,
      preparedConfigFingerprint: snapshot.configFingerprint,
    }),
  );
}

type PreparePluginMetadataParams = {
  config: OpenClawConfig;
  workspaceDir?: string;
  additionalWorkspaceDirs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  allowCurrent?: boolean;
  seed?: PreparedPluginMetadata;
};

type PluginMetadataScope = {
  pluginIds?: readonly string[];
  pluginIdScope?: PluginMetadataSnapshotPluginIdScope;
};

export type PluginMetadataOwner = {
  prepare: (params: PreparePluginMetadataParams) => PreparedPluginMetadata;
  publish: (
    metadata: PreparedPluginMetadata,
    params: { config: OpenClawConfig; sourceConfig?: OpenClawConfig; env?: NodeJS.ProcessEnv },
  ) => void;
  getActive: () => PreparedPluginMetadata | undefined;
  isPreparedCurrent: (metadata: PreparedPluginMetadata) => boolean;
  readSnapshot: (params: ResolvePluginMetadataSnapshotParams) => PluginMetadataSnapshot | undefined;
  readConfigWide: (
    params: PreparePluginMetadataParams & PluginMetadataScope,
  ) => ConfigWidePluginMetadataView | undefined;
  invalidatePreparation: () => void;
  dispose: () => void;
};

function mergeManifestRegistries(
  registries: readonly PluginManifestRegistry[],
): PluginManifestRegistry {
  const grouped = new Map<
    string,
    { plugin: PluginManifestRegistry["plugins"][number]; sources: Set<string> }
  >();
  const diagnostics = registries.flatMap((registry) => registry.diagnostics);
  for (const registry of registries) {
    for (const plugin of registry.plugins) {
      const id = normalizePluginPolicyId(plugin.id);
      const group = grouped.get(id) ?? { plugin, sources: new Set<string>() };
      group.plugin = plugin;
      group.sources.add(plugin.source);
      grouped.set(id, group);
    }
  }
  // Discovery order owns schema precedence; distinct sources cannot silently
  // turn one workspace's plugin into another workspace's execution owner.
  const plugins = [...grouped.entries()].flatMap(([pluginId, group]) => {
    if (group.sources.size === 1) {
      return [group.plugin];
    }
    diagnostics.push({
      level: "error",
      pluginId,
      message: `plugin id ${JSON.stringify(pluginId)} is present in multiple agent workspaces: ${[...group.sources].toSorted().join(", ")}`,
    });
    return [];
  });
  return { plugins, diagnostics };
}

function createManifestView(
  registries: readonly PluginManifestRegistry[],
): ConfigWidePluginMetadataView {
  const manifestRegistry = mergeManifestRegistries(registries);
  return freezePluginMetadataValue({
    manifestRegistry,
    plugins: manifestRegistry.plugins,
    diagnostics: manifestRegistry.diagnostics,
    byPluginId: new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin])),
    owners: buildPluginMetadataOwnerMaps(manifestRegistry.plugins),
  });
}

const validationViews = new WeakMap<
  PreparedPluginMetadata,
  { key: string; view: ConfigWidePluginMetadataView }
>();

/** Projects exact validation scope from each workspace without reading plugin files. */
export function projectConfigWidePluginMetadata(
  metadata: PreparedPluginMetadata,
  scope: PluginMetadataScope = {},
): ConfigWidePluginMetadataView {
  if (scope.pluginIds === undefined && scope.pluginIdScope === undefined) {
    return metadata;
  }
  const snapshots = metadata.configWorkspaceDirs.map((workspaceDir) =>
    projectPluginMetadataSnapshot(metadata.workspaces.get(workspaceDir)!, scope),
  );
  const key = JSON.stringify(
    snapshots.map((snapshot) => serializePluginIdScope(snapshot.pluginIds)),
  );
  const previous = validationViews.get(metadata);
  if (previous?.key === key) {
    return previous.view;
  }
  const view = createManifestView(snapshots.map((snapshot) => snapshot.manifestRegistry));
  validationViews.set(metadata, { key, view });
  return view;
}

/** Selects a workspace already prepared by this operation; never falls back to discovery. */
export function getPluginMetadataWorkspaceSnapshot(
  metadata: PreparedPluginMetadata,
  params: PluginMetadataScope & { workspaceDir?: string } = {},
): PluginMetadataSnapshot {
  const snapshot =
    params.workspaceDir === undefined
      ? metadata.selectedSnapshot
      : metadata.workspaces.get(params.workspaceDir);
  if (!snapshot) {
    throw new Error("Plugin metadata workspace was not prepared by the current operation");
  }
  return projectPluginMetadataSnapshot(snapshot, params);
}

type RetainedMetadata = {
  key: string;
  epoch: number;
  metadata: PreparedPluginMetadata;
  configIdentities: WeakSet<OpenClawConfig>;
};

/** Owns active metadata and one observed candidate, independently of config acceptance. */
export function createPluginMetadataOwner(): PluginMetadataOwner {
  let active: RetainedMetadata | undefined;
  let observed: RetainedMetadata | undefined;
  let publicationRevision: symbol | undefined;
  let epoch = 0;
  let disposed = false;
  const preparedEpochs = new WeakMap<PreparedPluginMetadata, number>();

  // Compare authored inputs before resolving paths: even resolving a default
  // state directory probes the filesystem and belongs to preparation only.
  const resolveKey = (params: PreparePluginMetadataParams) =>
    hashJson({
      stateDir: params.stateDir,
      env: resolvePluginMetadataEnvFingerprint(params.env ?? process.env),
      policy: resolveInstalledPluginIndexPolicyHash(params.config),
      loadPaths: params.config.plugins?.load?.paths,
      agents: listAgentEntries(params.config).map(({ id, workspace }) => ({ id, workspace })),
      defaultWorkspace: params.config.agents?.defaults?.workspace,
      owner: tryResolveAmbientOwnerAgentId(params.config),
      inheritedWorkspaceOwner: tryResolveLegacyCompatibilityAgentId(params.config),
      workspaceDir: params.workspaceDir,
    });

  const resolveInputs = (params: PreparePluginMetadataParams) => {
    const env = params.env ?? process.env;
    const configured = listAgentWorkspaceDirs(params.config, env);
    const workspaceDirs: Array<string | undefined> = configured.length ? configured : [undefined];
    const selectedWorkspace = resolvePluginControlPlaneWorkspace({
      config: params.config,
      env,
      workspaceDir: params.workspaceDir,
    }).workspaceDir;
    // An explicit roster without a system owner has a shared-root control
    // plane, not an implicit right to execute the first agent's plugins.
    if (!workspaceDirs.includes(selectedWorkspace)) {
      workspaceDirs.push(selectedWorkspace);
    }
    const key = resolveKey(params);
    const configWorkspaceDirs = [...workspaceDirs];
    for (const workspaceDir of params.additionalWorkspaceDirs ?? []) {
      if (!workspaceDirs.includes(workspaceDir)) {
        workspaceDirs.push(workspaceDir);
      }
    }
    return { env, workspaceDirs, configWorkspaceDirs, selectedWorkspace, key };
  };

  const findPrepared = (params: PreparePluginMetadataParams): RetainedMetadata | undefined => {
    if (params.allowCurrent === false) {
      return undefined;
    }
    const key = resolveKey(params);
    return [active, observed].find(
      (entry) =>
        entry?.key === key &&
        entry.epoch === epoch &&
        (params.additionalWorkspaceDirs ?? []).every((workspaceDir) =>
          entry.metadata.workspaces.has(workspaceDir),
        ),
    );
  };

  return {
    prepare(params) {
      if (disposed) {
        throw new Error("Plugin metadata owner has been disposed");
      }
      const preparationEpoch = epoch;
      const previous = findPrepared(params);
      if (previous) {
        return previous.metadata;
      }
      const { env, workspaceDirs, configWorkspaceDirs, selectedWorkspace, key } =
        resolveInputs(params);
      const envFingerprint = resolvePluginMetadataEnvFingerprint(env);
      const canReuse = params.allowCurrent !== false && params.stateDir === undefined;
      const seed =
        canReuse && params.seed?.envFingerprint === envFingerprint ? params.seed : undefined;
      const reusable = !canReuse
        ? []
        : [active, observed].filter(
            (entry) => entry?.epoch === epoch && entry.metadata.envFingerprint === envFingerprint,
          );
      const workspaces = new Map<string | undefined, PluginMetadataSnapshot>();
      for (const workspaceDir of workspaceDirs) {
        const seedSnapshot = seed?.workspaces.get(workspaceDir);
        const candidate = [
          seedSnapshot,
          ...reusable.map((entry) => entry?.metadata.workspaces.get(workspaceDir)),
        ].find(
          (snapshot) =>
            snapshot &&
            isPluginMetadataSnapshotCompatible({
              snapshot,
              config: params.config,
              env,
              workspaceDir,
              allowScopedSnapshot: true,
            }),
        );
        const snapshot =
          candidate ??
          loadPluginMetadataSnapshot({
            config: params.config,
            env,
            workspaceDir,
            stateDir: params.stateDir,
            allowCurrent: false,
          });
        workspaces.set(workspaceDir, snapshot);
      }
      const { catalog, discoveries } = preparePluginChannelCatalogs({
        config: params.config,
        env,
        stateDir: params.stateDir,
        workspaces,
      });
      for (const [workspaceDir, snapshot] of workspaces) {
        if (!snapshot.discovery) {
          workspaces.set(
            workspaceDir,
            freezePluginMetadataValue({ ...snapshot, discovery: discoveries.get(workspaceDir)! }),
          );
        }
      }
      const selectedSnapshot = workspaces.get(selectedWorkspace)!;
      const metadata = freezePluginMetadataValue({
        ...createManifestView(
          configWorkspaceDirs.map((workspaceDir) => workspaces.get(workspaceDir)!.manifestRegistry),
        ),
        workspaces,
        configWorkspaceDirs,
        envFingerprint,
        bundledDiscoveryMode: readBundledDiscoveryMode({
          env,
          path: resolveInstalledPluginIndexStorePath({ env, stateDir: params.stateDir }),
        }),
        selectedSnapshot,
        channelCatalog: catalog,
      });
      if (disposed || preparationEpoch !== epoch) {
        throw new Error("Plugin metadata preparation was superseded");
      }
      preparedEpochs.set(metadata, epoch);
      observed = {
        key,
        epoch,
        metadata,
        configIdentities: new WeakSet(),
      };
      return metadata;
    },
    publish(metadata, params) {
      if (disposed || preparedEpochs.get(metadata) !== epoch) {
        throw new Error("Plugin metadata preparation was superseded before publication");
      }
      const sourceConfig = params.sourceConfig ?? params.config;
      const key = resolveKey({ config: sourceConfig, env: params.env });
      active = {
        key,
        epoch,
        metadata,
        configIdentities: new WeakSet([sourceConfig, params.config]),
      };
      if (observed?.metadata === metadata) {
        observed = undefined;
      }
      setCurrentPluginMetadataSnapshot(metadata.selectedSnapshot, {
        config: sourceConfig,
        compatibleConfigs: [params.config],
        env: params.env,
        workspaceDir: metadata.selectedSnapshot.workspaceDir,
      });
      publicationRevision = getCurrentPluginMetadataSnapshotState().revision;
    },
    getActive: () => active?.metadata,
    isPreparedCurrent: (metadata) => !disposed && preparedEpochs.get(metadata) === epoch,
    readSnapshot(params) {
      if (
        params.allowCurrent === false ||
        params.preferPersisted === false ||
        params.stateDir !== undefined
      ) {
        return undefined;
      }
      for (const entry of [active, observed]) {
        if (
          !entry ||
          entry.metadata.envFingerprint !==
            resolvePluginMetadataEnvFingerprint(params.env ?? process.env)
        ) {
          continue;
        }
        const workspaceDir =
          params.workspaceDir ??
          (params.allowWorkspaceScopedCurrent
            ? entry.metadata.selectedSnapshot.workspaceDir
            : undefined);
        const snapshot = entry.metadata.workspaces.get(workspaceDir);
        if (!snapshot || (params.index && params.index !== snapshot.index)) {
          continue;
        }
        if (
          !(params.config && entry.configIdentities.has(params.config)) &&
          !isPluginMetadataSnapshotCompatible({
            snapshot,
            config: params.config,
            env: params.env,
            workspaceDir,
          })
        ) {
          continue;
        }
        return projectPluginMetadataSnapshot(snapshot, params);
      }
      return undefined;
    },
    readConfigWide(params) {
      if (params.allowCurrent === false || params.stateDir !== undefined) {
        return undefined;
      }
      const entry =
        active &&
        active.metadata.envFingerprint ===
          resolvePluginMetadataEnvFingerprint(params.env ?? process.env) &&
        (active.configIdentities.has(params.config) || active.key === resolveKey(params))
          ? active
          : findPrepared(params);
      return entry ? projectConfigWidePluginMetadata(entry.metadata, params) : undefined;
    },
    invalidatePreparation() {
      epoch += 1;
      observed = undefined;
    },
    dispose() {
      if (getCurrentPluginMetadataSnapshotState().revision === publicationRevision) {
        clearCurrentPluginMetadataSnapshot();
      }
      publicationRevision = undefined;
      active = undefined;
      observed = undefined;
      disposed = true;
      epoch += 1;
    },
  };
}

/** Prepares one explicit operation without publishing over the Gateway's metadata. */
export function preparePluginMetadata(params: PreparePluginMetadataParams): PreparedPluginMetadata {
  const seed =
    params.allowCurrent === false
      ? undefined
      : (params.seed ??
        getScopedPluginMetadata(params.env) ??
        getCurrentPluginMetadataOwner()?.getActive());
  return createPluginMetadataOwner().prepare({ ...params, seed });
}

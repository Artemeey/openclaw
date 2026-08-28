import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getActiveDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../infra/diagnostics-timeline.js";
import {
  getCurrentPluginMetadataSnapshot,
  isCurrentPluginMetadataSnapshotRuntimeGeneration,
} from "./current-plugin-metadata-snapshot.js";
import { getCurrentPluginMetadataOwner } from "./current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import {
  loadPluginManifestRegistryForInstalledIndex,
  resolveInstalledManifestRegistryIndexFingerprint,
} from "./manifest-registry-installed.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { resolvePluginControlPlaneFingerprint } from "./plugin-control-plane-context.js";
import { buildPluginMetadataProviderFacts } from "./plugin-metadata-provider-facts.js";
import { registerPluginMetadataSnapshotReaders } from "./plugin-metadata-snapshot.runtime.js";
import type {
  LoadPluginMetadataSnapshotParams,
  PluginMetadataSnapshot,
  PluginMetadataSnapshotOwnerMaps,
  ResolvePluginMetadataSnapshotParams,
} from "./plugin-metadata-snapshot.types.js";
import { createPluginRegistryIdNormalizer } from "./plugin-registry-id-normalizer.js";
import { loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-snapshot.js";
import { normalizePluginIdScope, serializePluginIdScope } from "./plugin-scope.js";

export { resolvePluginMetadataEnvFingerprint } from "./plugin-metadata-env.js";
export type {
  PluginMetadataSnapshot,
  PluginMetadataSnapshotOwnerMaps,
} from "./plugin-metadata-snapshot.types.js";

function throwReadonlyPluginMetadataMutation(): never {
  throw new TypeError("Plugin metadata snapshots are immutable");
}

export function freezePluginMetadataValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      freezePluginMetadataValue(key, seen);
      freezePluginMetadataValue(entry, seen);
    }
    Object.defineProperties(value, {
      clear: { value: throwReadonlyPluginMetadataMutation },
      delete: { value: throwReadonlyPluginMetadataMutation },
      set: { value: throwReadonlyPluginMetadataMutation },
    });
    return Object.freeze(value);
  }
  if (value instanceof Set) {
    for (const entry of value) {
      freezePluginMetadataValue(entry, seen);
    }
    Object.defineProperties(value, {
      add: { value: throwReadonlyPluginMetadataMutation },
      clear: { value: throwReadonlyPluginMetadataMutation },
      delete: { value: throwReadonlyPluginMetadataMutation },
    });
    return Object.freeze(value);
  }
  for (const entry of Object.values(value)) {
    freezePluginMetadataValue(entry, seen);
  }
  return Object.freeze(value);
}

function indexesMatch(
  left: InstalledPluginIndex | undefined,
  right: InstalledPluginIndex | undefined,
): boolean {
  if (!left || !right) {
    return true;
  }
  return (
    resolveInstalledManifestRegistryIndexFingerprint(left) ===
    resolveInstalledManifestRegistryIndexFingerprint(right)
  );
}

/** Restores process-local behavior and immutability after a snapshot crosses a worker boundary. */
export function restorePluginMetadataSnapshot(
  snapshot: Omit<PluginMetadataSnapshot, "normalizePluginId">,
): PluginMetadataSnapshot {
  return freezePluginMetadataValue({
    ...snapshot,
    normalizePluginId: createPluginRegistryIdNormalizer(snapshot.index, {
      manifestRegistry: snapshot.manifestRegistry,
    }),
  });
}

function resolvePluginMetadataSnapshotPluginIds(params: {
  index: InstalledPluginIndex;
  params: LoadPluginMetadataSnapshotParams;
}): string[] | undefined {
  const direct = normalizePluginIdScope(params.params.pluginIds);
  if (direct !== undefined) {
    return direct;
  }
  return normalizePluginIdScope(params.params.pluginIdScope?.resolve({ index: params.index }));
}

export function isPluginMetadataSnapshotCompatible(params: {
  snapshot: Pick<
    PluginMetadataSnapshot,
    "configFingerprint" | "index" | "pluginIds" | "policyHash" | "workspaceDir"
  >;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  allowScopedSnapshot?: boolean;
  pluginIds?: readonly string[];
  workspaceDir?: string;
  index?: InstalledPluginIndex;
}): boolean {
  const env = params.env ?? process.env;
  const requestedPluginIds = normalizePluginIdScope(params.pluginIds);
  const snapshotPluginIds = normalizePluginIdScope(params.snapshot.pluginIds);
  const scopeMatches =
    snapshotPluginIds === undefined ||
    params.allowScopedSnapshot === true ||
    (requestedPluginIds !== undefined &&
      serializePluginIdScope(snapshotPluginIds) === serializePluginIdScope(requestedPluginIds));
  return (
    scopeMatches &&
    params.snapshot.policyHash === resolveInstalledPluginIndexPolicyHash(params.config) &&
    (!params.snapshot.configFingerprint ||
      params.snapshot.configFingerprint ===
        resolvePluginControlPlaneFingerprint({
          config: params.config,
          env,
          index: params.index ?? params.snapshot.index,
          policyHash: params.snapshot.policyHash,
          workspaceDir: params.workspaceDir,
        })) &&
    (params.snapshot.workspaceDir ?? "") === (params.workspaceDir ?? "") &&
    indexesMatch(params.snapshot.index, params.index)
  );
}

function appendOwner(owners: Map<string, string[]>, ownedId: string, pluginId: string): void {
  const existing = owners.get(ownedId);
  if (existing) {
    if (existing.includes(pluginId)) {
      return;
    }
    existing.push(pluginId);
    return;
  }
  owners.set(ownedId, [pluginId]);
}

function freezeOwnerMap(owners: Map<string, string[]>): ReadonlyMap<string, readonly string[]> {
  return new Map(
    [...owners.entries()].map(([ownedId, pluginIds]) => [ownedId, Object.freeze([...pluginIds])]),
  );
}

export function buildPluginMetadataOwnerMaps(
  plugins: readonly PluginManifestRecord[],
): PluginMetadataSnapshotOwnerMaps {
  const channels = new Map<string, string[]>();
  const channelConfigs = new Map<string, string[]>();
  const providers = new Map<string, string[]>();
  const modelCatalogProviders = new Map<string, string[]>();
  const cliBackends = new Map<string, string[]>();
  const setupProviders = new Map<string, string[]>();
  const commandAliases = new Map<string, string[]>();
  const contracts = new Map<string, string[]>();

  for (const plugin of plugins) {
    for (const channelId of plugin.channels ?? []) {
      appendOwner(channels, channelId, plugin.id);
    }
    for (const channelId of Object.keys(plugin.channelConfigs ?? {})) {
      appendOwner(channelConfigs, channelId, plugin.id);
    }
    for (const providerId of plugin.providers ?? []) {
      appendOwner(providers, providerId, plugin.id);
    }
    for (const [rawAlias, target] of Object.entries(plugin.providerAuthAliases ?? {})) {
      const alias = normalizeProviderId(rawAlias);
      const targetProvider = normalizeProviderId(target);
      if (
        alias &&
        targetProvider &&
        (plugin.providers ?? []).some(
          (providerId) => normalizeProviderId(providerId) === targetProvider,
        )
      ) {
        appendOwner(providers, alias, plugin.id);
      }
    }
    for (const providerId of Object.keys(plugin.modelCatalog?.providers ?? {})) {
      appendOwner(modelCatalogProviders, providerId, plugin.id);
    }
    for (const providerId of Object.keys(plugin.modelCatalog?.aliases ?? {})) {
      appendOwner(modelCatalogProviders, providerId, plugin.id);
    }
    for (const cliBackendId of plugin.cliBackends ?? []) {
      appendOwner(cliBackends, cliBackendId, plugin.id);
    }
    for (const cliBackendId of plugin.setup?.cliBackends ?? []) {
      appendOwner(cliBackends, cliBackendId, plugin.id);
    }
    for (const setupProvider of plugin.setup?.providers ?? []) {
      appendOwner(setupProviders, setupProvider.id, plugin.id);
    }
    for (const commandAlias of plugin.commandAliases ?? []) {
      appendOwner(commandAliases, commandAlias.name, plugin.id);
    }
    for (const [contract, values] of Object.entries(plugin.contracts ?? {})) {
      if (Array.isArray(values) && values.length > 0) {
        appendOwner(contracts, contract, plugin.id);
      }
    }
  }

  return {
    channels: freezeOwnerMap(channels),
    channelConfigs: freezeOwnerMap(channelConfigs),
    providers: freezeOwnerMap(providers),
    modelCatalogProviders: freezeOwnerMap(modelCatalogProviders),
    cliBackends: freezeOwnerMap(cliBackends),
    setupProviders: freezeOwnerMap(setupProviders),
    commandAliases: freezeOwnerMap(commandAliases),
    contracts: freezeOwnerMap(contracts),
    ...buildPluginMetadataProviderFacts(plugins),
  };
}

export function listPluginOriginsFromMetadataSnapshot(
  snapshot: Pick<PluginMetadataSnapshot, "plugins">,
): ReadonlyMap<string, PluginManifestRecord["origin"]> {
  return new Map(snapshot.plugins.map((record) => [record.id, record.origin]));
}

/** Rebuilds every manifest-derived snapshot fact from one authoritative registry. */
export function rebasePluginMetadataSnapshotManifestRegistry(
  snapshot: PluginMetadataSnapshot,
  manifestRegistry: PluginManifestRegistry,
): PluginMetadataSnapshot {
  const plugins = manifestRegistry.plugins;
  return {
    ...snapshot,
    manifestRegistry,
    plugins,
    diagnostics: manifestRegistry.diagnostics,
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    normalizePluginId: snapshot.index
      ? createPluginRegistryIdNormalizer(snapshot.index, { manifestRegistry })
      : snapshot.normalizePluginId,
    owners: buildPluginMetadataOwnerMaps(plugins),
    ...(snapshot.metrics
      ? { metrics: { ...snapshot.metrics, manifestPluginCount: plugins.length } }
      : {}),
  };
}

const projectedMetadata = new WeakMap<
  PluginMetadataSnapshot,
  { key: string; snapshot: PluginMetadataSnapshot }
>();

/** Selects manifests from an already prepared workspace without reopening its inventory. */
export function projectPluginMetadataSnapshot(
  snapshot: PluginMetadataSnapshot,
  params: Pick<LoadPluginMetadataSnapshotParams, "pluginIds" | "pluginIdScope">,
): PluginMetadataSnapshot {
  const pluginIds = resolvePluginMetadataSnapshotPluginIds({ index: snapshot.index, params });
  if (serializePluginIdScope(pluginIds) === serializePluginIdScope(snapshot.pluginIds)) {
    return snapshot;
  }
  if (pluginIds === undefined) {
    throw new Error("A complete plugin metadata view must be prepared by its owner");
  }
  if (snapshot.pluginIds && pluginIds.some((pluginId) => !snapshot.pluginIds!.includes(pluginId))) {
    throw new Error("Plugin metadata projection cannot widen a prepared scope");
  }
  const key = serializePluginIdScope(pluginIds);
  const previous = projectedMetadata.get(snapshot);
  if (previous?.key === key) {
    return previous.snapshot;
  }
  const selected = new Set(pluginIds);
  const manifestRegistry = {
    plugins: snapshot.plugins.filter((plugin) => selected.has(plugin.id)),
    diagnostics:
      pluginIds.length === 0
        ? []
        : snapshot.diagnostics.filter(
            (diagnostic) => !diagnostic.pluginId || selected.has(diagnostic.pluginId),
          ),
  };
  const projected = freezePluginMetadataValue({
    ...rebasePluginMetadataSnapshotManifestRegistry(snapshot, manifestRegistry),
    pluginIds,
  });
  projectedMetadata.set(snapshot, { key, snapshot: projected });
  return projected;
}

export function loadPluginMetadataSnapshot(
  params: LoadPluginMetadataSnapshotParams,
): PluginMetadataSnapshot {
  const activeTimelineSpan = getActiveDiagnosticsTimelineSpan();
  const snapshot = measureDiagnosticsTimelineSpanSync(
    "plugins.metadata.scan",
    () => loadPluginMetadataSnapshotImpl(params),
    {
      phase:
        activeTimelineSpan?.phase ??
        (getCurrentPluginMetadataOwner()?.getActive() ? "runtime" : "startup"),
      config: params.config,
      env: params.env,
      attributes: {
        hasWorkspaceDir: params.workspaceDir !== undefined,
        hasInstalledIndex: params.index !== undefined,
      },
    },
  );
  return measureDiagnosticsTimelineSpanSync(
    "plugins.metadata.freeze",
    () => restorePluginMetadataSnapshot(snapshot),
    {
      phase:
        activeTimelineSpan?.phase ??
        (getCurrentPluginMetadataOwner()?.getActive() ? "runtime" : "startup"),
      config: params.config,
      env: params.env,
      attributes: {
        indexPluginCount: snapshot.index.plugins.length,
        manifestPluginCount: snapshot.plugins.length,
      },
    },
  );
}

export function resolvePluginMetadataSnapshot(
  params: ResolvePluginMetadataSnapshotParams,
): PluginMetadataSnapshot {
  const canUseCurrentSnapshot =
    params.allowCurrent !== false &&
    params.stateDir === undefined &&
    params.preferPersisted !== false;
  if (canUseCurrentSnapshot) {
    const current = getCurrentPluginMetadataSnapshot({
      config: params.config,
      env: params.env,
      ...(params.config === undefined ? { requireDefaultDiscoveryContext: true } : {}),
      ...(params.pluginIds !== undefined ? { pluginIds: params.pluginIds } : {}),
      ...(params.pluginIdScope !== undefined ? { pluginIdScope: params.pluginIdScope } : {}),
      ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
      ...(params.allowWorkspaceScopedCurrent === true
        ? { allowWorkspaceScopedSnapshot: true }
        : {}),
    });
    if (!current) {
      if (params.pluginIds !== undefined || params.pluginIdScope !== undefined) {
        const prepared = getCurrentPluginMetadataSnapshot({
          config: params.config,
          env: params.env,
          workspaceDir: params.workspaceDir,
          allowWorkspaceScopedSnapshot: params.allowWorkspaceScopedCurrent,
          requireDefaultDiscoveryContext: params.config === undefined,
        });
        if (
          prepared &&
          (!params.index ||
            isCurrentPluginMetadataSnapshotRuntimeGeneration(prepared) ||
            indexesMatch(prepared.index, params.index))
        ) {
          return projectPluginMetadataSnapshot(prepared, params);
        }
      }
      const owner = getCurrentPluginMetadataOwner();
      const prepared = owner?.readSnapshot(params);
      if (prepared) {
        return prepared;
      }
      if (owner?.getActive()) {
        throw new Error("Plugin metadata lookup escaped its prepared config or workspace");
      }
      return loadPluginMetadataSnapshot(params);
    }
    if (!params.index || isCurrentPluginMetadataSnapshotRuntimeGeneration(current)) {
      return current;
    }
    if (
      isPluginMetadataSnapshotCompatible({
        snapshot: current,
        config: params.config,
        env: params.env,
        allowScopedSnapshot: params.pluginIds !== undefined || params.pluginIdScope !== undefined,
        workspaceDir:
          params.workspaceDir ??
          (params.allowWorkspaceScopedCurrent === true ? current.workspaceDir : undefined),
        index: params.index,
      })
    ) {
      return current;
    }
  }
  return loadPluginMetadataSnapshot(params);
}

function loadPluginMetadataSnapshotImpl(
  params: LoadPluginMetadataSnapshotParams,
): Omit<PluginMetadataSnapshot, "normalizePluginId"> {
  const totalStartedAt = performance.now();
  const registryStartedAt = performance.now();
  const registryResult = loadPluginRegistrySnapshotWithMetadata({
    config: params.config,
    workspaceDir: params.workspaceDir,
    ...(params.stateDir ? { stateDir: params.stateDir } : {}),
    env: params.env,
    ...(params.preferPersisted !== undefined ? { preferPersisted: params.preferPersisted } : {}),
    ...(params.allowCurrent !== undefined ? { allowCurrent: params.allowCurrent } : {}),
    ...(params.index ? { index: params.index } : {}),
  });
  const registrySnapshotMs = performance.now() - registryStartedAt;
  const index = structuredClone(registryResult.snapshot);
  index.diagnostics ??= [];
  const pluginIds = resolvePluginMetadataSnapshotPluginIds({ params, index });
  const manifestStartedAt = performance.now();
  // Empty installed indexes are authoritative; bootstrap first derives a real
  // index so every manifest and scope follows the same immutable graph.
  const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
    index,
    ...(registryResult.manifestRegistry
      ? { manifestRegistry: registryResult.manifestRegistry }
      : {}),
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    ...(pluginIds !== undefined ? { pluginIds } : {}),
    includeDisabled: true,
  });
  const manifestRegistryMs = performance.now() - manifestStartedAt;
  const byPluginId = new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin]));
  const ownerMapsStartedAt = performance.now();
  const owners = buildPluginMetadataOwnerMaps(manifestRegistry.plugins);
  const ownerMapsMs = performance.now() - ownerMapsStartedAt;
  const totalMs = performance.now() - totalStartedAt;

  return {
    policyHash: index.policyHash,
    registrySource: registryResult.source,
    configFingerprint: resolvePluginControlPlaneFingerprint({
      config: params.config,
      env: params.env,
      index,
      policyHash: index.policyHash,
      workspaceDir: params.workspaceDir,
    }),
    ...(pluginIds !== undefined ? { pluginIds } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    index,
    registryDiagnostics: registryResult.diagnostics,
    manifestRegistry,
    plugins: manifestRegistry.plugins,
    diagnostics: manifestRegistry.diagnostics,
    byPluginId,
    owners,
    metrics: {
      registrySnapshotMs,
      manifestRegistryMs,
      ownerMapsMs,
      totalMs,
      indexPluginCount: index.plugins.length,
      manifestPluginCount: manifestRegistry.plugins.length,
    },
    discovery: registryResult.discovery,
  };
}

// Light bridges (plugin-metadata-snapshot.runtime.ts) serve loads through this
// instance whenever the metadata system is loaded; the require fallback only
// covers cold processes.
registerPluginMetadataSnapshotReaders({ resolvePluginMetadataSnapshot });

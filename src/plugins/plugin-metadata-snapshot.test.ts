// Verifies lifecycle snapshot loading, ownership facts, and immutable boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfigWidePluginManifestRegistry } from "../config/io.plugin-metadata.js";
import {
  getCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import {
  createPluginMetadataOwner,
  getPluginMetadataWorkspaceSnapshot,
  installPluginMetadataOwner,
  withPluginMetadataCollectionScope,
} from "./plugin-metadata-collection.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
  restorePluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";

const { loadPluginRegistrySnapshotWithMetadata, loadPluginManifestRegistryForInstalledIndex } =
  vi.hoisted(() => {
    // Shared plugin workers must load this graph after this file's mocks are installed.
    vi.resetModules();
    return {
      loadPluginRegistrySnapshotWithMetadata: vi.fn(),
      loadPluginManifestRegistryForInstalledIndex: vi.fn(),
    };
  });

vi.mock("./plugin-registry-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-registry-snapshot.js")>();
  return {
    ...actual,
    loadPluginRegistrySnapshotWithMetadata: (params: unknown) =>
      loadPluginRegistrySnapshotWithMetadata(params),
  };
});

vi.mock("./manifest-registry-installed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest-registry-installed.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForInstalledIndex: (params: unknown) =>
      loadPluginManifestRegistryForInstalledIndex(params),
  };
});

vi.mock("./plugin-metadata-catalog.js", () => ({
  preparePluginChannelCatalogs: ({
    workspaces,
  }: {
    workspaces: ReadonlyMap<string | undefined, unknown>;
  }) => ({
    catalog: { read: () => [] },
    discoveries: new Map(
      [...workspaces.keys()].map((workspaceDir) => [
        workspaceDir,
        { candidates: [], diagnostics: [] },
      ]),
    ),
  }),
}));

function makeIndex(pluginId = "demo"): InstalledPluginIndex {
  const rootDir = `/plugins/${pluginId}`;
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 1,
    installRecords: {},
    diagnostics: [],
    plugins: [
      {
        pluginId,
        manifestPath: `${rootDir}/openclaw.plugin.json`,
        manifestHash: `${pluginId}-manifest`,
        rootDir,
        origin: "global",
        enabled: true,
        startup: {
          sidecar: false,
          memory: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
  };
}

function makeManifestRegistry(pluginId = "demo"): PluginManifestRegistry {
  const plugin: PluginManifestRecord = {
    id: pluginId,
    name: pluginId,
    channels: [],
    providers: [pluginId],
    cliBackends: [],
    skills: [],
    hooks: [],
    commandAliases: [{ name: `${pluginId}-command` }],
    rootDir: `/plugins/${pluginId}`,
    source: `/plugins/${pluginId}/index.js`,
    manifestPath: `/plugins/${pluginId}/openclaw.plugin.json`,
    origin: "global",
  };
  return { plugins: [plugin], diagnostics: [] };
}

describe("plugin metadata snapshot", () => {
  const ownerDisposers: Array<() => void> = [];
  beforeEach(() => {
    loadPluginRegistrySnapshotWithMetadata.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(makeManifestRegistry());
  });

  afterEach(() => {
    for (const dispose of ownerDisposers.splice(0)) {
      dispose();
    }
    clearPluginMetadataLifecycleCaches();
  });

  it("keeps explicit control-plane loads fresh", () => {
    const index = makeIndex();
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });

    const first = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    const second = loadPluginMetadataSnapshot({ config: {}, env: {}, index });

    expect(second).not.toBe(first);
    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(2);
  });

  it("cold-loads the requested workspace instead of reusing a different lifecycle graph", () => {
    const config = {};
    const sourceWorkspace = "/workspace/source";
    const targetWorkspace = "/workspace/target";
    const staleIndex = makeIndex("stale");
    staleIndex.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    staleIndex.workspaceDir = sourceWorkspace;
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: staleIndex,
      diagnostics: [],
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(makeManifestRegistry("stale"));
    const stale = loadPluginMetadataSnapshot({
      config,
      env: {},
      index: staleIndex,
      workspaceDir: sourceWorkspace,
    });
    setCurrentPluginMetadataSnapshot(stale, { config, env: {}, workspaceDir: sourceWorkspace });

    // Convergence replaced the persisted inventory; a fresh load now sees a different graph.
    const freshIndex = makeIndex("fresh");
    freshIndex.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    freshIndex.workspaceDir = targetWorkspace;
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: freshIndex,
      diagnostics: [],
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(makeManifestRegistry("fresh"));

    const resolved = resolvePluginMetadataSnapshot({
      config,
      env: {},
      workspaceDir: targetWorkspace,
    });

    expect(resolved.index.plugins.map((plugin) => plugin.pluginId)).toEqual(["fresh"]);
    expect(resolved.configFingerprint).toBe(
      loadPluginMetadataSnapshot({ config, env: {}, workspaceDir: targetWorkspace })
        .configFingerprint,
    );
  });

  it("rewalks collection-bearing manifest graphs after prototype mutation", () => {
    const index = makeIndex();
    const registry = makeManifestRegistry();
    const plugin = registry.plugins[0];
    if (!plugin) {
      throw new Error("expected manifest plugin fixture");
    }
    const initialMapValue = { nested: { value: "initial-map" } };
    const initialSetValue = { nested: { value: "initial-set" } };
    const sharedMap = new Map([["initial", initialMapValue]]);
    const sharedSet = new Set([initialSetValue]);
    plugin.configSchema = {
      type: "object",
      properties: { sharedMap, sharedSet },
    };
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(registry);

    const first = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    expect(Object.isFrozen(initialMapValue.nested)).toBe(true);
    expect(Object.isFrozen(initialSetValue.nested)).toBe(true);
    expect(() => sharedMap.set("blocked", initialMapValue)).toThrow(
      "Plugin metadata snapshots are immutable",
    );
    expect(() => sharedSet.add(initialSetValue)).toThrow("Plugin metadata snapshots are immutable");

    const injectedMapValue = { nested: { value: "injected-map" } };
    const injectedSetValue = { nested: { value: "injected-set" } };
    Map.prototype.set.call(sharedMap, "injected", injectedMapValue);
    Set.prototype.add.call(sharedSet, injectedSetValue);
    expect(sharedMap.get("injected")).toBe(injectedMapValue);
    expect(sharedSet.has(injectedSetValue)).toBe(true);
    expect(Object.isFrozen(injectedMapValue.nested)).toBe(false);
    expect(Object.isFrozen(injectedSetValue.nested)).toBe(false);

    const second = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    expect(second).not.toBe(first);
    expect(second.index).not.toBe(first.index);
    expect(second.manifestRegistry).toBe(registry);
    expect(Object.isFrozen(injectedMapValue)).toBe(true);
    expect(Object.isFrozen(injectedMapValue.nested)).toBe(true);
    expect(Object.isFrozen(injectedSetValue)).toBe(true);
    expect(Object.isFrozen(injectedSetValue.nested)).toBe(true);
    expect(() => {
      injectedMapValue.nested.value = "mutated";
    }).toThrow();
    expect(() => {
      injectedSetValue.nested.value = "mutated";
    }).toThrow();
    expect(() => sharedMap.delete("injected")).toThrow("Plugin metadata snapshots are immutable");
    expect(() => sharedSet.delete(injectedSetValue)).toThrow(
      "Plugin metadata snapshots are immutable",
    );
  });

  it("rewalks enumerable accessor graphs when their closure-backed values change", () => {
    const index = makeIndex();
    const registry = makeManifestRegistry();
    const plugin = registry.plugins[0];
    if (!plugin) {
      throw new Error("expected manifest plugin fixture");
    }
    let accessorValue = { nested: { value: "initial" } };
    const accessor = {} as { current: typeof accessorValue };
    Object.defineProperty(accessor, "current", {
      enumerable: true,
      get: () => accessorValue,
    });
    plugin.configSchema = {
      type: "object",
      properties: { accessor },
    };
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(registry);

    const first = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    expect(Object.isFrozen(accessor)).toBe(true);
    expect(Object.isFrozen(accessorValue)).toBe(true);
    expect(Object.isFrozen(accessorValue.nested)).toBe(true);

    const replacement = { nested: { value: "replacement" } };
    accessorValue = replacement;
    expect(accessor.current).toBe(replacement);
    expect(Object.isFrozen(replacement)).toBe(false);
    expect(Object.isFrozen(replacement.nested)).toBe(false);

    const second = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    expect(second).not.toBe(first);
    expect(second.index).not.toBe(first.index);
    expect(second.manifestRegistry).toBe(registry);
    expect(Object.isFrozen(replacement)).toBe(true);
    expect(Object.isFrozen(replacement.nested)).toBe(true);
    expect(() => {
      replacement.nested.value = "mutated";
    }).toThrow();
  });

  it("rewalks proxy graphs that forge safe descriptors before their values change", () => {
    const index = makeIndex();
    const registry = makeManifestRegistry();
    const plugin = registry.plugins[0];
    if (!plugin) {
      throw new Error("expected manifest plugin fixture");
    }
    let currentValue = { nested: { value: "decoy" } };
    const target = {} as { current: typeof currentValue };
    Object.defineProperty(target, "current", {
      configurable: true,
      enumerable: true,
      get: () => currentValue,
    });
    let forgedDescriptors = 0;
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor(proxyTarget, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(proxyTarget, key);
        // Preserve the real accessor during Object.freeze so later proxy reads remain valid.
        if (key === "current" && descriptor?.configurable && forgedDescriptors < 1) {
          forgedDescriptors += 1;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: currentValue,
          };
        }
        return descriptor;
      },
      get(proxyTarget, key, receiver) {
        if (key === "current") {
          return currentValue;
        }
        return Reflect.get(proxyTarget, key, receiver);
      },
    });
    plugin.configSchema = {
      type: "object",
      properties: { proxy },
    };
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(registry);

    const first = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    expect(forgedDescriptors).toBe(1);
    expect(Object.isFrozen(proxy)).toBe(true);
    expect(Object.isFrozen(currentValue.nested)).toBe(true);

    const replacement = { nested: { value: "real" } };
    currentValue = replacement;
    expect(proxy.current).toBe(replacement);
    expect(Object.isFrozen(replacement)).toBe(false);
    expect(Object.isFrozen(replacement.nested)).toBe(false);

    const second = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    expect(second).not.toBe(first);
    expect(second.index).not.toBe(first.index);
    expect(second.manifestRegistry).toBe(registry);
    expect(Object.isFrozen(replacement)).toBe(true);
    expect(Object.isFrozen(replacement.nested)).toBe(true);
    expect(() => {
      replacement.nested.value = "mutated";
    }).toThrow();
  });

  it("reuses discovery from a derived empty plugin index", () => {
    const index = makeIndex();
    index.plugins = [];
    const discovery: PluginDiscoveryResult = { candidates: [], diagnostics: [] };
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: index,
      diagnostics: [],
      discovery,
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    const snapshot = loadPluginMetadataSnapshot({ config: {}, env: {} });

    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        index: expect.objectContaining({ plugins: [] }),
        includeDisabled: true,
      }),
    );
    expect(snapshot.discovery).toBe(discovery);
  });

  it("keeps an empty installed index authoritative without rediscovering plugins", () => {
    const index = makeIndex();
    index.plugins = [];
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: index,
      diagnostics: [],
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    const snapshot = loadPluginMetadataSnapshot({ config: {}, env: {}, index });

    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.index.plugins).toEqual([]);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        index: expect.objectContaining({ plugins: [] }),
        includeDisabled: true,
      }),
    );
  });

  it("carries a derived manifest graph into snapshot construction without rebuilding it", () => {
    const index = makeIndex();
    const manifestRegistry = makeManifestRegistry();
    const discovery: PluginDiscoveryResult = { candidates: [], diagnostics: [] };
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: index,
      diagnostics: [],
      discovery,
      manifestRegistry,
    });

    const snapshot = loadPluginMetadataSnapshot({ config: {}, env: {} });

    expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["demo"]);
    expect(snapshot.registrySource).toBe("derived");
    expect(snapshot.discovery).toBe(discovery);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        manifestRegistry,
        includeDisabled: true,
      }),
    );
  });

  it("reuses a published snapshot across config objects until its owner replaces it", () => {
    const config = { plugins: { entries: { demo: { enabled: true } } } };
    const index = makeIndex();
    index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });
    const snapshot = loadPluginMetadataSnapshot({ config, env: {}, index });
    setCurrentPluginMetadataSnapshot(snapshot, { config, env: {} });
    const ignored = { ...snapshot, registrySource: "persisted" as const };
    loadPluginRegistrySnapshotWithMetadata.mockClear();
    loadPluginManifestRegistryForInstalledIndex.mockClear();

    expect(resolvePluginMetadataSnapshot({ config: structuredClone(config), env: {} })).toBe(
      snapshot,
    );
    expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
    expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();

    setCurrentPluginMetadataSnapshot(ignored, { config, env: {} });
    expect(resolvePluginMetadataSnapshot({ config: structuredClone(config), env: {} })).toBe(
      ignored,
    );
  });

  it("keeps cold unscoped loads local even for equivalent selected-agent model configs", () => {
    const config = {
      agents: {
        entries: { ops: { models: { "openai/ops": { alias: "Operations" } } } },
      },
    };
    const index = makeIndex();
    index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: index,
      diagnostics: [],
    });

    const snapshot = resolvePluginMetadataSnapshot({ config, env: {} });

    expect(resolvePluginMetadataSnapshot({ config: structuredClone(config), env: {} })).not.toBe(
      snapshot,
    );
    expect(
      resolvePluginMetadataSnapshot({
        config: {
          agents: {
            entries: { support: { models: { "openai/support": { alias: "Support" } } } },
          },
        },
        env: {},
      }),
    ).not.toBe(snapshot);
    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(3);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(3);
  });

  it.each([
    { scope: "workspace", options: { workspaceDir: "/workspace" } },
    { scope: "plugin", options: { pluginIds: ["demo"] } },
    { scope: "empty plugin", options: { pluginIds: [] } },
    { scope: "caller-owned index", options: { index: makeIndex() } },
    { scope: "current bypass", options: { allowCurrent: false } },
    { scope: "persisted bypass", options: { preferPersisted: false } },
    { scope: "state override", options: { stateDir: "/state" } },
  ])("does not publish a cold $scope snapshot as process metadata", ({ options }) => {
    const config = {};
    const index = makeIndex();
    index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: index,
      diagnostics: [],
    });

    const first = resolvePluginMetadataSnapshot({ config, env: {}, ...options });
    const second = resolvePluginMetadataSnapshot({ config, env: {}, ...options });

    expect(second).not.toBe(first);
    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
  });

  it("propagates the current-snapshot bypass to the registry reader", () => {
    const config = {};
    const index = makeIndex();
    index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: index,
      diagnostics: [],
    });
    const current = loadPluginMetadataSnapshot({ config, env: {}, index });
    setCurrentPluginMetadataSnapshot(current, { config, env: {} });
    loadPluginRegistrySnapshotWithMetadata.mockClear();
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: index,
      diagnostics: [],
    });

    const resolved = resolvePluginMetadataSnapshot({
      config,
      env: {},
      allowCurrent: false,
    });

    expect(resolved).not.toBe(current);
    expect(resolved.registrySource).toBe("persisted");
    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ allowCurrent: false }),
    );
  });

  it("keeps scoped loads separate without an LRU", () => {
    const index = makeIndex();
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });

    const scoped = loadPluginMetadataSnapshot({
      config: {},
      env: {},
      index,
      pluginIds: ["demo"],
    });
    const unscoped = loadPluginMetadataSnapshot({ config: {}, env: {}, index });

    expect(scoped.pluginIds).toEqual(["demo"]);
    expect(unscoped.pluginIds).toBeUndefined();
    expect(loadPluginManifestRegistryForInstalledIndex.mock.calls[0]?.[0]).toMatchObject({
      pluginIds: ["demo"],
    });
    expect(loadPluginManifestRegistryForInstalledIndex.mock.calls[1]?.[0]).not.toHaveProperty(
      "pluginIds",
    );
  });

  it.each([
    { scope: "explicit empty", pluginIds: [], expectedPluginIds: [] },
    { scope: "explicit owner", pluginIds: ["demo"], expectedPluginIds: ["demo"] },
  ])(
    "projects an $scope request without rediscovering the lifecycle graph",
    ({ pluginIds, expectedPluginIds }) => {
      const config = {};
      const index = makeIndex();
      index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
      loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
        source: "provided",
        snapshot: index,
        diagnostics: [],
      });
      const unscoped = loadPluginMetadataSnapshot({ config, env: {}, index });
      setCurrentPluginMetadataSnapshot(unscoped, { config, env: {} });
      loadPluginManifestRegistryForInstalledIndex.mockClear();
      loadPluginManifestRegistryForInstalledIndex.mockImplementation(
        (params: { pluginIds?: readonly string[] }) => ({
          ...makeManifestRegistry(),
          plugins: makeManifestRegistry().plugins.filter(
            (plugin) => params.pluginIds === undefined || params.pluginIds.includes(plugin.id),
          ),
        }),
      );

      const scoped = resolvePluginMetadataSnapshot({ config, env: {}, pluginIds });

      expect(scoped).not.toBe(unscoped);
      expect(scoped.pluginIds).toEqual(pluginIds);
      expect(scoped.plugins.map((plugin) => plugin.id)).toEqual(expectedPluginIds);
      expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
      expect(resolvePluginMetadataSnapshot({ config, env: {}, pluginIds })).toBe(scoped);
    },
  );

  it("keeps accepted metadata readable while invalidating an unpublished candidate", () => {
    const config = {};
    const index = makeIndex();
    index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });
    const owner = createPluginMetadataOwner();
    ownerDisposers.push(installPluginMetadataOwner(owner));
    const active = owner.prepare({ config, env: {} });
    owner.publish(active, { config, env: {} });
    const candidateConfig = { plugins: { allow: ["replacement"] } };
    const candidateIndex = makeIndex("replacement");
    candidateIndex.policyHash = resolveInstalledPluginIndexPolicyHash(candidateConfig);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: candidateIndex,
      diagnostics: [],
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      makeManifestRegistry("replacement"),
    );
    const candidate = owner.prepare({ config: candidateConfig, env: {} });

    clearPluginMetadataLifecycleCaches(owner);
    expect(() => owner.publish(candidate, { config: candidateConfig, env: {} })).toThrow(
      "superseded",
    );
    expect(owner.getActive()).toBe(active);
    expect(owner.readConfigWide({ config: structuredClone(config), env: {} })).toBe(active);
    expect(
      resolvePluginMetadataSnapshot({ config, env: {}, allowWorkspaceScopedCurrent: true }),
    ).toBe(active.selectedSnapshot);
    expect(() =>
      getPluginMetadataWorkspaceSnapshot(active, { workspaceDir: "/unprepared" }),
    ).toThrow("not prepared");

    loadPluginManifestRegistryForInstalledIndex.mockImplementation(() => {
      throw new Error("unreadable manifest");
    });
    expect(() => owner.prepare({ config: candidateConfig, env: {} })).toThrow(
      "unreadable manifest",
    );
    expect(owner.getActive()).toBe(active);
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      makeManifestRegistry("replacement"),
    );
    const replacement = owner.prepare({ config: candidateConfig, env: {} });
    owner.publish(replacement, { config: candidateConfig, env: {} });
    expect(owner.getActive()?.plugins.map((plugin) => plugin.id)).toEqual(["replacement"]);
  });

  it.each(["process owner", "scoped collection", "owner reuse"] as const)(
    "reads an explicit state directory without inheriting the %s inventory",
    (mode) => {
      const config = {};
      const env = {};
      const stateDir = "/alternate-state";
      const activeIndex = makeIndex("active-store");
      const alternateIndex = makeIndex("alternate-store");
      for (const index of [activeIndex, alternateIndex]) {
        index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
      }
      loadPluginRegistrySnapshotWithMetadata.mockImplementation(
        (params: { stateDir?: string }) => ({
          source: "persisted",
          snapshot: params.stateDir === stateDir ? alternateIndex : activeIndex,
          diagnostics: [],
        }),
      );
      loadPluginManifestRegistryForInstalledIndex.mockImplementation(
        ({ index }: { index: InstalledPluginIndex }) =>
          makeManifestRegistry(index.plugins[0]?.pluginId),
      );
      const owner = createPluginMetadataOwner();
      ownerDisposers.push(installPluginMetadataOwner(owner));
      const active = owner.prepare({ config, env });
      owner.publish(active, { config, env });
      const readAlternate = () =>
        mode === "owner reuse"
          ? owner.prepare({ config, env, stateDir }).manifestRegistry
          : resolveConfigWidePluginManifestRegistry({ config, env, stateDir });

      const alternate =
        mode === "scoped collection"
          ? withPluginMetadataCollectionScope(active, readAlternate, { config, env })
          : readAlternate();

      expect(alternate.plugins.map((plugin) => plugin.id)).toEqual(["alternate-store"]);
      expect(owner.getActive()).toBe(active);
      expect(active.plugins.map((plugin) => plugin.id)).toEqual(["active-store"]);
    },
  );

  it("does not let a retired owner clear a successor using the same prepared graph", () => {
    const config = {};
    const index = makeIndex();
    index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });
    const firstOwner = createPluginMetadataOwner();
    const disposeFirst = installPluginMetadataOwner(firstOwner);
    ownerDisposers.push(disposeFirst);
    const first = firstOwner.prepare({ config, env: {} });
    firstOwner.publish(first, { config, env: {} });
    const secondOwner = createPluginMetadataOwner();
    const disposeSecond = installPluginMetadataOwner(secondOwner);
    ownerDisposers.push(disposeSecond);
    const second = secondOwner.prepare({ config, env: {}, seed: first });
    secondOwner.publish(second, { config, env: {} });
    expect(second.selectedSnapshot).toBe(first.selectedSnapshot);

    disposeFirst();
    expect(
      getCurrentPluginMetadataSnapshot({ config, env: {}, allowWorkspaceScopedSnapshot: true }),
    ).toBe(second.selectedSnapshot);
    disposeSecond();
    expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
  });

  it("prepares provider endpoint and request facts", () => {
    const index = makeIndex();
    const registry = makeManifestRegistry();
    const plugin = registry.plugins[0];
    if (!plugin) {
      throw new Error("expected manifest plugin fixture");
    }
    plugin.providerEndpoints = [
      {
        endpointClass: "openai-public",
        hosts: [" API.EXAMPLE.COM "],
        baseUrls: ["https://api.example.com/v1/"],
      },
    ];
    plugin.providerRequest = {
      providers: {
        demo: {
          family: " demo-family ",
          compatibilityFamily: " moonshot " as never,
          openAICompletions: { supportsStreamingUsage: true },
        },
      },
    };
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(registry);

    const snapshot = loadPluginMetadataSnapshot({ config: {}, env: {}, index });

    expect(snapshot.owners.providerEndpoints).toContainEqual({
      endpointClass: "openai-public",
      hosts: ["api.example.com"],
      hostSuffixes: [],
      baseUrls: ["https://api.example.com/v1"],
    });
    expect(snapshot.owners.providerRequests?.get("demo")).toEqual({
      family: "demo-family",
      compatibilityFamily: "moonshot",
      openAICompletions: { supportsStreamingUsage: true },
    });
  });

  it.each([false, true])(
    "freezes a cloned index instead of caller-owned records (worker: %s)",
    (worker) => {
      const index = makeIndex();
      loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
        source: "provided",
        snapshot: index,
        diagnostics: [],
      });

      const loaded = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
      const { normalizePluginId: _normalizePluginId, ...transfer } = loaded;
      const snapshot = worker ? restorePluginMetadataSnapshot(structuredClone(transfer)) : loaded;
      expect(snapshot.normalizePluginId(" DEMO ")).toBe("demo");
      expect(snapshot.owners.providers.get("demo")).toEqual(["demo"]);
      expect(() => (snapshot.owners.providers as Map<string, string[]>).set("other", [])).toThrow(
        "Plugin metadata snapshots are immutable",
      );
      const callerRecord = index.plugins[0];
      const snapshotRecord = snapshot.index.plugins[0];
      if (!callerRecord || !snapshotRecord) {
        throw new Error("expected metadata records");
      }

      callerRecord.pluginId = "caller-mutated";
      expect(snapshotRecord.pluginId).toBe("demo");
      expect(() => {
        snapshotRecord.pluginId = "snapshot-mutated";
      }).toThrow();
    },
  );
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "../current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../installed-plugin-index-policy.js";
import * as pluginMetadata from "../plugin-metadata-collection.js";
import { resolvePluginMetadataEnvFingerprint } from "../plugin-metadata-env.js";
import { clearPluginMetadataLifecycleCaches } from "../plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types.js";
import { resolvePluginRuntimeLoadContext } from "./load-context.js";

function createSnapshot(params: {
  config: OpenClawConfig;
  workspaceDir: string;
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
  return {
    policyHash,
    workspaceDir: params.workspaceDir,
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash,
      generatedAtMs: 1,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: { plugins: [], diagnostics: [] },
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 0,
    },
    discovery: { candidates: [], diagnostics: [] },
  };
}

describe("plugin runtime load context current snapshot ownership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearPluginMetadataLifecycleCaches();
  });

  it("keeps operation-local metadata from replacing the Gateway lifecycle snapshot", () => {
    const lifecycleConfig = { plugins: { allow: ["lifecycle"] } };
    const operationConfig = { plugins: { allow: ["operation"] } };
    const lifecycleWorkspace = "/workspace/lifecycle";
    const operationWorkspace = "/workspace/operation";
    const lifecycleSnapshot = createSnapshot({
      config: lifecycleConfig,
      workspaceDir: lifecycleWorkspace,
    });
    const operationSnapshot = createSnapshot({
      config: operationConfig,
      workspaceDir: operationWorkspace,
    });
    setCurrentPluginMetadataSnapshot(lifecycleSnapshot, {
      config: lifecycleConfig,
      workspaceDir: lifecycleWorkspace,
    });
    vi.spyOn(pluginMetadata, "preparePluginMetadata").mockReturnValue({
      workspaces: new Map([[operationWorkspace, operationSnapshot]]),
      configWorkspaceDirs: [operationWorkspace],
      envFingerprint: resolvePluginMetadataEnvFingerprint(process.env),
      selectedSnapshot: operationSnapshot,
      manifestRegistry: operationSnapshot.manifestRegistry,
      plugins: operationSnapshot.plugins,
      byPluginId: operationSnapshot.byPluginId,
      owners: operationSnapshot.owners,
      diagnostics: operationSnapshot.diagnostics,
      channelCatalog: { read: () => [] },
    });

    const context = resolvePluginRuntimeLoadContext({
      config: operationConfig,
      workspaceDir: operationWorkspace,
    });

    expect(context.metadataSnapshot).toBe(operationSnapshot);
    expect(
      getCurrentPluginMetadataSnapshot({
        config: lifecycleConfig,
        workspaceDir: lifecycleWorkspace,
      }),
    ).toBe(lifecycleSnapshot);
    expect(
      getCurrentPluginMetadataSnapshot({
        config: operationConfig,
        workspaceDir: operationWorkspace,
      }),
    ).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import * as currentPluginMetadata from "../plugins/current-plugin-metadata-snapshot.js";
import * as pluginMetadata from "../plugins/plugin-metadata-collection.js";
import { resolvePluginMetadataEnvFingerprint } from "../plugins/plugin-metadata-env.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getPreparedPluginRuntimeLoadContext,
  prepareOwnedPluginLoadContext,
} from "./prepared-model-runtime.plugin-context.js";
import { withPreparedPluginGenerationScope } from "./prepared-model-runtime.plugin-generation.js";

function operationMetadata(
  snapshot: PluginMetadataSnapshot,
): pluginMetadata.PreparedPluginMetadata {
  return {
    workspaces: new Map([[snapshot.workspaceDir, snapshot]]),
    configWorkspaceDirs: [snapshot.workspaceDir],
    envFingerprint: resolvePluginMetadataEnvFingerprint(process.env),
    selectedSnapshot: snapshot,
    manifestRegistry: snapshot.manifestRegistry,
    plugins: snapshot.plugins,
    byPluginId: snapshot.byPluginId,
    owners: snapshot.owners,
    diagnostics: snapshot.diagnostics,
    channelCatalog: { read: () => [] },
  };
}

describe("prepared model runtime plugin metadata ownership", () => {
  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
  });

  it("uses one explicit Gateway metadata generation across agent workspaces", () => {
    const config = { plugins: { allow: ["synthetic"] } };
    const gatewayWorkspace = "/tmp/gateway-plugin-workspace";
    const gatewaySnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([{ id: "synthetic", channels: [] }]),
      workspaceDir: gatewayWorkspace,
    });
    const inputs = ["first", "second"].map((name) => ({
      agentDir: `/tmp/${name}-agent`,
      config,
      workspaceDir: `/tmp/${name}-workspace`,
    }));
    const pluginGeneration = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: gatewaySnapshot,
    };
    const prepareMetadata = vi.spyOn(pluginMetadata, "preparePluginMetadata");
    const getCurrentMetadata = vi.spyOn(currentPluginMetadata, "getCurrentPluginMetadataSnapshot");

    try {
      for (const input of inputs) {
        const registry = createEmptyPluginRegistry();
        expect(
          prepareOwnedPluginLoadContext(input, process.env, registry, gatewaySnapshot, true),
        ).toBe(gatewaySnapshot);
        expect(getPreparedPluginRuntimeLoadContext(registry)).toMatchObject({
          metadataSnapshot: gatewaySnapshot,
          preferBuiltPluginArtifacts: true,
        });
        expect(
          withPreparedPluginGenerationScope({ input, pluginGeneration }, () =>
            prepareOwnedPluginLoadContext(input, process.env, undefined),
          ),
        ).toBe(gatewaySnapshot);
      }
      expect(prepareMetadata).not.toHaveBeenCalled();
    } finally {
      getCurrentMetadata.mockRestore();
      prepareMetadata.mockRestore();
    }
  });

  it("keeps direct no-current preparation on the requested workspace", () => {
    const config = { plugins: { allow: ["synthetic"] } };
    const workspaceDir = "/tmp/direct-plugin-workspace";
    const directSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([{ id: "synthetic", channels: [] }]),
      workspaceDir,
    });
    const prepareMetadata = vi
      .spyOn(pluginMetadata, "preparePluginMetadata")
      .mockReturnValue(operationMetadata(directSnapshot));
    const registry = createEmptyPluginRegistry();

    try {
      expect(
        prepareOwnedPluginLoadContext(
          {
            agentDir: "/tmp/direct-agent",
            config,
            workspaceDir,
          },
          process.env,
          registry,
        ),
      ).toBe(directSnapshot);
      expect(getPreparedPluginRuntimeLoadContext(registry)).toMatchObject({
        metadataSnapshot: directSnapshot,
        preferBuiltPluginArtifacts: false,
      });
      expect(prepareMetadata).toHaveBeenCalledWith({
        config,
        env: process.env,
        workspaceDir,
      });
    } finally {
      prepareMetadata.mockRestore();
    }
  });

  it("requests selected-runtime metadata for executable prepared probes", () => {
    const config = { plugins: { slots: { memory: "none" as const } } };
    const workspaceDir = "/tmp/selected-runtime-workspace";
    const directSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([
        { id: "selected", channels: [] },
        { id: "unrelated", channels: [] },
      ]),
      workspaceDir,
    });
    directSnapshot.index.plugins = directSnapshot.plugins.map((plugin) => ({
      pluginId: plugin.id,
      rootDir: plugin.rootDir,
      manifestPath: plugin.manifestPath,
      manifestHash: "fixture",
      origin: "global",
      enabled: true,
      startup: { sidecar: false, memory: false, agentHarnesses: [] },
      compat: [],
    }));
    const prepareMetadata = vi
      .spyOn(pluginMetadata, "preparePluginMetadata")
      .mockReturnValue(operationMetadata(directSnapshot));

    try {
      const prepared = prepareOwnedPluginLoadContext(
        {
          agentDir: "/tmp/selected-runtime-agent",
          config,
          loadRuntimePlugins: true,
          runtimePluginSelections: [
            { provider: "selected", modelId: "model", runtime: "openclaw" },
          ],
          workspaceDir,
        },
        process.env,
        undefined,
      );

      expect(prepared.index).toBe(directSnapshot.index);
      expect(prepared.plugins.map((plugin) => plugin.id)).toEqual(["selected"]);
      expect(prepared.pluginIds).toEqual(["selected"]);
    } finally {
      prepareMetadata.mockRestore();
    }
  });
});

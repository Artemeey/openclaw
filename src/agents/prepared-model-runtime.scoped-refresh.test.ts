// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getInstalledPluginIndexInstallRecordsCacheGeneration } from "../plugins/installed-plugin-index-record-cache.js";
import type { PreparedPluginMetadata } from "../plugins/plugin-metadata-collection.js";
import { resolvePluginMetadataEnvFingerprint } from "../plugins/plugin-metadata-env.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();

describe("prepared model runtime scoped refresh", () => {
  beforeEach(() => resetPreparedModelRuntimeHarness());

  it.each([
    { metadataState: "unchanged", replaceMetadata: false, refreshedAgents: 1 },
    { metadataState: "replaced", replaceMetadata: true, refreshedAgents: 2 },
  ])(
    "checks $metadataState workspace metadata before retaining unaffected configured owners",
    async ({ replaceMetadata, refreshedAgents }) => {
      mocks.configuredAgentIds = ["pro", "free"];
      const initialConfig = {
        agents: {
          entries: {
            pro: { model: "openai/gpt-5.6" },
            free: { model: "openai/gpt-5.5" },
          },
        },
      } satisfies OpenClawConfig;
      const nextConfig = {
        agents: {
          entries: {
            pro: { model: "openai/gpt-5.4" },
            free: { model: "openai/gpt-5.5" },
          },
        },
      } satisfies OpenClawConfig;
      const buildCounts: number[] = [];
      const freeInput = {
        config: initialConfig,
        agentId: "free",
        agentDir: "/tmp/configured-free",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/workspace-free",
      };
      const proMetadata = createPluginMetadataSnapshot({
        config: initialConfig,
        workspaceDir: "/tmp/workspace-pro",
        manifestRegistry: { plugins: [], diagnostics: [] },
      });
      const freeMetadata = createPluginMetadataSnapshot({
        config: initialConfig,
        workspaceDir: freeInput.workspaceDir,
        manifestRegistry: { plugins: [], diagnostics: [] },
      });
      const nextFreeMetadata = replaceMetadata
        ? createPluginMetadataSnapshot({
            config: nextConfig,
            workspaceDir: freeInput.workspaceDir,
            manifestRegistry: { plugins: [], diagnostics: [] },
          })
        : freeMetadata;
      const metadata = (freeSnapshot: PluginMetadataSnapshot): PreparedPluginMetadata => ({
        workspaces: new Map([
          [proMetadata.workspaceDir, proMetadata],
          [freeSnapshot.workspaceDir, freeSnapshot],
        ]),
        configWorkspaceDirs: [proMetadata.workspaceDir, freeSnapshot.workspaceDir],
        agentWorkspaceDirs: new Map([
          ["pro", "/tmp/workspace-pro"],
          ["free", freeInput.workspaceDir],
        ]),
        installRecordsGeneration: getInstalledPluginIndexInstallRecordsCacheGeneration(),
        envFingerprint: resolvePluginMetadataEnvFingerprint(process.env),
        selectedSnapshot: proMetadata,
        manifestRegistry: proMetadata.manifestRegistry,
        plugins: proMetadata.plugins,
        byPluginId: proMetadata.byPluginId,
        owners: proMetadata.owners,
        diagnostics: proMetadata.diagnostics,
        channelCatalog: { read: () => [] },
      });

      await refreshPreparedModelRuntimeSnapshots(initialConfig, {
        gatewayLifecycle: true,
        pluginMetadata: metadata(freeMetadata),
        onBuildStats: (stats) => buildCounts.push(stats.agentCount),
      });
      const retainedReader = getPreparedModelRuntimeSnapshot(freeInput)!;
      const retainedAuthStore = getPreparedModelRuntimeAuthStore(retainedReader);

      await refreshPreparedModelRuntimeSnapshots(nextConfig, {
        gatewayLifecycle: true,
        agentIds: new Set(["pro"]),
        pluginMetadata: metadata(nextFreeMetadata),
        onBuildStats: (stats) => buildCounts.push(stats.agentCount),
      });

      const retained = getPreparedModelRuntimeSnapshot({ ...freeInput, config: nextConfig });
      expect(buildCounts).toEqual([2, refreshedAgents]);
      expect(retained).toMatchObject({ agentId: "free", config: nextConfig });
      expect(retained).not.toBe(retainedReader);
      expect(retainedReader.config).toBe(initialConfig);
      expect(retainedReader.metadataSnapshot).toBe(freeMetadata);
      expect(retained?.metadataSnapshot).toBe(nextFreeMetadata);
      if (!replaceMetadata) {
        expect(retained?.modelCatalog).toBe(retainedReader.modelCatalog);
        expect(getPreparedModelRuntimeAuthStore(retained!)).toBe(retainedAuthStore);
      }
    },
  );

  it("falls back to full refresh when an out-of-scope owner dependency changes", async () => {
    mocks.configuredAgentIds = ["pro", "free"];
    const initialConfig = {
      agents: {
        defaults: { model: "openai/gpt-5.6" },
        entries: { pro: {}, free: {} },
      },
    } satisfies OpenClawConfig;
    const nextConfig = {
      agents: {
        defaults: { model: "openai/gpt-5.5" },
        entries: { pro: {}, free: {} },
      },
    } satisfies OpenClawConfig;
    const buildCounts: number[] = [];

    await refreshPreparedModelRuntimeSnapshots(initialConfig, {
      gatewayLifecycle: true,
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });
    await refreshPreparedModelRuntimeSnapshots(nextConfig, {
      gatewayLifecycle: true,
      agentIds: new Set(["pro"]),
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });

    expect(buildCounts).toEqual([2, 2]);
  });

  it("builds only a newly added non-default agent", async () => {
    mocks.configuredAgentIds = ["free"];
    const initialConfig = {
      agents: { entries: { free: { model: "openai/gpt-5.5" } } },
    } satisfies OpenClawConfig;
    const nextConfig = {
      agents: {
        entries: {
          free: { model: "openai/gpt-5.5" },
          pro: { model: "openai/gpt-5.6" },
        },
      },
    } satisfies OpenClawConfig;
    const buildCounts: number[] = [];

    await refreshPreparedModelRuntimeSnapshots(initialConfig, {
      gatewayLifecycle: true,
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });
    mocks.configuredAgentIds = ["free", "pro"];
    await refreshPreparedModelRuntimeSnapshots(nextConfig, {
      gatewayLifecycle: true,
      agentIds: new Set(["pro"]),
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });

    expect(buildCounts).toEqual([1, 1]);
    expect(
      getPreparedModelRuntimeSnapshot({
        config: nextConfig,
        agentId: "pro",
        agentDir: "/tmp/configured-pro",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/workspace-pro",
      }),
    ).toMatchObject({ agentId: "pro", config: nextConfig });
  });
});

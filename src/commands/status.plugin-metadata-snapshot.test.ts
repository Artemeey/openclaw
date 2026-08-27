import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const registryLoads = vi.hoisted(() => ({ count: 0 }));

vi.mock("../plugins/plugin-registry-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-registry-snapshot.js")>();
  return {
    ...actual,
    loadPluginRegistrySnapshotWithMetadata: (
      ...args: Parameters<typeof actual.loadPluginRegistrySnapshotWithMetadata>
    ) => {
      registryLoads.count += 1;
      return actual.loadPluginRegistrySnapshotWithMetadata(...args);
    },
  };
});

vi.mock("./status.scan.bootstrap-shared.js", () => ({
  createStatusScanCoreBootstrap: async () => ({
    tailscaleMode: "off",
    tailscaleDnsPromise: Promise.resolve(null),
    updatePromise: Promise.resolve({ installKind: "unknown" }),
    agentStatusPromise: Promise.resolve({
      defaultId: "main",
      agents: [],
      totalSessions: 0,
      bootstrapPendingCount: 0,
    }),
    gatewayProbePromise: Promise.resolve({ gatewayReachable: false }),
    resolveTailscaleHttpsUrl: async () => null,
    skipColdStartNetworkChecks: false,
  }),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => {
    throw new Error("gateway unavailable in status snapshot test");
  }),
}));

const { withStatusScanOverview } = await import("./status.scan-overview.js");

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
});

it("shares plugin metadata through the full status continuation without publishing it", async () => {
  await withOpenClawTestState(
    {
      prefix: "openclaw-status-plugin-metadata-",
      layout: "split",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    },
    async (state) => {
      const pluginDir = state.path("cold-plugin");
      fs.mkdirSync(pluginDir, { recursive: true });
      createColdPluginFixture({ rootDir: pluginDir, pluginId: "cold-plugin" });
      await state.writeConfig({
        memory: {
          search: {
            remote: { apiKey: "${OPENCLAW_STATUS_PLUGIN_METADATA_KEY}" },
          },
        },
        plugins: {
          load: { paths: [pluginDir] },
          entries: { "cold-plugin": { enabled: true } },
        },
      });
      clearPluginMetadataLifecycleCaches();
      registryLoads.count = 0;

      const overview = await withStatusScanOverview(
        {
          commandName: "status --json",
          opts: {},
          showSecrets: false,
          includeChannelsData: false,
          skipUpdateCheck: true,
          resolveHasConfiguredChannels: () => false,
        },
        async (scan) => {
          await Promise.resolve();
          const metadata = resolvePluginMetadataSnapshot({ config: scan.cfg });
          expect(metadata.plugins.map((plugin) => plugin.id)).toContain("cold-plugin");
          return scan;
        },
      );

      expect(overview.cfg.plugins?.entries?.["cold-plugin"]?.enabled).toBe(true);
      expect(registryLoads.count).toBe(1);
      expect(
        getCurrentPluginMetadataSnapshot({
          config: overview.cfg,
          allowWorkspaceScopedSnapshot: true,
        }),
      ).toBeUndefined();
    },
  );
});

it("keeps overlapping status commands on their own config metadata", async () => {
  await withOpenClawTestState(
    {
      prefix: "openclaw-status-plugin-scopes-",
      layout: "split",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    },
    async (state) => {
      const firstPluginDir = state.path("first-plugin");
      const secondPluginDir = state.path("second-plugin");
      for (const [rootDir, pluginId] of [
        [firstPluginDir, "first-plugin"],
        [secondPluginDir, "second-plugin"],
      ] as const) {
        fs.mkdirSync(rootDir, { recursive: true });
        createColdPluginFixture({ rootDir, pluginId });
      }
      await state.writeConfig(createColdPluginConfig(firstPluginDir, "first-plugin"));
      clearPluginMetadataLifecycleCaches();
      registryLoads.count = 0;
      const options = {
        commandName: "status --json",
        opts: {},
        showSecrets: false,
        includeChannelsData: false,
        skipUpdateCheck: true,
        resolveHasConfiguredChannels: () => false,
      };
      const firstReady = createDeferredCore();
      const finishFirst = createDeferredCore();
      const first = withStatusScanOverview(options, async (overview) => {
        const prepared = resolvePluginMetadataSnapshot({ config: overview.cfg });
        firstReady.resolve();
        await finishFirst.promise;
        const afterSecond = resolvePluginMetadataSnapshot({ config: overview.cfg });
        expect(afterSecond.plugins.map((plugin) => plugin.id)).toEqual(["first-plugin"]);
        expect(afterSecond).toBe(prepared);
      });
      try {
        await Promise.race([firstReady.promise, first]);
        await state.writeConfig(createColdPluginConfig(secondPluginDir, "second-plugin"));
        await withStatusScanOverview(options, async (overview) => {
          await Promise.resolve();
          const prepared = resolvePluginMetadataSnapshot({ config: overview.cfg });
          expect(prepared.plugins.map((plugin) => plugin.id)).toEqual(["second-plugin"]);
        });
      } finally {
        finishFirst.resolve();
        await first;
      }
      expect(registryLoads.count).toBe(2);
    },
  );
});

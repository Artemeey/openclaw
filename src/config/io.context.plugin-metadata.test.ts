import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "../plugins/installed-plugin-index-record-cache.js";
import { refreshPersistedInstalledPluginIndexSync } from "../plugins/installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndexSync } from "../plugins/installed-plugin-index-store.js";
import {
  createPluginMetadataOwner,
  getPluginMetadataWorkspaceSnapshot,
  withPluginMetadataCollectionScope,
} from "../plugins/plugin-metadata-collection.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "../plugins/test-helpers/fs-fixtures.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL } from "../state/openclaw-state-schema-v13-widerow.test-support.js";
import { createConfigIoContext } from "./io.context.js";
import { createConfigIO } from "./io.factory.js";
import { resolveConfigWidePluginManifestRegistry } from "./io.plugin-metadata.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type PluginFixture = ReturnType<typeof createColdPluginFixture>;

describe("config IO plugin metadata snapshots", () => {
  const tempDirs: string[] = [];
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    root = fs.realpathSync(makeTrackedTempDir("openclaw-config-metadata", tempDirs));
    const bundledPluginsDir = path.join(root, "bundled");
    mkdirSafeDir(bundledPluginsDir);
    env = {
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearPluginMetadataLifecycleCaches();
    closeOpenClawStateDatabaseForTest();
    cleanupTrackedTempDirs(tempDirs);
  });

  function writePlugin(rootDir: string, pluginId: string): PluginFixture {
    mkdirSafeDir(rootDir);
    return createColdPluginFixture({
      rootDir,
      pluginId,
      packageName: `@example/${pluginId}`,
      channelId: `${pluginId}-chat`,
      providerId: `${pluginId}-provider`,
    });
  }

  function createWorkspaceFixture(sharedWorkspace = false) {
    const shared = writePlugin(path.join(root, "shared"), "shared-plugin");
    const workspaceDirs = Array.from({ length: 4 }, (_, index) =>
      path.join(root, `workspace-${sharedWorkspace ? 0 : index}`),
    );
    const workspacePlugins = [...new Set(workspaceDirs)].map((workspaceDir, index) =>
      writePlugin(
        path.join(workspaceDir, ".openclaw", "extensions", `workspace-${index}-plugin`),
        `workspace-${index}-plugin`,
      ),
    );
    const plugins = [shared, ...workspacePlugins];
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: Object.fromEntries(
          workspaceDirs.map((workspace, index) => [`agent-${index}`, { workspace }]),
        ),
      },
      channels: Object.fromEntries(plugins.map((plugin) => [plugin.channelId, { enabled: true }])),
      plugins: {
        load: { paths: [shared.rootDir] },
        allow: plugins.map((plugin) => plugin.pluginId),
        entries: Object.fromEntries(plugins.map((plugin) => [plugin.pluginId, { enabled: true }])),
      },
    };
    return { config, plugins, workspaceDirs };
  }

  it.each(["first read", "read-only owner", "read-only seed after external open"])(
    "prepares complete metadata after state initialization: %s",
    async (preparation) => {
      const pluginDir = path.join(root, "custom-memory");
      mkdirSafeDir(pluginDir);
      const plugin = createColdPluginFixture({
        rootDir: pluginDir,
        pluginId: "custom-memory",
        manifest: {
          kind: "memory",
          configSchema: {
            type: "object",
            properties: { mode: { enum: ["valid"] } },
            required: ["mode"],
            additionalProperties: false,
          },
        },
      });
      const workspaceDir = path.join(root, "workspace");
      const config: OpenClawConfig = {
        gateway: { mode: "local" },
        agents: { ownership: "explicit", entries: { worker: { workspace: workspaceDir } } },
        plugins: {
          slots: { memory: plugin.pluginId },
          entries: { [plugin.pluginId]: { enabled: true, config: { mode: "valid" } } },
        },
      };
      const index = refreshPersistedInstalledPluginIndexSync({
        config,
        env,
        workspaceDir,
        reason: "manual",
        installRecords: {
          [plugin.pluginId]: {
            source: "path",
            sourcePath: pluginDir,
            installPath: pluginDir,
            version: "1.0.0",
          },
        },
      });
      const databasePath = openOpenClawStateDatabase({ env }).path;
      closeOpenClawStateDatabaseForTest();
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL);
      legacy.close();
      clearPluginMetadataLifecycleCaches();
      clearLoadInstalledPluginIndexInstallRecordsCache();
      fs.writeFileSync(env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));

      const owner = createPluginMetadataOwner();
      const readonlyIO = createConfigIO({ env, observe: false, pluginMetadataOwner: owner });
      let seed: ReturnType<typeof owner.prepare> | undefined;
      if (preparation !== "first read") {
        await readonlyIO.readConfigFileSnapshot();
        seed = owner.prepare({ config, env });
        const unchanged = new DatabaseSync(databasePath, { readOnly: true });
        expect(unchanged.prepare("PRAGMA user_version").get()?.user_version).toBe(12);
        unchanged.close();
        if (preparation === "read-only seed after external open") {
          openOpenClawStateDatabase({ env });
        }
      }

      const observingIO = createConfigIO({ env, pluginMetadataOwner: owner });
      const read = () => observingIO.readConfigFileSnapshotWithPluginMetadata();
      const result = seed
        ? await withPluginMetadataCollectionScope(seed, read, { config, env })
        : await read();
      expect(result.snapshot.valid, JSON.stringify(result.snapshot.issues)).toBe(true);
      expect(result.pluginMetadata?.byPluginId.has(plugin.pluginId)).toBe(true);
      expect(result.pluginMetadata?.selectedSnapshot.index.installRecords).toEqual(
        index.installRecords,
      );
      expect(readPersistedInstalledPluginIndexSync({ env })?.installRecords).toEqual(
        index.installRecords,
      );
      expect(
        openOpenClawStateDatabase({ env }).db.prepare("PRAGMA user_version").get()?.user_version,
      ).toBe(13);
      expect(
        owner.prepare({ config, env, seed: result.pluginMetadata }).byPluginId.has(plugin.pluginId),
      ).toBe(true);

      fs.writeFileSync(
        env.OPENCLAW_CONFIG_PATH!,
        JSON.stringify({
          ...config,
          plugins: {
            ...config.plugins,
            entries: { [plugin.pluginId]: { enabled: true, config: { mode: "invalid" } } },
          },
        }),
      );
      const rejected = await observingIO.readConfigFileSnapshot();
      expect(rejected.valid).toBe(false);
      expect(
        rejected.issues.some((issue) =>
          issue.path.startsWith(`plugins.entries.${plugin.pluginId}`),
        ),
      ).toBe(true);
      expect(fs.existsSync(plugin.runtimeMarker)).toBe(false);
      owner.dispose();
    },
  );

  it("does not initialize state while validating an unaccepted recovery backup", () => {
    const plugin = writePlugin(path.join(root, "backup-plugin"), "backup-plugin");
    const config = { plugins: { load: { paths: [plugin.rootDir] } } };
    const context = createConfigIoContext({ env });
    const result = context.prepareRecoveryBackupCandidate({
      parsed: config,
      raw: JSON.stringify(config),
    });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR!, "state", "openclaw.sqlite"))).toBe(
      false,
    );
    expect(fs.existsSync(plugin.runtimeMarker)).toBe(false);
  });

  it("keeps config inspection available when state initialization fails", async () => {
    const stateDatabase = await import("../state/openclaw-state-db.js");
    const openState = vi
      .spyOn(stateDatabase, "openOpenClawStateDatabase")
      .mockImplementation(() => {
        throw new Error("test state database unavailable");
      });
    mkdirSafeDir(path.dirname(env.OPENCLAW_CONFIG_PATH!));
    fs.writeFileSync(
      env.OPENCLAW_CONFIG_PATH!,
      JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } }),
    );

    const snapshot = await createConfigIO({
      env,
      logger: { error: vi.fn(), warn: vi.fn() },
    }).readConfigFileSnapshot();

    expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
    expect(openState).toHaveBeenCalled();
  });

  it.each([
    { sharedWorkspace: false, defaultStatePaths: false },
    { sharedWorkspace: true, defaultStatePaths: false },
    { sharedWorkspace: false, defaultStatePaths: true },
    { sharedWorkspace: true, defaultStatePaths: true },
  ])(
    "reuses all workspace metadata across validation reads (shared workspace: $sharedWorkspace, default state paths: $defaultStatePaths)",
    ({ sharedWorkspace, defaultStatePaths }) => {
      if (defaultStatePaths) {
        delete env.OPENCLAW_STATE_DIR;
        delete env.OPENCLAW_CONFIG_PATH;
      }
      const { config, plugins, workspaceDirs } = createWorkspaceFixture(sharedWorkspace);
      const metadataRoots = [
        ...plugins.map((plugin) => plugin.rootDir),
        ...workspaceDirs.map((workspaceDir) => path.join(workspaceDir, ".openclaw", "extensions")),
        path.join(root, "bundled"),
        path.join(root, defaultStatePaths ? ".openclaw" : "state"),
      ];
      const context = createConfigIoContext({ env, observe: false });
      const readMetadata = () => {
        const loader = context.createValidationPluginMetadataSnapshotLoader({
          env,
        });
        loader.load(config);
        return loader.getMetadata();
      };
      // Observe the real filesystem, not a mocked discovery result. This loader
      // must not revisit plugin or state metadata after preparation.
      const reads = [
        vi.spyOn(fs, "existsSync"),
        vi.spyOn(fs, "lstatSync"),
        vi.spyOn(fs, "openSync"),
        vi.spyOn(fs, "readdirSync"),
        vi.spyOn(fs, "readFileSync"),
        vi.spyOn(fs, "statSync"),
        vi.spyOn(fs.realpathSync, "native"),
      ];
      const pluginReads = () =>
        reads.flatMap((read) =>
          read.mock.calls.flatMap(([target]) =>
            typeof target === "string" &&
            metadataRoots.some(
              (metadataRoot) =>
                target === metadataRoot || target.startsWith(`${metadataRoot}${path.sep}`),
            )
              ? [target]
              : [],
          ),
        );
      const prepared = readMetadata();
      expect(pluginReads().length).toBeGreaterThan(0);
      const expectedPluginIds = plugins.map((plugin) => plugin.pluginId);
      expect(prepared?.plugins.map((plugin) => plugin.id)).toEqual(expectedPluginIds);
      for (const plugin of plugins) {
        expect(prepared?.byPluginId.get(plugin.pluginId)?.source).toBe(plugin.runtimeSource);
        expect(prepared?.owners.channels.get(plugin.channelId)).toEqual([plugin.pluginId]);
      }
      expect(
        resolveReadOnlyChannelPluginsForConfig(config, {
          env,
          metadataSnapshot: prepared,
        })
          .plugins.map((plugin) => plugin.id)
          .toSorted(),
      ).toEqual(plugins.map((plugin) => plugin.channelId).toSorted());

      for (const read of reads) {
        read.mockClear();
      }
      for (let iteration = 0; iteration < 3; iteration += 1) {
        expect(readMetadata()?.plugins.map((plugin) => plugin.id)).toEqual(expectedPluginIds);
      }
      expect(pluginReads()).toHaveLength(0);
      for (const plugin of plugins) {
        expect(fs.existsSync(plugin.runtimeMarker)).toBe(false);
      }
    },
  );

  it("keeps exact plugin scope and discovery precedence across workspace unions", () => {
    const { config } = createWorkspaceFixture();
    const cases = [
      {
        pluginIds: undefined,
        expected: [
          "shared-plugin",
          "workspace-0-plugin",
          "workspace-1-plugin",
          "workspace-2-plugin",
          "workspace-3-plugin",
        ],
      },
      {
        pluginIds: ["workspace-3-plugin", "shared-plugin"],
        expected: ["shared-plugin", "workspace-3-plugin"],
      },
      {
        pluginIds: ["shared-plugin", "workspace-3-plugin"],
        expected: ["shared-plugin", "workspace-3-plugin"],
      },
      { pluginIds: [], expected: [] },
      { pluginIds: ["missing-plugin"], expected: [] },
    ];
    for (const { pluginIds, expected } of cases) {
      const registry = resolveConfigWidePluginManifestRegistry({ config, env, pluginIds });
      expect(registry.plugins.map((plugin) => plugin.id)).toEqual(expected);
    }
  });

  it("deduplicates the same source but excludes plugin ids from different workspace sources", () => {
    const { config, plugins, workspaceDirs } = createWorkspaceFixture();
    const conflicts = workspaceDirs
      .slice(0, 2)
      .map((workspaceDir) =>
        writePlugin(path.join(workspaceDir, ".openclaw", "extensions", "collision"), "collision"),
      );
    const registry = resolveConfigWidePluginManifestRegistry({ config, env });

    expect(registry.plugins.map((plugin) => plugin.id)).toEqual(
      plugins.map((plugin) => plugin.pluginId),
    );
    expect(registry.diagnostics).toContainEqual({
      level: "error",
      pluginId: "collision",
      message: `plugin id "collision" is present in multiple agent workspaces: ${conflicts
        .map((plugin) => plugin.runtimeSource)
        .toSorted()
        .join(", ")}`,
    });
  });

  it("does not borrow an ordinary operation scope after its discovery environment changes", () => {
    const { config } = createWorkspaceFixture();
    const first = writePlugin(path.join(root, "bundled", "first"), "first-bundle");
    const nextBundledRoot = path.join(root, "next-bundled");
    const second = writePlugin(path.join(nextBundledRoot, "second"), "second-bundle");
    const nextEnv = { ...env, OPENCLAW_BUNDLED_PLUGINS_DIR: nextBundledRoot };
    const owner = createPluginMetadataOwner();
    const metadata = owner.prepare({ config, env });

    withPluginMetadataCollectionScope(
      metadata,
      () => {
        const registry = resolveConfigWidePluginManifestRegistry({ config, env: nextEnv });
        expect(registry.plugins.some((plugin) => plugin.id === second.pluginId)).toBe(true);
        expect(registry.plugins.some((plugin) => plugin.id === first.pluginId)).toBe(false);
        expect(() =>
          resolveConfigWidePluginManifestRegistry({ config, env: nextEnv, metadata }),
        ).toThrow("prepared for a different environment");
      },
      { config, env },
    );
    owner.dispose();
  });

  it("lets a prepared config operation override a retained generation using the same snapshot", () => {
    const { config, plugins } = createWorkspaceFixture();
    const owner = createPluginMetadataOwner();
    const metadata = owner.prepare({ config, env });
    const readIds = () =>
      resolveConfigWidePluginManifestRegistry({ config, env }).plugins.map((plugin) => plugin.id);

    withPluginMetadataSnapshotScope(
      metadata.selectedSnapshot,
      () => {
        expect(readIds()).toEqual(["shared-plugin"]);
        withPluginMetadataCollectionScope(
          metadata,
          () => {
            expect(readIds()).toEqual(plugins.map((plugin) => plugin.pluginId));
          },
          { config, env },
        );
        expect(readIds()).toEqual(["shared-plugin"]);
      },
      { config, env, trustConfigIdentity: true },
    );
    owner.dispose();
  });

  it("retains auxiliary execution workspaces without including them in config-wide validation", () => {
    const { config, plugins, workspaceDirs } = createWorkspaceFixture();
    const oldWorkspace = workspaceDirs[0]!;
    const nextWorkspace = workspaceDirs[1]!;
    const oldCollision = writePlugin(
      path.join(oldWorkspace, ".openclaw", "extensions", "collision"),
      "collision",
    );
    const nextCollision = writePlugin(
      path.join(nextWorkspace, ".openclaw", "extensions", "collision"),
      "collision",
    );
    const owner = createPluginMetadataOwner();
    owner.prepare({ config, env });
    const nextConfig: OpenClawConfig = {
      ...config,
      agents: { ownership: "explicit", entries: { next: { workspace: nextWorkspace } } },
    };

    const metadata = owner.prepare({
      config: nextConfig,
      env,
      additionalWorkspaceDirs: [oldWorkspace],
    });
    const oldExecution = getPluginMetadataWorkspaceSnapshot(metadata, {
      workspaceDir: oldWorkspace,
    });
    expect(oldExecution.byPluginId.get("collision")?.source).toBe(oldCollision.runtimeSource);
    expect(oldExecution.byPluginId.has("workspace-0-plugin")).toBe(true);
    expect(metadata.plugins.map((plugin) => plugin.id).toSorted()).toEqual([
      "collision",
      "shared-plugin",
      "workspace-1-plugin",
    ]);
    expect(metadata.byPluginId.get("collision")?.source).toBe(nextCollision.runtimeSource);
    expect(metadata.owners.providers.has("workspace-0-plugin-provider")).toBe(false);
    expect(metadata.diagnostics.some((diagnostic) => diagnostic.pluginId === "collision")).toBe(
      false,
    );
    for (const plugin of [...plugins, oldCollision, nextCollision]) {
      expect(fs.existsSync(plugin.runtimeMarker)).toBe(false);
    }
    owner.dispose();
  });
});

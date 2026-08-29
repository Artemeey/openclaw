import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { StartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  createPluginMetadataSnapshotFixture,
  createPreparedPluginMetadataFixture,
} from "../plugins/plugin-metadata.test-support.js";
import type { DoctorConfigPreflightPluginSnapshotRead } from "./doctor-config-preflight-plugin-index.js";

const writePersistedInstalledPluginIndexWithLeaseSync = vi.hoisted(() => vi.fn());

vi.mock("../plugins/installed-plugin-index-store-write.js", () => ({
  writePersistedInstalledPluginIndexWithLeaseSync,
}));

const { persistRefreshedPluginIndex } = await import("./doctor-config-preflight-plugin-index.js");

const measure = async <T>(_name: string, run: () => T | Promise<T>): Promise<T> => await run();

describe("persistRefreshedPluginIndex", () => {
  beforeEach(() => {
    writePersistedInstalledPluginIndexWithLeaseSync.mockReset();
  });

  it("reports selector diagnostics when the durable reread is rejected", async () => {
    const selected = createPluginMetadataSnapshotFixture();
    const secondary = createPluginMetadataSnapshotFixture({ plugins: [{ id: "secondary" }] });
    secondary.workspaceDir = "/workspace/secondary";
    secondary.index.workspaceDir = secondary.workspaceDir;
    const unionSnapshot = createPluginMetadataSnapshotFixture({ plugins: [...secondary.plugins] });
    const snapshotRead = (
      registryDiagnostics: PluginMetadataSnapshot["registryDiagnostics"] = [],
    ): DoctorConfigPreflightPluginSnapshotRead => {
      const selectedSnapshot: PluginMetadataSnapshot = {
        ...selected,
        registryDiagnostics,
        registrySource: "derived",
      };
      return {
        snapshot: {} as ConfigFileSnapshot,
        pluginMigrationFingerprint: "plugin-migrations",
        pluginMetadata: createPreparedPluginMetadataFixture({
          unionSnapshot,
          selectedSnapshot,
          workspaces: new Map([
            [undefined, selectedSnapshot],
            [secondary.workspaceDir, secondary],
          ]),
        }),
      };
    };
    const lease = {} as StartupMigrationLease;
    const env = { OPENCLAW_STATE_DIR: "test-state" };

    await expect(
      persistRefreshedPluginIndex({
        env,
        lease,
        measure,
        readPersistedSnapshot: async () =>
          snapshotRead([
            {
              level: "warn",
              code: "persisted-registry-stale-source",
              message: "stale",
            },
          ]),
        snapshotRead: snapshotRead(),
      }),
    ).rejects.toThrow("reread source was derived; diagnostics: persisted-registry-stale-source");

    expect(writePersistedInstalledPluginIndexWithLeaseSync).toHaveBeenCalledWith(selected.index, {
      env,
      lease,
    });
  });
});

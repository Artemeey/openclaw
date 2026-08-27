import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getStatusSummary } from "./summary.js";

describe("getStatusSummary read-only session access", () => {
  const previousRegistry = getActivePluginRegistry();
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    const telegram = createOutboundTestPlugin({
      id: "telegram",
      outbound: createDirectOutboundTestAdapter({ channel: "telegram" }),
      messaging: {
        targetPrefixes: ["telegram"],
        inferTargetChatType: ({ to }) => {
          return /^(?:telegram:)?\d+$/.test(to) ? "direct" : undefined;
        },
      },
    });
    telegram.config = {
      ...telegram.config,
      resolveAllowFrom: ({ cfg }) => cfg.channels?.telegram?.allowFrom ?? [],
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegram, source: "test" }]),
    );
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  afterAll(() => {
    if (previousRegistry) {
      setActivePluginRegistry(previousRegistry);
    }
  });

  it("does not create the heartbeat session database while checking its route", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-status-heartbeat-"));
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");

    try {
      const summary = await getStatusSummary({
        includeChannelSummary: false,
        config: { session: { store: databasePath } },
      });

      expect(summary.heartbeat.agents[0]?.waitingForRoute).toBe(true);
      expect(fs.existsSync(databasePath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([undefined, "owner"])(
    "resolves the configured owner DM without writing session state for target %s",
    async (target) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-status-owner-"));
      const databasePath = path.join(tempDir, "openclaw-agent.sqlite");

      try {
        const summary = await getStatusSummary({
          includeChannelSummary: false,
          config: {
            ...(target ? { agents: { defaults: { heartbeat: { target } } } } : {}),
            commands: { ownerAllowFrom: ["telegram:123"] },
            channels: { telegram: { allowFrom: ["123"] } },
            session: { store: databasePath },
          },
        });

        expect(summary.heartbeat.agents[0]?.waitingForRoute).toBe(false);
        expect(fs.existsSync(databasePath)).toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("reports and aggregates fixed logical stores by their physical SQLite targets", async () => {
    const tempDir = tempDirs.make("openclaw-status-session-stores-");
    const storePath = path.join(tempDir, "sessions.json");
    const config = {
      agents: {
        defaults: { systemAgent: { agentId: "main" } },
        list: [{ id: "main", default: true }, { id: "ops" }],
      },
      session: { store: storePath },
    };

    try {
      for (const agentId of ["main", "ops"]) {
        const logicalPath = resolveSessionStorePathCore(config.session.store, { agentId });
        await upsertSessionEntryCore(
          { agentId, sessionKey: `agent:${agentId}:main`, storePath: logicalPath },
          { sessionId: `${agentId}-session`, updatedAt: 10 },
        );
      }
      closeOpenClawAgentDatabasesForTest();

      const summary = await getStatusSummary({ includeChannelSummary: false, config });
      const expectedPaths = ["main", "ops"].map(
        (agentId) => resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path,
      );

      expect(summary.sessions.count).toBe(2);
      expect(summary.sessions.paths).toEqual(expectedPaths);
      expect(
        summary.sessions.byAgent.map((agent) => [agent.agentId, agent.path, agent.count]),
      ).toEqual([
        ["main", expectedPaths[0], 1],
        ["ops", expectedPaths[1], 1],
      ]);
      expect(expectedPaths.every((databasePath) => fs.existsSync(databasePath))).toBe(true);
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
    }
  });

  it("does not reread ambient config while projecting prepared session runtime state", async () => {
    await withOpenClawTestState(
      { prefix: "openclaw-status-prepared-config-", layout: "split" },
      async (state) => {
        const storePath = state.path("sessions.json");
        const config = { session: { store: storePath } };
        await state.writeConfig({ session: {} });
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: "agent:main:main", storePath },
          { sessionId: "prepared-config", updatedAt: 10 },
        );
        closeOpenClawAgentDatabasesForTest();
        clearRuntimeConfigSnapshot();
        const readFileSync = vi.spyOn(fs, "readFileSync");
        try {
          await getStatusSummary({ includeChannelSummary: false, config });
          expect(
            readFileSync.mock.calls.filter(([file]) => file === state.configPath),
          ).toHaveLength(0);
        } finally {
          readFileSync.mockRestore();
        }
      },
    );
  });

  it("bounds session payload hydration to the recent status window", async () => {
    await withOpenClawTestState({ prefix: "openclaw-status-recent-window-" }, async (state) => {
      const config = {
        agents: { defaults: { heartbeat: { every: "0m" } }, entries: { main: {} } },
      };
      const storePath = resolveSessionStorePathCore(undefined, {
        agentId: "main",
        env: state.env,
      });
      for (let index = 1; index <= 24; index += 1) {
        replaceSessionEntrySync(
          { agentId: "main", storePath, sessionKey: `agent:main:history-${index}` },
          {
            sessionId: `status-history-${index}`,
            updatedAt: index,
            pluginExtensions: {
              fixture: { history: Array.from({ length: 64 }, () => "x".repeat(128)) },
            },
          },
        );
      }
      await getStatusSummary({ config, includeChannelSummary: false });
      const clone = vi.spyOn(globalThis, "structuredClone");
      try {
        const summary = await getStatusSummary({ config, includeChannelSummary: false });

        expect(summary.sessions.count).toBe(24);
        expect(summary.sessions.byAgent[0]?.count).toBe(24);
        expect(summary.sessions.recent.map(({ key }) => key)).toEqual(
          Array.from({ length: 10 }, (_, index) => `agent:main:history-${24 - index}`),
        );
        expect(
          clone.mock.calls.filter(([value]) => {
            const sessionId = (value as { sessionId?: unknown })?.sessionId;
            return typeof sessionId === "string" && sessionId.startsWith("status-history-");
          }),
        ).toHaveLength(0);
      } finally {
        clone.mockRestore();
      }
    });
  });
});

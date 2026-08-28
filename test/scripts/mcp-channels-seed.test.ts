import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { seedMcpChannelsState } from "../../scripts/e2e/mcp-channels-seed.ts";
import {
  loadSessionEntry,
  loadTranscriptEvents,
} from "../../src/config/sessions/session-accessor.js";
import { runSessionStartupMigration } from "../../src/config/sessions/startup-migration.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../src/state/openclaw-state-db.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it("seeds canonical MCP channel state that passes session startup maintenance", async () => {
  const root = fs.realpathSync.native(tempDirs.make("openclaw-mcp-channels-seed-"));
  const stateDir = path.join(root, "state");
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_STATE_DIR: stateDir,
  };
  const now = 1_788_000_000_000;
  const seededConfig = {
    agents: { defaults: { heartbeat: { every: "0m" } } },
    plugins: { enabled: false },
  };

  const result = await seedMcpChannelsState({ env, now, seededConfig });

  expect(fs.existsSync(path.join(stateDir, "agents", "main", "sessions", "sessions.json"))).toBe(
    false,
  );
  expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId: "main", env }))).toBe(true);
  expect(loadSessionEntry({ agentId: "main", env, sessionKey: result.sessionKey })).toMatchObject({
    deliveryContext: {
      accountId: "imessage-default",
      channel: "imessage",
      threadId: "thread-42",
      to: "+15551234567",
    },
    displayName: "Docker MCP Channel Smoke",
    sessionId: result.sessionId,
    updatedAt: now,
  });

  const jsonlEvents = fs
    .readFileSync(result.sessionFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
  expect(jsonlEvents).toHaveLength(3);
  expect(jsonlEvents).toEqual(
    await loadTranscriptEvents({
      agentId: "main",
      env,
      sessionId: result.sessionId,
      sessionKey: result.sessionKey,
    }),
  );
  expect(jsonlEvents[2]).toMatchObject({
    id: "msg-attachment",
    message: {
      __openclaw: {
        media: [{ fileName: "seeded-image.png", kind: "image" }],
      },
    },
  });

  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await expect(
    runSessionStartupMigration({
      cfg: seededConfig,
      env,
      log: { info: vi.fn(), warn: vi.fn() },
    }),
  ).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        agentId: "main",
      }),
    ]),
  );
});

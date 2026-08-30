import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createTaskRecord as createTaskRecordOrNull } from "../../tasks/runtime-internal.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { tasksHandlers } from "./tasks.js";
import type { GatewayClient, RespondFn } from "./types.js";

const stateDirEnvSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const cursorError = "invalid or expired tasks.list cursor; restart pagination without a cursor";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let runtimeConfig: Record<string, unknown>;
let context: { getRuntimeConfig: () => Record<string, unknown> };

function createTaskRecord(params: Parameters<typeof createTaskRecordOrNull>[0]): TaskRecord {
  return expectDefined(createTaskRecordOrNull(params), "expected task creation to succeed");
}

function identifiedClient(scopes: string[], profileId: string): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes,
    },
    authenticatedUserId: "viewer@example.com",
    authenticatedUserProfile: {
      profileId,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

async function list(
  params: Record<string, unknown>,
  config: Record<string, unknown> = {},
  client: GatewayClient | null = null,
  requestContext = context,
) {
  runtimeConfig = config;
  const calls: Parameters<RespondFn>[] = [];
  await expectDefined(
    tasksHandlers["tasks.list"],
    "tasks.list handler",
  )({
    req: { type: "req", id: "req-tasks-list", method: "tasks.list" },
    params,
    respond: (...args) => calls.push(args),
    context: requestContext as never,
    client,
    isWebchatConnect: () => false,
  });
  return {
    calls,
    payload: calls[0]?.[1] as
      | { tasks?: Array<{ taskId?: string }>; nextCursor?: string }
      | undefined,
  };
}

function expectCursorRejected(calls: Parameters<RespondFn>[]) {
  expect(calls[0]).toMatchObject([
    false,
    undefined,
    { code: ErrorCodes.INVALID_REQUEST, message: cursorError },
  ]);
}

beforeEach(async () => {
  setTestEnvValue("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-task-pagination-"));
  runtimeConfig = {};
  context = { getRuntimeConfig: () => runtimeConfig };
  resetTaskRegistryForTests();
});

afterEach(async () => {
  resetTaskRegistryForTests();
  stateDirEnvSnapshot.restore();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("tasks.list cursor lifecycle", () => {
  it("binds opaque cursors to the query and gateway instance", async () => {
    for (const [agentId, status, index] of [
      ["main", "running", 0],
      ["main", "running", 1],
      ["worker", "running", 2],
      ["main", "queued", 3],
    ] as const) {
      createTaskRecord({
        runtime: "cli",
        requesterSessionKey: `agent:${agentId}:main`,
        ownerKey: `agent:${agentId}:main`,
        scopeKind: "session",
        agentId,
        runId: `run-cursor-query-${index}`,
        task: `Cursor query task ${index}`,
        status,
        deliveryStatus: "pending",
        lastEventAt: 1_000 - index,
      });
    }
    const query = { agentId: "main", limit: 1, status: "running" };
    const cursor = expectDefined((await list(query)).payload?.nextCursor, "expected cursor");
    for (const params of [
      { ...query, cursor: "" },
      { ...query, cursor: "not-an-issued-cursor" },
      { ...query, cursor: `${cursor}x` },
      { ...query, cursor, status: "queued" },
      { ...query, cursor, agentId: "worker" },
    ]) {
      expectCursorRejected((await list(params)).calls);
    }
    expect((await list({ ...query, cursor })).payload?.nextCursor).toBeUndefined();

    const restartCursor = expectDefined((await list({ limit: 1 })).payload?.nextCursor, "cursor");
    expectCursorRejected(
      (
        await list({ limit: 1, cursor: restartCursor }, {}, null, {
          getRuntimeConfig: () => ({}),
        })
      ).calls,
    );
  });

  it("binds cursors to canonical session selection", async () => {
    for (let index = 0; index < 2; index++) {
      createTaskRecord({
        runtime: "cli",
        requesterSessionKey: "agent:main:cursor-source",
        ownerKey: "agent:main:cursor-source",
        scopeKind: "session",
        agentId: "main",
        runId: `run-session-cursor-${index}`,
        task: `Session cursor task ${index}`,
        status: "running",
        deliveryStatus: "pending",
        lastEventAt: 2_000 - index,
      });
    }
    const query = { agentId: "main", limit: 1, sessionKey: "agent:main:cursor-source" };
    const cursor = expectDefined((await list(query)).payload?.nextCursor, "session cursor");
    expectCursorRejected((await list({ ...query, cursor, sessionKey: "agent:main:other" })).calls);
    expect((await list({ ...query, cursor })).payload?.nextCursor).toBeUndefined();
  });

  it("retires completed cursors and bounds abandoned traversals without capping pages", async () => {
    for (let index = 0; index < 258; index++) {
      createTaskRecord({
        runtime: "cli",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: `run-long-cursor-${index}`,
        task: `Long cursor task ${index}`,
        status: "succeeded",
        deliveryStatus: "not_applicable",
        lastEventAt: 10_000 - index,
      });
    }
    const visited = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await list({ limit: 1, ...(cursor ? { cursor } : {}) });
      const taskId = expectDefined(page.payload?.tasks?.[0]?.taskId, "expected paged task");
      expect(visited.has(taskId)).toBe(false);
      visited.add(taskId);
      cursor = page.payload?.nextCursor;
      if (cursor) {
        expect(cursor).toHaveLength(36);
      }
    } while (cursor);
    expect(visited.size).toBe(258);

    const completed = expectDefined((await list({ limit: 257 })).payload?.nextCursor, "cursor");
    expect((await list({ limit: 257, cursor: completed })).payload?.nextCursor).toBeUndefined();
    expectCursorRejected((await list({ limit: 257, cursor: completed })).calls);

    const abandoned = expectDefined((await list({ limit: 1 })).payload?.nextCursor, "cursor");
    for (let index = 0; index < 300; index++) {
      expect((await list({ limit: 1 })).payload?.nextCursor).toEqual(expect.any(String));
    }
    expectCursorRejected((await list({ limit: 1, cursor: abandoned })).calls);
  });

  it("revalidates requester-session access on continuation", async () => {
    const profileId = ensureProfileForEmail("viewer@example.com").id;
    const foreignKey = "agent:main:dashboard:foreign";
    const ownKey = "agent:main:own-task";
    for (const [sessionKey, actorId] of [
      [foreignKey, "owner@example.com"],
      [ownKey, profileId],
    ] satisfies [string, string][]) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: `session-${sessionKey}`,
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: actorId },
          visibility: "shared",
        },
      );
    }
    const task = (sessionKey: string, lastEventAt: number) =>
      createTaskRecord({
        runtime: "cli",
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        ownerKey: sessionKey,
        scopeKind: "session",
        task: sessionKey,
        status: "running",
        deliveryStatus: "pending",
        lastEventAt,
      });
    task(foreignKey, 2_000);
    const hiddenForeign = task(foreignKey, 1_500);
    const own = task(ownKey, 1_000);
    const guest: GatewayOperatorRoleDefinition = {
      sessions: { others: "view" },
      agents: "*",
      scopes: ["operator.read", "operator.write"],
    };
    const viewer = identifiedClient(["operator.read", "operator.write"], profileId);
    const cursor = expectDefined(
      (
        await list(
          { limit: 1 },
          { gateway: { roles: { default: "guest", definitions: { guest } } } },
          viewer,
        )
      ).payload?.nextCursor,
      "access cursor",
    );
    const restricted: OpenClawConfig = {
      gateway: {
        roles: {
          default: "guest",
          definitions: { guest: { ...guest, sessions: { others: "none" } } },
        },
      },
    };
    const continuation = await list({ limit: 1, cursor }, restricted, viewer);
    expect(continuation.payload?.tasks?.map((entry) => entry.taskId)).toEqual([own.taskId]);
    expect(continuation.payload?.tasks?.map((entry) => entry.taskId)).not.toContain(
      hiddenForeign.taskId,
    );
    expect(continuation.payload?.nextCursor).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { SessionGoal } from "../../config/sessions/types.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { sessionGoalHandlers } from "./sessions-goals.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const SESSION_KEY = "agent:main:goal-rpc";
const SESSION_ID = "session-goal-rpc";
const GOAL_ID = "goal-rpc";

function goal(): SessionGoal {
  return {
    schemaVersion: 1,
    id: GOAL_ID,
    objective: "ship safely",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    tokenStart: 0,
    tokenStartFresh: true,
    tokensUsed: 0,
    continuationTurns: 0,
  };
}

async function seedSession(): Promise<void> {
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: SESSION_KEY },
    {
      sessionId: SESSION_ID,
      updatedAt: 1,
      visibility: "shared",
      goal: goal(),
    },
  );
}

function context() {
  return {
    getRuntimeConfig: () => ({}),
    getSessionEventSubscriberConnIds: () => new Set(["observer"]),
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
  } as unknown as GatewayRequestContext;
}

async function invoke(params: {
  context: GatewayRequestContext;
  method: "sessions.goal.update" | "sessions.goal.clear";
  request: Record<string, unknown>;
  assertCurrent?: () => void;
}) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionGoalHandlers[params.method]?.({
    params: params.request,
    client: null,
    context: params.context,
    sessionMutationAuthorization: {
      assertCurrent: params.assertCurrent ?? vi.fn(),
      assertTargetCurrent: vi.fn(),
    },
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  return responses;
}

describe("typed session goal mutations", () => {
  it("persists update and clear once and exactly replays both results", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seedSession();
      const requestContext = context();
      const update = {
        sessionKey: SESSION_KEY,
        goalId: GOAL_ID,
        operationId: "goal-update-1",
        action: "pause",
        note: "waiting on review",
      };

      const firstUpdate = await invoke({
        context: requestContext,
        method: "sessions.goal.update",
        request: update,
      });
      closeOpenClawAgentDatabasesForTest();
      const replayedUpdate = await invoke({
        context: context(),
        method: "sessions.goal.update",
        request: update,
      });

      expect(firstUpdate[0]?.[0]).toBe(true);
      expect(firstUpdate[0]?.[1]).toMatchObject({
        ok: true,
        sessionKey: SESSION_KEY,
        operationId: "goal-update-1",
        goal: { id: GOAL_ID, status: "paused", lastStatusNote: "waiting on review" },
      });
      expect(replayedUpdate[0]?.[1]).toEqual(firstUpdate[0]?.[1]);
      expect(replayedUpdate[0]?.[3]).toEqual({ cached: true });

      const clear = {
        sessionKey: SESSION_KEY,
        goalId: GOAL_ID,
        operationId: "goal-clear-1",
      };
      const firstClear = await invoke({
        context: requestContext,
        method: "sessions.goal.clear",
        request: clear,
      });
      closeOpenClawAgentDatabasesForTest();
      const replayedClear = await invoke({
        context: context(),
        method: "sessions.goal.clear",
        request: clear,
      });

      expect(firstClear[0]?.[0]).toBe(true);
      expect(firstClear[0]?.[1]).toEqual({
        ok: true,
        sessionKey: SESSION_KEY,
        goalId: GOAL_ID,
        operationId: "goal-clear-1",
      });
      expect(replayedClear[0]?.[1]).toEqual(firstClear[0]?.[1]);
      expect(replayedClear[0]?.[3]).toEqual({ cached: true });
      const updateReplayAfterClear = await invoke({
        context: context(),
        method: "sessions.goal.update",
        request: update,
      });
      expect(updateReplayAfterClear[0]?.[1]).toEqual(firstUpdate[0]?.[1]);
      expect(updateReplayAfterClear[0]?.[3]).toEqual({ cached: true });
      expect(loadSessionEntry({ agentId: "main", sessionKey: SESSION_KEY })?.goal).toBeUndefined();
      expect(
        listSessionStateEventsSince(SESSION_KEY, "main", 0).events.filter(
          (event) => event.kind === "goal_changed",
        ),
      ).toHaveLength(2);
      flushPendingSessionsChangedEvents(requestContext);
      expect(requestContext.broadcastToConnIds).toHaveBeenCalledTimes(2);
    });
  });

  it("rejects operation reuse and stale goal identities without mutation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seedSession();
      const requestContext = context();
      await invoke({
        context: requestContext,
        method: "sessions.goal.update",
        request: {
          sessionKey: SESSION_KEY,
          goalId: GOAL_ID,
          operationId: "goal-update-1",
          action: "pause",
        },
      });

      const reused = await invoke({
        context: requestContext,
        method: "sessions.goal.update",
        request: {
          sessionKey: SESSION_KEY,
          goalId: GOAL_ID,
          operationId: "goal-update-1",
          action: "complete",
        },
      });
      const replaced = await invoke({
        context: requestContext,
        method: "sessions.goal.clear",
        request: {
          sessionKey: SESSION_KEY,
          goalId: "replacement-goal",
          operationId: "goal-clear-stale",
        },
      });

      expect(reused[0]?.[2]).toMatchObject({
        code: "INVALID_REQUEST",
        details: { code: "SESSION_GOAL_CONFLICT" },
        message: "goal operationId was reused with different input",
      });
      expect(replaced[0]?.[2]).toMatchObject({
        details: { code: "SESSION_GOAL_CONFLICT" },
        message: "goal was replaced or no longer exists",
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey: SESSION_KEY })?.goal).toMatchObject({
        id: GOAL_ID,
        status: "paused",
      });
    });
  });

  it("composes session authorization into the persistence commit", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seedSession();
      const assertCurrent = vi.fn(() => {
        throw new Error("session authorization changed");
      });

      const responses = await invoke({
        context: context(),
        method: "sessions.goal.update",
        request: {
          sessionKey: SESSION_KEY,
          goalId: GOAL_ID,
          operationId: "goal-update-fenced",
          action: "pause",
        },
        assertCurrent,
      });

      expect(assertCurrent).toHaveBeenCalledOnce();
      expect(responses[0]?.[2]).toMatchObject({
        code: "INVALID_REQUEST",
        message: "session authorization changed",
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey: SESSION_KEY })?.goal).toEqual(goal());
      expect(
        listSessionStateEventsSince(SESSION_KEY, "main", 0).events.filter(
          (event) => event.kind === "goal_changed",
        ),
      ).toHaveLength(0);

      const retried = await invoke({
        context: context(),
        method: "sessions.goal.update",
        request: {
          sessionKey: SESSION_KEY,
          goalId: GOAL_ID,
          operationId: "goal-update-fenced",
          action: "pause",
        },
      });
      expect(retried[0]?.[0]).toBe(true);
      expect(loadSessionEntry({ agentId: "main", sessionKey: SESSION_KEY })?.goal?.status).toBe(
        "paused",
      );
    });
  });
});

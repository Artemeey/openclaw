import type { Static } from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  SessionGoalSchema,
  SessionsGoalClearParamsSchema,
  SessionsGoalClearResultSchema,
  SessionsGoalUpdateParamsSchema,
  SessionsGoalUpdateResultSchema,
  validateSessionsGoalClearParams,
  validateSessionsGoalClearResult,
  validateSessionsGoalUpdateParams,
  validateSessionsGoalUpdateResult,
  type SessionGoal,
  type SessionsGoalClearParams,
  type SessionsGoalClearResult,
  type SessionsGoalUpdateParams,
  type SessionsGoalUpdateResult,
} from "./index.js";
import { ProtocolSchemas } from "./schema/protocol-schemas.js";

const identity = {
  sessionKey: "agent:main:main",
  goalId: "goal-1",
  operationId: "operation-1",
};
const goal = {
  schemaVersion: 1,
  id: "goal-1",
  objective: "Land the protocol change",
  status: "paused",
  createdAt: 10,
  updatedAt: 20,
  tokenStart: 100,
  tokenStartFresh: true,
  tokensUsed: 25,
  tokenBudget: 1_000,
  continuationTurns: 2,
  lastStatusNote: "Waiting for review",
  pausedAt: 20,
} as const;

describe("session Goal protocol", () => {
  it("exposes schema-derived types and registry entries through the package boundary", () => {
    expectTypeOf<SessionGoal>().toEqualTypeOf<Static<typeof SessionGoalSchema>>();
    expectTypeOf<SessionsGoalUpdateParams>().toEqualTypeOf<
      Static<typeof SessionsGoalUpdateParamsSchema>
    >();
    expectTypeOf<SessionsGoalUpdateResult>().toEqualTypeOf<
      Static<typeof SessionsGoalUpdateResultSchema>
    >();
    expectTypeOf<SessionsGoalClearParams>().toEqualTypeOf<
      Static<typeof SessionsGoalClearParamsSchema>
    >();
    expectTypeOf<SessionsGoalClearResult>().toEqualTypeOf<
      Static<typeof SessionsGoalClearResultSchema>
    >();
    expect(ProtocolSchemas.SessionGoal).toBe(SessionGoalSchema);
    expect(ProtocolSchemas.SessionsGoalUpdateParams).toBe(SessionsGoalUpdateParamsSchema);
    expect(ProtocolSchemas.SessionsGoalUpdateResult).toBe(SessionsGoalUpdateResultSchema);
    expect(ProtocolSchemas.SessionsGoalClearParams).toBe(SessionsGoalClearParamsSchema);
    expect(ProtocolSchemas.SessionsGoalClearResult).toBe(SessionsGoalClearResultSchema);
  });

  it.each([
    { ...identity, action: "edit", objective: "Ship the protocol" },
    { ...identity, action: "pause", note: "Waiting" },
    { ...identity, action: "resume" },
    { ...identity, action: "complete", note: "Shipped" },
    { ...identity, action: "block", note: "Dependency unavailable" },
  ])("accepts the closed $action update variant", (params) => {
    expect(validateSessionsGoalUpdateParams(params)).toBe(true);
  });

  it.each([
    { ...identity, action: "edit" },
    { ...identity, action: "edit", objective: "Ship", note: "extra" },
    { ...identity, action: "pause", objective: "not valid for pause" },
    { ...identity, action: "cancel" },
    { ...identity, action: "resume", extra: true },
  ])("rejects an invalid or open update variant", (params) => {
    expect(validateSessionsGoalUpdateParams(params)).toBe(false);
  });

  it("rejects Goal mutations that exceed durable receipt bounds", () => {
    expect(
      validateSessionsGoalUpdateParams({
        ...identity,
        operationId: "o".repeat(257),
        action: "pause",
      }),
    ).toBe(false);
    expect(
      validateSessionsGoalUpdateParams({
        ...identity,
        action: "edit",
        objective: "x".repeat(8_193),
      }),
    ).toBe(false);
    expect(
      validateSessionsGoalUpdateParams({
        ...identity,
        action: "block",
        note: "x".repeat(2_001),
      }),
    ).toBe(false);
  });

  it("validates closed update and clear results", () => {
    const updateResult = {
      ok: true,
      sessionKey: identity.sessionKey,
      operationId: identity.operationId,
      goal,
    };
    expect(validateSessionsGoalUpdateResult(updateResult)).toBe(true);
    expect(validateSessionsGoalUpdateResult({ ...updateResult, replayed: true })).toBe(false);
    expect(
      validateSessionsGoalUpdateResult({
        ...updateResult,
        goal: { ...goal, status: "cancelled" },
      }),
    ).toBe(false);
    expect(validateSessionsGoalClearParams(identity)).toBe(true);
    expect(validateSessionsGoalClearResult({ ok: true, ...identity })).toBe(true);
    expect(validateSessionsGoalClearParams({ ...identity, force: true })).toBe(false);
    expect(validateSessionsGoalClearResult({ ok: true, ...identity, clearedAt: 20 })).toBe(false);
  });
});

import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const SESSION_GOAL_ID_MAX_LENGTH = 128;
export const SESSION_GOAL_OBJECTIVE_MAX_LENGTH = 8_192;
export const SESSION_GOAL_NOTE_MAX_LENGTH = 2_000;
export const SESSION_GOAL_OPERATION_ID_MAX_LENGTH = 256;
const GoalIdString = Type.String({ minLength: 1, maxLength: SESSION_GOAL_ID_MAX_LENGTH });
const GoalObjectiveString = Type.String({
  minLength: 1,
  maxLength: SESSION_GOAL_OBJECTIVE_MAX_LENGTH,
});
const GoalNoteString = Type.String({ minLength: 1, maxLength: SESSION_GOAL_NOTE_MAX_LENGTH });
const GoalOperationIdString = Type.String({
  minLength: 1,
  maxLength: SESSION_GOAL_OPERATION_ID_MAX_LENGTH,
});

/** Public session Goal lifecycle states returned by typed Goal mutations. */
export const SessionGoalStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("blocked"),
  Type.Literal("usage_limited"),
  Type.Literal("budget_limited"),
  Type.Literal("complete"),
]);

/** Complete Goal state returned after a successful typed update. */
export const SessionGoalSchema = closedObject({
  schemaVersion: Type.Literal(1),
  id: GoalIdString,
  objective: GoalObjectiveString,
  status: SessionGoalStatusSchema,
  createdAt: Type.Integer({ minimum: 0 }),
  updatedAt: Type.Integer({ minimum: 0 }),
  tokenStart: Type.Integer({ minimum: 0 }),
  tokenStartFresh: Type.Optional(Type.Boolean()),
  tokensUsed: Type.Integer({ minimum: 0 }),
  tokenBudget: Type.Optional(Type.Integer({ minimum: 1 })),
  continuationTurns: Type.Integer({ minimum: 0 }),
  lastStatusNote: Type.Optional(GoalNoteString),
  pausedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  blockedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  completedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  usageLimitedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  budgetLimitedAt: Type.Optional(Type.Integer({ minimum: 0 })),
});

const SessionsGoalMutationIdentitySchema = {
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  goalId: GoalIdString,
  operationId: GoalOperationIdString,
};

/** Updates one exact Goal without creating a chat turn. */
export const SessionsGoalUpdateParamsSchema = Type.Union([
  closedObject({
    ...SessionsGoalMutationIdentitySchema,
    action: Type.Literal("edit"),
    objective: GoalObjectiveString,
  }),
  closedObject({
    ...SessionsGoalMutationIdentitySchema,
    action: Type.Union([
      Type.Literal("pause"),
      Type.Literal("resume"),
      Type.Literal("complete"),
      Type.Literal("block"),
    ]),
    note: Type.Optional(GoalNoteString),
  }),
]);

/** Replay-stable result of a typed Goal update. */
export const SessionsGoalUpdateResultSchema = closedObject({
  ok: Type.Literal(true),
  sessionKey: NonEmptyString,
  operationId: GoalOperationIdString,
  goal: SessionGoalSchema,
});

/** Clears one exact Goal without creating a chat turn. */
export const SessionsGoalClearParamsSchema = closedObject({
  ...SessionsGoalMutationIdentitySchema,
});

/** Replay-stable result of clearing one exact Goal. */
export const SessionsGoalClearResultSchema = closedObject({
  ok: Type.Literal(true),
  sessionKey: NonEmptyString,
  goalId: GoalIdString,
  operationId: GoalOperationIdString,
});

export type SessionGoalStatus = Static<typeof SessionGoalStatusSchema>;
export type SessionGoal = Static<typeof SessionGoalSchema>;
export type SessionsGoalUpdateParams = Static<typeof SessionsGoalUpdateParamsSchema>;
export type SessionsGoalUpdateResult = Static<typeof SessionsGoalUpdateResultSchema>;
export type SessionsGoalClearParams = Static<typeof SessionsGoalClearParamsSchema>;
export type SessionsGoalClearResult = Static<typeof SessionsGoalClearResultSchema>;

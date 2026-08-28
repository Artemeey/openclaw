import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { SessionPermissionModeSchema } from "./sessions-row.js";

export const SessionsRestartTurnParamsSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  runId: NonEmptyString,
  reason: Type.Literal("permission-change"),
  permissionMode: Type.Union([SessionPermissionModeSchema, Type.Null()]),
  idempotencyKey: NonEmptyString,
});

export const SessionsRestartTurnResultSchema = closedObject({
  ok: Type.Literal(true),
  interruptedRunId: NonEmptyString,
  runId: NonEmptyString,
  status: Type.Literal("started"),
});

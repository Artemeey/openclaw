import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionsGoalClearParams,
  type SessionsGoalClearResult,
  type SessionsGoalUpdateParams,
  type SessionsGoalUpdateResult,
  validateSessionsGoalClearParams,
  validateSessionsGoalClearResult,
  validateSessionsGoalUpdateParams,
  validateSessionsGoalUpdateResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  clearSessionGoal,
  projectSessionGoalTransition,
  updateSessionGoalObjective,
  updateSessionGoalStatus,
} from "../../config/sessions/goals.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { SessionStateActorType } from "../../sessions/session-state-events.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  fingerprintSessionRpcReceiptInput,
  insertSessionRpcReceiptInTransaction,
  readSessionRpcReceipt,
  SessionRpcReceiptConflictError,
  type SessionRpcReceipt,
  type SessionRpcReceiptJson,
} from "../../state/openclaw-agent-session-rpc-receipts.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  resolveSessionSharingTarget,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type {
  GatewayClient,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

type SessionGoalMutationParams = SessionsGoalUpdateParams | SessionsGoalClearParams;
type SessionGoalMutationResult = SessionsGoalUpdateResult | SessionsGoalClearResult;

type GoalMutationTarget = {
  agentId: string;
  canonicalKey: string;
  entry: SessionEntry;
  storeKey: string;
  storePath: string;
};

function validateStoredGoalResult(
  method: "sessions.goal.update" | "sessions.goal.clear",
  result: SessionRpcReceiptJson,
): result is SessionGoalMutationResult & SessionRpcReceiptJson {
  return method === "sessions.goal.update"
    ? validateSessionsGoalUpdateResult(result)
    : validateSessionsGoalClearResult(result);
}

class SessionGoalReceiptReplayError extends Error {
  constructor(readonly receipt: SessionRpcReceipt) {
    super("Session Goal mutation already committed");
    this.name = "SessionGoalReceiptReplayError";
  }
}

function goalRequestFingerprint(params: {
  method: "sessions.goal.update" | "sessions.goal.clear";
  request: SessionGoalMutationParams;
  agentId: string;
  canonicalKey: string;
  sessionId: string;
}) {
  const transition =
    params.method === "sessions.goal.update" && "action" in params.request
      ? [
          params.request.action,
          params.request.action === "edit"
            ? params.request.objective
            : (params.request.note ?? null),
        ]
      : null;
  return fingerprintSessionRpcReceiptInput([
    params.method,
    params.agentId,
    params.sessionId,
    params.request.goalId,
    transition,
  ]);
}

function goalConflict(message: string) {
  return errorShape(ErrorCodes.INVALID_REQUEST, message, {
    details: { code: "SESSION_GOAL_CONFLICT" },
  });
}

function goalProjectionInput(entry: SessionEntry): string {
  return JSON.stringify([
    entry.goal ?? null,
    entry.totalTokens ?? null,
    entry.totalTokensFresh ?? null,
    entry.totalTokensVersion ?? null,
  ]);
}

function resolveGoalMutationActor(client: GatewayClient | null): {
  type: SessionStateActorType;
  id?: string;
} {
  const runtimeAgentId = normalizeOptionalString(client?.internal?.agentRuntimeIdentity?.agentId);
  const toolAgentId =
    client?.internal?.syntheticClient === true
      ? normalizeOptionalString(client.internal.agentToolCaller?.agentId)
      : undefined;
  const agentId = runtimeAgentId ?? toolAgentId;
  if (agentId) {
    return { type: "agent", id: agentId };
  }
  const human = gatewayClientSessionCreator(client);
  return human ? { type: "human", id: human.id } : { type: "human" };
}

async function runSessionGoalMutation(params: {
  method: "sessions.goal.update" | "sessions.goal.clear";
  request: SessionGoalMutationParams;
  options: Omit<GatewayRequestHandlerOptions, "params">;
  prepare: (target: GoalMutationTarget) => {
    result: SessionGoalMutationResult & SessionRpcReceiptJson;
    mutate: (assertCommitAllowed: () => void) => Promise<void>;
  };
}): Promise<void> {
  const { context, respond } = params.options;
  const requestedAgent = resolveRequestedSessionAgentId(
    context.getRuntimeConfig(),
    params.request.sessionKey,
    params.request.agentId,
  );
  if (!requestedAgent.ok) {
    respond(false, undefined, requestedAgent.error);
    return;
  }
  const target = resolveSessionSharingTarget({
    cfg: context.getRuntimeConfig(),
    sessionKey: params.request.sessionKey,
    agentId: requestedAgent.agentId,
  });
  const sessionId = target?.entry.sessionId?.trim();
  if (!target || !sessionId) {
    respond(false, undefined, goalConflict("session or goal no longer exists"));
    return;
  }
  const projectionInput = goalProjectionInput(target.entry);

  const receiptKey = {
    sessionId,
    method: params.method,
    operationId: params.request.operationId,
  };
  const requestIdentity = goalRequestFingerprint({
    method: params.method,
    request: params.request,
    agentId: target.agentId,
    canonicalKey: target.canonicalKey,
    sessionId,
  });
  const databaseOptions = toDatabaseOptions(
    resolveSqliteReadScope({
      agentId: target.agentId,
      sessionKey: target.storeKey,
      storePath: target.storePath,
    }),
  );
  const existingReceipt = readSessionRpcReceipt(
    openOpenClawAgentDatabase(databaseOptions),
    receiptKey,
  );
  if (existingReceipt) {
    if (existingReceipt.requestFingerprint !== requestIdentity) {
      respond(false, undefined, goalConflict("goal operationId was reused with different input"));
      return;
    }
    if (!validateStoredGoalResult(params.method, existingReceipt.result)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "stored goal result is invalid"),
      );
      return;
    }
    params.options.sessionMutationCommitGuard?.();
    params.options.sessionMutationAuthorization?.assertCurrent();
    respond(true, existingReceipt.result, undefined, { cached: true });
    return;
  }

  const currentGoalId = target.entry.goal?.id;
  if (currentGoalId !== params.request.goalId) {
    respond(false, undefined, goalConflict("goal was replaced or no longer exists"));
    return;
  }
  let prepared: ReturnType<typeof params.prepare>;
  try {
    prepared = params.prepare(target);
    if (!validateStoredGoalResult(params.method, prepared.result)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "prepared goal result is invalid"),
      );
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    respond(
      false,
      undefined,
      /goal (?:changed|not found)/u.test(message)
        ? goalConflict("goal was replaced or no longer exists")
        : errorShape(ErrorCodes.INVALID_REQUEST, message),
    );
    return;
  }
  try {
    const assertCommitAllowed = () => {
      params.options.sessionMutationCommitGuard?.();
      params.options.sessionMutationAuthorization?.assertCurrent();
      const current = resolveSessionSharingTarget({
        cfg: context.getRuntimeConfig(),
        sessionKey: target.canonicalKey,
        agentId: target.agentId,
      });
      if (
        !current ||
        current.agentId !== target.agentId ||
        current.canonicalKey !== target.canonicalKey ||
        current.storeKey !== target.storeKey ||
        current.storePath !== target.storePath ||
        current.entry.sessionId?.trim() !== sessionId
      ) {
        throw new SessionMutationAuthorizationChangedError(
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `${params.method} target session changed; retry the request`,
            {
              details: {
                code: "SESSION_MUTATION_AUTHORIZATION_CHANGED",
                method: params.method,
                sessionKey: params.request.sessionKey,
              },
            },
          ),
        );
      }
      const receipt = insertSessionRpcReceiptInTransaction(
        openOpenClawAgentDatabase(databaseOptions),
        {
          ...receiptKey,
          requestFingerprint: requestIdentity,
          result: prepared.result,
          createdAt: Date.now(),
        },
      );
      if (receipt.status === "replay") {
        throw new SessionGoalReceiptReplayError(receipt.receipt);
      }
      if (goalProjectionInput(current.entry) !== projectionInput) {
        throw new SessionMutationAuthorizationChangedError(
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `${params.method} target goal changed; retry the request`,
            {
              details: {
                code: "SESSION_MUTATION_AUTHORIZATION_CHANGED",
                method: params.method,
                sessionKey: params.request.sessionKey,
              },
            },
          ),
        );
      }
    };
    await prepared.mutate(assertCommitAllowed);
    emitSessionsChanged(context, {
      sessionKey: target.canonicalKey,
      agentId: target.agentId,
      reason: "goal",
    });
    respond(true, prepared.result, undefined);
  } catch (error) {
    if (error instanceof SessionGoalReceiptReplayError) {
      if (!validateStoredGoalResult(params.method, error.receipt.result)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "stored goal result is invalid"),
        );
        return;
      }
      params.options.sessionMutationCommitGuard?.();
      params.options.sessionMutationAuthorization?.assertCurrent();
      respond(true, error.receipt.result, undefined, { cached: true });
      return;
    }
    if (error instanceof SessionRpcReceiptConflictError) {
      respond(false, undefined, goalConflict("goal operationId was reused with different input"));
      return;
    }
    if (error instanceof SessionMutationAuthorizationChangedError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    respond(
      false,
      undefined,
      /goal (?:changed|not found)/u.test(message)
        ? goalConflict("goal was replaced or no longer exists")
        : errorShape(ErrorCodes.INVALID_REQUEST, message),
    );
  }
}

export const sessionGoalHandlers: GatewayRequestHandlers = {
  "sessions.goal.update": defineValidatedGatewayMethod(
    "sessions.goal.update",
    validateSessionsGoalUpdateParams,
    async ({ params: request, ...options }) => {
      await runSessionGoalMutation({
        method: "sessions.goal.update",
        request,
        options,
        prepare: (target) => {
          const now = Date.now();
          const transition =
            request.action === "edit"
              ? ({ action: "edit", objective: request.objective } as const)
              : ({
                  action: request.action,
                  ...(request.note ? { note: request.note } : {}),
                } as const);
          const projected = projectSessionGoalTransition(target.entry, {
            expectedGoalId: request.goalId,
            now,
            transition,
          });
          const common = {
            sessionKey: target.storeKey,
            storePath: target.storePath,
            expectedGoalId: request.goalId,
            actor: resolveGoalMutationActor(options.client),
            agentId: target.agentId,
          };
          return {
            result: {
              ok: true,
              sessionKey: target.canonicalKey,
              operationId: request.operationId,
              goal: projected.goal,
            },
            mutate: async (assertCommitAllowed) => {
              if (request.action === "edit") {
                await updateSessionGoalObjective({
                  ...common,
                  objective: request.objective,
                  now,
                  assertCommitAllowed,
                });
                return;
              }
              await updateSessionGoalStatus({
                ...common,
                status:
                  request.action === "resume"
                    ? "active"
                    : request.action === "pause"
                      ? "paused"
                      : request.action === "block"
                        ? "blocked"
                        : "complete",
                ...(request.note ? { note: request.note } : {}),
                now,
                assertCommitAllowed,
              });
            },
          };
        },
      });
    },
  ),
  "sessions.goal.clear": defineValidatedGatewayMethod(
    "sessions.goal.clear",
    validateSessionsGoalClearParams,
    async ({ params: request, ...options }) => {
      await runSessionGoalMutation({
        method: "sessions.goal.clear",
        request,
        options,
        prepare: (target) => {
          return {
            result: {
              ok: true,
              sessionKey: target.canonicalKey,
              goalId: request.goalId,
              operationId: request.operationId,
            },
            mutate: async (assertCommitAllowed) => {
              await clearSessionGoal({
                sessionKey: target.storeKey,
                storePath: target.storePath,
                expectedGoalId: request.goalId,
                actor: resolveGoalMutationActor(options.client),
                agentId: target.agentId,
                assertCommitAllowed,
              });
            },
          };
        },
      });
    },
  ),
};

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  insertSessionRpcReceiptInTransaction,
  readSessionRpcReceipt,
  SessionRpcReceiptConflictError,
} from "../../state/openclaw-agent-session-rpc-receipts.js";
import type { TranscriptMessageAppendResult } from "./session-accessor.sqlite-contract.js";
import type { SessionTurnMutation, SessionTurnMutationResult } from "./session-accessor.types.js";
import { projectSessionGoalCreate } from "./session-goal-create.js";
import type { SessionEntry, SessionGoal } from "./types.js";

function parseSessionGoalStartResult(value: unknown): SessionTurnMutationResult["result"] {
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    typeof value.goalId !== "string" ||
    value.status !== "started"
  ) {
    throw new Error("Stored session Goal start result is invalid");
  }
  return { runId: value.runId, goalId: value.goalId, status: "started" };
}

export function readSessionGoalStartReplay(params: {
  database: OpenClawAgentDatabase;
  mutation: SessionTurnMutation;
  sessionId: string;
}): SessionTurnMutationResult["result"] | undefined {
  const key = {
    sessionId: params.sessionId,
    method: "chat.send",
    operationId: params.mutation.operationId,
  };
  const receipt = readSessionRpcReceipt(params.database, key, params.mutation.now);
  if (!receipt) {
    return undefined;
  }
  if (receipt.requestFingerprint !== params.mutation.requestFingerprint) {
    throw new SessionRpcReceiptConflictError(key);
  }
  return parseSessionGoalStartResult(receipt.result);
}

export function commitSessionGoalStartMutation(params: {
  appendedMessages: readonly TranscriptMessageAppendResult<unknown>[];
  database: OpenClawAgentDatabase;
  entry: SessionEntry;
  mutation: SessionTurnMutation;
  sessionId: string;
}): { goal: SessionGoal } {
  const admitted = params.appendedMessages[0];
  const admittedContent =
    admitted?.message && typeof admitted.message === "object" && "content" in admitted.message
      ? admitted.message.content
      : undefined;
  if (
    params.appendedMessages.length !== 1 ||
    admitted?.appended !== true ||
    admittedContent !== params.mutation.objective
  ) {
    throw new Error("Session Goal start requires one unchanged new transcript turn");
  }
  const goalPatch = projectSessionGoalCreate(params.entry, {
    goalId: params.mutation.goalId,
    now: params.mutation.now,
    objective: params.mutation.objective,
  });
  const receipt = insertSessionRpcReceiptInTransaction(params.database, {
    sessionId: params.sessionId,
    method: "chat.send",
    operationId: params.mutation.operationId,
    requestFingerprint: params.mutation.requestFingerprint,
    result: params.mutation.result,
    createdAt: params.mutation.now,
  });
  if (receipt.status === "replay") {
    throw new Error("Session Goal start receipt raced its transcript transaction");
  }
  return goalPatch;
}

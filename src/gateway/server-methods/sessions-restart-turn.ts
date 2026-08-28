import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  validateSessionsRestartTurnParams,
  type SessionsRestartTurnResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionPermissionMode } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import { TOOL_FAILURE_INSTRUCTION } from "../../agents/tool-outcome-instructions.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { PERMISSION_CHANGE_RESTART_SOURCE_TOOL } from "../../sessions/input-provenance.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { handleTrustedInternalChatSend } from "./chat-send-handler.js";
import { executeSessionPatch } from "./sessions-patch-engine.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function permissionModeLabel(mode: SessionPermissionMode | null): string {
  switch (mode) {
    case "read-only":
      return "Read only";
    case "guarded":
      return "Guarded";
    case "workspace":
      return "Workspace";
    case "full":
      return "Full access";
    default:
      return "Default";
  }
}

async function launchPermissionChangeRestart(params: {
  agentId?: string;
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  idempotencyKey: string;
  permissionMode: SessionPermissionMode | null;
  req: GatewayRequestHandlerOptions["req"];
  runId: string;
  sessionId: string;
  sessionKey: string;
}) {
  let outcome:
    | { ok: true; runId: string }
    | { ok: false; error: ReturnType<typeof errorShape> }
    | undefined;
  const mode = permissionModeLabel(params.permissionMode);
  try {
    await handleTrustedInternalChatSend(
      {
        req: params.req,
        params: {
          sessionKey: params.sessionKey,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          sessionId: params.sessionId,
          message: formatSystemTurnPrompt(
            `Permissions changed to ${mode}. Continue the interrupted response from the existing transcript. ` +
              `Treat interrupted or missing tool results as having an unknown outcome. ${TOOL_FAILURE_INSTRUCTION}`,
          ),
          idempotencyKey: params.idempotencyKey,
          deliver: false,
          queueMode: "interrupt",
          suppressCommandInterpretation: true,
          systemInputProvenance: {
            kind: "internal_system",
            sourceSessionKey: params.sessionKey,
            sourceTool: PERMISSION_CHANGE_RESTART_SOURCE_TOOL,
          },
        },
        respond: (ok, payload, error) => {
          const runId =
            ok && isRecord(payload) && typeof payload.runId === "string"
              ? payload.runId.trim()
              : "";
          outcome = runId
            ? { ok: true, runId }
            : {
                ok: false,
                error: error ?? errorShape(ErrorCodes.UNAVAILABLE, "Turn restart was not started."),
              };
        },
        context: params.context,
        client: params.client,
        isWebchatConnect: () => false,
      },
      undefined,
      { expectedInterruptRunId: params.runId },
    );
  } catch (error) {
    return {
      ok: false as const,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        `Turn restart failed: ${formatErrorMessage(error)}`,
      ),
    };
  }
  return (
    outcome ?? {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "Turn restart returned no outcome."),
    }
  );
}

export const sessionRestartTurnHandlers: GatewayRequestHandlers = {
  "sessions.restartTurn": async ({
    req,
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
  }) => {
    if (
      !assertValidParams(params, validateSessionsRestartTurnParams, "sessions.restartTurn", respond)
    ) {
      return;
    }
    const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
    if (params.permissionMode === "full" && client !== null && !scopes.includes(ADMIN_SCOPE)) {
      respond(
        false,
        undefined,
        missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
      );
      return;
    }
    const patched = await executeSessionPatch({
      client,
      context,
      patch: {
        key: params.key,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        permissionMode: params.permissionMode,
      },
      sessionMutationAuthorization,
    });
    if (!patched.ok) {
      respond(false, undefined, patched.error);
      return;
    }
    const sessionId = patched.result.entry.sessionId;
    if (!sessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Session has no runtime identity."),
      );
      return;
    }
    const restarted = await launchPermissionChangeRestart({
      ...(params.agentId ? { agentId: params.agentId } : {}),
      client,
      context,
      idempotencyKey: params.idempotencyKey,
      permissionMode: params.permissionMode,
      req,
      runId: params.runId,
      sessionId,
      sessionKey: patched.result.key,
    });
    if (!restarted.ok) {
      respond(false, undefined, restarted.error);
      return;
    }
    const result: SessionsRestartTurnResult = {
      ok: true,
      interruptedRunId: params.runId,
      runId: restarted.runId,
      status: "started",
    };
    respond(true, result, undefined);
  },
};

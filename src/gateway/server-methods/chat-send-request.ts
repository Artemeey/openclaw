import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
  type GatewayClientInfo,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  formatValidationErrors,
  validateChatSendParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type {
  ChatSendIntent,
  QueueMode,
} from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { isBtwRequestText } from "../../auto-reply/reply/btw-command.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { normalizeInputProvenance } from "../../sessions/input-provenance.js";
import { isBrowserCopilotClient, isOperatorUiClient } from "../../utils/message-channel.js";
import { isChatStopCommandText } from "../chat-abort.js";
import type { ChatAttachment } from "../chat-attachments.js";
import { sanitizeChatSendMessageInput } from "../chat-input-sanitize.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import {
  hasGatewayAdminScope,
  normalizeExplicitChatSendOrigin,
  normalizeOptionalChatSystemReceipt,
  type ChatSendExplicitOrigin,
} from "./chat-origin-routing.js";
import { resolveControlUiReconnectResumeParams } from "./chat-server-timing.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type ChatSendRequestParams = {
  sessionKey: string;
  agentId?: string;
  sessionId?: string;
  message: string;
  thinking?: string;
  fastMode?: FastMode;
  fastAutoOnSeconds?: number;
  queueMode?: QueueMode;
  deliver?: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string;
  replyToId?: string;
  attachments?: Array<{
    type?: string;
    mimeType?: string;
    fileName?: string;
    content?: unknown;
  }>;
  toolBindings?: Record<string, unknown>;
  timeoutMs?: number;
  systemInputProvenance?: InputProvenance;
  systemProvenanceReceipt?: string;
  suppressCommandInterpretation?: boolean;
  expectedLeafEntryId?: string | null;
  expectedSessionRoutingContract?: string;
  intent?: ChatSendIntent;
  idempotencyKey: string;
};

type StructuredChatGoalStart = {
  goalId: string;
  kind: "session-goal-start";
  operationId: string;
  sourceRunId: string;
  sourceTurnId: string;
  version: 1;
};

export type NormalizedChatSendRequest = {
  chatSendReceivedAtMs: number;
  clientInfo?: GatewayClientInfo;
  supportsTaskSuggestions: boolean;
  p: ChatSendRequestParams;
  explicitOrigin?: ChatSendExplicitOrigin;
  inboundMessage: string;
  systemInputProvenance?: InputProvenance;
  systemProvenanceReceipt?: string;
  suppressCommandInterpretation: boolean;
  toolBindings?: Readonly<Record<string, unknown>>;
  stopCommand: boolean;
  turnKind: "btw" | "main";
  normalizedAttachments: ChatAttachment[];
  rawMessage: string;
  reconnectResumeRequested: boolean;
  structuredGoalStart?: StructuredChatGoalStart;
};

type NormalizeChatSendRequestResult =
  | { ok: true; value: NormalizedChatSendRequest }
  | { ok: false; error: string; reason?: string };

/** Validate and normalize the wire request before session or lifecycle work begins. */
export function normalizeChatSendRequest(params: {
  params: Record<string, unknown>;
  client: GatewayRequestHandlerOptions["client"];
  trustedSystemInput?: boolean;
}): NormalizeChatSendRequestResult {
  const chatSendReceivedAtMs = performance.now();
  const client = params.client;
  const clientInfo = client?.connect?.client;
  const supportsTaskSuggestions =
    isOperatorUiClient(clientInfo) &&
    params.client?.connect?.scopes?.includes("operator.admin") === true &&
    hasGatewayClientCap(params.client?.connect?.caps, GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS);
  const controlUiReconnectResume = resolveControlUiReconnectResumeParams(params.params, clientInfo);
  if (!validateChatSendParams(controlUiReconnectResume.params)) {
    return {
      ok: false,
      error: `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
    };
  }

  const p = controlUiReconnectResume.params as ChatSendRequestParams;
  const isStructuredGoalStart = p.intent?.kind === "session-goal-start";
  if (
    isStructuredGoalStart &&
    (p.queueMode !== undefined ||
      p.deliver !== undefined ||
      p.suppressCommandInterpretation !== undefined ||
      p.systemInputProvenance !== undefined ||
      p.systemProvenanceReceipt !== undefined ||
      p.originatingChannel !== undefined ||
      p.originatingTo !== undefined ||
      p.originatingAccountId !== undefined ||
      p.originatingThreadId !== undefined ||
      p.toolBindings !== undefined)
  ) {
    return {
      ok: false,
      error:
        "session Goal start cannot include queue, delivery, routing, provenance, command, or tool-binding controls",
    };
  }
  if (
    isStructuredGoalStart &&
    (p.idempotencyKey !== p.idempotencyKey.trim() || p.idempotencyKey.length > 256)
  ) {
    return {
      ok: false,
      error: "session Goal start idempotencyKey must be canonical and at most 256 characters",
    };
  }
  const suppressCommandInterpretation =
    isStructuredGoalStart || p.suppressCommandInterpretation === true;
  const explicitOriginResult = normalizeExplicitChatSendOrigin({
    originatingChannel: p.originatingChannel,
    originatingTo: p.originatingTo,
    accountId: p.originatingAccountId,
    messageThreadId: p.originatingThreadId,
  });
  if (!explicitOriginResult.ok) {
    return explicitOriginResult;
  }
  if (
    (p.systemInputProvenance ||
      p.systemProvenanceReceipt ||
      p.suppressCommandInterpretation === true ||
      explicitOriginResult.value) &&
    !params.trustedSystemInput &&
    !hasGatewayAdminScope(params.client)
  ) {
    return {
      ok: false,
      error:
        p.systemInputProvenance ||
        p.systemProvenanceReceipt ||
        p.suppressCommandInterpretation === true
          ? "system provenance fields require admin scope"
          : "originating route fields require admin scope",
    };
  }

  const sanitizedMessageResult = sanitizeChatSendMessageInput(p.message);
  if (!sanitizedMessageResult.ok) {
    return sanitizedMessageResult;
  }
  const systemReceiptResult = normalizeOptionalChatSystemReceipt(p.systemProvenanceReceipt);
  if (!systemReceiptResult.ok) {
    return systemReceiptResult;
  }

  const inboundMessage = sanitizedMessageResult.message;
  const systemInputProvenance = normalizeInputProvenance(p.systemInputProvenance);
  const systemProvenanceReceipt = systemReceiptResult.receipt;
  const stopCommand = !suppressCommandInterpretation && isChatStopCommandText(inboundMessage);
  if (p.toolBindings) {
    if (
      !client ||
      !isBrowserCopilotClient(clientInfo) ||
      client.pairedClientId !== clientInfo?.id
    ) {
      return { ok: false, error: "run tool bindings require a paired browser copilot" };
    }
    if (!hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS)) {
      return { ok: false, error: "run tool bindings require client capability" };
    }
  }
  if (
    isBrowserCopilotClient(clientInfo) &&
    !stopCommand &&
    (!p.toolBindings || !Object.hasOwn(p.toolBindings, "browser"))
  ) {
    return { ok: false, error: "browser copilot runs require an explicit browser tool binding" };
  }
  // The browser plugin owns the binding schema and validates it while tools are
  // constructed, before model execution. Gateway owns only paired-client admission.
  const turnKind =
    !suppressCommandInterpretation && isBtwRequestText(inboundMessage) ? "btw" : "main";
  const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(p.attachments);
  const rawMessage = inboundMessage.trim();
  if (!rawMessage && normalizedAttachments.length === 0) {
    return { ok: false, error: "message or attachment required" };
  }

  return {
    ok: true,
    value: {
      chatSendReceivedAtMs,
      clientInfo,
      supportsTaskSuggestions,
      p,
      explicitOrigin: explicitOriginResult.value,
      inboundMessage,
      systemInputProvenance,
      systemProvenanceReceipt,
      suppressCommandInterpretation,
      toolBindings: p.toolBindings,
      stopCommand,
      turnKind,
      normalizedAttachments,
      rawMessage,
      reconnectResumeRequested: controlUiReconnectResume.resumeRequested,
      ...(isStructuredGoalStart
        ? {
            structuredGoalStart: {
              goalId: `goal-${createHash("sha256")
                .update(`openclaw.session-goal-start.v1\0${p.idempotencyKey}`)
                .digest("hex")
                .slice(0, 36)}`,
              kind: "session-goal-start" as const,
              operationId: p.idempotencyKey,
              sourceRunId: p.idempotencyKey,
              sourceTurnId: `${p.idempotencyKey}:user`,
              version: 1 as const,
            },
          }
        : {}),
    },
  };
}

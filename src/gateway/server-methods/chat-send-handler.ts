// chat.send owns admission, ACK timing, and detached dispatch handoff.
import { performance } from "node:perf_hooks";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { emitDiagnosticsTimelineEvent } from "../../infra/diagnostics-timeline.js";
import { recordSessionGoalChanged } from "../../sessions/session-state-events.js";
import type { SkillWorkshopProposalRevisionConstraint } from "../../skills/workshop/types.js";
import { SessionRpcReceiptConflictError } from "../../state/openclaw-agent-session-rpc-receipts.js";
import { discardPreparedInboundMedia } from "../chat-attachments.js";
import type { ChatRunTiming } from "../server-chat-state.js";
import {
  terminalizeRestartSafeChatAdmission,
  type RestartSafeChatTerminalState,
} from "./chat-restart-recovery.js";
import { startChatDispatch } from "./chat-send-agent-dispatch.js";
import { prepareChatSendAttachments } from "./chat-send-attachments.js";
import { handleChatSendSetupError } from "./chat-send-dispatch-errors.js";
import type { ChatSendExternalAuthorityAdmission } from "./chat-send-external-authority-contract.js";
import {
  createChatSendMessageInjectionStarter,
  settleChatSendPreAckMessageInjection,
} from "./chat-send-message-injection.js";
import { applyChatSendReplyContextFields } from "./chat-send-reply-context.js";
import { prepareAndAdmitChatSend } from "./chat-send-setup.js";
import { prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import {
  chatSendAckServerTimingAttributes,
  roundedChatSendTimingMs,
  shouldIncludeChatSendAckServerTiming,
} from "./chat-server-timing.js";
import { createGatewayChatUserTurnController } from "./chat-user-turn-recorder.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type ChatSendInternalOptions = {
  trustedSystemInput?: boolean;
  toolsAllow?: string[];
  skillWorkshopProposalRevision?: SkillWorkshopProposalRevisionConstraint;
};

async function handleChatSendWithOptions(
  requestOptions: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
  externalAuthorityAdmission?: ChatSendExternalAuthorityAdmission,
  options?: ChatSendInternalOptions,
): Promise<void> {
  const { params, respond, context, client } = requestOptions;
  const setup = await prepareAndAdmitChatSend(
    { params, respond, context, client },
    onAdmissionOwned,
    options,
  );
  if (!setup) {
    return;
  }
  const { normalizedRequest, preparedSession, admitted } = setup;
  const { chatSendReceivedAtMs, clientInfo, p, systemInputProvenance, reconnectResumeRequested } =
    normalizedRequest.value;
  const {
    clientRunId,
    sessionLoadMs,
    cfg,
    storePath,
    entry,
    sessionKey,
    sessionRoutingChanged,
    selectedAgent,
  } = preparedSession.value;
  const {
    activeRunAbort,
    admittedSessionId,
    chatSendTraceAttributes,
    finishAbortedChatSend,
    interruptedActiveRun,
    lifecycleGeneration,
    messageInjectionTarget,
    restartSafeAdmission,
  } = admitted.value;
  const preparedAttachments = await prepareChatSendAttachments({
    request: normalizedRequest.value,
    session: preparedSession.value,
    admission: admitted.value,
    respond,
    context,
  });
  if (!preparedAttachments.ok) {
    return;
  }
  // Prepared inbound media has no transcript reference until the user turn
  // persists; every pre-ACK abandonment exit funnels through
  // cleanupAdmittedRun, which fires this armed discard. The hasPersisted gate
  // protects the restart-safe path, which persists durably before its abort
  // and routing exits; dispatch owns persistence after the ACK disarms this.
  let preparedMediaRecorder: { hasPersisted: () => boolean } | undefined;
  admitted.value.setDiscardAbandonedPreparedMedia(() => {
    if (!preparedMediaRecorder?.hasPersisted()) {
      void discardPreparedInboundMedia(preparedAttachments.value.offloadedRefs);
    }
  });
  if (activeRunAbort.controller.signal.aborted) {
    finishAbortedChatSend();
    return;
  }
  // Attachment preparation can suspend. Recheck immediately before the
  // synchronous ACK path so aborts and hot routing reloads cannot cross it.
  if (sessionRoutingChanged(context.getRuntimeConfig())) {
    admitted.value.rejectSessionRoutingChanged();
    return;
  }
  const { imageOrder, prepareAttachmentsMs } = preparedAttachments.value;
  const cronCreatorAuthority = externalAuthorityAdmission?.resolve({
    runId: clientRunId,
    sessionKey,
    spawnedBy: entry?.spawnedBy,
    client,
    inputProvenance: systemInputProvenance,
    hasExplicitOrigin: normalizedRequest.value.explicitOrigin !== undefined,
    hasRestoredCronContinuation: entry?.cronRunContinuation !== undefined,
    isIncognitoEntry: entry?.incognito === true,
    isReconnectResume: reconnectResumeRequested,
    isSystemGenerated:
      normalizedRequest.value.suppressCommandInterpretation ||
      normalizedRequest.value.systemProvenanceReceipt !== undefined,
    turnKind: normalizedRequest.value.turnKind,
  });

  const admissionStartedAt = Date.now();
  const terminalizeRestartSafeAdmission = async (
    terminalState: RestartSafeChatTerminalState,
  ): Promise<boolean> =>
    await terminalizeRestartSafeChatAdmission({
      admittedSessionId,
      clientRunId,
      sessionKey,
      startedAt: admissionStartedAt,
      storePath,
      ...terminalState,
    });
  try {
    const userTurn = createGatewayChatUserTurnController({
      admission: admitted.value,
      client,
      request: normalizedRequest.value,
      session: preparedSession.value,
      startedAt: admissionStartedAt,
      warn: (message) => context.logGateway.warn(message),
      assertCommitAllowed: requestOptions.sessionMutationAuthorization?.assertCurrent,
    });
    const {
      persist: persistGatewayUserTurnTranscript,
      recorder: userTurnRecorder,
      replyContextFieldsPromise,
    } = userTurn;
    preparedMediaRecorder = userTurnRecorder;
    const preparedUserTurn = prepareChatSendUserTurn({
      request: normalizedRequest.value,
      session: preparedSession.value,
      admission: admitted.value,
      attachments: preparedAttachments.value,
      client,
      logGateway: context.logGateway,
      userTurn,
    });
    if (restartSafeAdmission) {
      const persistedUserTurn = await persistGatewayUserTurnTranscript();
      // A matching idempotency row and lifecycle claim commit atomically, so
      // retries adopt the durable turn without submitting it twice.
      if (
        preparedSession.value.structuredGoalStart &&
        persistedUserTurn?.sessionTurnMutation?.status === "replay"
      ) {
        admitted.value.cleanupAdmittedRun({ force: true });
        clearAgentRunContext(clientRunId, lifecycleGeneration);
        context.removeChatRun(clientRunId, clientRunId, sessionKey);
        respond(true, persistedUserTurn.sessionTurnMutation.result, undefined, {
          cached: true,
          runId: clientRunId,
        });
        return;
      }
      if (
        !persistedUserTurn ||
        persistedUserTurn.sessionEntry?.status !== "running" ||
        persistedUserTurn.sessionEntry.restartRecoveryDeliveryRunId !== clientRunId
      ) {
        throw new Error("chat turn was not durably admitted");
      }
      if (
        preparedSession.value.structuredGoalStart &&
        persistedUserTurn.sessionTurnMutation?.status !== "inserted"
      ) {
        throw new Error("session Goal start was not durably committed");
      }
      if (preparedSession.value.structuredGoalStart) {
        recordSessionGoalChanged({
          sessionKey,
          entry: persistedUserTurn.sessionEntry,
          agentId: preparedSession.value.agentId,
          summary: "goal created",
        });
        emitSessionsChanged(context, {
          sessionKey,
          agentId: preparedSession.value.agentId,
          reason: "goal",
        });
      }
      if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
        if (activeRunAbort.entry) {
          activeRunAbort.entry.abortStopReason = "restart";
        }
        activeRunAbort.controller.abort(createAgentRunRestartAbortError());
      }
      if (activeRunAbort.controller.signal.aborted) {
        if (
          !(await terminalizeRestartSafeAdmission({
            retryable: activeRunAbort.entry?.abortStopReason === "restart",
            status: "killed",
          }))
        ) {
          throw new Error("chat admission ownership changed before terminalization");
        }
        finishAbortedChatSend();
        return;
      }
      if (sessionRoutingChanged(context.getRuntimeConfig())) {
        if (!(await terminalizeRestartSafeAdmission({ retryable: true, status: "failed" }))) {
          throw new Error("chat admission ownership changed before terminalization");
        }
        admitted.value.rejectSessionRoutingChanged();
        return;
      }
    }

    const { ctx, isInternalTextSlashCommandTurn } = preparedUserTurn;
    const beginCapturedMessageInjection = createChatSendMessageInjectionStarter({
      target: messageInjectionTarget,
      request: normalizedRequest.value,
      session: preparedSession.value,
      turn: preparedUserTurn,
      imageOrder,
      userTurnTranscriptRecorder: userTurnRecorder,
    });
    const preAckReplyContextPromise =
      messageInjectionTarget && !isInternalTextSlashCommandTurn
        ? replyContextFieldsPromise
        : undefined;
    if (preAckReplyContextPromise) {
      applyChatSendReplyContextFields(ctx, await preAckReplyContextPromise);
      if (activeRunAbort.controller.signal.aborted) {
        return finishAbortedChatSend();
      }
      if (sessionRoutingChanged(context.getRuntimeConfig())) {
        return admitted.value.rejectSessionRoutingChanged();
      }
    }
    let messageInjectionAttempt =
      !p.replyToId || preAckReplyContextPromise ? beginCapturedMessageInjection() : undefined;
    const preAckInjection = await settleChatSendPreAckMessageInjection({
      attempt: messageInjectionAttempt,
      isAborted: () => activeRunAbort.controller.signal.aborted,
      sessionRoutingChanged: () => sessionRoutingChanged(context.getRuntimeConfig()),
      onAborted: finishAbortedChatSend,
      onSessionRoutingChanged: admitted.value.rejectSessionRoutingChanged,
    });
    if (preAckInjection.status === "handled") {
      return;
    }
    messageInjectionAttempt = preAckInjection.attempt;
    const serverTiming = shouldIncludeChatSendAckServerTiming(clientInfo)
      ? {
          receivedToAckMs: roundedChatSendTimingMs(performance.now() - chatSendReceivedAtMs),
          loadSessionMs: sessionLoadMs,
          ...(prepareAttachmentsMs !== undefined ? { prepareAttachmentsMs } : {}),
        }
      : undefined;
    const chatSendTiming: ChatRunTiming | undefined =
      serverTiming && typeof client?.connId === "string" && client.connId.trim()
        ? {
            ackedAtMs: performance.now(),
            connId: client.connId.trim(),
            receivedAtMs: chatSendReceivedAtMs,
          }
        : undefined;
    context.addChatRun(clientRunId, {
      sessionKey,
      agentId: selectedAgent.agentId,
      clientRunId,
      ...(chatSendTiming ? { chatSendTiming } : {}),
    });
    const ackPayload = {
      runId: clientRunId,
      ...(preparedSession.value.structuredGoalStart
        ? { goalId: preparedSession.value.structuredGoalStart.goalId }
        : {}),
      status: "started" as const,
      ...(interruptedActiveRun ? { interruptedActiveRun: true } : {}),
      ...(serverTiming ? { serverTiming } : {}),
    };
    emitDiagnosticsTimelineEvent(
      {
        type: "mark",
        name: "gateway.chat_send.ack_ready",
        phase: "agent-turn",
        attributes: {
          ...chatSendTraceAttributes,
          ackStatus: ackPayload.status,
          ...chatSendAckServerTimingAttributes(serverTiming),
        },
      },
      { config: cfg },
    );
    // After the ACK, dispatch owns the turn: its error lifecycle persists the
    // user transcript (which references the media) on every path, so a
    // post-ACK cleanupAdmittedRun must not race that persist with a discard.
    admitted.value.setDiscardAbandonedPreparedMedia(undefined);
    respond(true, ackPayload, undefined, { runId: clientRunId });
    context.recordClientActivity?.(client);
    const chatSendAckedAtMs = chatSendTiming?.ackedAtMs ?? performance.now();
    startChatDispatch({
      admissionStartedAt,
      admission: admitted.value,
      attachments: preparedAttachments.value,
      client,
      context,
      toolsAllow: options?.toolsAllow,
      skillWorkshopProposalRevision: options?.skillWorkshopProposalRevision,
      cronCreatorAuthority,
      externalAuthorityAdmission,
      injection: {
        beginCapturedMessageInjection,
        messageInjectionAttempt,
        preAckReplyContextPromise,
        replyContextFieldsPromise,
      },
      request: normalizedRequest.value,
      session: preparedSession.value,
      terminalizeRestartSafeAdmission,
      timing: {
        chatSendAckedAtMs,
        chatSendTiming,
      },
      turn: preparedUserTurn,
      userTurn,
    });
  } catch (err) {
    if (
      preparedSession.value.structuredGoalStart &&
      (err instanceof SessionRpcReceiptConflictError ||
        (err instanceof Error && err.message === "goal already exists"))
    ) {
      admitted.value.cleanupAdmittedRun({ force: true });
      clearAgentRunContext(clientRunId, lifecycleGeneration);
      context.removeChatRun(clientRunId, clientRunId, sessionKey);
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          err instanceof SessionRpcReceiptConflictError
            ? "session Goal operation was reused with different input"
            : "session already has a Goal",
          { details: { code: "SESSION_GOAL_CONFLICT" } },
        ),
      );
      return;
    }
    await handleChatSendSetupError({
      admission: admitted.value,
      context,
      error: err,
      respond,
      session: preparedSession.value,
      terminalizeRestartSafeAdmission,
    });
  }
}

export async function handleChatSend(
  options: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
  externalAuthorityAdmission?: ChatSendExternalAuthorityAdmission,
): Promise<void> {
  await handleChatSendWithOptions(options, onAdmissionOwned, externalAuthorityAdmission);
}

/** Dispatches an internally delegated turn within its caller-owned tool boundary. */
export async function handleChatSendWithRuntimeTools(
  options: GatewayRequestHandlerOptions,
  toolsAllow: string[],
): Promise<void> {
  await handleChatSendWithOptions(options, undefined, undefined, { toolsAllow });
}

/** Dispatches an operator-requested proposal revision with its reviewed revision bound to the run. */
export async function handleChatSendWithSkillWorkshopProposalRevision(
  options: GatewayRequestHandlerOptions,
  proposalRevision: SkillWorkshopProposalRevisionConstraint,
): Promise<void> {
  await handleChatSendWithOptions(options, undefined, undefined, {
    toolsAllow: ["skill_workshop"],
    skillWorkshopProposalRevision: { ...proposalRevision },
  });
}

/** Dispatches Gateway-authored system input without widening the public chat-send contract. */
export async function handleTrustedInternalChatSend(
  options: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
): Promise<void> {
  await handleChatSendWithOptions(options, onAdmissionOwned, undefined, {
    trustedSystemInput: true,
  });
}

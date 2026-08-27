import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { normalizeToolPolicyName } from "../../tool-policy.js";
import type { EmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const CODE_MODE_RECONCILIATION_PROMPT =
  "The previous Code Mode mutation may have partially applied. Do not repeat or finish any mutation. Use only the available read-only inspection tools to determine the authoritative current state, then report exactly what applied, what did not, what remains unknown, and what work is still required.";
const CODE_MODE_POST_RECONCILIATION_PROMPT =
  "The previous uncertain Code Mode mutation has now been reconciled through read-only inspection. Continue the original task from the reconciled state. Do not repeat the failed mutation. Apply only work that the reconciliation established did not happen; if any target remains unknown, inspect it again before mutating it.";

const RECONCILIATION_TOOL_NAMES = new Set(["read"]);

export function isCodeModeReconciliationTool(tool: { name?: string }): boolean {
  return RECONCILIATION_TOOL_NAMES.has(normalizeToolPolicyName(tool.name ?? ""));
}

function isQuiescentCodeModeRecoveryAttempt(params: {
  attempt: EmbeddedRunAttemptResult;
  hostOwnsToolSurface: boolean;
  aborted: boolean;
  timedOut: boolean;
  promptError: unknown;
}): boolean {
  const { attempt } = params;
  return (
    params.hostOwnsToolSurface &&
    !params.aborted &&
    !params.timedOut &&
    !params.promptError &&
    attempt.itemLifecycle.activeCount === 0 &&
    attempt.itemLifecycle.startedCount === attempt.itemLifecycle.completedCount &&
    !attempt.clientToolCalls &&
    !attempt.yieldDetected &&
    !attempt.didSendDeterministicApprovalPrompt &&
    !attempt.runtimeContinuationStarted &&
    !attempt.toolMetas.some((entry) => entry.asyncStarted === true) &&
    (attempt.acceptedSessionSpawns?.length ?? 0) === 0 &&
    !attempt.didSendViaMessagingTool &&
    (attempt.successfulCronAdds ?? 0) === 0
  );
}

function shouldRetryCodeModeReconciliation(
  params: Parameters<typeof isQuiescentCodeModeRecoveryAttempt>[0],
): boolean {
  return (
    params.attempt.codeModeReconciliationCandidate === true &&
    isQuiescentCodeModeRecoveryAttempt(params)
  );
}

function hasCompletedCodeModeReconciliationReport(attempt: EmbeddedRunAttemptResult): boolean {
  const assistant = attempt.currentAttemptCompletedAssistant;
  // A tool-use assistant can contain pre-read commentary. Only the later completed
  // non-tool-use message proves the report was produced after the read result.
  return (
    assistant?.stopReason === "stop" &&
    !assistant.content.some((entry) => entry.type === "toolCall") &&
    assistant.content.some((entry) => entry.type === "text" && entry.text.trim().length > 0)
  );
}

function hasSuccessfulCodeModeReconciliationRead(attempt: EmbeddedRunAttemptResult): boolean {
  return attempt.toolMetas.some(
    (entry) =>
      normalizeToolPolicyName(entry.toolName) === "read" &&
      entry.isError !== true &&
      entry.terminate !== true &&
      entry.asyncStarted !== true,
  );
}

export function activateCodeModeReconciliation(params: {
  attempt: EmbeddedRunAttemptResult;
  hostOwnsToolSurface: boolean;
  retryState: EmbeddedRunTerminalRetryState;
  activateInternalPrompt: (prompt: string) => void;
}): boolean {
  const terminal = projectAgentRunAttemptTerminal(params.attempt.terminal);
  if (params.retryState.forceCodeModeReconciliationTools) {
    if (
      !isQuiescentCodeModeRecoveryAttempt({
        attempt: params.attempt,
        hostOwnsToolSurface: params.hostOwnsToolSurface,
        ...terminal,
      }) ||
      params.attempt.lastToolError !== undefined ||
      params.attempt.toolMetas.some(
        (entry) => entry.isError === true || entry.terminate === true,
      ) ||
      !hasSuccessfulCodeModeReconciliationRead(params.attempt) ||
      !hasCompletedCodeModeReconciliationReport(params.attempt)
    ) {
      return false;
    }
    // The clean readback is the state boundary the failed mutation could not provide.
    // The original admitted run continues to own every resumed tool call.
    params.retryState.forceCodeModeReconciliationTools = false;
    params.activateInternalPrompt(CODE_MODE_POST_RECONCILIATION_PROMPT);
    return true;
  }
  if (
    params.retryState.codeModeReconciliationAttempts >= 1 ||
    !shouldRetryCodeModeReconciliation({
      attempt: params.attempt,
      hostOwnsToolSurface: params.hostOwnsToolSurface,
      ...terminal,
    })
  ) {
    return false;
  }
  params.retryState.codeModeReconciliationAttempts += 1;
  params.retryState.forceCodeModeReconciliationTools = true;
  params.activateInternalPrompt(CODE_MODE_RECONCILIATION_PROMPT);
  return true;
}

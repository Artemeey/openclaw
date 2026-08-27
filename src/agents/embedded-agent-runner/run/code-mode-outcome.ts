import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  isCodeModeExecTool,
} from "../../code-mode-control-tools.js";
import { consumeRepairableCodeModeFailure } from "../../code-mode-repair-provenance.js";
import { readCode } from "../../code-mode-runtime.js";
import type { AfterToolCallResult, Agent } from "../../runtime/index.js";
import { readToolResultDetails } from "../../tool-result-error.js";

export type CodeModeReconciliationReplayFence = {
  code: string;
};

function readCodeModeReconciliationReplayFence(
  args: unknown,
): CodeModeReconciliationReplayFence | undefined {
  try {
    const input = readCode(args);
    return { code: input.code };
  } catch {
    return undefined;
  }
}

function matchesCodeModeReconciliationReplayFence(
  args: unknown,
  fence: CodeModeReconciliationReplayFence,
): boolean {
  const input = readCodeModeReconciliationReplayFence(args);
  return input?.code === fence.code;
}

/** Reject the exact uncertain exec before it can reach the Code Mode bridge again. */
export function installCodeModeReconciliationReplayFence(params: {
  agent: Agent;
  fence: CodeModeReconciliationReplayFence;
}): void {
  const previousBeforeToolCall = params.agent.beforeToolCall?.bind(params.agent);
  params.agent.beforeToolCall = async (context, signal) => {
    const tool = params.agent.state.tools.find((entry) => entry.name === context.toolCall.name);
    if (
      tool &&
      isCodeModeExecTool(tool) &&
      matchesCodeModeReconciliationReplayFence(context.args, params.fence)
    ) {
      return {
        block: true,
        reason:
          "Blocked an exact replay of the Code Mode mutation with an uncertain outcome. Continue only with work that readback proved did not happen.",
      };
    }
    return await previousBeforeToolCall?.(context, signal);
  };
}

/** Preserve the model's ordinary error recovery without replaying uncertain mutations. */
export function installCodeModeOutcomeHook(params: {
  agent: Agent;
  onReconciliationCandidate?: (fence: CodeModeReconciliationReplayFence) => void;
}): void {
  const previousAfterToolOutcome = params.agent.afterToolOutcome?.bind(params.agent);

  params.agent.afterToolOutcome = async (context, signal) => {
    const isCodeModeExec = context.toolCall.name === CODE_MODE_EXEC_TOOL_NAME;
    const isCodeModeWait = context.toolCall.name === CODE_MODE_WAIT_TOOL_NAME;
    if (!isCodeModeExec && !isCodeModeWait) {
      return await previousAfterToolOutcome?.(context, signal);
    }

    const details = readToolResultDetails(context.result);
    // Capability is host-minted on this exact result object; guest-supplied fields cannot grant it.
    const noToolStarted = consumeRepairableCodeModeFailure(details);
    let prior: AfterToolCallResult | undefined;
    try {
      prior = await previousAfterToolOutcome?.(context, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Code Mode outcome hook failed: ${message}` }],
        details: { ...details, status: "failed", error: message },
        isError: true,
        terminate: true,
      };
    }

    if (context.result.terminate === true || prior?.terminate === true) {
      return { ...prior, terminate: true };
    }
    if (signal?.aborted && !context.executionStarted) {
      return prior;
    }
    if (
      (details?.status === "blocked" && details.deniedReason === "tool-loop") ||
      (details?.status === "skipped" && details.deniedReason === "steering")
    ) {
      return prior;
    }

    const failed = context.isError || details?.status === "failed" || prior?.isError === true;
    if (!failed) {
      return prior;
    }

    const bridgeStarted = details?.bridgeDispatchStarted === true;
    const dispatchUnknown =
      context.executionStarted && typeof details?.bridgeDispatchStarted !== "boolean";
    const unsafeToContinue =
      isCodeModeWait || ((bridgeStarted || dispatchUnknown) && !noToolStarted);
    if (
      unsafeToContinue &&
      isCodeModeExec &&
      context.assistantMessage.content.filter((entry) => entry.type === "toolCall").length === 1
    ) {
      const fence = readCodeModeReconciliationReplayFence(context.args);
      if (fence) {
        params.onReconciliationCandidate?.(fence);
      }
    }

    // Agent core owns ordinary continuation; only uncertain side effects need a restricted retry.
    return {
      ...prior,
      content: context.result.content,
      details: context.result.details,
      isError: true,
      ...(unsafeToContinue ? { terminate: true } : {}),
    };
  };
}

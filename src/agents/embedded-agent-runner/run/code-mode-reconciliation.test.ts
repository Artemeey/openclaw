import { describe, expect, it } from "vitest";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  activateCodeModeReconciliation,
  isCodeModeReconciliationTool,
} from "./code-mode-reconciliation.js";
import { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

function eligibleAttempt() {
  return makeEmbeddedRunnerAttempt({
    codeModeReconciliationCandidate: true,
    itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
  });
}

function activates(overrides = {}, hostOwnsToolSurface = true) {
  return activateCodeModeReconciliation({
    attempt: { ...eligibleAttempt(), ...overrides } as ReturnType<typeof eligibleAttempt>,
    hostOwnsToolSurface,
    retryState: createEmbeddedRunTerminalRetryState(),
    activateInternalPrompt: () => undefined,
  });
}

describe("Code Mode reconciliation", () => {
  it("admits one quiescent candidate", () => {
    expect(activates()).toBe(true);
  });

  it.each([
    ["active tool", { itemLifecycle: { startedCount: 2, completedCount: 1, activeCount: 1 } }],
    ["async work", { toolMetas: [{ toolName: "exec", asyncStarted: true }] }],
    ["message delivery", { didSendViaMessagingTool: true }],
    ["child session", { acceptedSessionSpawns: [{ runId: "child" }] }],
    ["approval", { didSendDeterministicApprovalPrompt: true }],
    ["yield", { yieldDetected: true }],
    ["plugin-owned transport", {}, false],
  ])("rejects a candidate with %s", (_label, overrides, hostOwnsToolSurface = true) => {
    expect(activates(overrides, hostOwnsToolSurface)).toBe(false);
  });

  it("exposes only the audited core observation tool", () => {
    expect(
      [
        "read",
        "find",
        "glob",
        "grep",
        "ls",
        "search",
        "exec",
        "write",
        "apply_patch",
        "message",
        "sessions_spawn",
        "web_fetch",
      ].filter((name) => isCodeModeReconciliationTool({ name })),
    ).toEqual(["read"]);
  });

  it("releases the read-only restriction after a clean reconciliation report", () => {
    const retryState = createEmbeddedRunTerminalRetryState();
    retryState.forceCodeModeReconciliationTools = true;
    let prompt = "";

    expect(
      activateCodeModeReconciliation({
        attempt: {
          ...eligibleAttempt(),
          assistantTexts: ["Only the first hunk applied."],
          toolMetas: [{ toolName: "read", isError: false }],
        },
        hostOwnsToolSurface: true,
        retryState,
        activateInternalPrompt: (value) => {
          prompt = value;
        },
      }),
    ).toBe(true);
    expect(retryState.forceCodeModeReconciliationTools).toBe(false);
    expect(prompt).toContain("Continue the original task from the reconciled state");
  });

  it.each([
    [
      "failed read",
      {
        lastToolError: { toolName: "read", message: "read failed" },
        toolMetas: [{ toolName: "read", isError: true }],
      },
    ],
    ["terminal tool", { toolMetas: [{ toolName: "read", terminate: true }] }],
    ["text-only report", { toolMetas: [] }],
    ["empty report", { assistantTexts: [], toolMetas: [{ toolName: "read", isError: false }] }],
  ])("keeps reconciliation restricted after a %s", (_label, overrides) => {
    const retryState = createEmbeddedRunTerminalRetryState();
    retryState.forceCodeModeReconciliationTools = true;
    expect(
      activateCodeModeReconciliation({
        attempt: { ...eligibleAttempt(), assistantTexts: ["Observed state."], ...overrides },
        hostOwnsToolSurface: true,
        retryState,
        activateInternalPrompt: () => undefined,
      }),
    ).toBe(false);
    expect(retryState.forceCodeModeReconciliationTools).toBe(true);
  });
});

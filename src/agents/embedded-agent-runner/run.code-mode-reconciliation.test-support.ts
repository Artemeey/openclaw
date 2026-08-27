import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEmbeddedRunnerAssistant } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedClassifyFailoverReason,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

describe("runEmbeddedAgent Code Mode reconciliation", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetSharedRunIntegrationHarnessMocks();
    mockedClassifyFailoverReason.mockReturnValue(null);
    useOpenAIPlatformAuthFixture();
  });

  it("resumes ordinary work after one settled read-only reconciliation", async () => {
    const mutationAssistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "code-mode-mutation",
          name: "code_mode",
          arguments: { action: "exec" },
        },
      ],
    });
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          lastAssistant: mutationAssistant,
          currentAttemptAssistant: mutationAssistant,
          currentAttemptCompletedAssistant: mutationAssistant,
          codeModeReconciliationCandidate: true,
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["The first hunk applied."] }))
      .mockResolvedValueOnce(
        makeAttemptResult({ assistantTexts: ["Finished the remaining work."] }),
      );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
          },
        },
      },
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-code-mode-reconciliation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(
      mockedRunEmbeddedAttempt.mock.calls[0]?.[0].forceCodeModeReconciliationTools,
    ).toBeFalsy();
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]).toMatchObject({
      forceCodeModeReconciliationTools: true,
      prompt: expect.stringContaining("may have partially applied"),
    });
    expect(mockedRunEmbeddedAttempt.mock.calls[2]?.[0]).toMatchObject({
      forceCodeModeReconciliationTools: undefined,
      prompt: expect.stringContaining("Continue the original task from the reconciled state"),
    });
  });
});

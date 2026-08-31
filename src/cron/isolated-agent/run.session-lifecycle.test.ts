// Persistent cron session tests cover lifecycle admission and mutation races.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolvePreparedRunAdmission } from "../../agents/admitted-run-context.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import {
  classifyEmbeddedAgentRunResultForModelFallback,
  mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
} from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
import { prepareEmbeddedAttemptStream } from "../../agents/embedded-agent-runner/run/attempt-stream-prepare.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { clearActiveEmbeddedRun } from "../../agents/embedded-agent-runner/runs.js";
import { createStubSessionHarness } from "../../agents/embedded-agent-subscribe.e2e-harness.js";
import { FailoverError } from "../../agents/failover-error.js";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../../agents/failover/user-copy.js";
import { runWithModelFallback } from "../../agents/model-fallback-runner.js";
import { AuthStorage } from "../../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../../agents/sessions/model-registry.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../../gateway/server-chat-state.js";
import {
  createAgentEventHandler,
  type AgentEventHandlerOptions,
} from "../../gateway/server-chat.js";
import { onAgentRuntimeEvent } from "../../infra/agent-events.js";
import {
  clearAgentRunContext,
  getAgentRunContextOwnership,
} from "../../infra/agent-run-registry.js";
import { createDiagnosticEmbeddedRunOwner } from "../../logging/diagnostic-run-activity.js";
import * as diagnostic from "../../logging/diagnostic.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  interruptSessionWorkAdmissions,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import {
  classifyEmbeddedAgentRunResultForModelFallbackMock,
  mergeEmbeddedAgentRunResultForModelFallbackExhaustionMock,
  dispatchCronDeliveryMock,
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  callGatewayMock,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  preflightCronModelProviderMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  resolveCronDeliveryPlanMock,
  resolveCronPayloadOutcomeMock,
  resolveDeliveryTargetMock,
  runEmbeddedAgentMock,
  runCliAgentMock,
  isCliProviderMock,
  runWithModelFallbackMock,
  resolveConfiguredModelRefMock,
  resolveAllowedModelRefMock,
  resolveAgentModelFallbacksOverrideMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const inMemoryStorePath = "/tmp/store.json";

function makeCronLifecycleParams(sessionKey: string, useRunSession = false) {
  return makeIsolatedAgentParamsFixture({
    agentId: "main",
    sessionKey,
    job: makeIsolatedAgentJobFixture({
      // Lease cases use the persistent key; continuation cases enter through
      // the normal isolated target and get its exact hidden run session.
      sessionTarget: useRunSession ? "isolated" : `session:${sessionKey}`,
      delivery: { mode: "none" },
    }),
  });
}

describe("runCronIsolatedAgentTurn session lifecycle", () => {
  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
  });

  it.each([
    "success",
    "failure",
    "cancelled",
    "cli-success",
    "cli-cancelled",
    "cli-timeout",
    "cli-exhausted-throw",
    "cli-exhausted-result",
    "outer-failure",
    "finalize-failure",
    "continuation-failure",
    "post-execution-abort",
    "retry-prepare-failure",
    "retry-exhausted",
  ] as const)("keeps a cron fallback active until outer $0 settlement", async (outcome) => {
    const sessionKey = "agent:main:cron:lifecycle-fallback";
    const sessionId = "cron-lifecycle-fallback";
    const usesContinuation =
      outcome === "continuation-failure" || outcome === "post-execution-abort";
    const initialSessionEntry = makeCronSessionEntry({ sessionId });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: inMemoryStorePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: usesContinuation,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockImplementation((_storePath, key) =>
      key === sessionKey ? { ...initialSessionEntry } : undefined,
    );
    resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-5.6-luna" });
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "openai", model: "gpt-5.6-luna" },
    });
    const exhausted = outcome.includes("exhausted") || outcome === "retry-prepare-failure";
    const cliFallback = outcome.startsWith("cli-");
    const cancelled = outcome === "cancelled" || outcome === "cli-cancelled";
    resolveAgentModelFallbacksOverrideMock.mockReturnValue([
      cliFallback ? "claude-cli/fallback-model" : "openai/fallback-model",
    ]);
    if (cliFallback) {
      isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    }
    const retryPreparationFailure = outcome === "retry-prepare-failure";
    const retryPreparationError = new Error("retry preparation failed");
    const retriesInterimAck = retryPreparationFailure || outcome === "retry-exhausted";
    if (outcome === "outer-failure" || retriesInterimAck) {
      resolveCronPayloadOutcomeMock.mockImplementation(
        (await vi.importActual<typeof import("./helpers.js")>("./helpers.js"))
          .resolveCronPayloadOutcome,
      );
    }
    if (outcome === "finalize-failure") {
      dispatchCronDeliveryMock.mockRejectedValueOnce(new Error("delivery finalization failed"));
    }
    runWithModelFallbackMock.mockImplementation(runWithModelFallback);
    classifyEmbeddedAgentRunResultForModelFallbackMock.mockImplementation(
      classifyEmbeddedAgentRunResultForModelFallback,
    );
    mergeEmbeddedAgentRunResultForModelFallbackExhaustionMock.mockImplementation(
      mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
    );
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const secondPreparing = createDeferred();
    const releaseSecond = createDeferred();
    const postExecutionWriteStarted = createDeferred();
    const releasePostExecutionWrite = createDeferred();
    const controller = new AbortController();
    const onExecutionStarted = vi.fn();
    let completedContinuationSessionKey: string | undefined;
    if (usesContinuation) {
      const patchSessionEntry = patchSessionEntryMock.getMockImplementation();
      if (!patchSessionEntry) {
        throw new Error("expected guarded cron writer");
      }
      patchSessionEntryMock.mockImplementation(
        async (
          ...args: Parameters<
            typeof import("../../config/sessions/session-accessor.js").patchSessionEntryCore
          >
        ) => {
          if (args[0].sessionKey === completedContinuationSessionKey) {
            completedContinuationSessionKey = undefined;
            if (outcome === "continuation-failure") {
              throw new Error("continuation write failed");
            }
            postExecutionWriteStarted.resolve();
            await releasePostExecutionWrite.promise;
          }
          return patchSessionEntry(...args);
        },
      );
    }
    const chatRunState = createChatRunState();
    const broadcast = vi.fn();
    const clearTrackedActiveRun = vi.fn();
    const persist = vi.fn<
      NonNullable<AgentEventHandlerOptions["persistGatewaySessionLifecycleEventForEvent"]>
    >(async () => {});
    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds: vi.fn(),
      nodeSendToSession: vi.fn(),
      agentRunSeq: new Map(),
      chatRunState,
      clearAgentRunContext,
      resolveSessionKeyForRun: () => sessionKey,
      toolEventRecipients: chatRunState.toolEventRecipients,
      sessionEventSubscribers: createSessionEventSubscriberRegistry(),
      sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
      persistGatewaySessionLifecycleEventForEvent: persist,
      clearTrackedActiveRun,
    });
    const unsubscribe = onAgentRuntimeEvent(handler);
    let attemptIndex = 0;
    runCliAgentMock.mockImplementation(async (runParams: RunCliAgentParams) => {
      attemptIndex++;
      runParams.onExecutionStarted?.();
      secondPreparing.resolve();
      await releaseSecond.promise;
      if (outcome === "cli-exhausted-throw") {
        throw new FailoverError("CLI provider unavailable", { reason: "server_error" });
      }
      if (outcome === "cli-exhausted-result") {
        // The real classifier rejects generic CLI failure copy; exhaustion
        // merges this candidate's metadata with the native incomplete reply.
        return {
          payloads: [{ text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT }],
          meta: { agentMeta: {} },
        };
      }
      if (cancelled || outcome === "cli-timeout") {
        return {
          payloads: [],
          meta: {
            agentMeta: {},
            aborted: true,
            providerStarted: true,
            stopReason: cancelled ? "aborted" : "timeout",
            ...(outcome === "cli-timeout" ? { timeoutPhase: "provider" } : {}),
          },
        };
      }
      return { payloads: [{ text: "Final report" }], meta: { agentMeta: {} } };
    });
    runEmbeddedAgentMock.mockImplementation(async (runParams: RunEmbeddedAgentParams) => {
      const first = attemptIndex++ === 0;
      if (retriesInterimAck && attemptIndex > 2) {
        throw retryPreparationFailure
          ? retryPreparationError
          : new FailoverError("retry provider unavailable", { reason: "server_error" });
      }
      if (!first) {
        secondPreparing.resolve();
        await releaseSecond.promise;
      }
      const { provider, model, thinkLevel } = runParams;
      if (!provider || !model || !thinkLevel) {
        throw new Error("Cron did not prepare the model attempt");
      }
      const admittedRunContext = await resolvePreparedRunAdmission({
        ...runParams,
        runtimeKind: "embedded",
      });
      runParams.onExecutionStarted?.();
      const authStorage = AuthStorage.inMemory();
      const native = createStubSessionHarness();
      const stream = prepareEmbeddedAttemptStream({
        attempt: {
          runId: runParams.runId,
          sessionId: runParams.sessionId,
          sessionKey: runParams.sessionKey,
          agentId: runParams.agentId,
          workspaceDir: runParams.workspaceDir,
          prompt: runParams.prompt,
          timeoutMs: runParams.timeoutMs,
          config: runParams.config,
          trigger: runParams.trigger,
          abortSignal: runParams.abortSignal,
          deferTerminalLifecycle: runParams.deferTerminalLifecycle,
          onAgentEvent: runParams.onAgentEvent,
          admittedRunContext,
          provider,
          modelId: model,
          model: makeProviderModelFixture({
            provider,
            id: model,
            api: "openai-responses",
            baseUrl: "https://provider.test",
          }),
          thinkLevel,
          sessionFile: sessionKey,
          authStorage,
          authProfileStore: { version: 1, profiles: {} },
          modelRegistry: ModelRegistry.inMemory(authStorage),
          startedAtMs: Date.now(),
        },
        activeSession: native.session,
        hookRunner: getGlobalHookRunner(),
        hookAgentId: "main",
        diagnosticTrace: { traceId: "1".repeat(32) },
        diagnosticOwner: createDiagnosticEmbeddedRunOwner({
          sessionId,
          sessionKey,
          runId: runParams.runId,
        }),
        clientToolCallSlots: [],
        nestedToolActivities: [],
        isReplaySafeTool: () => false,
        runAbortController: new AbortController(),
        abortRun: vi.fn(),
        markExternalAbort: vi.fn(),
        getRunState: () => ({
          aborted: controller.signal.aborted,
          promptError: undefined,
          timedOut: false,
          yieldDetected: false,
        }),
        hasDeliveredSourceReply: () => false,
        markSourceReplyDelivered: vi.fn(),
        onBlockReply: undefined,
        onBlockReplyFlush: undefined,
        sandboxSessionKey: sessionKey,
        builtinToolNames: new Set(),
        replaySafeToolNames: new Set(),
      });
      try {
        native.emit({ type: "agent_start" });
        if (first || outcome === "failure") {
          if (first) {
            firstStarted.resolve();
            await releaseFirst.promise;
          }
          const incomplete = outcome === "cli-exhausted-result";
          native.emit({
            type: "message_update",
            message: makeAssistantMessageFixture({
              provider,
              model,
              stopReason: incomplete ? "stop" : "error",
              errorMessage: incomplete ? undefined : "429 rate limit",
              content: incomplete ? [{ type: "thinking", thinking: "Still reasoning" }] : [],
            }),
          });
          native.emit({ type: "agent_end" });
          if (incomplete) {
            // Native terminal resolution preserves a safe incomplete reply after
            // its internal retries; the later CLI candidate supplies no liveness.
            return {
              payloads: [{ text: "Incomplete provider response", isError: true }],
              meta: {
                agentMeta: {},
                livenessState: "abandoned",
                replayInvalid: true,
                error: {
                  kind: "incomplete_turn",
                  message: "Incomplete provider response",
                  fallbackSafe: true,
                },
              },
            };
          }
          throw new FailoverError("429 rate limit", { reason: "rate_limit", provider, model });
        }
        if (outcome === "cancelled") {
          native.emit({
            type: "message_update",
            message: makeAssistantMessageFixture({
              provider,
              model,
              stopReason: "aborted",
              errorMessage: undefined,
              content: [],
            }),
          });
          native.emit({ type: "agent_end" });
          return { payloads: [], meta: { aborted: true, stopReason: "aborted", agentMeta: {} } };
        }
        const text = retriesInterimAck ? "On it." : "Final report";
        const assistantMessage = makeAssistantMessageFixture({
          provider,
          model,
          stopReason: "stop",
          errorMessage: undefined,
          content: [{ type: "text", text }],
          timestamp: Date.now(),
        });
        native.emit({ type: "message_start", message: assistantMessage });
        native.emit({ type: "message_end", message: assistantMessage });
        native.emit({ type: "agent_end" });
        if (usesContinuation) {
          expect(runParams.sessionKey).toContain(":run:");
          completedContinuationSessionKey = runParams.sessionKey;
        }
        return {
          payloads: [
            { text },
            ...(outcome === "outer-failure"
              ? [{ text: "Tool execution failed", isError: true }]
              : []),
          ],
          meta: { agentMeta: {}, stopReason: "stop" },
        };
      } finally {
        stream.subscription.unsubscribe();
        clearActiveEmbeddedRun(sessionId, stream.queueHandle, sessionKey);
      }
    });
    const run = runCronIsolatedAgentTurn({
      ...makeCronLifecycleParams(sessionKey, usesContinuation),
      abortSignal: controller.signal,
      onExecutionStarted,
    });
    const exited = run.then((result) => {
      throw new Error(`Cron exited before fallback boundary: ${JSON.stringify(result)}`);
    });
    try {
      await Promise.race([firstStarted.promise, exited]);
      vi.useFakeTimers();
      releaseFirst.resolve();
      await Promise.race([secondPreparing.promise, exited]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(attemptIndex).toBe(2);
      expect(runCliAgentMock).toHaveBeenCalledTimes(cliFallback ? 1 : 0);
      expect(broadcast.mock.calls.filter(([event]) => event === "chat")).toHaveLength(0);
      expect(
        persist.mock.calls.filter(([params]) => params.event.data?.phase === "error"),
      ).toHaveLength(0);
      expect(getAgentRunContextOwnership(sessionId)?.clearRequested).toBe(false);
      expect(clearTrackedActiveRun).not.toHaveBeenCalled();
      if (cancelled) {
        controller.abort();
      }
      releaseSecond.resolve();
      if (outcome === "post-execution-abort") {
        await Promise.race([postExecutionWriteStarted.promise, exited]);
        controller.abort(new Error("post-execution abort"));
        releasePostExecutionWrite.resolve();
      }
      const succeeded = outcome === "success" || outcome === "cli-success";
      await expect(run).resolves.toMatchObject({ status: succeeded ? "ok" : "error" });
      if (outcome === "outer-failure" || outcome === "finalize-failure") {
        const error =
          outcome === "outer-failure" ? "Tool execution failed" : "delivery finalization failed";
        await expect(run).resolves.toMatchObject({ error });
      }
      if (outcome === "finalize-failure") {
        await expect(run).resolves.toMatchObject({ executionStarted: true });
      }
      if (outcome === "continuation-failure") {
        await expect(run).resolves.toMatchObject({ error: "continuation write failed" });
      }
      if (outcome === "post-execution-abort") {
        await expect(run).resolves.toMatchObject({ error: "post-execution abort" });
      }
      if (retryPreparationFailure) {
        await expect(run).resolves.toMatchObject({
          error: expect.stringContaining("retry preparation failed"),
        });
        await expect(runWithModelFallbackMock.mock.results[1]?.value).rejects.toBe(
          retryPreparationError,
        );
      }
      // Exhaustion settles persistence and active tracking without advancing the
      // retry-grace clock, even when the last candidate emitted no blocked metadata.
      if (exhausted) {
        if (outcome === "cli-exhausted-result") {
          await expect(runWithModelFallbackMock.mock.results[0]?.value).resolves.toMatchObject({
            outcome: "exhausted",
            result: { meta: { error: { kind: "incomplete_turn" } } },
          });
        }
        expect({
          terminalWrites: persist.mock.calls.filter(
            ([params]) => params.event.data?.phase === "error",
          ).length,
          activityClears: clearTrackedActiveRun.mock.calls.length,
        }).toEqual({ terminalWrites: 1, activityClears: 1 });
        expect(clearTrackedActiveRun).toHaveBeenCalledExactlyOnceWith({
          runId: sessionId,
          clientRunId: sessionId,
          sessionKey,
        });
      }
      expect(onExecutionStarted).toHaveBeenCalledTimes(2);
      const state = cancelled
        ? "aborted"
        : outcome === "failure" || outcome === "cli-timeout" || retryPreparationFailure || exhausted
          ? "error"
          : "final";
      expect(
        broadcast.mock.calls.filter(
          ([event, payload]) => event === "chat" && payload.state !== "delta",
        ),
      ).toEqual([
        [
          "chat",
          expect.objectContaining({
            runId: sessionId,
            state,
            ...(outcome === "cli-timeout" ? { stopReason: "timeout", errorKind: "timeout" } : {}),
          }),
          expect.anything(),
        ],
      ]);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      releasePostExecutionWrite.resolve();
      await run.catch(() => {});
      unsubscribe();
      handler.dispose();
      vi.useRealTimers();
    }
  });

  it("rejects a session that rotates before async setup", async () => {
    const sessionKey = "agent:main:main";
    const initialSessionEntry = makeCronSessionEntry({ sessionId: "session-before-setup" });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: inMemoryStorePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue({
      ...initialSessionEntry,
      sessionId: "session-after-setup",
    });
    await expect(
      runCronIsolatedAgentTurn(makeCronLifecycleParams(sessionKey)),
    ).resolves.toMatchObject({
      status: "error",
      error: `Session "${sessionKey}" changed while starting work. Retry.`,
      admissionDisposition: "session-conflict",
    });
    expect(preflightCronModelProviderMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("allows a rename and unpin during async setup", async () => {
    const sessionKey = "agent:main:main";
    const initialSessionEntry = makeCronSessionEntry({
      label: "before setup",
      pinnedAt: 1,
      sessionId: "same-session",
      updatedAt: 1,
    });
    const currentSessionEntry = {
      ...initialSessionEntry,
      label: "patched during setup",
      pinnedAt: undefined,
      updatedAt: 2,
    };
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: inMemoryStorePath,
        store: { [sessionKey]: { ...currentSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue(currentSessionEntry);
    const releasePreflight = createDeferred();
    preflightCronModelProviderMock.mockImplementationOnce(async () => {
      await releasePreflight.promise;
      return { status: "available" };
    });

    const run = runCronIsolatedAgentTurn(makeCronLifecycleParams(sessionKey));
    await vi.waitFor(() => expect(preflightCronModelProviderMock).toHaveBeenCalledTimes(1));
    releasePreflight.resolve();

    await expect(run).resolves.toMatchObject({ status: "ok" });
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
  });

  it("protects the isolated cron session throughout async model preparation", async () => {
    const sessionKey = "agent:main:cron:test-job";
    const initialSessionEntry = makeCronSessionEntry({
      lifecycleRevision: "initial-revision",
      sessionId: "previous-session",
    });
    const sessionEntry = makeCronSessionEntry({ sessionId: "isolated-session" });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: inMemoryStorePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: true,
        sessionEntry,
      }),
    );
    loadSessionEntryMock.mockImplementation((_storePath, currentSessionKey) =>
      currentSessionKey === sessionKey ? initialSessionEntry : undefined,
    );
    const releasePreflight = createDeferred();
    preflightCronModelProviderMock.mockImplementationOnce(async () => {
      await releasePreflight.promise;
      return { status: "available" };
    });

    const run = runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "main",
        sessionKey: "cron:test-job",
        job: makeIsolatedAgentJobFixture({
          sessionTarget: "isolated",
          delivery: { mode: "none" },
        }),
      }),
    );
    await vi.waitFor(() => expect(preflightCronModelProviderMock).toHaveBeenCalledTimes(1));
    const sessionIsProtectedDuringPreflight = isSessionWorkAdmissionActive(inMemoryStorePath, [
      sessionKey,
      "previous-session",
      "isolated-session",
    ]);
    releasePreflight.resolve();

    expect(sessionIsProtectedDuringPreflight).toBe(true);
    await expect(run).resolves.toMatchObject({ status: "ok" });
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(patchSessionEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey }),
      expect.any(Function),
      expect.objectContaining({
        fallbackEntry: expect.objectContaining({ sessionId: "isolated-session" }),
      }),
    );
  });

  it("does not recreate a persistent session deleted during async setup", async () => {
    const sessionKey = "agent:main:main";
    const initialSessionEntry = makeCronSessionEntry({ sessionId: "persistent-session" });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: inMemoryStorePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue(undefined);

    await expect(
      runCronIsolatedAgentTurn(makeCronLifecycleParams(sessionKey)),
    ).resolves.toMatchObject({
      status: "error",
      error: `Session "${sessionKey}" changed while starting work. Retry.`,
      admissionDisposition: "session-conflict",
    });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("interrupts persistent cron work and waits for its lifecycle lease to release", async () => {
    const sessionKey = "agent:main:telegram:direct:42";
    const sessionId = "shared-session";
    const storePath = inMemoryStorePath;
    const initialSessionEntry = makeCronSessionEntry({ sessionId });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue({ ...initialSessionEntry });
    const runnerStarted = createDeferred();
    const lifecycleInterrupted = createDeferred();
    const releaseRunner = createDeferred();
    runEmbeddedAgentMock.mockImplementationOnce(
      async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        runnerStarted.resolve();
        if (abortSignal?.aborted) {
          lifecycleInterrupted.resolve();
        } else {
          abortSignal?.addEventListener("abort", () => lifecycleInterrupted.resolve(), {
            once: true,
          });
        }
        await releaseRunner.promise;
        return {
          payloads: [],
          meta: { aborted: true, agentMeta: {} },
        };
      },
    );

    const run = runCronIsolatedAgentTurn(makeCronLifecycleParams(sessionKey));
    await runnerStarted.promise;
    let mutationCommitted = false;
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      prepare: async () => {
        await interruptSessionWorkAdmissions({
          scope: storePath,
          identities: [sessionKey, sessionId],
        });
      },
      run: async () => {
        mutationCommitted = true;
      },
    });

    await lifecycleInterrupted.promise;
    expect(mutationCommitted).toBe(false);
    releaseRunner.resolve();

    const [result] = await Promise.all([run, mutation]);
    expect(result).toEqual(
      expect.objectContaining({
        status: "error",
        error: "agent run aborted for restart | OPENCLAW_RESTART_ABORT",
      }),
    );
    expect(mutationCommitted).toBe(true);
  });

  it("releases admission when final lifecycle marking fails", async () => {
    const sessionKey = "agent:main:cron:final-lifecycle-failure";
    const sessionId = "final-lifecycle-session";
    const initialSessionEntry = makeCronSessionEntry({ sessionId });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: inMemoryStorePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue({ ...initialSessionEntry });
    const originalLogSessionStateChange = diagnostic.logSessionStateChange;
    const logSessionStateChangeSpy = vi
      .spyOn(diagnostic, "logSessionStateChange")
      .mockImplementation((params) => {
        if (params.state === "idle") {
          throw new Error("simulated final lifecycle failure");
        }
        return originalLogSessionStateChange(params);
      });

    try {
      await expect(runCronIsolatedAgentTurn(makeCronLifecycleParams(sessionKey))).rejects.toThrow(
        "simulated final lifecycle failure",
      );
      expect(isSessionWorkAdmissionActive(inMemoryStorePath, [sessionKey, sessionId])).toBe(false);
    } finally {
      logSessionStateChangeSpy.mockRestore();
    }
  });

  it.each(["none", "silent", "best-effort", "execution error", "presentation warning"])(
    "settles isolated %s cleanup after releasing its lease",
    async (outcome) => {
      dispatchCronDeliveryMock.mockImplementationOnce(
        (await vi.importActual<typeof import("./delivery-dispatch.js")>("./delivery-dispatch.js"))
          .dispatchCronDelivery,
      );
      const bestEffort = outcome !== "none" && outcome !== "silent";
      const failed = outcome === "execution error" || outcome === "presentation warning";
      resolveCronPayloadOutcomeMock.mockImplementation(
        (await vi.importActual<typeof import("./helpers.js")>("./helpers.js"))
          .resolveCronPayloadOutcome,
      );
      resolveCronDeliveryPlanMock.mockReturnValue({
        requested: outcome !== "none",
        mode: outcome === "none" ? "none" : "announce",
      });
      resolveDeliveryTargetMock.mockResolvedValue({
        ok: false,
        mode: "implicit",
        error: new Error("delivery target unavailable"),
      });
      runEmbeddedAgentMock.mockResolvedValue({
        payloads: [
          { text: outcome === "silent" ? "NO_REPLY" : "Report" },
          ...(outcome === "presentation warning"
            ? [{ text: "⚠️ ✉️ Message failed", isError: true }]
            : []),
        ],
        meta: {
          agentMeta: {},
          ...(outcome === "silent" ? { finalAssistantRawText: "NO_REPLY" } : {}),
          ...(outcome === "execution error"
            ? { error: { kind: "provider_error", message: "provider failed" } }
            : {}),
        },
      });
      const sessionKey = "agent:main:cron:test-job";
      const sessionId = "isolated-session";
      const storePath = inMemoryStorePath;
      resolveCronSessionMock.mockReturnValue(
        makeCronSession({
          storePath,
          initialSessionEntry: undefined,
          isNewSession: true,
          sessionEntry: makeCronSessionEntry({ sessionId }),
        }),
      );
      loadSessionEntryMock.mockReturnValue(undefined);
      let admissionActiveDuringDelete = true;
      callGatewayMock.mockImplementationOnce(async () => {
        admissionActiveDuringDelete = isSessionWorkAdmissionActive(storePath, [
          sessionKey,
          sessionId,
        ]);
        return { ok: true, deleted: true };
      });

      const result = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          agentId: "main",
          sessionKey: "cron:test-job",
          job: makeIsolatedAgentJobFixture({
            sessionTarget: "isolated",
            deleteAfterRun: true,
            delivery: { mode: outcome === "none" ? "none" : "announce", bestEffort },
          }),
        }),
      );

      expect(result.status).toBe(failed ? "error" : "ok");
      expect(callGatewayMock).toHaveBeenCalledTimes(failed ? 0 : 1);
      if (!failed) {
        expect(admissionActiveDuringDelete).toBe(false);
      }
      expect(isSessionWorkAdmissionActive(storePath, [sessionKey, sessionId])).toBe(false);
    },
  );

  it("keeps a non-deleting isolated run admitted through delivery", async () => {
    const sessionKey = "agent:main:cron:test-job";
    const sessionId = "isolated-session";
    const storePath = inMemoryStorePath;
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath,
        initialSessionEntry: undefined,
        isNewSession: true,
        sessionEntry: makeCronSessionEntry({ sessionId }),
      }),
    );
    loadSessionEntryMock.mockReturnValue(undefined);
    const deliveryStarted = createDeferred();
    const releaseDelivery = createDeferred();
    dispatchCronDeliveryMock.mockImplementationOnce(async ({ deliveryPayloads }) => {
      deliveryStarted.resolve();
      await releaseDelivery.promise;
      return {
        delivered: false,
        deliveryAttempted: false,
        deliveryPayloads,
      };
    });

    const run = runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "main",
        sessionKey: "cron:test-job",
        job: makeIsolatedAgentJobFixture({
          sessionTarget: "isolated",
          deleteAfterRun: false,
          delivery: { mode: "none" },
        }),
      }),
    );
    await deliveryStarted.promise;
    expect(isSessionWorkAdmissionActive(storePath, [sessionKey, sessionId])).toBe(true);
    releaseDelivery.resolve();

    await expect(run).resolves.toMatchObject({ status: "ok" });
    expect(isSessionWorkAdmissionActive(storePath, [sessionKey, sessionId])).toBe(false);
  });

  it("marks a final lifecycle claim conflict as post-execution (#108428)", async () => {
    const sessionKey = "agent:main:main";
    const initialSessionEntry = makeCronSessionEntry({ sessionId: "persistent-session" });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: inMemoryStorePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue({ ...initialSessionEntry });

    let agentExecutionStarted = false;
    runEmbeddedAgentMock.mockImplementationOnce(
      async (runParams: { onExecutionStarted?: () => void }) => {
        runParams.onExecutionStarted?.();
        agentExecutionStarted = true;
        return {
          payloads: [{ text: "completed" }],
          meta: { agentMeta: {} },
        };
      },
    );

    const committedRows = new Map<string, SessionEntry>([
      [`${inMemoryStorePath}\0${sessionKey}`, structuredClone(initialSessionEntry) as SessionEntry],
    ]);
    patchSessionEntryMock.mockImplementation(
      async (
        scope: { storePath?: string; sessionKey: string },
        update: (
          entry: SessionEntry,
          context: { existingEntry: SessionEntry | undefined },
        ) => SessionEntry | null,
        options: { fallbackEntry?: SessionEntry } = {},
      ) => {
        const key = `${scope.storePath ?? ""}\0${scope.sessionKey}`;
        const current = committedRows.get(key);
        const writeBase = current ?? options.fallbackEntry;
        if (!writeBase) {
          return null;
        }
        const existingEntry =
          agentExecutionStarted && scope.sessionKey === sessionKey
            ? { ...writeBase, lifecycleRevision: "replacement-revision" }
            : current;
        const committed = update(structuredClone(writeBase), {
          existingEntry: existingEntry ? structuredClone(existingEntry) : undefined,
        });
        if (committed) {
          committedRows.set(key, structuredClone(committed));
        }
        return committed;
      },
    );

    await expect(
      runCronIsolatedAgentTurn(makeCronLifecycleParams(sessionKey)),
    ).resolves.toMatchObject({
      status: "error",
      error: `Session "${sessionKey}" changed while starting work. Retry.`,
      executionStarted: true,
    });
  });

  it("releases a custom cron session lease before delete-after-run cleanup", async () => {
    dispatchCronDeliveryMock.mockImplementationOnce(
      (await vi.importActual<typeof import("./delivery-dispatch.js")>("./delivery-dispatch.js"))
        .dispatchCronDelivery,
    );
    const sessionKey = "agent:main:cron:cleanup";
    const sessionId = "custom-cron-session";
    const storePath = inMemoryStorePath;
    const initialSessionEntry = makeCronSessionEntry({ sessionId });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue({ ...initialSessionEntry });
    let admissionActiveDuringDelete = true;
    callGatewayMock.mockImplementationOnce(async () => {
      admissionActiveDuringDelete = isSessionWorkAdmissionActive(storePath, [
        sessionKey,
        sessionId,
      ]);
      return { ok: true, deleted: true };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "main",
        sessionKey,
        job: makeIsolatedAgentJobFixture({
          sessionTarget: `session:${sessionKey}`,
          deleteAfterRun: true,
          delivery: { mode: "none" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(admissionActiveDuringDelete).toBe(false);
  });
});

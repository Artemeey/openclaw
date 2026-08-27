import { beforeEach, describe, expect, it, vi } from "vitest";
import { startAgentRunExecution } from "./agent-run-execution-phase.js";

const dispatchAgentRunFromGateway = vi.hoisted(() => vi.fn());
const loadPublishedGatewayReplyDispatchRuntime = vi.hoisted(() =>
  vi.fn(async () => ({
    config: { runtime: "late" },
    pluginGeneration: "late",
  })),
);

vi.mock("../../agents/prepared-model-runtime.js", () => ({
  loadPublishedGatewayReplyDispatchRuntime,
}));

vi.mock("./agent-run-dispatch.js", () => ({
  dispatchAgentRunFromGateway,
  resolveAbortedAgentStopReason: () => "rpc",
}));

describe("startAgentRunExecution Gateway ownership", () => {
  beforeEach(() => {
    dispatchAgentRunFromGateway.mockReset();
    loadPublishedGatewayReplyDispatchRuntime.mockReset();
    loadPublishedGatewayReplyDispatchRuntime.mockResolvedValue({
      config: { runtime: "late" },
      pluginGeneration: "late",
    });
  });

  function createExecutionParams(
    options: {
      assertContextCurrent?: () => void;
      controller?: AbortController;
    } = {},
  ) {
    const cleanup = vi.fn();
    const gatewayRelease = vi.fn();
    const runtimeRelease = vi.fn();
    const emitFinal = vi.fn();
    return {
      cleanup,
      gatewayRelease,
      runtimeRelease,
      emitFinal,
      params: {
        assertContextCurrent: options.assertContextCurrent,
        prepared: {
          activeGatewayWorkAdmission: {
            release: gatewayRelease,
            run: async (run: () => Promise<void>) => await run(),
          },
          activeRunAbort: {
            cleanup,
            controller: options.controller ?? new AbortController(),
            registered: false,
          },
          dispatchTaskTrackingMode: "none",
          effectiveAllowModelOverride: false,
          lifecycleStorePath: "",
          operationalRunInstance: {},
          preparedModelRuntimeLease: { release: runtimeRelease },
          replyDispatchRuntime: {
            config: { runtime: "admitted" },
            pluginGeneration: "admitted",
          },
          unpersistedOffloadedRefs: [],
          userTurn: {
            execApprovalFollowupHandoffClaimId: "claim",
            message: "continue",
            senderIsOwner: false,
            suppressPromptPersistence: false,
          },
          workspaceDir: "/workspace/admitted",
        },
        request: {},
        cfg: {},
        activeSessionAgentId: "main",
        delivery: {},
        isNewSession: false,
        isRawModelRun: true,
        isOneShotModelRun: true,
        isRestartRecoveryResumeRun: false,
        suppressVisibleSessionEffects: true,
        images: [],
        imageOrder: [],
        media: [],
        runId: "owner-test",
        agentDedupeKeys: [],
        bestEffortDeliver: false,
        lifecycleGeneration: "test",
        preserveUserFacingSessionModelState: false,
        skipAgentInitialSessionTouch: true,
        canUseInternalRuntimeHandoff: false,
        client: null,
        context: {
          dedupe: new Map(),
          deps: {},
          logGateway: { error: vi.fn(), warn: vi.fn() },
        },
        io: {
          emitAcceptance: vi.fn(),
          emitFinal,
        },
        releaseCronContinuationClaimWithRecovery: async () => true,
      },
    };
  }

  it("dispatches with the admitted runtime and releases its lease on completion", async () => {
    const fixture = createExecutionParams();
    dispatchAgentRunFromGateway.mockImplementationOnce((params) => {
      params.cleanupAbortController({ force: true });
    });

    startAgentRunExecution(fixture.params as never);

    await vi.waitFor(() => expect(dispatchAgentRunFromGateway).toHaveBeenCalledOnce());
    const dispatched = dispatchAgentRunFromGateway.mock.calls[0]?.[0];
    expect(dispatched).toMatchObject({
      commandRuntimeContext: {
        config: { runtime: "admitted" },
        pluginGeneration: "admitted",
      },
      ingressOpts: { workspaceDir: "/workspace/admitted" },
    });
    expect(loadPublishedGatewayReplyDispatchRuntime).not.toHaveBeenCalled();
    expect(fixture.runtimeRelease).toHaveBeenCalledOnce();
  });

  it("releases the admitted runtime lease when aborted before dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    const fixture = createExecutionParams({ controller });

    startAgentRunExecution(fixture.params as never);

    await vi.waitFor(() => expect(fixture.emitFinal).toHaveBeenCalledOnce());
    expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
    expect(fixture.runtimeRelease).toHaveBeenCalledOnce();
  });

  it("rejects a retired owner after preparation and before final dispatch", async () => {
    const fixture = createExecutionParams({
      assertContextCurrent: () => {
        throw new Error("Gateway owner retired");
      },
    });

    startAgentRunExecution(fixture.params as never);

    await vi.waitFor(() => expect(fixture.emitFinal).toHaveBeenCalledOnce());
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    expect(dispatchAgentRunFromGateway).not.toHaveBeenCalled();
    expect(fixture.gatewayRelease).toHaveBeenCalledOnce();
    expect(fixture.runtimeRelease).toHaveBeenCalledOnce();
  });
});

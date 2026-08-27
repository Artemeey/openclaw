import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { resolveDurableChatClaim } from "../../gateway/server-methods/chat-restart-recovery.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import {
  beginCloudSessionTest,
  bindCloudSessionTestPlacementTurn,
  createCloudSessionTestPlacementLifecycle,
} from "../../gateway/worker-environments/cloud-session-test-cleanup.js";
import { completeCloudSessionTestCleanup } from "../../gateway/worker-environments/cloud-session-test-record.js";
import { REQUEST } from "../../gateway/worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "../../gateway/worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "../../gateway/worker-environments/placement-store.js";
import { deriveEnvironmentIntent } from "../../gateway/worker-environments/service-contract.js";
import * as support from "../../gateway/worker-environments/service.test-support.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  claimAgentRunContext,
  getAgentRunContextOwnership,
  releaseAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  markRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
} from "./main-session-restart-recovery-marking.js";
import { recoverStore } from "./main-session-restart-recovery-store.js";

// Regression: ordinary interrupted rows were scheduled for a second model turn,
// and clearing only the cleanup marker made them eligible again after teardown.
describe("cloud test restart retirement", () => {
  support.setupWorkerEnvironmentServiceSuite();
  let handle: Awaited<ReturnType<typeof beginCloudSessionTest>> | undefined;
  const operationId = `session-dispatch:${REQUEST.sessionId}:1`;
  const environmentId = deriveEnvironmentIntent(operationId).environmentId;
  const requestRunId = "cloud-test-request";
  const sourceRunId = "cloud-test-source";
  const dispatchAgent = vi.fn(async (): Promise<never> => {
    throw new Error("test turn must never replay");
  });
  const runtime: GatewayRecoveryRuntime = {
    dispatchAgent,
    waitForAgent: vi.fn(async (): Promise<never> => {
      throw new Error("no recovery wait");
    }),
    abortAgent: vi.fn(async () => ({ aborted: false })),
    sendRecoveryNotice: vi.fn(async () => ({ suppressed: false })),
  };
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
    setRuntimeConfigSnapshot({});
    dispatchAgent.mockClear();
    replaceSessionEntrySync(REQUEST, { sessionId: REQUEST.sessionId, updatedAt: 1 });
  });
  afterEach(() => {
    handle?.close();
    handle = undefined;
    rotateAgentEventLifecycleGeneration();
    clearRuntimeConfigSnapshot();
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
  });
  const prepare = async () => {
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const lifecycle = createCloudSessionTestPlacementLifecycle({
      placements,
      environments: { get: (id) => harness.environments.get(id) },
    });
    const harness: ReturnType<typeof createHarness> = createHarness(placements, {
      testLifecycle: lifecycle,
      workspacePath: path.join(support.testState.root, "workspace"),
    });
    handle = await beginCloudSessionTest(REQUEST, operationId);
    handle.bindDispatchRequest(REQUEST);
    const active = await harness.service.dispatch(REQUEST);
    await handle.bindActive(active, () => {});
    await handle.expectTurn(requestRunId, () => {});
    const generation = getAgentEventLifecycleGeneration();
    await handle.bindTurnAdmission(requestRunId, generation, () => {});
    await appendTranscriptMessage(REQUEST, {
      cwd: support.testState.root,
      message: { role: "user", content: "Write the test proof file", timestamp: 1 },
    });
    return { placements, harness, lifecycle, active, generation };
  };
  const recover = () =>
    recoverStore({
      cfg: {},
      stateDir: support.testState.root,
      storePath: resolveDefaultSessionStorePath("main"),
      handledSessionKeys: new Set(),
      gatewayRuntime: runtime,
    });
  it.each(["admitted", "claim-planned", "started", "suspended", "failed"] as const)(
    "never replays an interrupted %s test, including after verified teardown clears its marker",
    async (stage) => {
      const { placements, harness, generation, active } = await prepare();
      if (stage !== "admitted") {
        await persistGatewaySessionLifecycleEvent({
          ...REQUEST,
          event: {
            runId: sourceRunId,
            clientRunId: requestRunId,
            sessionId: REQUEST.sessionId,
            lifecycleGeneration: generation,
            ts: 10,
            data: { phase: "start", startedAt: 10 },
          },
        });
        if (stage === "suspended" || stage === "failed") {
          await persistGatewaySessionLifecycleEvent({
            ...REQUEST,
            event: {
              runId: sourceRunId,
              clientRunId: requestRunId,
              sessionId: REQUEST.sessionId,
              lifecycleGeneration: generation,
              ts: 20,
              data:
                stage === "suspended"
                  ? { phase: "end", yielded: true, livenessState: "paused", stopReason: "end_turn" }
                  : { phase: "error", error: "model rejected test", endedAt: 20 },
            },
          });
        }
      }
      if (stage === "started" || stage === "claim-planned") {
        const planned = {
          ...REQUEST,
          runId: requestRunId,
          claimId: "interrupted-test-claim",
          owner: { kind: "worker" as const, environmentId, ownerEpoch: active.activeOwnerEpoch },
        };
        await bindCloudSessionTestPlacementTurn(
          active,
          {
            ...planned,
            placementGeneration: active.generation,
          },
          () => {
            if (placements.get(REQUEST.sessionId)?.turnClaim) {
              throw new Error("claim already owned");
            }
          },
        );
        if (stage === "started") {
          placements.claimTurn(planned);
        }
      }
      await markRestartAbortedMainSessions({
        cfg: {},
        stateDir: support.testState.root,
        sessionIds: [REQUEST.sessionId],
        activeRuns: [{ ...REQUEST, runId: sourceRunId, lifecycleGeneration: generation }],
      });
      expect(loadSessionEntry(REQUEST)?.mainRestartRecovery).toBeUndefined();
      handle!.close();
      rotateAgentEventLifecycleGeneration();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      support.testState.stateDb = openOpenClawStateDatabase({
        env: { OPENCLAW_STATE_DIR: support.testState.root },
      });
      const reopened = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const lifecycle = createCloudSessionTestPlacementLifecycle({
        placements: reopened,
        environments: harness.environments,
      });
      const recovery = createHarness(reopened, {
        testLifecycle: lifecycle,
        environmentService: harness.environments,
        workspacePath: path.join(support.testState.root, "workspace"),
      });
      const marking = await markStartupOrphanedMainSessionsForRecovery({
        cfg: {},
        stateDir: support.testState.root,
      });
      expect(marking.marked).toBe(0);
      expect((await recover()).started).toBe(0);
      expect(
        await resolveDurableChatClaim({
          cfg: {},
          canonicalSessionKey: REQUEST.sessionKey,
          persistedSessionKey: REQUEST.sessionKey,
          clientRunId: requestRunId,
          entry: loadSessionEntry(REQUEST),
          reloadEntry: () => loadSessionEntry(REQUEST),
          storePath: resolveDefaultSessionStorePath("main"),
          recoveryRuntime: runtime,
          warn: vi.fn(),
        }),
      ).toMatchObject({ kind: "rejected" });
      await recovery.service.reconcile("startup");
      const settled = loadSessionEntry(REQUEST);
      expect(settled?.cloudSessionTestCleanup).toBeUndefined();
      expect(settled).toMatchObject({
        status: stage === "failed" ? "failed" : "killed",
        lastRunId: requestRunId,
      });
      if (stage === "failed") {
        expect(settled?.lastRunError).toBe("model rejected test");
      }
      expect(reopened.get(REQUEST.sessionId)?.turnClaim).toBeNull();
      expect(harness.environments.create).toHaveBeenCalledOnce();
      expect(harness.environments.destroy).toHaveBeenCalledOnce();
      expect(settled?.restartRecoveryTerminalRunIds).toContain(requestRunId);
      expect(
        await resolveDurableChatClaim({
          cfg: {},
          canonicalSessionKey: REQUEST.sessionKey,
          persistedSessionKey: REQUEST.sessionKey,
          clientRunId: requestRunId,
          entry: settled,
          reloadEntry: () => loadSessionEntry(REQUEST),
          storePath: resolveDefaultSessionStorePath("main"),
          recoveryRuntime: runtime,
          warn: vi.fn(),
        }),
      ).toEqual({ kind: "accepted" });
      await markStartupOrphanedMainSessionsForRecovery({
        cfg: {},
        stateDir: support.testState.root,
      });
      await recover();
      expect(dispatchAgent).not.toHaveBeenCalled();
    },
  );

  it("does not settle an unrelated successor run or consume its live registry owner", async () => {
    const { harness } = await prepare();
    const entry = loadSessionEntry(REQUEST)!;
    replaceSessionEntrySync(REQUEST, {
      ...entry,
      status: "running",
      lifecycleRunId: "successor",
      activeWriterRunId: "successor",
    });
    const claimId = claimAgentRunContext(
      "successor",
      { ...REQUEST, lifecycleGeneration: getAgentEventLifecycleGeneration() },
      { trackOwner: true },
    );
    try {
      harness.markEnvironmentDestroyed();
      await expect(completeCloudSessionTestCleanup(REQUEST, operationId, () => {})).rejects.toThrow(
        /ownership changed|live run owner|different run owner/,
      );
      expect(getAgentRunContextOwnership("successor")?.claimIds.has(claimId!)).toBe(true);
      expect(loadSessionEntry(REQUEST)).toMatchObject({
        status: "running",
        lifecycleRunId: "successor",
        cloudSessionTestCleanup: entry.cloudSessionTestCleanup,
      });
    } finally {
      releaseAgentRunContext("successor", claimId);
    }
  });
});

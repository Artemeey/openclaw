import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { installWorkerPlacementReconcileGuard } from "../server-worker-placement-reconcile-guard.js";
import {
  beginCloudSessionTest,
  bindCloudSessionTestPlacementTurn,
  observeCloudSessionTestTurn,
  createCloudSessionTestPlacementLifecycle,
} from "./cloud-session-test-cleanup.js";
import {
  CloudSessionTestOwnershipChangedError,
  completeCloudSessionTestCleanup,
} from "./cloud-session-test-record.js";
import { REQUEST, seedProvisioningPlacement } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";
import * as support from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { readActualWorkspaceManifest, applyStagedWorkerWorkspace } from "./workspace-reconcile.js";
import { reconcileWorkspaceAfterTurn } from "./workspace-result-finalize.js";

const operationId = `session-dispatch:${REQUEST.sessionId}:1`;
const environmentId = deriveEnvironmentIntent(operationId).environmentId;

describe("cloud test cleanup ownership", () => {
  support.setupWorkerEnvironmentServiceSuite();
  let handle: Awaited<ReturnType<typeof beginCloudSessionTest>> | undefined;
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
    replaceSessionEntrySync(REQUEST, {
      sessionId: REQUEST.sessionId,
      updatedAt: 1,
      createdActor: { type: "human", id: "operator-1" },
    });
  });
  afterEach(() => {
    handle?.close();
    handle = undefined;
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
  });

  const prepare = async (options: Parameters<typeof createHarness>[1] = {}, request = REQUEST) => {
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const lifecycle = createCloudSessionTestPlacementLifecycle({
      placements,
      environments: { get: (id) => harness.environments.get(id) },
    });
    const harness: ReturnType<typeof createHarness> = createHarness(placements, {
      workspacePath: path.join(support.testState.root, "workspace"),
      testLifecycle: lifecycle,
      ...options,
    });
    handle = await beginCloudSessionTest(REQUEST, operationId);
    handle.bindDispatchRequest(request);
    return { placements, lifecycle, harness };
  };

  it("persists intent and awaited generation binding before allocation, without exposing it to plugins", async () => {
    const { harness, lifecycle } = await prepare();
    expect(projectPublicSessionEntry(loadSessionEntry(REQUEST)!)).not.toHaveProperty(
      "cloudSessionTestCleanup",
    );
    const releaseBinding = createDeferredCore();
    const enteredBinding = createDeferredCore();
    const original = lifecycle.beforeProvision;
    lifecycle.beforeProvision = async (...args) => {
      await original(...args);
      enteredBinding.resolve();
      await releaseBinding.promise;
    };
    const dispatch = harness.service.dispatch(REQUEST);
    await enteredBinding.promise;
    expect(harness.environments.create).not.toHaveBeenCalled();
    expect(loadSessionEntry(REQUEST)?.cloudSessionTestCleanup).toMatchObject({
      environmentId,
      binding: { stage: "provisioning", generation: harness.placements.current()?.generation },
    });
    releaseBinding.resolve();
    const active = await dispatch;
    expect(loadSessionEntry(REQUEST)?.cloudSessionTestCleanup).toMatchObject({
      binding: {
        stage: "activating",
        activeGeneration: active.generation,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    await handle!.bindActive(active, () => {});
    expect(loadSessionEntry(REQUEST)?.cloudSessionTestCleanup?.binding.stage).toBe("active");
  });

  it("rejects a copied dispatch identity before any placement mutation or allocation", async () => {
    const { placements, harness } = await prepare();
    await expect(
      harness.service.dispatch({ ...REQUEST, idempotencyKey: operationId }),
    ).rejects.toThrow(/cleanup before redispatch/);
    expect(placements.get(REQUEST.sessionId)).toBeUndefined();
    expect(harness.environments.create).not.toHaveBeenCalled();
    await expect(harness.service.dispatch(REQUEST)).resolves.toMatchObject({ state: "active" });
  });

  it("propagates a binding failure before provider allocation", async () => {
    const { harness, lifecycle } = await prepare();
    lifecycle.beforeProvision = async () => {
      throw new Error("metadata write failed");
    };
    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("metadata write failed");
    expect(harness.environments.create).not.toHaveBeenCalled();
  });

  it("fences allocation when authority closes during the awaited binding", async () => {
    const { harness, lifecycle } = await prepare();
    let allowed = true;
    const bind = lifecycle.beforeProvision;
    lifecycle.beforeProvision = async (...args) => {
      await bind(...args);
      allowed = false;
    };
    await expect(
      harness.service.dispatch(REQUEST, undefined, () => {
        if (!allowed) {
          throw new CloudSessionTestOwnershipChangedError("operator closed");
        }
      }),
    ).rejects.toThrow("operator closed");
    expect(harness.environments.create).not.toHaveBeenCalled();
    expect(loadSessionEntry(REQUEST)?.cloudSessionTestCleanup).toBeDefined();
  });

  it.each(["epoch", "attachment", "independent-turn"] as const)(
    "does not reclaim a test after its %s changes",
    async (change) => {
      const { placements, harness } = await prepare();
      const active = await harness.service.dispatch(REQUEST);
      await handle!.bindActive(active, () => {});
      handle!.close();
      if (change === "epoch") {
        harness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch + 1);
      } else if (change === "attachment") {
        harness.markEnvironmentAttachments([REQUEST.sessionId, "other-session"]);
      } else {
        placements.claimTurn({
          ...REQUEST,
          claimId: "independent-claim",
          runId: "independent-run",
          owner: { kind: "worker", environmentId, ownerEpoch: active.activeOwnerEpoch },
        });
      }
      await harness.service.reconcile("startup");
      expect(harness.environments.destroy).not.toHaveBeenCalled();
      expect(harness.log).not.toContain("placement:adopted");
      expect(loadSessionEntry(REQUEST)?.cloudSessionTestCleanup).toBeDefined();
    },
  );

  it("retains an unverified cleanup marker and clears a verified teardown idempotently", async () => {
    const { harness } = await prepare();
    const active = await harness.service.dispatch(REQUEST);
    await handle!.bindActive(active, () => {});
    const assertReleased = () => {
      if (harness.environments.get(environmentId)?.state !== "destroyed") {
        throw new Error("physical teardown unverified");
      }
    };
    await expect(
      completeCloudSessionTestCleanup(REQUEST, operationId, assertReleased),
    ).rejects.toThrow("physical teardown unverified");
    expect(loadSessionEntry(REQUEST)?.cloudSessionTestCleanup).toBeDefined();
    await harness.service.reclaim(REQUEST);
    await completeCloudSessionTestCleanup(REQUEST, operationId, assertReleased);
    await completeCloudSessionTestCleanup(REQUEST, operationId, assertReleased);
    expect(loadSessionEntry(REQUEST)?.cloudSessionTestCleanup).toBeUndefined();
  });

  it.each(["activating", "active"] as const)(
    "reclaims a restarted %s test instead of adopting it",
    async (stage) => {
      // The shared SSH environment supports remote-exec; worker-turn needs a node lease.
      const request = { ...REQUEST, executionMode: "remote-exec" as const };
      const { placements, lifecycle, harness } = await prepare({}, request);
      const active = await harness.service.dispatch(request);
      if (stage === "active") {
        await handle!.bindActive(active, () => {});
      }
      let guard:
        | Parameters<WorkerEnvironmentService["installReconcileEnvironmentGuard"]>[0]
        | undefined;
      installWorkerPlacementReconcileGuard({
        placements,
        environments: {
          get: harness.environments.get,
          installReconcileEnvironmentGuard: (installed) => {
            guard = installed;
            return async () => {};
          },
        },
        dispatch: harness.service,
        isStopping: () => false,
        deferReconciliation: lifecycle.deferReconciliation,
      });
      const refreshCredentials = vi.fn(async () => {});
      vi.mocked(harness.environments.reconcileEnvironment).mockImplementation(async (id) => {
        if (!guard) {
          throw new Error("reconciliation guard missing");
        }
        await guard(id, refreshCredentials);
      });
      await harness.service.reconcileActive();
      expect(harness.environments.destroy).not.toHaveBeenCalled();
      handle!.close();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      support.testState.stateDb = openOpenClawStateDatabase({
        env: { OPENCLAW_STATE_DIR: support.testState.root },
      });
      // Recovery reads the reopened agent metadata; placement data remains in its
      // independent canonical state store, never in a browser-owned test object.
      await harness.service.reconcile("startup");
      expect(refreshCredentials).not.toHaveBeenCalled();
      expect(placements.get(REQUEST.sessionId)?.state).toBe("reclaimed");
      expect(harness.environments.destroy).toHaveBeenCalledOnce();
      expect(harness.log).not.toContain("placement:adopted");
      await lifecycle.clearCompleted();
      expect(loadSessionEntry(REQUEST)?.cloudSessionTestCleanup).toBeUndefined();
    },
  );

  it("retains unknown teardown without blocking Gateway startup", async () => {
    const { harness } = await prepare({ destroyFails: true });
    const active = await harness.service.dispatch(REQUEST);
    await handle!.bindActive(active, () => {});
    handle!.close();
    await harness.service.reconcile("startup");
    expect(loadSessionEntry(REQUEST)?.cloudSessionTestCleanup).toBeDefined();
    expect(harness.placements.current()?.state).not.toBe("reclaimed");
  });

  it("rejects a successor generation before provisioning replay", async () => {
    const { placements, harness } = await prepare();
    const active = await harness.service.dispatch(REQUEST);
    await handle!.bindActive(active, () => {});
    handle!.close();
    await harness.service.reclaim(REQUEST);
    expect(loadSessionEntry(REQUEST)?.cloudSessionTestCleanup).toBeDefined();
    // Even reusing the old environment identity cannot authorize a new generation.
    const successor = placements.startDispatch(REQUEST);
    placements.transition({
      sessionId: REQUEST.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: successor.generation,
      patch: { environmentId },
    });
    const destroyCalls = vi.mocked(harness.environments.destroy).mock.calls.length;
    const replay = vi.fn(async () => {});
    const pending = placements.get(REQUEST.sessionId)!;
    if (pending.state !== "provisioning") {
      throw new Error("expected successor provisioning");
    }
    await harness.service.resumeProvisioning(pending, replay);
    expect(replay).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledTimes(destroyCalls);
    expect(placements.get(REQUEST.sessionId)).toEqual(pending);
    expect(loadSessionEntry(REQUEST)?.cloudSessionTestCleanup?.cleanupIssue).toBe(
      "ownership-changed",
    );
  });

  it("isolates changed session ownership while unrelated placement recovery continues", async () => {
    const { placements, harness } = await prepare();
    const active = await harness.service.dispatch(REQUEST);
    await handle!.bindActive(active, () => {});
    handle!.close();
    const entry = loadSessionEntry(REQUEST)!;
    replaceSessionEntrySync(REQUEST, { ...entry, lifecycleRevision: "replacement-revision" });
    const other = {
      sessionId: "other-session",
      sessionKey: "agent:main:other-session",
      agentId: "main",
    };
    replaceSessionEntrySync(other, { sessionId: other.sessionId, updatedAt: 1 });
    placements.startDispatch(other);
    await expect(harness.service.reconcile("startup")).resolves.toBeUndefined();
    expect(placements.get(other.sessionId)?.state).toBe("failed");
    expect(placements.get(REQUEST.sessionId)?.generation).toBe(active.generation);
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(loadSessionEntry(REQUEST)?.cloudSessionTestCleanup?.cleanupIssue).toBe(
      "ownership-changed",
    );
  });

  it.each(["remote", "gateway-only", "unverified"] as const)(
    "requires accepted inbound remote bytes, not merely a local file (%s)",
    async (origin) => {
      const local = path.join(support.testState.root, "proof-local");
      const remote = path.join(support.testState.root, "proof-remote");
      await fs.mkdir(local);
      await fs.mkdir(remote);
      const base = await readActualWorkspaceManifest({ root: local, baseCommit: null });
      const { placements, harness } = await prepare({
        workspacePath: local,
        workspaceSyncResult: {
          mode: "plain",
          remoteWorkspaceDir: "/worker/workspace",
          manifestRef: base.manifestRef,
        },
      });
      const active = await harness.service.dispatch(REQUEST);
      expect(active.workspaceBaseManifestRef).toBe(base.manifestRef);
      await handle!.bindActive(active, () => {});
      const runId = "nonce-turn";
      await handle!.expectTurn(runId, () => {});
      await handle!.bindTurnAdmission(runId, getAgentEventLifecycleGeneration(), () => {});
      const nonce = randomUUID();
      const filename = "proof.txt";
      handle!.expectProof({
        path: filename,
        size: Buffer.byteLength(nonce),
        sha256: createHash("sha256").update(nonce).digest("hex"),
      });
      await fs.writeFile(path.join(origin === "gateway-only" ? local : remote, filename), nonce);
      const incoming = await readActualWorkspaceManifest({ root: remote, baseCommit: null });
      const claim = placements.claimTurn({
        ...REQUEST,
        claimId: "nonce-claim",
        runId,
        owner: { kind: "worker", environmentId, ownerEpoch: active.activeOwnerEpoch },
      });
      await bindCloudSessionTestPlacementTurn(active, claim, () => {
        if (!placements.validateTurnClaim(claim)) {
          throw new Error("claim changed");
        }
      });
      placements.markWorkspaceResultPending(claim);
      const uninstall = placements.registerTurnClaimClosedHandler(observeCloudSessionTestTurn);
      const tunnel: WorkerTunnelHandle = {
        environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        stop: async () => {},
        runWorkspaceCommand: async () => {
          throw new Error("no parallel command path");
        },
        syncWorkspace: async () => {
          throw new Error("already synchronized");
        },
        quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
        reconcileWorkspace: async (request) => {
          expect(request.localPath).toBe(local);
          expect(request.baseManifestRef).toBe(active.workspaceBaseManifestRef);
          const applied = await applyStagedWorkerWorkspace({
            root: local,
            stagingRoot: remote,
            baseManifestRef: request.baseManifestRef,
            currentManifestRef: incoming.manifestRef,
            base: base.manifest,
            current: incoming.manifest,
            journal: request.journal,
          });
          return {
            manifestRef: applied.manifestRef,
            sourceManifest: incoming.manifest,
            changed: true,
            getAppliedWorkspaceResult: () => applied,
            verifyStable: async () => {
              if (origin === "unverified") {
                throw new Error("remote changed");
              }
            },
            verifyLocalStable: () => applied.verifyLocalStable(),
          };
        },
      };
      try {
        const finalized = reconcileWorkspaceAfterTurn({
          placement: active,
          placements,
          turnClaim: claim,
          workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
          localWorkspaceDir: local,
          transcriptTarget: { ...REQUEST, storePath: resolveDefaultSessionStorePath("main") },
          tunnel,
        });
        if (origin === "unverified") {
          await expect(finalized).rejects.toThrow("remote changed");
        } else {
          await finalized;
        }
        expect(await fs.readFile(path.join(local, filename), "utf8")).toBe(nonce);
        expect(handle!.observedRemoteProof(runId)).toBe(origin === "remote");
        expect(handle!.observedTurn(runId)).toBe(origin !== "unverified");
      } finally {
        uninstall();
      }
    },
  );

  it("recovers response-loss cleanup through the original provider operation after both stores reopen", async () => {
    let placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const physicalLeases = new Set<string>();
    let physicalAllocations = 0;
    const operationIds: string[] = [];
    let loseReply = true;
    const provider = support.createProvider({
      provision: async (_profile, id) => {
        operationIds.push(id);
        if (!physicalLeases.has("exact-test-lease")) {
          physicalAllocations += 1;
          physicalLeases.add("exact-test-lease");
        }
        if (loseReply) {
          loseReply = false;
          throw new Error("lost allocation response");
        }
        return { leaseId: "exact-test-lease", ssh: support.SSH_ENDPOINT };
      },
      destroy: async ({ leaseId }) => {
        physicalLeases.delete(leaseId);
      },
      inspect: async () => ({ status: physicalLeases.size ? "active" : "destroyed" }),
    });
    let environments = support.createService(provider);
    let lifecycle = createCloudSessionTestPlacementLifecycle({ placements, environments });
    handle = await beginCloudSessionTest(REQUEST, operationId);
    handle.bindDispatchRequest(REQUEST);
    const pending = seedProvisioningPlacement(placements, environmentId, "remote-exec");
    await lifecycle.beforeProvision(pending);
    await expect(
      environments.create("development", operationId, undefined, "remote-exec"),
    ).rejects.toThrow();
    expect(physicalLeases.size).toBe(1);
    handle.close();
    await environments.stop();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    support.testState.stateDb = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: support.testState.root },
    });
    support.testState.store = createWorkerEnvironmentStore({ database: support.testState.stateDb });
    placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    environments = support.createService(provider);
    lifecycle = createCloudSessionTestPlacementLifecycle({ placements, environments });
    const harness = createHarness(placements, {
      testLifecycle: lifecycle,
      environmentService: environments,
    });
    const current = placements.get(REQUEST.sessionId)!;
    if (current.state !== "provisioning") {
      throw new Error("expected original provisioning");
    }
    const resume = vi.fn(async () => {
      throw new Error("test recovery must not bootstrap or activate");
    });
    await harness.service.resumeProvisioning(current, resume);
    expect(resume).not.toHaveBeenCalled();
    expect(physicalLeases.size).toBe(0);
    expect(physicalAllocations).toBe(1);
    expect(new Set(operationIds).size).toBe(1);
    expect(support.testState.store.get(environmentId)?.state).toBe("destroyed");
    expect(loadSessionEntry(REQUEST)?.cloudSessionTestCleanup).toBeUndefined();
  });
});

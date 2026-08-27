import { randomUUID } from "node:crypto";
import type {
  WorkerActiveDispatchPlacement,
  WorkerDispatchEnvironmentService,
  WorkerDispatchPlacement,
} from "./placement-dispatch-failure.js";
import type { PlacementRecoveryDeps } from "./placement-dispatch-pending-results.js";
import type { WorkerPlacementMoveIntent } from "./placement-move-intent.js";
import { placementTurnOwner } from "./placement-record.js";
import {
  completeMovedWorkspaceTeardown,
  completeReclaimedWorkspaceTeardown,
} from "./placement-teardown.js";
import type {
  WorkerPlacementAuthorization,
  WorkerPlacementReclaimRequest,
} from "./service-contract.js";
import { isFailedWorkerPlacementEnvironmentGone } from "./session-placement-lifecycle.js";
import { WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";
import {
  verifyReconciledWorkspaceFinal,
  WorkerWorkspaceFinalFenceError,
} from "./workspace-finalize.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile.js";
import {
  finalizeWorkspaceResultConflicts,
  settleStagedWorkspaceResult,
} from "./workspace-result-finalize.js";
import {
  hasWorkerWorkspaceResultRef,
  preparedWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

type WorkerDrainingDispatchPlacement = Extract<WorkerDispatchPlacement, { state: "draining" }>;
type WorkerReclaimPlacement = Extract<WorkerDispatchPlacement, { state: "local" | "reclaimed" }>;
type WorkerPlacementReclaimBarrier = (
  params: WorkerPlacementReclaimRequest & {
    authorize?: WorkerPlacementAuthorization;
    beforeDrain?: WorkerPlacementAuthorization;
    begin: () => WorkerDrainingDispatchPlacement;
    reclaim: (
      localPath: string,
      placement: WorkerDrainingDispatchPlacement,
      authorize?: WorkerPlacementAuthorization,
    ) => Promise<WorkerReclaimPlacement>;
  },
) => Promise<WorkerReclaimPlacement>;

type WorkerPlacementFailedReclaimBarrier = (
  params: WorkerPlacementReclaimRequest & {
    authorize?: WorkerPlacementAuthorization;
    reclaim: (authorize?: WorkerPlacementAuthorization) => Promise<WorkerReclaimPlacement>;
  },
) => Promise<WorkerReclaimPlacement>;

export type WorkerPlacementReclaimBarriers = {
  runReclaimBarrier: WorkerPlacementReclaimBarrier;
  runFailedReclaimBarrier: WorkerPlacementFailedReclaimBarrier;
};

function isExactAttachedEnvironment(
  environment: ReturnType<WorkerDispatchEnvironmentService["get"]>,
  placement: WorkerActiveDispatchPlacement | WorkerDrainingDispatchPlacement,
): boolean {
  return Boolean(
    environment &&
    environment.environmentId === placement.environmentId &&
    environment.state === "attached" &&
    environment.ownerEpoch === placement.activeOwnerEpoch &&
    environment.attachedSessionIds.length === 1 &&
    environment.attachedSessionIds[0] === placement.sessionId,
  );
}

export function createPlacementReclaimActions(
  options: WorkerPlacementReclaimBarriers &
    Pick<
      PlacementRecoveryDeps,
      | "placements"
      | "environments"
      | "failure"
      | "workspaceOperations"
      | "resolveWorkspaceResultConflict"
      | "reportWorkspaceResultConflict"
    > & { reconcileActive: (environmentId?: string) => Promise<void> },
) {
  const { environments, placements, failure } = options;
  const reclaimOnce = async (
    request: WorkerPlacementReclaimRequest,
    moveIntent?: WorkerPlacementMoveIntent,
    authorize?: WorkerPlacementAuthorization,
    beforeDrain?: WorkerPlacementAuthorization,
  ): Promise<WorkerReclaimPlacement> =>
    await options.runReclaimBarrier({
      ...request,
      authorize,
      beforeDrain,
      begin: () => {
        const current = placements.get(request.sessionId);
        if ((current?.state !== "active" && current?.state !== "draining") || current.turnClaim) {
          throw new Error(
            `Session ${request.sessionKey} cannot stop cloud worker from placement ${current?.state ?? "missing"}`,
          );
        }
        const environment = environments.get(current.environmentId);
        if (!isExactAttachedEnvironment(environment, current)) {
          throw new Error("Active cloud worker does not match its session placement");
        }
        if (current.state === "draining") {
          return current;
        }
        const draining = placements.startDrain({
          sessionId: current.sessionId,
          environmentId: current.environmentId,
          ownerEpoch: current.activeOwnerEpoch,
          expectedGeneration: current.generation,
        });
        if (draining.state !== "draining") {
          throw new Error(`Session ${request.sessionKey} did not enter draining placement`);
        }
        return draining;
      },
      reclaim: async (localPath, current, reauthorize) => {
        const journalOwner = {
          sessionId: current.sessionId,
          environmentId: current.environmentId,
          ownerEpoch: current.activeOwnerEpoch,
          placementGeneration: current.generation,
        };
        const reclaimClaimId = `reclaim-${randomUUID()}`;
        const reclaimClaim = placements.claimReclaimWorkspaceResult({
          sessionId: current.sessionId,
          sessionKey: current.sessionKey,
          agentId: current.agentId,
          claimId: reclaimClaimId,
          runId: reclaimClaimId,
          owner: placementTurnOwner(current),
        });
        const reclaimResultRef = workerWorkspaceResultRef(reclaimClaim.claimId);
        let manifestAccepted = false;
        const journal = {
          load: () => placements.loadWorkspaceReconciliation(journalOwner),
          begin: (next: Parameters<typeof placements.beginWorkspaceReconciliation>[1]) =>
            placements.beginWorkspaceReconciliation(journalOwner, next),
          commit: (manifestRef: string) => {
            placements.updateWorkspaceBaseManifest({
              claim: reclaimClaim,
              manifestRef,
            });
            manifestAccepted = true;
          },
          abort: () => placements.abortWorkspaceReconciliation(journalOwner),
        };
        const cancelUnstagedFailedReclaim = async (allowCommitted: boolean): Promise<void> => {
          await options.workspaceOperations.run(current.environmentId, async () => {
            const stillOwnsEmptyResult = (): boolean => {
              const owned = placements.get(current.sessionId);
              const currentEnvironment = environments.get(current.environmentId);
              const pendingResult = placements
                .listPendingWorkspaceResults()
                .find(
                  (pending) =>
                    pending.sessionId === reclaimClaim.sessionId &&
                    pending.claimId === reclaimClaim.claimId &&
                    pending.runId === reclaimClaim.runId,
                );
              return (
                (allowCommitted || !manifestAccepted) &&
                owned?.state === "draining" &&
                owned.turnClaim?.claimId === reclaimClaim.claimId &&
                reclaimClaim.owner.environmentId === current.environmentId &&
                reclaimClaim.owner.ownerEpoch === current.activeOwnerEpoch &&
                currentEnvironment?.state === "attached" &&
                currentEnvironment.ownerEpoch === reclaimClaim.owner.ownerEpoch &&
                currentEnvironment.attachedSessionIds.length === 1 &&
                currentEnvironment.attachedSessionIds[0] === owned.sessionId &&
                pendingResult?.workspaceAcceptedAtMs === null &&
                pendingResult.stagedResultRef === null
              );
            };
            if (!stillOwnsEmptyResult()) {
              return;
            }
            const [canonicalExists, preparedExists] = await Promise.all([
              hasWorkerWorkspaceResultRef({ root: localPath, stagedResultRef: reclaimResultRef }),
              hasWorkerWorkspaceResultRef({
                root: localPath,
                stagedResultRef: preparedWorkerWorkspaceResultRef(reclaimResultRef),
              }),
            ]);
            // Recheck after filesystem I/O while the session barrier and workspace
            // owner lock are still held. A committed manifest or durable ref keeps
            // recovery authoritative.
            if (!canonicalExists && !preparedExists && stillOwnsEmptyResult()) {
              await placements.closeWorkerTurnToolState(reclaimClaim);
              placements.cancelWorkspaceResultAndReleaseTurn(reclaimClaim);
            }
          });
        };
        const finishReclaim = async (): Promise<WorkerReclaimPlacement> => {
          const pending = journal.load();
          if (pending) {
            reauthorize?.();
            await recoverWorkerWorkspaceReconciliation({ root: localPath, journal: pending });
            reauthorize?.();
            journal.abort();
          }
          reauthorize?.();
          const tunnel = await environments.startTunnel({
            environmentId: current.environmentId,
            ownerEpoch: current.activeOwnerEpoch,
          });
          const reclaimed = await options.workspaceOperations.run(
            current.environmentId,
            async () => {
              // Lock acquisition and every remote/filesystem step may yield; stale callers must
              // fail before the next reclaim effect, not only after teardown has completed.
              reauthorize?.();
              const owned = placements.get(current.sessionId);
              if (
                owned?.state !== "draining" ||
                owned.generation !== current.generation ||
                owned.environmentId !== current.environmentId ||
                owned.activeOwnerEpoch !== current.activeOwnerEpoch ||
                owned.turnClaim?.claimId !== reclaimClaim.claimId
              ) {
                throw new Error("Cloud worker stop lost its placement owner before reconciliation");
              }
              reauthorize?.();
              const quiescence = await tunnel.quiesceWorkspace(current.remoteWorkspaceDir);
              let destroyed = false;
              try {
                reauthorize?.();
                const reconciliation = await tunnel.reconcileWorkspace({
                  localPath,
                  remoteWorkspaceDir: current.remoteWorkspaceDir,
                  baseManifestRef: current.workspaceBaseManifestRef,
                  journal,
                  stagedResult: {
                    ref: reclaimResultRef,
                    record: (ref) => placements.recordStagedWorkspaceResult(reclaimClaim, ref),
                  },
                });
                const applied = await verifyReconciledWorkspaceFinal(reconciliation, quiescence);
                if (reconciliation.changed && !manifestAccepted) {
                  throw new Error("Cloud worker stop did not commit its reconciled workspace");
                }
                reauthorize?.();
                placements.acceptWorkspaceResult(reclaimClaim);
                const recordedStagedResultRef = placements
                  .listPendingWorkspaceResults()
                  .find(
                    (result) =>
                      result.sessionId === reclaimClaim.sessionId &&
                      result.claimId === reclaimClaim.claimId &&
                      result.runId === reclaimClaim.runId,
                  )?.stagedResultRef;
                const conflictPaths = applied?.conflictPaths ?? [];
                if (conflictPaths.length > 0 && !recordedStagedResultRef) {
                  throw new Error("Cloud worker stop conflict has no staged result reference");
                }
                const priorWorkspaceResultConflict =
                  current.workspaceResultConflict ??
                  (await options.resolveWorkspaceResultConflict({
                    sessionId: current.sessionId,
                    sessionKey: current.sessionKey,
                    agentId: current.agentId,
                  }));
                reauthorize?.();
                const finalized = await finalizeWorkspaceResultConflicts({
                  placements,
                  turnClaim: reclaimClaim,
                  conflictPaths,
                  priorConflict: priorWorkspaceResultConflict,
                  stagedResultRef: recordedStagedResultRef,
                  // An unchanged stop is not a later cloud result; keep its prior fence inspectable.
                  retainPriorConflict: !reconciliation.changed,
                  root: localPath,
                  report: async (report) =>
                    await options.reportWorkspaceResultConflict({
                      sessionId: current.sessionId,
                      sessionKey: current.sessionKey,
                      agentId: current.agentId,
                      ...report,
                    }),
                });
                reauthorize?.();
                return await settleStagedWorkspaceResult({
                  placements,
                  turnClaim: reclaimClaim,
                  root: localPath,
                  stagedResultRef: recordedStagedResultRef,
                  conflictRetained: finalized.conflictRetained,
                  beforeComplete: async () => {
                    reauthorize?.();
                    await environments.destroy(current.environmentId);
                    destroyed = true;
                  },
                  complete: () => {
                    // Destroy is the final privileged effect. Once it commits, durable placement
                    // completion must finish even if caller authority closes during the await.
                    return moveIntent
                      ? completeMovedWorkspaceTeardown({
                          placements,
                          turnClaim: reclaimClaim,
                          environmentId: current.environmentId,
                          ownerEpoch: current.activeOwnerEpoch,
                          operationId: moveIntent.operationId,
                        })
                      : completeReclaimedWorkspaceTeardown({
                          placements,
                          turnClaim: reclaimClaim,
                          environmentId: current.environmentId,
                          ownerEpoch: current.activeOwnerEpoch,
                        });
                  },
                  validateCompleted: (completed) => {
                    const expectedState = moveIntent ? "local" : "reclaimed";
                    if (completed.state !== expectedState) {
                      throw new Error(
                        `Cloud worker teardown did not produce ${expectedState} placement`,
                      );
                    }
                  },
                });
              } finally {
                if (
                  !destroyed &&
                  isExactAttachedEnvironment(environments.get(current.environmentId), current)
                ) {
                  await quiescence.resume();
                }
              }
            },
          );
          if (reclaimed.state !== "local" && reclaimed.state !== "reclaimed") {
            throw new Error("Cloud worker teardown produced a nonterminal placement");
          }
          try {
            await environments.stopTunnel(current.environmentId, current.activeOwnerEpoch);
          } catch {
            // Provider teardown is authoritative; local tunnel cleanup is best effort.
          }
          return reclaimed;
        };
        try {
          return await finishReclaim();
        } catch (error) {
          // An unstaged final-fence failure is retryable even after an unchanged
          // manifest commit; the journal remains authoritative for the next attempt.
          await cancelUnstagedFailedReclaim(
            error instanceof WorkerWorkspaceFinalFenceError && error.reclaimDisposition === "retry",
          ).catch(() => undefined);
          const pendingReclaimResult = placements
            .listPendingWorkspaceResults()
            .find(
              (pending) =>
                pending.sessionId === reclaimClaim.sessionId &&
                pending.claimId === reclaimClaim.claimId &&
                pending.runId === reclaimClaim.runId,
            );
          if (pendingReclaimResult && pendingReclaimResult.workspaceAcceptedAtMs !== null) {
            placements.handoffWorkspaceResultRecovery(reclaimClaim);
            await options.reconcileActive(current.environmentId).catch(() => undefined);
          }
          throw error;
        }
      },
    });

  const reclaimInFlight = new Map<string, Promise<WorkerReclaimPlacement>>();
  const reclaim = async (
    request: WorkerPlacementReclaimRequest,
    authorize?: WorkerPlacementAuthorization,
    beforeDrain?: WorkerPlacementAuthorization,
  ): Promise<WorkerReclaimPlacement> => {
    beforeDrain?.();
    const current = placements.get(request.sessionId);
    if (current?.state === "reclaimed") {
      return current;
    }
    const inFlight = reclaimInFlight.get(request.sessionId);
    if (inFlight) {
      return await inFlight;
    }
    const operation = (async () => {
      const owned = placements.get(request.sessionId);
      if (owned?.state === "failed") {
        return await options.runFailedReclaimBarrier({
          ...request,
          authorize,
          reclaim: async (reauthorize) => {
            const failedPlacement = placements.get(request.sessionId);
            if (failedPlacement?.state !== "failed") {
              throw new Error("Failed cloud worker placement changed during reclaim");
            }
            await failure.retryFailedTeardown(failedPlacement, reauthorize);
            const failed = placements.get(request.sessionId);
            if (failed?.state !== "failed") {
              throw new Error("Failed cloud worker placement changed during reclaim");
            }
            if (
              !isFailedWorkerPlacementEnvironmentGone({
                environmentService: environments,
                placement: failed,
              })
            ) {
              throw new Error("Failed cloud worker environment cleanup is still pending");
            }
            const local = placements.transition({
              sessionId: request.sessionId,
              from: "failed",
              to: "local",
              expectedGeneration: failed.generation,
            });
            if (local.state !== "local") {
              throw new Error("Failed cloud worker reclaim did not produce a local placement");
            }
            return local;
          },
        });
      }
      return await reclaimOnce(request, undefined, authorize, beforeDrain);
    })().catch((error: unknown) => {
      // Another teardown path can win after this call has crossed its durable completion fence.
      // Report the committed terminal state instead of leaking a stale tunnel error to callers.
      const completed = placements.get(request.sessionId);
      if (error instanceof WorkerTunnelOwnerDisconnectedError && completed?.state === "reclaimed") {
        return completed;
      }
      throw error;
    });
    reclaimInFlight.set(request.sessionId, operation);
    try {
      return await operation;
    } finally {
      if (reclaimInFlight.get(request.sessionId) === operation) {
        reclaimInFlight.delete(request.sessionId);
      }
    }
  };

  return { reclaim, reclaimOnce };
}

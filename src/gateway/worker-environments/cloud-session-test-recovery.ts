import { isDeepStrictEqual } from "node:util";
import { hasPendingFollowupQueueWork } from "../../auto-reply/reply/queue/state.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  CloudSessionTestOwnershipChangedError,
  completeCloudSessionTestCleanup,
  matchingCloudSessionTestStage,
  readCloudSessionTestIntent as readIntent,
  type CloudSessionTestIntent as Intent,
} from "./cloud-session-test-record.js";
import type {
  WorkerDispatchEnvironmentService,
  WorkerDispatchPlacementStore,
} from "./placement-dispatch-failure.js";
import {
  nextGeneration,
  projectWorkerSessionTurnClaim,
  type WorkerSessionPlacementRecord as Placement,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import { boundedWorkerError } from "./worker-error.js";

export type CloudSessionTestRecoveryActions = {
  retireClaim: (claim: WorkerSessionTurnClaim, authorize: () => void) => Promise<void>;
  reclaim: (authorize: () => void, beforeDrain: () => void) => Promise<unknown>;
  teardown: (authorize: () => void) => Promise<void>;
};

export function createCloudSessionTestRecovery(options: {
  placements: WorkerDispatchPlacementStore;
  environments: Pick<WorkerDispatchEnvironmentService, "get">;
  warn?: (message: string) => void;
  exactPlacement: (expected: Placement) => Placement;
  isLive: (placement: Placement, intent: Intent) => boolean;
}): {
  recover: (placement: Placement, actions: CloudSessionTestRecoveryActions) => Promise<boolean>;
  deferReconciliation: (placement: Placement) => boolean;
  clearCompleted: () => Promise<void>;
} {
  const { placements, environments, exactPlacement, isLive } = options;
  const pending = async (
    placement: Placement,
    issue: NonNullable<Intent["cleanupIssue"]>,
    error: unknown,
  ) => {
    options.warn?.(
      `Cloud test cleanup pending (${placement.sessionKey}): ${boundedWorkerError(error)}`,
    );
    try {
      await patchSessionEntryCore(
        placement,
        (entry) => {
          const intent = entry.cloudSessionTestCleanup;
          if (!intent || intent.cleanupIssue === issue) {
            return null;
          }
          // Diagnostic only: retaining a stale marker does not authorize cleanup
          // of the replacement session, environment, or run.
          return { cloudSessionTestCleanup: { ...intent, cleanupIssue: issue } };
        },
        { skipMaintenance: true },
      );
    } catch (writeError) {
      options.warn?.(
        `Cloud test pending diagnostic could not be saved: ${boundedWorkerError(writeError)}`,
      );
    }
  };
  const clearCompleted = async () => {
    for (const placement of placements.list()) {
      let intent: Intent | undefined;
      try {
        intent = readIntent(placement);
      } catch (error) {
        await pending(placement, "ownership-changed", error);
        continue;
      }
      if (!intent || isLive(placement, intent)) {
        continue;
      }
      const released = () => {
        const environment = environments.get(intent.environmentId);
        // Missing environment is only proof before allocation; later stages
        // require terminal provider state proving physical release.
        return (
          environment?.state === "destroyed" ||
          (environment?.state === "failed" && environment.leaseId === null) ||
          (!environment &&
            (intent.binding.stage === "pending" || intent.binding.stage === "provisioning"))
        );
      };
      if (released()) {
        try {
          await completeCloudSessionTestCleanup(placement, intent.operationId, () => {
            exactPlacement(placement);
            if (!released()) {
              throw new Error("Cloud test teardown proof changed");
            }
            if (
              placement.turnClaim ||
              (placement.environmentId && placement.environmentId !== intent.environmentId)
            ) {
              throw new CloudSessionTestOwnershipChangedError(
                "Cloud test placement changed before marker clear",
              );
            }
          });
        } catch (error) {
          await pending(placement, "teardown-pending", error);
        }
      }
    }
  };
  return {
    deferReconciliation: (placement) => {
      if (
        placement.state !== "active" &&
        placement.state !== "syncing" &&
        placement.state !== "starting"
      ) {
        return false;
      }
      try {
        const intent = readIntent(placement);
        return Boolean(
          intent && placement.environmentId === intent.environmentId && !isLive(placement, intent),
        );
      } catch (error) {
        if (!(error instanceof CloudSessionTestOwnershipChangedError)) {
          throw error;
        }
        options.warn?.(boundedWorkerError(error));
        return true;
      }
    },
    recover: async (placement, actions) => {
      let intent: Intent | undefined;
      try {
        intent = readIntent(placement);
      } catch (error) {
        if (!(error instanceof CloudSessionTestOwnershipChangedError)) {
          throw error;
        }
        await pending(placement, "ownership-changed", error);
        return true;
      }
      if (!intent || isLive(placement, intent)) {
        return false;
      }
      if (placement.environmentId !== intent.environmentId) {
        await pending(
          placement,
          "ownership-changed",
          "Test environment was replaced; successor recovery retains ownership",
        );
        return false;
      }
      const binding = intent.binding;
      const matchedStage = matchingCloudSessionTestStage(placement, intent);
      const matchedProvision = matchedStage === "provisioning";
      const matchedActive = matchedStage === "active";
      if (!matchedProvision && !matchedActive) {
        if (
          placement.state === "draining" ||
          placement.state === "reconciling" ||
          placement.state === "reclaimed" ||
          placement.state === "failed"
        ) {
          return false;
        }
        await pending(
          placement,
          "ownership-changed",
          "Test placement generation changed; cleanup will not touch its successor",
        );
        return true;
      }
      // Run correlation only disqualifies cleanup. It never supplies execution
      // or teardown authority; the exact placement/environment fences below do.
      const lastRunId = loadSessionEntry({ ...placement, readConsistency: "latest" })?.lastRunId;
      const testRunId = binding.stage === "active" ? binding.testRunId : undefined;
      if (lastRunId && lastRunId !== testRunId) {
        await pending(
          placement,
          "session-work-pending",
          "Independent session work owns this placement",
        );
        return true;
      }
      // Pending result recovery owns stale claims first. Never interrupt an
      // independent turn merely because its session carries a test marker.
      const interruptedClaim = projectWorkerSessionTurnClaim(placement);
      if (
        interruptedClaim &&
        (!intent.turn ||
          intent.turn.lifecycleGeneration === getAgentEventLifecycleGeneration() ||
          intent.turn.claimId !== interruptedClaim.claimId ||
          intent.turn.requestRunId !== interruptedClaim.runId)
      ) {
        await pending(
          placement,
          "session-work-pending",
          "An unbound or live turn still owns the placement",
        );
        return true;
      }
      const environment = environments.get(intent.environmentId);
      if (
        environment?.state === "destroyed" ||
        (environment?.state === "failed" && environment.leaseId === null)
      ) {
        await clearCompleted();
        return false;
      }
      if (
        environment &&
        ((matchedActive &&
          (environment.state !== "attached" ||
            environment.ownerEpoch !== placement.activeOwnerEpoch ||
            environment.attachedSessionIds.length !== 1 ||
            environment.attachedSessionIds[0] !== placement.sessionId)) ||
          (matchedProvision &&
            ((binding.stage === "activating" && environment.ownerEpoch !== binding.ownerEpoch) ||
              (environment.attachedSessionIds.length !== 0 &&
                (placement.state === "provisioning" ||
                  environment.attachedSessionIds.length !== 1 ||
                  environment.attachedSessionIds[0] !== placement.sessionId)))))
      ) {
        await pending(placement, "ownership-changed", "Cloud test environment attachment changed");
        return true;
      }
      const beforeDrain = () => {
        const current = exactPlacement(placement);
        if (!isDeepStrictEqual(readIntent(placement), intent)) {
          throw new Error("Cloud test cleanup ownership changed");
        }
        const currentLastRunId = loadSessionEntry({
          ...placement,
          readConsistency: "latest",
        })?.lastRunId;
        if (
          current.turnClaim ||
          hasPendingFollowupQueueWork([placement.sessionKey, placement.sessionId]) ||
          (currentLastRunId && currentLastRunId !== testRunId)
        ) {
          throw new Error("Cloud test cleanup found independent session work");
        }
      };
      const authorize = () => {
        if (!isDeepStrictEqual(readIntent(placement), intent)) {
          throw new Error("Cloud test cleanup ownership changed");
        }
        const current = placements.get(placement.sessionId);
        const env = environments.get(intent.environmentId);
        const generation =
          current?.state === "draining" && matchedActive
            ? nextGeneration(placement.generation)
            : placement.generation;
        if (
          !current ||
          current.generation !== generation ||
          current.environmentId !== intent.environmentId ||
          current.activeOwnerEpoch !== placement.activeOwnerEpoch ||
          current.sessionKey !== placement.sessionKey ||
          current.agentId !== placement.agentId ||
          (env &&
            (env.ownerEpoch !== environment?.ownerEpoch ||
              !isDeepStrictEqual(env.attachedSessionIds, environment?.attachedSessionIds)))
        ) {
          throw new Error("Cloud test cleanup lost its exact owner");
        }
      };
      try {
        if (interruptedClaim) {
          await actions.retireClaim(interruptedClaim, () => {
            authorize();
            if (
              !isDeepStrictEqual(
                projectWorkerSessionTurnClaim(exactPlacement(placement)),
                interruptedClaim,
              )
            ) {
              throw new CloudSessionTestOwnershipChangedError("Interrupted test claim changed");
            }
          });
        }
        beforeDrain();
        if (matchedProvision) {
          await actions.teardown(authorize);
        } else {
          await actions.reclaim(authorize, beforeDrain);
        }
        await clearCompleted();
      } catch (error) {
        // The durable intent and canonical reclaim journal retain retry work.
        // An unavailable test worker must not prevent Gateway startup.
        await pending(placement, "teardown-pending", error);
      }
      return true;
    },
    clearCompleted,
  };
}

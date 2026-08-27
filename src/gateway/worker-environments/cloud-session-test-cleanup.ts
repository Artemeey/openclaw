import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  CloudSessionTestOwnershipChangedError,
  cloudSessionTestOwner,
  matchingCloudSessionTestStage,
  readCloudSessionTestIntent as readIntent,
  writeCloudSessionTestIntent as writeIntent,
  type CloudSessionTestIntent as Intent,
} from "./cloud-session-test-record.js";
import { createCloudSessionTestRecovery } from "./cloud-session-test-recovery.js";
import type {
  WorkerDispatchEnvironmentService,
  WorkerDispatchPlacementStore,
} from "./placement-dispatch-failure.js";
import {
  nextGeneration,
  type WorkerSessionPlacementIdentity,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import { deriveEnvironmentIntent, type WorkerPlacementAuthorization } from "./service-contract.js";
import type { WorkerWorkspaceManifest } from "./workspace-manifest.js";

type Identity = WorkerSessionPlacementIdentity;
type Placement = WorkerSessionPlacementRecord;

export type CloudSessionTestPlacementLifecycle = ReturnType<
  typeof createCloudSessionTestRecovery
> & {
  idempotencyKey: (identity: Identity) => string | undefined;
  beforeProvision: (
    placement: Placement,
    authorize?: WorkerPlacementAuthorization,
  ) => Promise<void>;
  beforeActivation: (
    placement: Extract<Placement, { state: "starting" }>,
    ownerEpoch: number,
    authorize?: WorkerPlacementAuthorization,
  ) => Promise<void>;
  close: () => void;
};

// Wizard admission admits at most one test. This closure is only a same-process
// recovery exemption, never worker execution authority and never persisted.
type LiveCloudSessionTest = {
  identity: Identity;
  operationId: string;
  closed: boolean;
  observedRunId?: string;
  expectedRunId?: string;
  dispatchRequest?: Identity;
  runtime?: object;
  expectedProof?: { path: string; sha256: string; size: number };
  remoteProofRunId?: string;
};
let liveTest: LiveCloudSessionTest | undefined;
let currentRuntime: object | undefined;

export async function beginCloudSessionTest(identity: Identity, operationId: string) {
  if (liveTest && !liveTest.closed) {
    throw new Error("A cloud session test is already running");
  }
  const entry = loadSessionEntry({ ...identity, readConsistency: "latest" });
  if (!entry || entry.sessionId !== identity.sessionId || entry.cloudSessionTestCleanup) {
    throw new Error("Cloud test requires its fresh session identity");
  }
  const owner = cloudSessionTestOwner(entry);
  if (operationId.length > 128 || owner.length > 1024) {
    throw new Error("Cloud test identity exceeds its metadata bound");
  }
  const initialIntent: Intent = {
    operationId,
    sessionId: identity.sessionId,
    environmentId: deriveEnvironmentIntent(operationId).environmentId,
    owner,
    binding: { stage: "pending" },
  };
  await writeIntent(identity, undefined, initialIntent);
  const handle: LiveCloudSessionTest = {
    identity,
    operationId,
    closed: false,
    runtime: currentRuntime,
  };
  liveTest = handle;
  return {
    assertLive: () => {
      if (handle.closed || handle.runtime !== currentRuntime || liveTest !== handle) {
        throw new CloudSessionTestOwnershipChangedError(
          "Cloud test continuation is no longer live",
        );
      }
    },
    bindDispatchRequest: (request: Identity) => {
      if (
        handle.closed ||
        liveTest !== handle ||
        (handle.dispatchRequest && handle.dispatchRequest !== request)
      ) {
        throw new CloudSessionTestOwnershipChangedError("Cloud test dispatch continuation changed");
      }
      handle.dispatchRequest = request;
    },
    close: () => {
      handle.closed = true;
      handle.dispatchRequest = undefined;
      if (liveTest === handle) {
        liveTest = undefined;
      }
    },
    expectTurn: async (runId: string, assertCurrent: () => void) => {
      const intent = readIntent(identity);
      if (!intent || intent.binding.stage !== "active" || runId.length > 128) {
        throw new CloudSessionTestOwnershipChangedError(
          "Cloud test turn lost its placement binding",
        );
      }
      await writeIntent(
        identity,
        intent,
        { ...intent, binding: { ...intent.binding, testRunId: runId } },
        assertCurrent,
      );
      handle.expectedRunId = runId;
    },
    bindTurnAdmission: async (
      runId: string,
      lifecycleGeneration: string,
      assertCurrent: () => void,
    ) => {
      const intent = readIntent(identity);
      if (
        !intent ||
        intent.binding.stage !== "active" ||
        intent.binding.testRunId !== runId ||
        lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
        lifecycleGeneration.length > 128 ||
        intent.turn
      ) {
        throw new CloudSessionTestOwnershipChangedError("Cloud test admission changed");
      }
      await writeIntent(
        identity,
        intent,
        {
          ...intent,
          turn: { requestRunId: runId, lifecycleGeneration },
        },
        assertCurrent,
      );
    },
    expectProof: (proof: { path: string; sha256: string; size: number }) => {
      handle.expectedProof = proof;
    },
    observedTurn: (runId: string) => handle.observedRunId === runId,
    observedRemoteProof: (runId: string) => handle.remoteProofRunId === runId,
    bindActive: async (
      placement: Extract<Placement, { state: "active" }>,
      assertCurrent: () => void,
    ) => {
      const current = readIntent(identity);
      if (
        !current ||
        current.binding.stage !== "activating" ||
        current.environmentId !== placement.environmentId ||
        current.binding.activeGeneration !== placement.generation ||
        current.binding.ownerEpoch !== placement.activeOwnerEpoch ||
        placement.turnClaim
      ) {
        throw new Error("Cloud test activation identity changed");
      }
      await writeIntent(
        identity,
        current,
        {
          ...current,
          binding: {
            stage: "active",
            generation: placement.generation,
            ownerEpoch: placement.activeOwnerEpoch,
          },
        },
        assertCurrent,
      );
    },
  };
}

/** Bind the producer-selected claim before installation and remote execution. */
export async function bindCloudSessionTestPlacementTurn(
  placement: Placement,
  claim: WorkerSessionTurnClaim,
  assertCurrent: () => void,
): Promise<void> {
  const intent = readIntent(placement);
  if (!intent) {
    return;
  }
  const handle = liveTest;
  if (
    !handle ||
    handle.closed ||
    handle.runtime !== currentRuntime ||
    handle.operationId !== intent.operationId ||
    intent.binding.stage !== "active" ||
    !intent.turn ||
    intent.turn.lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
    intent.turn.requestRunId !== claim.runId ||
    claim.sessionId !== intent.sessionId ||
    claim.placementGeneration !== intent.binding.generation ||
    claim.owner.environmentId !== intent.environmentId ||
    claim.owner.ownerEpoch !== intent.binding.ownerEpoch
  ) {
    throw new CloudSessionTestOwnershipChangedError("Cloud test placement turn is not owned");
  }
  await writeIntent(
    placement,
    intent,
    { ...intent, turn: { ...intent.turn, claimId: claim.claimId } },
    () => {
      assertCurrent();
      if (handle.closed || liveTest !== handle || handle.runtime !== currentRuntime) {
        throw new CloudSessionTestOwnershipChangedError("Cloud test continuation closed");
      }
    },
  );
}

/** Claim closure is producer-owned evidence of actual remote placement admission. */
export function observeCloudSessionTestTurn(claim: WorkerSessionTurnClaim): void {
  const handle = liveTest;
  if (
    !handle ||
    handle.closed ||
    claim.sessionId !== handle.identity.sessionId ||
    claim.runId !== handle.expectedRunId
  ) {
    return;
  }
  let intent: Intent | undefined;
  try {
    intent = readIntent(handle.identity);
  } catch {
    return;
  }
  if (
    intent?.binding.stage === "active" &&
    intent.operationId === handle.operationId &&
    claim.placementGeneration === intent.binding.generation &&
    claim.owner.environmentId === intent.environmentId &&
    claim.owner.ownerEpoch === intent.binding.ownerEpoch
  ) {
    handle.observedRunId = claim.runId;
  }
}

/** Called only after the inbound remote manifest was verified and durably accepted. */
export function observeCloudSessionTestWorkspaceResult(
  claim: WorkerSessionTurnClaim,
  sourceManifest: WorkerWorkspaceManifest | undefined,
  conflicts: readonly string[],
): void {
  const handle = liveTest;
  if (
    !handle ||
    handle.closed ||
    handle.runtime !== currentRuntime ||
    claim.sessionId !== handle.identity.sessionId ||
    claim.runId !== handle.expectedRunId ||
    !handle.expectedProof ||
    !sourceManifest
  ) {
    return;
  }
  let intent: Intent | undefined;
  try {
    intent = readIntent(handle.identity);
  } catch {
    return;
  }
  if (
    intent?.binding.stage !== "active" ||
    intent.operationId !== handle.operationId ||
    claim.placementGeneration !== intent.binding.generation ||
    claim.owner.environmentId !== intent.environmentId ||
    claim.owner.ownerEpoch !== intent.binding.ownerEpoch ||
    intent.turn?.claimId !== claim.claimId
  ) {
    return;
  }
  const proof = handle.expectedProof;
  const remote = sourceManifest.entries.find((entry) => entry.path === proof.path);
  if (
    !conflicts.includes(proof.path) &&
    remote?.type === "file" &&
    remote.sha256 === proof.sha256 &&
    remote.size === proof.size
  ) {
    handle.remoteProofRunId = claim.runId;
  }
}

export function createCloudSessionTestPlacementLifecycle(options: {
  placements: WorkerDispatchPlacementStore;
  environments: Pick<WorkerDispatchEnvironmentService, "get">;
  warn?: (message: string) => void;
}): CloudSessionTestPlacementLifecycle {
  const { placements, environments } = options;
  const runtime = {};
  currentRuntime = runtime;
  if (liveTest) {
    liveTest.closed = true;
    liveTest = undefined;
  }
  const exactPlacement = (expected: Placement) => {
    const current = placements.get(expected.sessionId);
    if (
      !current ||
      current.sessionKey !== expected.sessionKey ||
      current.agentId !== expected.agentId ||
      current.generation !== expected.generation ||
      current.state !== expected.state ||
      current.environmentId !== expected.environmentId ||
      current.activeOwnerEpoch !== expected.activeOwnerEpoch
    ) {
      throw new CloudSessionTestOwnershipChangedError(
        "Cloud test placement ownership changed; cleanup remains pending",
      );
    }
    return current;
  };
  const bind = async (
    placement: Placement,
    binding: Intent["binding"],
    authorize?: () => void,
    ownerEpoch?: number,
  ) => {
    const intent = readIntent(placement);
    if (!intent) {
      return;
    }
    if (intent.environmentId !== placement.environmentId) {
      throw new Error("Cloud test environment identity changed");
    }
    const assertCurrent = () => {
      authorize?.();
      exactPlacement(placement);
      if (ownerEpoch !== undefined) {
        const environment = environments.get(intent.environmentId);
        if (
          environment?.state !== "attached" ||
          environment.ownerEpoch !== ownerEpoch ||
          environment.attachedSessionIds.length !== 1 ||
          environment.attachedSessionIds[0] !== placement.sessionId
        ) {
          throw new CloudSessionTestOwnershipChangedError(
            "Cloud test attachment ownership changed",
          );
        }
      }
    };
    await writeIntent(placement, intent, { ...intent, binding }, assertCurrent);
  };
  const isLive = (placement: Placement, intent: Intent) => {
    if (
      !liveTest ||
      liveTest.closed ||
      liveTest.runtime !== runtime ||
      liveTest.operationId !== intent.operationId ||
      liveTest.identity.sessionId !== placement.sessionId ||
      liveTest.identity.sessionKey !== placement.sessionKey
    ) {
      return false;
    }
    return intent.binding.stage === "pending"
      ? placement.environmentId === null
      : matchingCloudSessionTestStage(placement, intent) !== undefined;
  };
  const recovery = createCloudSessionTestRecovery({ ...options, exactPlacement, isLive });
  return {
    ...recovery,
    close: () => {
      if (currentRuntime === runtime) {
        currentRuntime = undefined;
        if (liveTest) {
          liveTest.closed = true;
        }
        liveTest = undefined;
      }
    },
    idempotencyKey: (identity) => {
      const intent = readIntent(identity);
      if (
        intent &&
        (intent.binding.stage !== "pending" ||
          !liveTest ||
          liveTest.closed ||
          liveTest.runtime !== runtime ||
          liveTest.operationId !== intent.operationId ||
          liveTest.dispatchRequest !== identity)
      ) {
        throw new CloudSessionTestOwnershipChangedError(
          "Interrupted cloud test must finish cleanup before redispatch",
        );
      }
      return intent?.operationId;
    },
    beforeProvision: async (placement, authorize) => {
      if (placement.state !== "provisioning") {
        throw new Error("Cloud test binding requires provisioning placement");
      }
      // Record the exact CAS successors of this dispatch before allocation.
      // Attachment epochs are deliberately absent until attachment produces one.
      const syncingGeneration = nextGeneration(placement.generation);
      await bind(
        placement,
        {
          stage: "provisioning",
          generation: placement.generation,
          syncingGeneration,
          startingGeneration: nextGeneration(syncingGeneration),
        },
        authorize,
      );
    },
    beforeActivation: async (placement, ownerEpoch, authorize) => {
      await bind(
        placement,
        {
          stage: "activating",
          generation: placement.generation,
          activeGeneration: nextGeneration(placement.generation),
          ownerEpoch,
        },
        authorize,
        ownerEpoch,
      );
    },
  };
}

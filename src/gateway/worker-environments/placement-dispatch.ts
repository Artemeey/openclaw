import { getRuntimeConfig } from "../../config/config.js";
import { resolveNodeCommandAllowlist } from "../node-command-policy.js";
import type { CloudSessionTestPlacementLifecycle } from "./cloud-session-test-cleanup.js";
import { CloudSessionTestOwnershipChangedError } from "./cloud-session-test-record.js";
import { resolveDevicePlacementEligibility } from "./device-placement-eligibility.js";
import {
  createPlacementFailureActions,
  type WorkerActivationBarrier,
  type WorkerActiveDispatchPlacement,
  type WorkerDispatchEnvironmentService,
  type WorkerDispatchPlacement,
} from "./placement-dispatch-failure.js";
import type { PlacementRecoveryDeps } from "./placement-dispatch-pending-results.js";
import {
  createPlacementReclaimActions,
  type WorkerPlacementReclaimBarriers,
} from "./placement-dispatch-reclaim.js";
import { createPlacementRecoveryActions } from "./placement-dispatch-recovery.js";
import {
  createWorkerPlacementDispatchStartup,
  type WorkerDevicePlacementRequirementResolver,
  type WorkerNodePlacementAuthority,
  type WorkerPlacementRecoveryBarrier,
  type WorkerLocalDispatchBarrier,
} from "./placement-dispatch-startup.js";
import { createWorkerPlacementMoveAbandonment } from "./placement-move-abandon.js";
import {
  createWorkerPlacementMoveService,
  type WorkerPlacementMoveBarrier,
} from "./placement-move-service.js";
import type { WorkerPlacementRunnerAvailabilityReader } from "./placement-projector.js";
import type {
  WorkerPlacementDispatchRequest,
  WorkerPlacementAuthorization,
  WorkerPlacementMoveDestination,
  WorkerPlacementMoveRequest,
} from "./service-contract.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";

type WorkerPlacementDispatchOptions = WorkerPlacementReclaimBarriers &
  Pick<
    PlacementRecoveryDeps,
    | "placements"
    | "workspaceOperations"
    | "resolveWorkspacePath"
    | "reportWorkspaceResultConflict"
    | "reportWorkspaceResultRecoveryFailure"
    | "resolveWorkspaceResultConflict"
    | "prepareAcceptedWorkspacePublication"
    | "publishAcceptedWorkspace"
  > & {
    testLifecycle?: CloudSessionTestPlacementLifecycle;
    environments: WorkerDispatchEnvironmentService &
      Partial<Pick<WorkerEnvironmentService, "requiresNodeEnrollment">>;
    runnerAvailability: WorkerPlacementRunnerAvailabilityReader;
    runLocalBarrier: WorkerLocalDispatchBarrier;
    runRecoveryBarrier: WorkerPlacementRecoveryBarrier;
    runActivationBarrier: WorkerActivationBarrier;
    runMoveBarrier: WorkerPlacementMoveBarrier;
    resolveMoveDestination: (
      identity: Pick<WorkerPlacementMoveRequest, "sessionId" | "sessionKey" | "agentId">,
      target: WorkerPlacementMoveRequest["target"],
    ) => Promise<WorkerPlacementMoveDestination | undefined>;
    onActivated?: (request: WorkerPlacementDispatchRequest) => void;
    resolveGitAuthor?: (agentId: string) => { name?: string; email?: string } | undefined;
    resolveDevicePlacementRequirement?: WorkerDevicePlacementRequirementResolver;
    isCurrentNodePlacement?: WorkerNodePlacementAuthority;
  };

export function createWorkerPlacementDispatchService(options: WorkerPlacementDispatchOptions) {
  const { environments, placements } = options;
  const failure = createPlacementFailureActions({ environments, placements });
  let recoverPlacementMoves = async (): Promise<Set<string>> => new Set();

  const reportTransition = (
    observer: ((placement: WorkerDispatchPlacement) => void) | undefined,
    placement: WorkerDispatchPlacement,
  ): void => {
    try {
      observer?.(placement);
    } catch {
      // Reporting cannot overturn the durable placement transition.
    }
  };

  const startup = createWorkerPlacementDispatchStartup({
    placements,
    environments,
    failure,
    runRecoveryBarrier: options.runRecoveryBarrier,
    runActivationBarrier: options.runActivationBarrier,
    onActivated: options.onActivated,
    resolveGitAuthor: options.resolveGitAuthor,
    resolveDevicePlacementRequirement: options.resolveDevicePlacementRequirement,
    isCurrentNodePlacement: options.isCurrentNodePlacement,
    reportTransition,
    testLifecycle: options.testLifecycle,
  });

  const recovery = createPlacementRecoveryActions({
    environments,
    failure,
    placements,
    resolveWorkspacePath: options.resolveWorkspacePath,
    reportWorkspaceResultConflict: options.reportWorkspaceResultConflict,
    ...(options.reportWorkspaceResultRecoveryFailure
      ? { reportWorkspaceResultRecoveryFailure: options.reportWorkspaceResultRecoveryFailure }
      : {}),
    resolveWorkspaceResultConflict: options.resolveWorkspaceResultConflict,
    recoverPlacementMoves: () => recoverPlacementMoves(),
    workspaceOperations: options.workspaceOperations,
    recoverTestPlacement: async (placement) =>
      (await options.testLifecycle?.recover(placement, {
        retireClaim: async (claim, authorize) => {
          if (placement.state !== "active") {
            throw new Error("Interrupted test claim is not active");
          }
          await options.runRecoveryBarrier({
            ...placement,
            expectedGeneration: placement.generation,
            expectedState: "active",
            run: async () => {
              authorize();
              await placements.closeWorkerTurnToolState(claim);
              authorize();
              placements.releaseTurn(claim);
            },
          });
        },
        reclaim: (authorize, beforeDrain) => reclaim(placement, authorize, beforeDrain),
        teardown: async (authorize) => {
          if (
            !placement.environmentId ||
            (placement.state !== "provisioning" &&
              placement.state !== "syncing" &&
              placement.state !== "starting")
          ) {
            throw new Error("Interrupted test lost its dispatch stage");
          }
          await options.runRecoveryBarrier({
            ...placement,
            environmentId: placement.environmentId,
            expectedGeneration: placement.generation,
            expectedState: placement.state,
            run: async () => {
              authorize();
              const environment = environments.get(placement.environmentId!);
              await failure.teardownEnvironment({
                placement,
                environmentId: environment?.environmentId ?? null,
                ownerEpoch: environment?.ownerEpoch ?? null,
                primaryError: new Error("Interrupted cloud session test"),
                authorize,
              });
            },
          });
        },
      })) ?? false,
    ...(options.prepareAcceptedWorkspacePublication
      ? { prepareAcceptedWorkspacePublication: options.prepareAcceptedWorkspacePublication }
      : {}),
    ...(options.publishAcceptedWorkspace
      ? { publishAcceptedWorkspace: options.publishAcceptedWorkspace }
      : {}),
  });

  const dispatch = async (
    request: WorkerPlacementDispatchRequest,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
    authorize?: WorkerPlacementAuthorization,
  ): Promise<WorkerActiveDispatchPlacement> => {
    let placement: WorkerDispatchPlacement | undefined;
    const validateDevicePlacement = async () => {
      if (!request.deviceId) {
        return;
      }
      const eligibility = await resolveDevicePlacementEligibility({
        environmentService: environments,
        deviceId: request.deviceId,
        requirement: request.devicePlacement,
        config: getRuntimeConfig(),
      });
      if (!eligibility.ok) {
        throw new Error(eligibility.error);
      }
    };
    try {
      placement = await options.runLocalBarrier({
        sessionId: request.sessionId,
        sessionKey: request.sessionKey,
        agentId: request.agentId,
        executionMode: request.executionMode,
        authorize,
        startDispatch: () => {
          // The private test continuation is bound to the original request object,
          // not its copied idempotency key. Reject copies before changing placement.
          options.testLifecycle?.idempotencyKey(request);
          placement = placements.startDispatch({
            sessionId: request.sessionId,
            sessionKey: request.sessionKey,
            agentId: request.agentId,
            executionMode: request.executionMode,
          });
          reportTransition(onTransition, placement);
          return placement;
        },
      });
      if (
        !request.deviceId &&
        request.devicePlacement?.requiredNodeCommands.length &&
        environments.requiresNodeEnrollment?.(
          request.profileId,
          request.inheritedProfile?.providerId,
        )
      ) {
        const allowlist = resolveNodeCommandAllowlist(getRuntimeConfig());
        const deniedCommand = request.devicePlacement.requiredNodeCommands.find(
          (command) => !allowlist.has(command),
        );
        if (deniedCommand) {
          throw new Error(
            `cloud worker node command ${deniedCommand} is not enabled; add it to gateway.nodes.commands.allow and approve the command on the node`,
          );
        }
      }
      await validateDevicePlacement();
      const localPath = await options.resolveWorkspacePath(request);
      // Workspace preparation yields; fence the current paired node again before durable provision.
      await validateDevicePlacement();
      const idempotencyKey =
        options.testLifecycle?.idempotencyKey(request) ??
        request.idempotencyKey ??
        `session-dispatch:${request.sessionId}:${placement.generation}`;
      const expectedEnvironmentId = deriveEnvironmentIntent(idempotencyKey).environmentId;
      placement = placements.transition({
        sessionId: request.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: placement.generation,
        patch: { environmentId: expectedEnvironmentId },
      });
      reportTransition(onTransition, placement);
      // Cleanup binding is a control effect, unlike transition telemetry. A
      // failed write must prevent allocation, including after response loss.
      await options.testLifecycle?.beforeProvision(placement, authorize);
      authorize?.();
      const bound = placements.get(request.sessionId);
      if (
        bound?.state !== "provisioning" ||
        bound.generation !== placement.generation ||
        bound.environmentId !== expectedEnvironmentId
      ) {
        throw new CloudSessionTestOwnershipChangedError(
          "Worker placement changed before allocation",
        );
      }
      const environment = request.inheritedProfile
        ? await environments.createFromProfileSnapshot(
            {
              profileId: request.profileId,
              providerId: request.inheritedProfile.providerId,
              profileSnapshot: request.inheritedProfile.profileSnapshot,
            },
            idempotencyKey,
            request.machineClass,
            request.executionMode,
          )
        : await environments.create(
            request.profileId,
            idempotencyKey,
            request.machineClass,
            request.executionMode,
          );
      return await startup.continueProvisionedDispatch({
        request,
        placement,
        environment,
        expectedEnvironmentId,
        localPath,
        onTransition: (next) => {
          placement = next;
          onTransition?.(next);
        },
        authorize,
      });
    } catch (error) {
      if (error instanceof CloudSessionTestOwnershipChangedError) {
        throw error;
      }
      try {
        const current = placement ? placements.get(request.sessionId) : undefined;
        // Failure cleanup retires the operation that produced this placement,
        // never a successor that became authoritative during an awaited hook.
        if (
          current &&
          placement &&
          (current.generation !== placement.generation ||
            current.state !== placement.state ||
            current.environmentId !== placement.environmentId ||
            current.activeOwnerEpoch !== placement.activeOwnerEpoch)
        ) {
          throw new CloudSessionTestOwnershipChangedError("Worker dispatch cleanup owner changed");
        }
        if (current && current.state !== "local" && current.state !== "reclaimed") {
          if (current.state === "active") {
            await failure.failActive(current, error);
          } else {
            const currentEnvironment = current.environmentId
              ? environments.get(current.environmentId)
              : undefined;
            const ownedEnvironment =
              currentEnvironment?.environmentId === current.environmentId
                ? currentEnvironment
                : undefined;
            await failure.teardownEnvironment({
              placement: current,
              environmentId: ownedEnvironment?.environmentId ?? null,
              ownerEpoch: ownedEnvironment?.ownerEpoch ?? null,
              primaryError: error,
            });
          }
        }
      } finally {
        const finalPlacement = placements.get(request.sessionId);
        if (finalPlacement) {
          reportTransition(onTransition, finalPlacement);
        }
      }
      throw error;
    }
  };

  const { reclaim, reclaimOnce } = createPlacementReclaimActions({
    ...options,
    failure,
    reconcileActive: recovery.reconcileActive,
  });

  const abandonment = createWorkerPlacementMoveAbandonment(options);

  const moveService = createWorkerPlacementMoveService({
    placements,
    environments,
    runMoveBarrier: options.runMoveBarrier,
    dispatch,
    reclaimSource: reclaimOnce,
    validateAbandonSource: abandonment.validateAbandonSource,
    abandonSource: abandonment.abandonSource,
    resolveDestination: options.resolveMoveDestination,
  });
  recoverPlacementMoves = moveService.recoverAll;

  return {
    dispatch,
    forceDestroyEnvironment: abandonment.forceDestroyEnvironment,
    move: moveService.move,
    reclaim,
    reconcile: async (mode?: "startup") => {
      await recovery.reconcile(mode);
      await options.testLifecycle?.clearCompleted();
    },
    reconcileActive: async (environmentId?: string) => {
      await recovery.reconcileActive(environmentId);
      await options.testLifecycle?.clearCompleted();
    },
    resumeProvisioning: startup.resumeProvisioning,
  };
}

export type WorkerPlacementDispatchService = ReturnType<
  typeof createWorkerPlacementDispatchService
>;

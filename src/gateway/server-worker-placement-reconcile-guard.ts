import type { WorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";

export function installWorkerPlacementReconcileGuard(params: {
  placements: Pick<WorkerSessionPlacementStore, "list">;
  environments: Pick<WorkerEnvironmentService, "get" | "installReconcileEnvironmentGuard">;
  dispatch: Pick<WorkerPlacementDispatchService, "resumeProvisioning">;
  isStopping: () => boolean;
  deferReconciliation?: (
    placement: NonNullable<ReturnType<WorkerSessionPlacementStore["get"]>>,
  ) => boolean;
}) {
  return params.environments.installReconcileEnvironmentGuard(
    async (environmentId, reconcileEnvironmentCore) => {
      if (params.isStopping()) {
        return;
      }
      const references = params.placements
        .list()
        .filter((placement) => placement.environmentId === environmentId);
      if (references.length > 1) {
        throw new Error(`Worker environment ${environmentId} has multiple placement owners`);
      }
      const owner = references[0];
      if (owner?.state === "provisioning") {
        await params.dispatch.resumeProvisioning(owner, reconcileEnvironmentCore);
        return;
      }
      // Interrupted test placement recovery must read the recorded attachment
      // before provider reconciliation can refresh credentials or bootstrap it.
      if (owner && params.deferReconciliation?.(owner)) {
        return;
      }
      const environment = params.environments.get(environmentId);
      if (
        owner &&
        (environment?.state === "requested" ||
          environment?.state === "provisioning" ||
          environment?.state === "bootstrapping") &&
        (owner.state !== "failed" ||
          owner.turnClaim !== null ||
          owner.activeOwnerEpoch !== null ||
          environment.destroyRequestedAtMs === null)
      ) {
        throw new Error(`Worker environment ${environmentId} provisioning owner is ${owner.state}`);
      }
      await reconcileEnvironmentCore();
    },
  );
}

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { type PlacementStore, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("worker placement restart result recovery", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  beforeEach(async () => {
    root = tempDirs.make("openclaw-dispatch-restart-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("fails a same-instance draining result when restart precedes recovery handoff", async () => {
    const harness = createHarness(placementStore, { workspacePath: path.join(root, "workspace") });
    const active = harness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "restart-before-handoff-claim",
      runId: "restart-before-handoff-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    const draining = placementStore.startDrain({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    placementStore.markWorkspaceResultPending(claim);
    harness.markEnvironmentDestroyed();

    expect(draining.generation).toBe(claim.placementGeneration + 1);
    expect(placementStore.listPendingWorkspaceResults()).toMatchObject([
      {
        gatewayInstanceId: placementStore.workspaceResultInstanceId(),
        recoveryRequestedAtMs: null,
        stagedResultRef: null,
        workspaceAcceptedAtMs: null,
      },
    ]);

    await harness.service.reconcile("startup");

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: "cloud worker disappeared: environment state destroyed",
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(harness.log).toContain("placement:reconciling");
    expect(harness.log).toContain("placement:failed");
  });
});

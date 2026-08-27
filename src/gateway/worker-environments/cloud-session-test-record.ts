import { isDeepStrictEqual } from "node:util";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  hasCurrentCloudSessionTestCleanup,
  type InternalSessionEntry,
} from "../../config/sessions/types.js";
import type {
  WorkerSessionPlacementIdentity as Identity,
  WorkerSessionPlacementRecord as Placement,
} from "./placement-record.js";

export type CloudSessionTestIntent = NonNullable<InternalSessionEntry["cloudSessionTestCleanup"]>;
type Intent = CloudSessionTestIntent;

export class CloudSessionTestOwnershipChangedError extends Error {}

export function assertCloudSessionTestOwner(identity: Identity, operationId: string): void {
  if (readCloudSessionTestIntent(identity)?.operationId !== operationId) {
    throw new CloudSessionTestOwnershipChangedError("Cloud test cleanup ownership changed");
  }
}

export function cloudSessionTestOwner(entry: InternalSessionEntry): string {
  const owner = entry.owner?.actor ?? entry.createdActor;
  return JSON.stringify([entry.lifecycleRevision ?? null, owner?.type ?? null, owner?.id ?? null]);
}

export function readCloudSessionTestIntent(identity: Identity): Intent | undefined {
  const entry = loadSessionEntry({ ...identity, readConsistency: "latest" });
  const intent = entry?.cloudSessionTestCleanup;
  if (!entry || !intent) {
    return undefined;
  }
  if (
    entry.sessionId !== identity.sessionId ||
    intent.sessionId !== identity.sessionId ||
    intent.owner !== cloudSessionTestOwner(entry) ||
    !hasCurrentCloudSessionTestCleanup(entry)
  ) {
    throw new CloudSessionTestOwnershipChangedError(
      "Cloud test session ownership changed; cleanup remains pending",
    );
  }
  return intent;
}

export async function writeCloudSessionTestIntent(
  identity: Identity,
  expected: Intent | undefined,
  next: Intent | undefined,
  authorize?: () => void,
) {
  const retire =
    expected && !next
      ? (await import("../session-lifecycle-state.js")).retireCloudSessionTestLifecycle
      : undefined;
  authorize?.();
  const updated = await patchSessionEntryCore(
    identity,
    (entry) => {
      authorize?.();
      if (
        entry.sessionId !== identity.sessionId ||
        !isDeepStrictEqual(entry.cloudSessionTestCleanup, expected) ||
        (expected && expected.owner !== cloudSessionTestOwner(entry))
      ) {
        throw new CloudSessionTestOwnershipChangedError("Cloud test cleanup intent changed");
      }
      return {
        ...(retire ? retire(entry, identity.sessionKey) : {}),
        cloudSessionTestCleanup: next,
      };
    },
    { skipMaintenance: true, assertCommitAllowed: authorize },
  );
  if (!updated) {
    throw new CloudSessionTestOwnershipChangedError(
      "Cloud test session disappeared; cleanup remains pending",
    );
  }
  authorize?.();
}

export async function completeCloudSessionTestCleanup(
  identity: Identity,
  operationId: string,
  assertReleased: () => void,
): Promise<void> {
  const entry = loadSessionEntry({ ...identity, readConsistency: "latest" });
  if (entry?.sessionId !== identity.sessionId) {
    throw new CloudSessionTestOwnershipChangedError("Cloud test session identity changed");
  }
  const intent = readCloudSessionTestIntent(identity);
  assertReleased();
  // A lost clear response is idempotent, but never substitutes for lease proof.
  if (!intent) {
    return;
  }
  if (intent.operationId !== operationId) {
    throw new CloudSessionTestOwnershipChangedError("Cloud test cleanup intent changed");
  }
  await writeCloudSessionTestIntent(identity, intent, undefined, assertReleased);
}

/** Matches recorded dispatch stages only; the caller still owns live/session/lease fencing. */
export function matchingCloudSessionTestStage(
  placement: Placement,
  intent: Intent,
): "provisioning" | "active" | undefined {
  if (placement.environmentId !== intent.environmentId) {
    return undefined;
  }
  const binding = intent.binding;
  if (
    (binding.stage === "provisioning" &&
      ((placement.state === "provisioning" && binding.generation === placement.generation) ||
        (placement.state === "syncing" && binding.syncingGeneration === placement.generation) ||
        (placement.state === "starting" && binding.startingGeneration === placement.generation))) ||
    (binding.stage === "activating" &&
      placement.state === "starting" &&
      binding.generation === placement.generation)
  ) {
    return "provisioning";
  }
  if (
    placement.state === "active" &&
    ((binding.stage === "active" &&
      binding.generation === placement.generation &&
      binding.ownerEpoch === placement.activeOwnerEpoch) ||
      (binding.stage === "activating" &&
        binding.activeGeneration === placement.generation &&
        binding.ownerEpoch === placement.activeOwnerEpoch))
  ) {
    return "active";
  }
  return undefined;
}

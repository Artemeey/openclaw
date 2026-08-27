import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "../infra/crypto-digest.js";
import type { PendingBridgeRequest } from "./code-mode-worker-types.js";

const repairableFailureDetails = new WeakSet<object>();
const uncertainMutationKeysByDetails = new WeakMap<object, readonly string[]>();

export type CodeModeReconciliationReplayFence = {
  code: string;
  mutationKeys: readonly string[];
};

/** Identify the bridged operation independently of its guest JavaScript source. */
export function codeModeMutationReplayKey(request: PendingBridgeRequest): string {
  const args =
    request.method === "callValue" ? [request.args[0], request.args[1] ?? {}] : request.args;
  return `${request.method}:${sha256Hex(stableStringify(args))}`;
}

/** Attach host-only repair authority to one finalized Code Mode failure payload. */
export function registerRepairableCodeModeFailure(details: object): void {
  repairableFailureDetails.add(details);
}

/** Consume repair authority from the exact host-created failure payload. */
export function consumeRepairableCodeModeFailure(details: unknown): boolean {
  return (
    typeof details === "object" && details !== null && repairableFailureDetails.delete(details)
  );
}

/** Attach the bounded set of bridged mutations whose outcomes may be uncertain. */
export function registerUncertainCodeModeMutations(
  details: object,
  mutationKeys: readonly string[],
): void {
  uncertainMutationKeysByDetails.set(details, [...mutationKeys]);
}

/** Consume host-only mutation identities from the exact finalized failure payload. */
export function consumeUncertainCodeModeMutations(details: unknown): readonly string[] | undefined {
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  const mutationKeys = uncertainMutationKeysByDetails.get(details);
  uncertainMutationKeysByDetails.delete(details);
  return mutationKeys;
}

/** Preserve host-only failure provenance when timeout normalization clones a result. */
export function copyCodeModeFailureProvenance(source: object, target: object): void {
  if (repairableFailureDetails.has(source)) {
    repairableFailureDetails.add(target);
  }
  const mutationKeys = uncertainMutationKeysByDetails.get(source);
  if (mutationKeys) {
    uncertainMutationKeysByDetails.set(target, mutationKeys);
  }
}

import type { ReleasePlanLock } from "./release-plan-contract.mjs";
import type {
  ReleaseValidationIntent,
  ReleaseValidationProfile,
  ReleaseValidationPurpose,
} from "./release-validation-intent.mjs";

declare const verifiedArtifactEvidenceBrand: unique symbol;
declare const verifiedReceiptBrand: unique symbol;

export type ReleaseValidationReceiptDigest = `sha256:${string}`;
export type ReleaseValidationRunConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "stale"
  | "startup_failure"
  | "success"
  | "timed_out";
export type ReleaseValidationJobStatus = "completed" | "in_progress" | "queued";

export type ReleaseValidationExecutionGroup = {
  id: string;
  mode: "blocking" | "diagnostic";
  policy: string;
  workflow_path: string;
  run_id: string;
  run_attempt: number;
  workflow_sha: string;
  url: string;
};

export type ReleaseValidationExecutionPlanSource = {
  schema: "openclaw.full-release-execution-plan.v1";
  parent_run_id: string;
  parent_run_attempt: number;
  workflow_ref: string;
  workflow_sha: string;
  target_sha: string;
  release_profile: string;
  rerun_group: string;
  fail_fast: boolean;
  started_at: string;
  groups: ReleaseValidationExecutionGroup[];
};

export type ReleaseValidationStateJob = {
  name: string;
  policy: "advisory" | "blocking";
  status: ReleaseValidationJobStatus;
  conclusion: ReleaseValidationRunConclusion | null;
  started_at: string | null;
  completed_at: string | null;
  url: string;
};

export type ReleaseValidationStateGroup = {
  id: string;
  run_id: string;
  run_attempt: number;
  status: ReleaseValidationJobStatus;
  conclusion: ReleaseValidationRunConclusion | null;
  completed_at: string | null;
  url: string;
  jobs: ReleaseValidationStateJob[];
};

export type ReleaseValidationStateSource = {
  schema: "openclaw.full-release-decision.v2" | "openclaw.full-release-diagnostic-drain.v2";
  parent_run_id: string;
  parent_run_attempt: number;
  source_parent_run_attempt: number;
  workflow_ref: string;
  workflow_sha: string;
  target_sha: string;
  execution_plan_digest: ReleaseValidationReceiptDigest;
  observed_at: string;
  groups: ReleaseValidationStateGroup[];
};

export type ReleaseValidationSourceArtifact = {
  kind: "decision" | "diagnostic-drain" | "execution-plan" | "release-plan-lock";
  artifact_id: string;
  artifact_name: string;
  entry_name: string;
  run_id: string;
  run_attempt: number;
  archive_digest: ReleaseValidationReceiptDigest;
  content_digest: ReleaseValidationReceiptDigest;
  created_at: string;
  expires_at: string;
  url: string;
};

export type ReleaseValidationArtifactEvidence = Readonly<
  ReleaseValidationSourceArtifact & { entry_bytes: string }
>;

export type ReleaseValidationVerifiedArtifactEvidence = ReleaseValidationArtifactEvidence & {
  readonly [verifiedArtifactEvidenceBrand]: true;
};

export type ReleaseValidationSourceAttempt = {
  schema: string;
  digest: ReleaseValidationReceiptDigest;
  parent_run_attempt: number;
  source_parent_run_attempt?: number;
};

export type ReleaseValidationReceipt = {
  schema: "openclaw.release-validation-receipt.v1";
  canonicalization: "ascii-sorted-compact-json-trailing-newline-v1";
  target: {
    repository: "openclaw/openclaw";
    ref: string;
    sha: string;
  };
  tooling: {
    repository: "openclaw/openclaw";
    workflow_path: ".github/workflows/full-release-validation.yml";
    ref: string;
    sha: string;
  };
  attempt: {
    workflow_name: "Full Release Validation";
    run_id: string;
    run_attempt: number;
    url: string;
  };
  release_plan: {
    schema: "openclaw.release-plan.v1";
    purpose: ReleaseValidationPurpose;
    plan_digest: ReleaseValidationReceiptDigest;
    lock_digest: ReleaseValidationReceiptDigest;
  };
  validation: {
    intent: ReleaseValidationIntent;
    profile: ReleaseValidationProfile;
    soak: boolean;
    allowed_groups: string[];
    rerun_group: string;
    policy: {
      id: "openclaw.release-validation-policy.v1";
      fail_fast: boolean;
    };
  };
  source_attempts: {
    execution_plan: ReleaseValidationSourceAttempt;
    decision: Required<ReleaseValidationSourceAttempt>;
    diagnostic_drain: Required<ReleaseValidationSourceAttempt>;
  };
  groups: Array<
    ReleaseValidationExecutionGroup & {
      conclusion: ReleaseValidationRunConclusion;
      completed_at: string;
      jobs: Array<
        ReleaseValidationStateJob & {
          status: "completed";
          conclusion: ReleaseValidationRunConclusion;
          completed_at: string;
        }
      >;
    }
  >;
  source_artifacts: ReleaseValidationSourceArtifact[];
  timestamps: {
    started_at: string;
    decision_at: string;
    drain_completed_at: string;
    sealed_at: string;
  };
  lineage: {
    generation: number;
    root_receipt_digest: ReleaseValidationReceiptDigest | null;
    parent_receipt_digest: ReleaseValidationReceiptDigest | null;
  };
};

export type ReleaseValidationVerifiedReceipt = ReleaseValidationReceipt & {
  readonly [verifiedReceiptBrand]: true;
};

export type ReleaseValidationReceiptSealInput = {
  releasePlanLock: ReleasePlanLock;
  executionPlan: ReleaseValidationExecutionPlanSource;
  decision: ReleaseValidationStateSource;
  diagnosticDrain: ReleaseValidationStateSource;
  sourceArtifacts: ReleaseValidationVerifiedArtifactEvidence[];
  sealedAt: string;
  parentReceipt?: ReleaseValidationVerifiedReceipt;
  rootReceipt?: ReleaseValidationVerifiedReceipt;
};

export type ReleaseValidationReceiptLocator = {
  schema: "openclaw.release-validation-receipt-locator.v1";
  canonicalization: "ascii-sorted-compact-json-trailing-newline-v1";
  receipt_digest: ReleaseValidationReceiptDigest;
  locator: {
    repository: "openclaw/openclaw";
    run_id: string;
    run_attempt: number;
    artifact_id: string;
    artifact_name: string;
    entry_name: "release-validation-receipt.json";
    archive_digest: ReleaseValidationReceiptDigest;
    url: string;
  };
  sealed_at: string;
};

export function validateReleaseValidationExecutionPlanSource(
  value: unknown,
): ReleaseValidationExecutionPlanSource;
export function validateReleaseValidationStateSource(
  value: unknown,
  mode: "decision" | "diagnostic-drain",
): ReleaseValidationStateSource;
export function sealReleaseValidationReceipt(
  input: ReleaseValidationReceiptSealInput,
): ReleaseValidationVerifiedReceipt;
export function validateReleaseValidationReceipt(value: unknown): ReleaseValidationReceipt;
export function verifyReleaseValidationReceiptLineage(
  receiptValue: unknown,
  lineage?: {
    parentReceipt?: ReleaseValidationVerifiedReceipt;
    rootReceipt?: ReleaseValidationVerifiedReceipt;
  },
): ReleaseValidationReceipt["lineage"];
export function verifyReleaseValidationReceipt(
  receiptValue: unknown,
  input: ReleaseValidationReceiptSealInput,
): ReleaseValidationVerifiedReceipt;
export function validateReleaseValidationReceiptReuseFreshness(
  receiptValue: ReleaseValidationVerifiedReceipt,
  options: {
    now_ms: number;
    max_future_skew_ms: number;
  },
): {
  intent: ReleaseValidationIntent;
  age_ms: number;
  max_age_ms: number;
  cadence_ms: number;
  expires_at_ms: number;
};
export function canonicalReleaseValidationReceiptJson(value: unknown): string;
export function releaseValidationReceiptDigest(value: unknown): ReleaseValidationReceiptDigest;
export function parseReleaseValidationReceiptJson(text: string): ReleaseValidationReceipt;
export function createReleaseValidationReceiptLocator(
  receiptValue: unknown,
  locatorValue: unknown,
): ReleaseValidationReceiptLocator;
export function validateReleaseValidationReceiptLocatorForReceipt(
  locatorValue: unknown,
  receiptValue: unknown,
): ReleaseValidationReceiptLocator;
export function canonicalReleaseValidationReceiptLocatorJson(value: unknown): string;
export function parseReleaseValidationReceiptLocatorJson(
  text: string,
): ReleaseValidationReceiptLocator;

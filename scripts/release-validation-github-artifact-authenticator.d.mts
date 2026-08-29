import type {
  ReleaseValidationArtifactEvidence,
  ReleaseValidationSourceArtifact,
  ReleaseValidationVerifiedArtifactEvidence,
} from "./release-validation-receipt-contract.mjs";

export type GitHubReleaseValidationArtifactEvidence = ReleaseValidationSourceArtifact & {
  entry_bytes: string;
};

export type GitHubReleaseValidationArtifactExpected = {
  repository: string;
  workflowPath: string;
  workflowSha: string;
};

export function validateReleaseValidationArtifactEvidence(
  value: unknown,
): ReleaseValidationArtifactEvidence;
export function isAuthenticatedGitHubReleaseValidationArtifactEvidence(
  value: unknown,
): value is ReleaseValidationVerifiedArtifactEvidence;

export function downloadAndAuthenticateGitHubReleaseValidationArtifact(params: {
  evidence: GitHubReleaseValidationArtifactEvidence;
  expected: GitHubReleaseValidationArtifactExpected & {
    artifactSizeBytes: number;
    runStatePolicy: "completed-success" | "same-run-producer-success";
    workflowEvent: string;
    workflowHeadBranch: string;
    consumerRunAttempt?: number;
    producerJobName?: string;
  };
  token: string;
  nowMs: number;
  timeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
}): Promise<ReleaseValidationVerifiedArtifactEvidence>;

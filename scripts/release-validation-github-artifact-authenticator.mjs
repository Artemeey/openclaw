import {
  downloadActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
  sha256Digest,
} from "./lib/actions-artifact-archive.mjs";
import { canonicalAsciiJson } from "./lib/canonical-json.mjs";
import { isRecord } from "./lib/record-shared.mjs";

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024;
const REPOSITORY = "openclaw/openclaw";
const WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ASCII_PATTERN = /^[\x20-\x7e]+$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/u;
// Receipt sealing can inspect membership, but only this GitHub-backed path can add it.
const authenticatedArtifactEvidence = new WeakSet();
const compareAscii = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function fail(message) {
  throw new Error(message);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).toSorted(compareAscii);
  const expected = [...keys].toSorted(compareAscii);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} keys must be exactly: ${expected.join(", ")}`);
  }
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function ascii(value, label) {
  const text = string(value, label);
  if (!ASCII_PATTERN.test(text)) {
    fail(`${label} must be printable ASCII`);
  }
  return text;
}

function digest(value, label) {
  const text = ascii(value, label);
  if (!DIGEST_PATTERN.test(text)) {
    fail(`${label} must be sha256:<64 lowercase hex characters>`);
  }
  return text;
}

function runId(value, label) {
  const text = ascii(value, label);
  if (!RUN_ID_PATTERN.test(text)) {
    fail(`${label} must be a positive decimal run ID`);
  }
  return text;
}

function repositoryName(value, label) {
  if (!isRecord(value) || typeof value.full_name !== "string") {
    fail(`${label} must include full_name`);
  }
  return value.full_name;
}

function timestamp(value, label) {
  const text = string(value, label);
  parseGitHubTimestampMillis(text, label);
  return text;
}

function parseGitHubTimestampMillis(value, label) {
  const text = string(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    fail(`${label} must be a valid timestamp`);
  }
  return milliseconds;
}

function artifactUrl(value, run, artifact, label) {
  const url = ascii(value, label);
  if (url !== `https://github.com/${REPOSITORY}/actions/runs/${run}/artifacts/${artifact}`) {
    fail(`${label} must identify the exact GitHub Actions artifact`);
  }
  return url;
}

export function validateReleaseValidationArtifactEvidence(value) {
  const label = "release validation artifact evidence";
  if (!isRecord(value)) {
    fail(`${label} must be an object`);
  }
  exactKeys(
    value,
    [
      "kind",
      "artifact_id",
      "artifact_name",
      "entry_name",
      "run_id",
      "run_attempt",
      "archive_digest",
      "content_digest",
      "created_at",
      "expires_at",
      "url",
      "entry_bytes",
    ],
    label,
  );
  const artifactId = runId(value.artifact_id, `${label}.artifact_id`);
  const parentRunId = runId(value.run_id, `${label}.run_id`);
  if (
    typeof value.entry_bytes !== "string" ||
    Buffer.byteLength(value.entry_bytes, "utf8") > MAX_ENTRY_BYTES ||
    !/^[\x20-\x7e]+\n$/u.test(value.entry_bytes)
  ) {
    fail(`${label}.entry_bytes must be compact printable ASCII canonical JSON`);
  }
  let parsedEntry;
  try {
    parsedEntry = JSON.parse(value.entry_bytes);
  } catch (error) {
    throw new Error(`${label}.entry_bytes is invalid JSON`, { cause: error });
  }
  if (value.entry_bytes !== canonicalAsciiJson(parsedEntry)) {
    fail(`${label}.entry_bytes does not use canonical bytes`);
  }
  const result = Object.freeze({
    kind: ascii(value.kind, `${label}.kind`),
    artifact_id: artifactId,
    artifact_name: ascii(value.artifact_name, `${label}.artifact_name`),
    entry_name: ascii(value.entry_name, `${label}.entry_name`),
    run_id: parentRunId,
    run_attempt: positiveInteger(value.run_attempt, `${label}.run_attempt`),
    archive_digest: digest(value.archive_digest, `${label}.archive_digest`),
    content_digest: digest(value.content_digest, `${label}.content_digest`),
    created_at: timestamp(value.created_at, `${label}.created_at`),
    expires_at: timestamp(value.expires_at, `${label}.expires_at`),
    url: artifactUrl(value.url, parentRunId, artifactId, `${label}.url`),
    entry_bytes: value.entry_bytes,
  });
  if (result.content_digest !== sha256Digest(Buffer.from(result.entry_bytes, "ascii"))) {
    fail(`${label}.content_digest differs from the exact canonical entry bytes`);
  }
  return result;
}

export function isAuthenticatedGitHubReleaseValidationArtifactEvidence(value) {
  return isRecord(value) && authenticatedArtifactEvidence.has(value);
}

function authenticateGitHubReleaseValidationArtifact(params) {
  if (!isRecord(params)) {
    fail("GitHub release validation artifact authentication parameters are required");
  }
  const evidence = validateReleaseValidationArtifactEvidence(params.evidence);
  const expected = params.expected;
  const artifact = params.artifactMetadata;
  const run = params.workflowRun;
  if (!isRecord(evidence) || !isRecord(expected) || !isRecord(artifact) || !isRecord(run)) {
    fail("GitHub release validation artifact metadata is incomplete");
  }
  if (!(params.archiveBytes instanceof Uint8Array)) {
    fail("GitHub release validation artifact archiveBytes must be a Uint8Array");
  }
  const archiveBytes = Buffer.from(
    params.archiveBytes.buffer,
    params.archiveBytes.byteOffset,
    params.archiveBytes.byteLength,
  );
  const nowMs = nonNegativeInteger(params.nowMs, "GitHub artifact authentication nowMs");
  const repository = string(expected.repository, "GitHub artifact expected repository");
  const workflowPath = string(expected.workflowPath, "GitHub artifact expected workflow path");
  const workflowSha = string(expected.workflowSha, "GitHub artifact expected workflow SHA");
  if (
    repository !== REPOSITORY ||
    workflowPath !== WORKFLOW_PATH ||
    !SHA_PATTERN.test(workflowSha)
  ) {
    fail("GitHub artifact expected repository or workflow authority is unsupported");
  }
  const artifactId = positiveInteger(
    Number(evidence.artifact_id),
    "GitHub artifact evidence artifact_id",
  );
  const runNumber = positiveInteger(Number(evidence.run_id), "GitHub artifact evidence run_id");
  const runAttempt = positiveInteger(evidence.run_attempt, "GitHub artifact evidence run_attempt");
  const createdAtMs = parseGitHubTimestampMillis(
    evidence.created_at,
    "GitHub artifact evidence created_at",
  );
  const expiresAtMs = parseGitHubTimestampMillis(
    evidence.expires_at,
    "GitHub artifact evidence expires_at",
  );
  if (
    artifact.id !== artifactId ||
    artifact.name !== evidence.artifact_name ||
    artifact.digest !== evidence.archive_digest ||
    artifact.created_at !== evidence.created_at ||
    artifact.expires_at !== evidence.expires_at ||
    artifact.expired !== false ||
    artifact.size_in_bytes !== archiveBytes.byteLength ||
    !isRecord(artifact.workflow_run) ||
    artifact.workflow_run.id !== runNumber ||
    artifact.workflow_run.head_sha !== workflowSha
  ) {
    fail("GitHub artifact metadata differs from the authenticated evidence tuple");
  }
  if (
    run.id !== runNumber ||
    run.run_attempt !== runAttempt ||
    run.path !== workflowPath ||
    run.head_sha !== workflowSha ||
    repositoryName(run.repository, "GitHub workflow repository") !== repository ||
    repositoryName(run.head_repository, "GitHub workflow head repository") !== repository
  ) {
    fail("GitHub workflow metadata differs from the authenticated evidence tuple");
  }
  if (createdAtMs > nowMs || createdAtMs >= expiresAtMs || expiresAtMs <= nowMs) {
    fail("GitHub artifact is expired or has invalid creation/expiry timestamps");
  }
  if (sha256Digest(archiveBytes) !== evidence.archive_digest) {
    fail("downloaded GitHub artifact archive digest differs from metadata");
  }
  const files = inspectActionsArtifactZipWithPolicy(archiveBytes, {
    expectedEntries: [evidence.entry_name],
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
    maxExpandedBytes: MAX_ENTRY_BYTES,
    maxEntryBytes: () => MAX_ENTRY_BYTES,
  });
  const entryBytes = files.get(evidence.entry_name);
  if (
    !entryBytes ||
    typeof evidence.entry_bytes !== "string" ||
    !entryBytes.equals(Buffer.from(evidence.entry_bytes, "ascii"))
  ) {
    fail("GitHub artifact entry bytes differ from the authenticated evidence");
  }
  authenticatedArtifactEvidence.add(evidence);
  return evidence;
}

export async function downloadAndAuthenticateGitHubReleaseValidationArtifact(params) {
  if (!isRecord(params) || !isRecord(params.evidence) || !isRecord(params.expected)) {
    fail("GitHub release validation artifact download parameters are required");
  }
  const evidence = params.evidence;
  const expected = params.expected;
  const downloaded = await downloadActionsArtifactArchive({
    expected: {
      artifactDigest: evidence.archive_digest,
      artifactId: Number(evidence.artifact_id),
      artifactName: evidence.artifact_name,
      artifactSizeBytes: expected.artifactSizeBytes,
      repository: expected.repository,
      runStatePolicy: expected.runStatePolicy,
      runAttempt: evidence.run_attempt,
      runId: Number(evidence.run_id),
      workflowEvent: expected.workflowEvent,
      workflowHeadBranch: expected.workflowHeadBranch,
      workflowPath: expected.workflowPath,
      workflowSha: expected.workflowSha,
      ...(expected.consumerRunAttempt === undefined
        ? {}
        : { consumerRunAttempt: expected.consumerRunAttempt }),
      ...(expected.producerJobName === undefined
        ? {}
        : { producerJobName: expected.producerJobName }),
    },
    token: params.token,
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
    ...(params.retryAttempts === undefined ? {} : { retryAttempts: params.retryAttempts }),
    ...(params.retryDelayMs === undefined ? {} : { retryDelayMs: params.retryDelayMs }),
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
  });
  return authenticateGitHubReleaseValidationArtifact({
    evidence,
    expected,
    artifactMetadata: downloaded.artifactMetadata,
    workflowRun: downloaded.workflowRun,
    archiveBytes: downloaded.archiveBytes,
    nowMs: params.nowMs,
  });
}

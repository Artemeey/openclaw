import { createHash } from "node:crypto";
import { canonicalAsciiJson } from "./lib/canonical-json.mjs";
import { isRecord } from "./lib/record-shared.mjs";
import {
  RELEASE_PLAN_CANONICALIZATION,
  canonicalReleasePlanJson,
  canonicalReleasePlanLockJson,
} from "./release-plan-contract.mjs";
import { isAuthenticatedGitHubReleaseValidationArtifactEvidence } from "./release-validation-github-artifact-authenticator.mjs";
import {
  releaseValidationIntentForPurpose,
  resolveReleaseValidationIntent,
} from "./release-validation-intent.mjs";

const RELEASE_VALIDATION_RECEIPT_SCHEMA = "openclaw.release-validation-receipt.v1";
const RELEASE_VALIDATION_RECEIPT_LOCATOR_SCHEMA = "openclaw.release-validation-receipt-locator.v1";
const RELEASE_VALIDATION_POLICY_ID = "openclaw.release-validation-policy.v1";
const RELEASE_VALIDATION_RECEIPT_MAX_BYTES = 256 * 1024;
const RELEASE_VALIDATION_RECEIPT_LOCATOR_MAX_BYTES = 16 * 1024;
const RELEASE_VALIDATION_REUSE_POLICIES = Object.freeze({
  "release-beta": Object.freeze({
    max_age_ms: 6 * 60 * 60 * 1000,
    cadence_ms: 6 * 60 * 60 * 1000,
  }),
  "release-stable": Object.freeze({
    max_age_ms: 6 * 60 * 60 * 1000,
    cadence_ms: 6 * 60 * 60 * 1000,
  }),
  "main-daily": Object.freeze({
    max_age_ms: 24 * 60 * 60 * 1000,
    cadence_ms: 24 * 60 * 60 * 1000,
  }),
  "main-weekly": Object.freeze({
    max_age_ms: 7 * 24 * 60 * 60 * 1000,
    cadence_ms: 7 * 24 * 60 * 60 * 1000,
  }),
  "diagnostic-full": Object.freeze({
    max_age_ms: 7 * 24 * 60 * 60 * 1000,
    cadence_ms: 7 * 24 * 60 * 60 * 1000,
  }),
});

const REPOSITORY = "openclaw/openclaw";
const WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const WORKFLOW_NAME = "Full Release Validation";
const EXECUTION_PLAN_SCHEMA = "openclaw.full-release-execution-plan.v1";
const DECISION_SCHEMA = "openclaw.full-release-decision.v2";
const DRAIN_SCHEMA = "openclaw.full-release-diagnostic-drain.v2";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ASCII_PATTERN = /^[\x20-\x7e]+$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/u;
const REF_PATTERN = /^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u;
const TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const GROUP_MODES = new Set(["blocking", "diagnostic"]);
const JOB_POLICIES = new Set(["advisory", "blocking"]);
const RUN_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);
const JOB_STATUSES = new Set(["completed", "in_progress", "queued"]);
const REQUIRED_ARTIFACTS = Object.freeze({
  decision: { entry: "full-release-decision.json" },
  "diagnostic-drain": { entry: "full-release-diagnostic-manifest.json" },
  "execution-plan": { entry: "full-release-execution-plan.json" },
  "release-plan-lock": { entry: "release-plan-lock.json" },
});
const verifiedReceipts = new WeakMap();
const compareAscii = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function fail(message) {
  throw new Error(message);
}

function object(value, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object`);
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

function ascii(value, label) {
  if (typeof value !== "string" || !ASCII_PATTERN.test(value)) {
    fail(`${label} must be a non-empty printable ASCII string`);
  }
  return value;
}

function enumValue(value, allowed, label) {
  const result = ascii(value, label);
  if (!allowed.has(result)) {
    fail(`${label} contains unsupported value: ${result}`);
  }
  return result;
}

function sha(value, label) {
  const result = ascii(value, label);
  if (!SHA_PATTERN.test(result)) {
    fail(`${label} must be a lowercase 40-character commit SHA`);
  }
  return result;
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail(`${label} must be sha256:<64 lowercase hex characters>`);
  }
  return value;
}

function exactBytesDigest(value) {
  return `sha256:${createHash("sha256").update(value, "ascii").digest("hex")}`;
}

function canonicalReleaseJson(value) {
  return canonicalAsciiJson(value);
}

function releaseCanonicalDigest(value) {
  return exactBytesDigest(canonicalReleaseJson(value));
}

function releasePlanDigest(value) {
  return exactBytesDigest(canonicalReleasePlanJson(value));
}

function validateReleasePlanLock(value) {
  return JSON.parse(canonicalReleasePlanLockJson(value));
}

function parseCanonicalReleaseJson(
  text,
  { label = "release JSON", maxBytes = RELEASE_VALIDATION_RECEIPT_MAX_BYTES, validate } = {},
) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maxBytes) {
    fail(`${label} is missing or too large`);
  }
  if (!/^[\x20-\x7e]+\n$/u.test(text)) {
    fail(`${label} must be compact printable ASCII with exactly one trailing LF`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is invalid JSON`, { cause: error });
  }
  const result = validate === undefined ? value : validate(value);
  if (text !== canonicalReleaseJson(result)) {
    fail(`${label} does not use canonical bytes`);
  }
  return result;
}

function runId(value, label) {
  const result = ascii(value, label);
  if (!RUN_ID_PATTERN.test(result)) {
    fail(`${label} must be a positive integer string`);
  }
  return result;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} must be boolean`);
  }
  return value;
}

function timestamp(value, label) {
  const result = ascii(value, label);
  const milliseconds = Date.parse(result);
  if (
    !TIMESTAMP_PATTERN.test(result) ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().replace(".000Z", "Z") !== result
  ) {
    fail(`${label} must be a valid canonical UTC timestamp`);
  }
  return result;
}

function nullableTimestamp(value, label) {
  return value === null ? null : timestamp(value, label);
}

function qualifiedRef(value, label) {
  const result = ascii(value, label);
  if (!REF_PATTERN.test(result)) {
    fail(`${label} must be a qualified branch or tag ref`);
  }
  return result;
}

function targetRef(value, targetSha, label) {
  const result = ascii(value, label);
  if (result !== targetSha && !REF_PATTERN.test(result)) {
    fail(`${label} must be the target SHA or a qualified branch or tag ref`);
  }
  return result;
}

function exactRunUrl(value, id, label) {
  const expected = `https://github.com/${REPOSITORY}/actions/runs/${id}`;
  if (value !== expected) {
    fail(`${label} must equal ${expected}`);
  }
  return expected;
}

function exactJobUrl(value, parentRunId, label) {
  const pattern = new RegExp(
    `^https://github\\.com/${REPOSITORY}/actions/runs/${parentRunId}/job/([1-9][0-9]*)$`,
    "u",
  );
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} must be an exact job URL for run ${parentRunId}`);
  }
  return value;
}

function exactArtifactUrl(value, parentRunId, artifactId, label) {
  const expected = `https://github.com/${REPOSITORY}/actions/runs/${parentRunId}/artifacts/${artifactId}`;
  if (value !== expected) {
    fail(`${label} must equal ${expected}`);
  }
  return expected;
}

function sortedUnique(values, label, identity) {
  const identities = values.map(identity);
  if (
    new Set(identities).size !== identities.length ||
    identities.some((entry, index) => index > 0 && compareAscii(identities[index - 1], entry) >= 0)
  ) {
    fail(`${label} must be unique in ascending ASCII order`);
  }
  return values;
}

function validateExecutionGroup(value, index, toolingSha) {
  const label = `release validation execution plan groups[${index}]`;
  const group = object(value, label);
  exactKeys(
    group,
    ["id", "mode", "policy", "workflow_path", "run_id", "run_attempt", "workflow_sha", "url"],
    label,
  );
  const result = {
    id: ascii(group.id, `${label}.id`),
    mode: enumValue(group.mode, GROUP_MODES, `${label}.mode`),
    policy: ascii(group.policy, `${label}.policy`),
    workflow_path: ascii(group.workflow_path, `${label}.workflow_path`),
    run_id: runId(group.run_id, `${label}.run_id`),
    run_attempt: positiveInteger(group.run_attempt, `${label}.run_attempt`),
    workflow_sha: sha(group.workflow_sha, `${label}.workflow_sha`),
    url: "",
  };
  result.url = exactRunUrl(group.url, result.run_id, `${label}.url`);
  if (result.workflow_sha !== toolingSha) {
    fail(`${label}.workflow_sha differs from the execution plan tooling`);
  }
  return result;
}

export function validateReleaseValidationExecutionPlanSource(value) {
  const label = "release validation execution plan source";
  const source = object(value, label);
  exactKeys(
    source,
    [
      "schema",
      "parent_run_id",
      "parent_run_attempt",
      "workflow_ref",
      "workflow_sha",
      "target_sha",
      "release_profile",
      "rerun_group",
      "fail_fast",
      "started_at",
      "groups",
    ],
    label,
  );
  if (source.schema !== EXECUTION_PLAN_SCHEMA) {
    fail(`release validation execution plan source schema must be ${EXECUTION_PLAN_SCHEMA}`);
  }
  const workflowSha = sha(source.workflow_sha, `${label}.workflow_sha`);
  if (!Array.isArray(source.groups) || source.groups.length === 0) {
    fail(`${label}.groups must be a non-empty array`);
  }
  const groups = sortedUnique(
    source.groups.map((group, index) => validateExecutionGroup(group, index, workflowSha)),
    `${label}.groups`,
    (group) => group.id,
  );
  if (!groups.some((group) => group.mode === "blocking")) {
    fail(`${label}.groups must contain a blocking group`);
  }
  return {
    schema: EXECUTION_PLAN_SCHEMA,
    parent_run_id: runId(source.parent_run_id, `${label}.parent_run_id`),
    parent_run_attempt: positiveInteger(source.parent_run_attempt, `${label}.parent_run_attempt`),
    workflow_ref: qualifiedRef(source.workflow_ref, `${label}.workflow_ref`),
    workflow_sha: workflowSha,
    target_sha: sha(source.target_sha, `${label}.target_sha`),
    release_profile: ascii(source.release_profile, `${label}.release_profile`),
    rerun_group: ascii(source.rerun_group, `${label}.rerun_group`),
    fail_fast: booleanValue(source.fail_fast, `${label}.fail_fast`),
    started_at: timestamp(source.started_at, `${label}.started_at`),
    groups,
  };
}

function validateStateJob(value, stateLabel, groupId, parentRunId, index) {
  const label = `${stateLabel} groups.${groupId}.jobs[${index}]`;
  const job = object(value, label);
  exactKeys(
    job,
    ["name", "policy", "status", "conclusion", "started_at", "completed_at", "url"],
    label,
  );
  const result = {
    name: ascii(job.name, `${label}.name`),
    policy: enumValue(job.policy, JOB_POLICIES, `${label}.policy`),
    status: enumValue(job.status, JOB_STATUSES, `${label}.status`),
    conclusion:
      job.conclusion === null
        ? null
        : enumValue(job.conclusion, RUN_CONCLUSIONS, `${label}.conclusion`),
    started_at: nullableTimestamp(job.started_at, `${label}.started_at`),
    completed_at: nullableTimestamp(job.completed_at, `${label}.completed_at`),
    url: exactJobUrl(job.url, parentRunId, `${label}.url`),
  };
  if (
    (result.status === "completed" &&
      (result.conclusion === null || result.completed_at === null)) ||
    (result.status !== "completed" &&
      (result.conclusion !== null || result.completed_at !== null)) ||
    (result.started_at !== null &&
      result.completed_at !== null &&
      Date.parse(result.started_at) > Date.parse(result.completed_at))
  ) {
    fail(`${label} status, conclusion, or timestamps are inconsistent`);
  }
  return result;
}

function validateStateGroup(value, stateLabel, index) {
  const label = `${stateLabel} groups[${index}]`;
  const group = object(value, label);
  exactKeys(
    group,
    ["id", "run_id", "run_attempt", "status", "conclusion", "completed_at", "url", "jobs"],
    label,
  );
  const id = ascii(group.id, `${label}.id`);
  const groupRunId = runId(group.run_id, `${label}.run_id`);
  if (!Array.isArray(group.jobs) || group.jobs.length === 0) {
    fail(`${label}.jobs must be a non-empty array`);
  }
  const jobs = sortedUnique(
    group.jobs.map((job, jobIndex) => validateStateJob(job, stateLabel, id, groupRunId, jobIndex)),
    `${label}.jobs`,
    (job) => job.name,
  );
  const result = {
    id,
    run_id: groupRunId,
    run_attempt: positiveInteger(group.run_attempt, `${label}.run_attempt`),
    status: enumValue(group.status, JOB_STATUSES, `${label}.status`),
    conclusion:
      group.conclusion === null
        ? null
        : enumValue(group.conclusion, RUN_CONCLUSIONS, `${label}.conclusion`),
    completed_at: nullableTimestamp(group.completed_at, `${label}.completed_at`),
    url: exactRunUrl(group.url, groupRunId, `${label}.url`),
    jobs,
  };
  if (
    (result.status === "completed" &&
      (result.conclusion === null ||
        result.completed_at === null ||
        jobs.some((job) => job.status !== "completed"))) ||
    (result.status !== "completed" &&
      (result.conclusion !== null || result.completed_at !== null)) ||
    (result.completed_at !== null &&
      jobs.some(
        (job) =>
          job.completed_at !== null &&
          Date.parse(job.completed_at) > Date.parse(result.completed_at),
      ))
  ) {
    fail(`${label} status, conclusion, jobs, or timestamps are inconsistent`);
  }
  return result;
}

export function validateReleaseValidationStateSource(value, mode) {
  if (mode !== "decision" && mode !== "diagnostic-drain") {
    fail("release validation state source mode is unsupported");
  }
  const label = `release validation ${mode} source`;
  const source = object(value, label);
  exactKeys(
    source,
    [
      "schema",
      "parent_run_id",
      "parent_run_attempt",
      "source_parent_run_attempt",
      "workflow_ref",
      "workflow_sha",
      "target_sha",
      "execution_plan_digest",
      "observed_at",
      "groups",
    ],
    label,
  );
  const expectedSchema = mode === "decision" ? DECISION_SCHEMA : DRAIN_SCHEMA;
  if (source.schema !== expectedSchema) {
    fail(`${label} schema must be ${expectedSchema}`);
  }
  if (!Array.isArray(source.groups) || source.groups.length === 0) {
    fail(`${label}.groups must be a non-empty array`);
  }
  return {
    schema: expectedSchema,
    parent_run_id: runId(source.parent_run_id, `${label}.parent_run_id`),
    parent_run_attempt: positiveInteger(source.parent_run_attempt, `${label}.parent_run_attempt`),
    source_parent_run_attempt: positiveInteger(
      source.source_parent_run_attempt,
      `${label}.source_parent_run_attempt`,
    ),
    workflow_ref: qualifiedRef(source.workflow_ref, `${label}.workflow_ref`),
    workflow_sha: sha(source.workflow_sha, `${label}.workflow_sha`),
    target_sha: sha(source.target_sha, `${label}.target_sha`),
    execution_plan_digest: digest(source.execution_plan_digest, `${label}.execution_plan_digest`),
    observed_at: timestamp(source.observed_at, `${label}.observed_at`),
    groups: sortedUnique(
      source.groups.map((group, index) => validateStateGroup(group, label, index)),
      `${label}.groups`,
      (group) => group.id,
    ),
  };
}

function verifyPlanBinding(lock, executionPlan) {
  const plan = lock.plan;
  if (
    plan.candidate_sha !== executionPlan.target_sha ||
    plan.tooling.repository !== REPOSITORY ||
    plan.tooling.workflow_path !== WORKFLOW_PATH ||
    plan.tooling.ref !== executionPlan.workflow_ref ||
    plan.tooling.sha !== executionPlan.workflow_sha ||
    plan.validation.profile !== executionPlan.release_profile ||
    !plan.validation.allowed_groups.includes(executionPlan.rerun_group)
  ) {
    fail("release validation sources differ from the validated ReleasePlan");
  }
}

function verifyStateBinding(state, executionPlan, label) {
  const executionDigest = releaseCanonicalDigest(executionPlan);
  if (
    state.parent_run_id !== executionPlan.parent_run_id ||
    state.source_parent_run_attempt !== executionPlan.parent_run_attempt ||
    state.workflow_ref !== executionPlan.workflow_ref ||
    state.workflow_sha !== executionPlan.workflow_sha ||
    state.target_sha !== executionPlan.target_sha ||
    state.execution_plan_digest !== executionDigest
  ) {
    fail(`${label} differs from the execution plan`);
  }
  const plannedIds = executionPlan.groups.map((group) => group.id);
  if (
    state.groups.length !== plannedIds.length ||
    state.groups.some((group, index) => group.id !== plannedIds[index])
  ) {
    fail(`${label} group set differs from the execution plan`);
  }
  for (const group of state.groups) {
    const planned = executionPlan.groups.find((entry) => entry.id === group.id);
    if (
      group.run_id !== planned.run_id ||
      group.run_attempt !== planned.run_attempt ||
      group.url !== planned.url
    ) {
      fail(`${label} group tuple differs from the execution plan: ${group.id}`);
    }
  }
}

function requireTerminalJob(job, deadline, label) {
  if (
    job.status !== "completed" ||
    job.conclusion === null ||
    job.completed_at === null ||
    Date.parse(job.completed_at) > Date.parse(deadline)
  ) {
    fail(`${label} was not complete before ${deadline}`);
  }
}

function verifyDecisionAndDrain(executionPlan, decision, drain) {
  verifyStateBinding(decision, executionPlan, "release validation decision");
  verifyStateBinding(drain, executionPlan, "release validation diagnostic drain");
  if (
    executionPlan.parent_run_attempt > decision.parent_run_attempt ||
    decision.parent_run_attempt > drain.parent_run_attempt ||
    Date.parse(executionPlan.started_at) > Date.parse(decision.observed_at) ||
    Date.parse(decision.observed_at) > Date.parse(drain.observed_at)
  ) {
    fail("release validation source attempt or timestamp order is invalid");
  }
  for (const planned of executionPlan.groups) {
    const decisionGroup = decision.groups.find((group) => group.id === planned.id);
    const drainGroup = drain.groups.find((group) => group.id === planned.id);
    if (planned.mode === "blocking") {
      if (
        decisionGroup.status !== "completed" ||
        decisionGroup.conclusion !== "success" ||
        decisionGroup.completed_at === null ||
        Date.parse(decisionGroup.completed_at) > Date.parse(decision.observed_at)
      ) {
        fail(`blocking group was not complete before Decision: ${planned.id}`);
      }
      const blockingJobs = decisionGroup.jobs.filter((job) => job.policy === "blocking");
      if (blockingJobs.length === 0) {
        fail(`blocking group omitted blocking jobs: ${planned.id}`);
      }
      for (const job of blockingJobs) {
        requireTerminalJob(job, decision.observed_at, `blocking job ${planned.id}/${job.name}`);
        if (job.conclusion !== "success") {
          fail(`blocking job failed release policy: ${planned.id}/${job.name}`);
        }
      }
    } else if (
      decisionGroup.jobs.some((job) => job.policy !== "advisory") ||
      drainGroup.jobs.some((job) => job.policy !== "advisory")
    ) {
      fail(`diagnostic group contains a blocking job: ${planned.id}`);
    }
    if (
      drainGroup.status !== "completed" ||
      drainGroup.conclusion === null ||
      drainGroup.completed_at === null ||
      Date.parse(drainGroup.completed_at) > Date.parse(drain.observed_at)
    ) {
      fail(`group was not complete before Diagnostic Drain: ${planned.id}`);
    }
    for (const job of drainGroup.jobs) {
      requireTerminalJob(job, drain.observed_at, `drained job ${planned.id}/${job.name}`);
    }
    if (planned.mode === "blocking") {
      if (
        drainGroup.conclusion !== "success" ||
        drainGroup.conclusion !== decisionGroup.conclusion
      ) {
        fail(`blocking group changed after Decision: ${planned.id}`);
      }
      const decisionJobs = decisionGroup.jobs.filter((job) => job.policy === "blocking");
      const drainJobs = drainGroup.jobs.filter((job) => job.policy === "blocking");
      if (
        decisionJobs.length !== drainJobs.length ||
        decisionJobs.some(
          (job, index) => canonicalReleaseJson(job) !== canonicalReleaseJson(drainJobs[index]),
        )
      ) {
        const changedJob =
          decisionJobs.find(
            (job, index) => canonicalReleaseJson(job) !== canonicalReleaseJson(drainJobs[index]),
          )?.name ?? "job-set";
        fail(`blocking job changed after Decision: ${planned.id}/${changedJob}`);
      }
      for (const job of drainJobs) {
        if (job.conclusion !== "success") {
          fail(`blocking job changed after Decision: ${planned.id}/${job.name}`);
        }
      }
    }
  }
}

function artifactName(kind, run, executionPlan, decision, drain) {
  if (kind === "execution-plan") {
    return `full-release-execution-plan-${run}`;
  }
  if (kind === "decision") {
    return `full-release-decision-${run}-${decision.parent_run_attempt}`;
  }
  if (kind === "diagnostic-drain") {
    return `full-release-diagnostics-${run}-${drain.parent_run_attempt}`;
  }
  return `release-plan-lock-${run}-${executionPlan.parent_run_attempt}`;
}

function artifactAttempt(kind, executionPlan, decision, drain) {
  if (kind === "decision") {
    return decision.parent_run_attempt;
  }
  if (kind === "diagnostic-drain") {
    return drain.parent_run_attempt;
  }
  return executionPlan.parent_run_attempt;
}

function validateSourceArtifacts(value, sources) {
  if (!Array.isArray(value) || value.length !== 4) {
    fail("release validation source_artifacts must contain exactly four source artifacts");
  }
  const expectedBytes = {
    decision: canonicalReleaseJson(sources.decision),
    "diagnostic-drain": canonicalReleaseJson(sources.diagnosticDrain),
    "execution-plan": canonicalReleaseJson(sources.executionPlan),
    "release-plan-lock": canonicalReleaseJson(sources.releasePlanLock),
  };
  const artifacts = sortedUnique(
    value.map((entry, index) => {
      const label = `release validation source_artifacts[${index}]`;
      if (!isRecord(entry) || !isAuthenticatedGitHubReleaseValidationArtifactEvidence(entry)) {
        fail(`${label} must be authenticated artifact evidence`);
      }
      const artifact = object(entry, label);
      exactKeys(
        artifact,
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
      const kind = ascii(artifact.kind, `${label}.kind`);
      if (!Object.hasOwn(REQUIRED_ARTIFACTS, kind)) {
        fail(`${label}.kind is unsupported`);
      }
      const artifactId = runId(artifact.artifact_id, `${label}.artifact_id`);
      const parentRunId = runId(artifact.run_id, `${label}.run_id`);
      const result = {
        kind,
        artifact_id: artifactId,
        artifact_name: ascii(artifact.artifact_name, `${label}.artifact_name`),
        entry_name: ascii(artifact.entry_name, `${label}.entry_name`),
        run_id: parentRunId,
        run_attempt: positiveInteger(artifact.run_attempt, `${label}.run_attempt`),
        archive_digest: digest(artifact.archive_digest, `${label}.archive_digest`),
        content_digest: digest(artifact.content_digest, `${label}.content_digest`),
        created_at: timestamp(artifact.created_at, `${label}.created_at`),
        expires_at: timestamp(artifact.expires_at, `${label}.expires_at`),
        url: exactArtifactUrl(artifact.url, parentRunId, artifactId, `${label}.url`),
      };
      if (
        result.run_id !== sources.executionPlan.parent_run_id ||
        result.run_attempt !==
          artifactAttempt(kind, sources.executionPlan, sources.decision, sources.diagnosticDrain) ||
        result.artifact_name !==
          artifactName(
            kind,
            result.run_id,
            sources.executionPlan,
            sources.decision,
            sources.diagnosticDrain,
          ) ||
        result.entry_name !== REQUIRED_ARTIFACTS[kind].entry ||
        result.content_digest !== exactBytesDigest(expectedBytes[kind]) ||
        Date.parse(result.expires_at) <= Date.parse(result.created_at) ||
        artifact.entry_bytes !== expectedBytes[kind]
      ) {
        fail(`${label} coordinates differ from its source object`);
      }
      return result;
    }),
    "release validation source_artifacts",
    (artifact) => `${artifact.kind}\0${artifact.artifact_name}`,
  );
  const ids = artifacts.map((artifact) => artifact.artifact_id);
  const coordinates = artifacts.map(
    (artifact) =>
      `${artifact.run_id}\0${artifact.run_attempt}\0${artifact.artifact_name}\0${artifact.entry_name}`,
  );
  if (new Set(ids).size !== ids.length || new Set(coordinates).size !== coordinates.length) {
    fail("release validation source_artifacts must have unique IDs and coordinates");
  }
  const byKind = Object.fromEntries(artifacts.map((artifact) => [artifact.kind, artifact]));
  const decisionAt = Date.parse(sources.decision.observed_at);
  const drainAt = Date.parse(sources.diagnosticDrain.observed_at);
  const executionCreatedAt = Date.parse(byKind["execution-plan"].created_at);
  if (
    Date.parse(byKind.decision.created_at) < decisionAt ||
    Date.parse(byKind["diagnostic-drain"].created_at) < drainAt ||
    executionCreatedAt < Date.parse(sources.executionPlan.started_at) ||
    executionCreatedAt > decisionAt ||
    Date.parse(byKind["release-plan-lock"].created_at) > decisionAt
  ) {
    fail("release validation source artifact timestamps differ from source observations");
  }
  return artifacts;
}

function validateLineageShape(value) {
  const lineage = object(value, "release validation receipt lineage");
  exactKeys(
    lineage,
    ["generation", "root_receipt_digest", "parent_receipt_digest"],
    "release validation receipt lineage",
  );
  const result = {
    generation: nonNegativeInteger(
      lineage.generation,
      "release validation receipt lineage generation",
    ),
    root_receipt_digest:
      lineage.root_receipt_digest === null
        ? null
        : digest(
            lineage.root_receipt_digest,
            "release validation receipt lineage root_receipt_digest",
          ),
    parent_receipt_digest:
      lineage.parent_receipt_digest === null
        ? null
        : digest(
            lineage.parent_receipt_digest,
            "release validation receipt lineage parent_receipt_digest",
          ),
  };
  if (
    (result.generation === 0 &&
      (result.root_receipt_digest !== null || result.parent_receipt_digest !== null)) ||
    (result.generation > 0 &&
      (result.root_receipt_digest === null || result.parent_receipt_digest === null))
  ) {
    fail("release validation receipt lineage generation and digests disagree");
  }
  return result;
}

function sameLineagePolicy(left, right) {
  return (
    left.validation.intent === right.validation.intent &&
    left.validation.profile === right.validation.profile &&
    left.validation.soak === right.validation.soak &&
    left.validation.policy.id === right.validation.policy.id
  );
}

function authenticatedReceipt(value, label) {
  if (!isRecord(value) || !verifiedReceipts.has(value)) {
    fail(`${label} must be an authenticated release validation receipt`);
  }
  const receipt = validateReleaseValidationReceipt(value);
  if (verifiedReceipts.get(value) !== releaseValidationReceiptDigest(receipt)) {
    fail(`${label} changed after it was authenticated`);
  }
  return receipt;
}

function buildLineage({ parentReceipt, rootReceipt, validation, startedAt }) {
  if (parentReceipt === undefined) {
    if (rootReceipt !== undefined) {
      fail("release validation root receipt requires a parent receipt");
    }
    return { generation: 0, root_receipt_digest: null, parent_receipt_digest: null };
  }
  const parent = authenticatedReceipt(parentReceipt, "release validation parent receipt");
  if (!sameLineagePolicy({ validation }, parent)) {
    fail("release validation parent receipt uses a different intent policy");
  }
  if (Date.parse(parent.timestamps.sealed_at) > Date.parse(startedAt)) {
    fail("release validation parent receipt was sealed after its child started");
  }
  const parentDigest = releaseValidationReceiptDigest(parent);
  let root;
  if (parent.lineage.generation === 0) {
    root = parent;
    if (rootReceipt !== undefined) {
      const suppliedRoot = authenticatedReceipt(
        rootReceipt,
        "release validation supplied root receipt",
      );
      if (releaseValidationReceiptDigest(suppliedRoot) !== parentDigest) {
        fail("release validation supplied root differs from the generation-zero parent");
      }
    }
  } else {
    if (rootReceipt === undefined) {
      fail("release validation non-root parent requires the actual root receipt");
    }
    root = authenticatedReceipt(rootReceipt, "release validation root receipt");
    if (
      root.lineage.generation !== 0 ||
      releaseValidationReceiptDigest(root) !== parent.lineage.root_receipt_digest
    ) {
      fail("release validation root receipt does not continue the parent lineage");
    }
  }
  if (!sameLineagePolicy({ validation }, root)) {
    fail("release validation root receipt uses a different intent policy");
  }
  return {
    generation: parent.lineage.generation + 1,
    root_receipt_digest: releaseValidationReceiptDigest(root),
    parent_receipt_digest: parentDigest,
  };
}

function normalizeFinalGroups(executionPlan, drain) {
  return executionPlan.groups.map((planned) => {
    const observed = drain.groups.find((group) => group.id === planned.id);
    return {
      id: planned.id,
      mode: planned.mode,
      policy: planned.policy,
      workflow_path: planned.workflow_path,
      run_id: planned.run_id,
      run_attempt: planned.run_attempt,
      workflow_sha: planned.workflow_sha,
      url: planned.url,
      conclusion: observed.conclusion,
      completed_at: observed.completed_at,
      jobs: observed.jobs,
    };
  });
}

export function sealReleaseValidationReceipt(input) {
  const releasePlanLock = validateReleasePlanLock(input.releasePlanLock);
  const executionPlan = validateReleaseValidationExecutionPlanSource(input.executionPlan);
  const decision = validateReleaseValidationStateSource(input.decision, "decision");
  const diagnosticDrain = validateReleaseValidationStateSource(
    input.diagnosticDrain,
    "diagnostic-drain",
  );
  verifyPlanBinding(releasePlanLock, executionPlan);
  verifyDecisionAndDrain(executionPlan, decision, diagnosticDrain);
  const sourceArtifacts = validateSourceArtifacts(input.sourceArtifacts, {
    releasePlanLock,
    executionPlan,
    decision,
    diagnosticDrain,
  });
  const sealedAt = timestamp(input.sealedAt, "release validation receipt sealed_at");
  if (
    sourceArtifacts.some(
      (artifact) =>
        Date.parse(artifact.created_at) > Date.parse(sealedAt) ||
        Date.parse(artifact.expires_at) <= Date.parse(sealedAt),
    ) ||
    Date.parse(diagnosticDrain.observed_at) > Date.parse(sealedAt)
  ) {
    fail("release validation receipt was sealed before its sources completed");
  }
  const plan = releasePlanLock.plan;
  const validation = {
    intent: plan.validation.intent,
    profile: plan.validation.profile,
    soak: plan.validation.soak,
    allowed_groups: plan.validation.allowed_groups,
    rerun_group: executionPlan.rerun_group,
    policy: {
      id: RELEASE_VALIDATION_POLICY_ID,
      fail_fast: executionPlan.fail_fast,
    },
  };
  const receipt = {
    schema: RELEASE_VALIDATION_RECEIPT_SCHEMA,
    canonicalization: RELEASE_PLAN_CANONICALIZATION,
    target: {
      repository: REPOSITORY,
      ref: plan.target_context_ref,
      sha: plan.candidate_sha,
    },
    tooling: {
      repository: plan.tooling.repository,
      workflow_path: plan.tooling.workflow_path,
      ref: plan.tooling.ref,
      sha: plan.tooling.sha,
    },
    attempt: {
      workflow_name: WORKFLOW_NAME,
      run_id: executionPlan.parent_run_id,
      run_attempt: Math.max(decision.parent_run_attempt, diagnosticDrain.parent_run_attempt),
      url: `https://github.com/${REPOSITORY}/actions/runs/${executionPlan.parent_run_id}`,
    },
    release_plan: {
      schema: plan.schema,
      purpose: plan.purpose,
      plan_digest: releasePlanDigest(plan),
      lock_digest: releaseCanonicalDigest(releasePlanLock),
    },
    validation,
    source_attempts: {
      execution_plan: {
        schema: executionPlan.schema,
        digest: releaseCanonicalDigest(executionPlan),
        parent_run_attempt: executionPlan.parent_run_attempt,
      },
      decision: {
        schema: decision.schema,
        digest: releaseCanonicalDigest(decision),
        parent_run_attempt: decision.parent_run_attempt,
        source_parent_run_attempt: decision.source_parent_run_attempt,
      },
      diagnostic_drain: {
        schema: diagnosticDrain.schema,
        digest: releaseCanonicalDigest(diagnosticDrain),
        parent_run_attempt: diagnosticDrain.parent_run_attempt,
        source_parent_run_attempt: diagnosticDrain.source_parent_run_attempt,
      },
    },
    groups: normalizeFinalGroups(executionPlan, diagnosticDrain),
    source_artifacts: sourceArtifacts,
    timestamps: {
      started_at: executionPlan.started_at,
      decision_at: decision.observed_at,
      drain_completed_at: diagnosticDrain.observed_at,
      sealed_at: sealedAt,
    },
    lineage: buildLineage({
      parentReceipt: input.parentReceipt,
      rootReceipt: input.rootReceipt,
      validation,
      startedAt: executionPlan.started_at,
    }),
  };
  const result = validateReleaseValidationReceipt(receipt);
  verifiedReceipts.set(result, releaseValidationReceiptDigest(result));
  return result;
}

function validateReceiptGroup(value, index, toolingSha) {
  const label = `release validation receipt groups[${index}]`;
  const group = object(value, label);
  exactKeys(
    group,
    [
      "id",
      "mode",
      "policy",
      "workflow_path",
      "run_id",
      "run_attempt",
      "workflow_sha",
      "url",
      "conclusion",
      "completed_at",
      "jobs",
    ],
    label,
  );
  const id = ascii(group.id, `${label}.id`);
  const groupRunId = runId(group.run_id, `${label}.run_id`);
  if (!Array.isArray(group.jobs) || group.jobs.length === 0) {
    fail(`${label}.jobs must be a non-empty array`);
  }
  const jobs = sortedUnique(
    group.jobs.map((job, jobIndex) =>
      validateStateJob(job, "release validation receipt", id, groupRunId, jobIndex),
    ),
    `${label}.jobs`,
    (job) => job.name,
  );
  const result = {
    id,
    mode: enumValue(group.mode, GROUP_MODES, `${label}.mode`),
    policy: ascii(group.policy, `${label}.policy`),
    workflow_path: ascii(group.workflow_path, `${label}.workflow_path`),
    run_id: groupRunId,
    run_attempt: positiveInteger(group.run_attempt, `${label}.run_attempt`),
    workflow_sha: sha(group.workflow_sha, `${label}.workflow_sha`),
    url: exactRunUrl(group.url, groupRunId, `${label}.url`),
    conclusion: enumValue(group.conclusion, RUN_CONCLUSIONS, `${label}.conclusion`),
    completed_at: timestamp(group.completed_at, `${label}.completed_at`),
    jobs,
  };
  if (
    result.workflow_sha !== toolingSha ||
    jobs.some(
      (job) => job.status !== "completed" || job.conclusion === null || job.completed_at === null,
    )
  ) {
    fail(`${label} is not terminal or differs from tooling`);
  }
  const blockingJobs = jobs.filter((job) => job.policy === "blocking");
  if (
    (result.mode === "blocking" &&
      (result.conclusion !== "success" ||
        blockingJobs.length === 0 ||
        blockingJobs.some((job) => job.conclusion !== "success"))) ||
    (result.mode === "diagnostic" && blockingJobs.length > 0)
  ) {
    fail(`${label} violates blocking or diagnostic policy`);
  }
  return result;
}

function validateReceiptSourceAttempt(value, label, state) {
  const source = object(value, label);
  exactKeys(
    source,
    state
      ? ["schema", "digest", "parent_run_attempt", "source_parent_run_attempt"]
      : ["schema", "digest", "parent_run_attempt"],
    label,
  );
  return {
    schema: ascii(source.schema, `${label}.schema`),
    digest: digest(source.digest, `${label}.digest`),
    parent_run_attempt: positiveInteger(source.parent_run_attempt, `${label}.parent_run_attempt`),
    ...(state
      ? {
          source_parent_run_attempt: positiveInteger(
            source.source_parent_run_attempt,
            `${label}.source_parent_run_attempt`,
          ),
        }
      : {}),
  };
}

function validateReceiptArtifacts(value, context) {
  if (!Array.isArray(value) || value.length !== 4) {
    fail("release validation receipt source_artifacts must contain exactly four artifacts");
  }
  const expected = {
    decision: {
      name: `full-release-decision-${context.attempt.run_id}-${context.sourceAttempts.decision.parent_run_attempt}`,
      entry: REQUIRED_ARTIFACTS.decision.entry,
      attempt: context.sourceAttempts.decision.parent_run_attempt,
      digest: context.sourceAttempts.decision.digest,
    },
    "diagnostic-drain": {
      name: `full-release-diagnostics-${context.attempt.run_id}-${context.sourceAttempts.diagnostic_drain.parent_run_attempt}`,
      entry: REQUIRED_ARTIFACTS["diagnostic-drain"].entry,
      attempt: context.sourceAttempts.diagnostic_drain.parent_run_attempt,
      digest: context.sourceAttempts.diagnostic_drain.digest,
    },
    "execution-plan": {
      name: `full-release-execution-plan-${context.attempt.run_id}`,
      entry: REQUIRED_ARTIFACTS["execution-plan"].entry,
      attempt: context.sourceAttempts.execution_plan.parent_run_attempt,
      digest: context.sourceAttempts.execution_plan.digest,
    },
    "release-plan-lock": {
      name: `release-plan-lock-${context.attempt.run_id}-${context.sourceAttempts.execution_plan.parent_run_attempt}`,
      entry: REQUIRED_ARTIFACTS["release-plan-lock"].entry,
      attempt: context.sourceAttempts.execution_plan.parent_run_attempt,
      digest: context.releasePlan.lock_digest,
    },
  };
  const artifacts = sortedUnique(
    value.map((entry, index) => {
      const label = `release validation receipt source_artifacts[${index}]`;
      const artifact = object(entry, label);
      exactKeys(
        artifact,
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
        ],
        label,
      );
      const kind = ascii(artifact.kind, `${label}.kind`);
      if (!Object.hasOwn(expected, kind)) {
        fail(`${label}.kind is unsupported`);
      }
      const artifactId = runId(artifact.artifact_id, `${label}.artifact_id`);
      const artifactRunId = runId(artifact.run_id, `${label}.run_id`);
      const result = {
        kind,
        artifact_id: artifactId,
        artifact_name: ascii(artifact.artifact_name, `${label}.artifact_name`),
        entry_name: ascii(artifact.entry_name, `${label}.entry_name`),
        run_id: artifactRunId,
        run_attempt: positiveInteger(artifact.run_attempt, `${label}.run_attempt`),
        archive_digest: digest(artifact.archive_digest, `${label}.archive_digest`),
        content_digest: digest(artifact.content_digest, `${label}.content_digest`),
        created_at: timestamp(artifact.created_at, `${label}.created_at`),
        expires_at: timestamp(artifact.expires_at, `${label}.expires_at`),
        url: exactArtifactUrl(artifact.url, artifactRunId, artifactId, `${label}.url`),
      };
      const required = expected[kind];
      if (
        result.run_id !== context.attempt.run_id ||
        result.run_attempt !== required.attempt ||
        result.artifact_name !== required.name ||
        result.entry_name !== required.entry ||
        result.content_digest !== required.digest ||
        Date.parse(result.expires_at) <= Date.parse(result.created_at)
      ) {
        fail(`${label} coordinates differ from its receipt sources`);
      }
      return result;
    }),
    "release validation receipt source_artifacts",
    (artifact) => `${artifact.kind}\0${artifact.artifact_name}`,
  );
  const ids = artifacts.map((artifact) => artifact.artifact_id);
  const coordinates = artifacts.map(
    (artifact) =>
      `${artifact.run_id}\0${artifact.run_attempt}\0${artifact.artifact_name}\0${artifact.entry_name}`,
  );
  if (new Set(ids).size !== ids.length || new Set(coordinates).size !== coordinates.length) {
    fail("release validation receipt source_artifacts IDs or coordinates are duplicated");
  }
  const byKind = Object.fromEntries(artifacts.map((artifact) => [artifact.kind, artifact]));
  const startedAt = Date.parse(context.timestamps.started_at);
  const decisionAt = Date.parse(context.timestamps.decision_at);
  const drainAt = Date.parse(context.timestamps.drain_completed_at);
  const sealedAt = Date.parse(context.timestamps.sealed_at);
  if (
    Date.parse(byKind.decision.created_at) < decisionAt ||
    Date.parse(byKind["diagnostic-drain"].created_at) < drainAt ||
    Date.parse(byKind["execution-plan"].created_at) < startedAt ||
    Date.parse(byKind["execution-plan"].created_at) > decisionAt ||
    Date.parse(byKind["release-plan-lock"].created_at) > decisionAt ||
    artifacts.some(
      (artifact) =>
        Date.parse(artifact.created_at) > sealedAt || Date.parse(artifact.expires_at) <= sealedAt,
    )
  ) {
    fail("release validation receipt source artifact timestamps are invalid");
  }
  return artifacts;
}

export function validateReleaseValidationReceipt(value) {
  const label = "release validation receipt";
  const receipt = object(value, label);
  exactKeys(
    receipt,
    [
      "schema",
      "canonicalization",
      "target",
      "tooling",
      "attempt",
      "release_plan",
      "validation",
      "source_attempts",
      "groups",
      "source_artifacts",
      "timestamps",
      "lineage",
    ],
    label,
  );
  if (
    receipt.schema !== RELEASE_VALIDATION_RECEIPT_SCHEMA ||
    receipt.canonicalization !== RELEASE_PLAN_CANONICALIZATION
  ) {
    fail("release validation receipt schema or canonicalization is unsupported");
  }
  const target = object(receipt.target, `${label} target`);
  exactKeys(target, ["repository", "ref", "sha"], `${label} target`);
  const targetSha = sha(target.sha, `${label} target.sha`);
  const normalizedTarget = {
    repository: ascii(target.repository, `${label} target.repository`),
    ref: targetRef(target.ref, targetSha, `${label} target.ref`),
    sha: targetSha,
  };
  if (normalizedTarget.repository !== REPOSITORY) {
    fail(`release validation receipt target.repository must be ${REPOSITORY}`);
  }
  const tooling = object(receipt.tooling, `${label} tooling`);
  exactKeys(tooling, ["repository", "workflow_path", "ref", "sha"], `${label} tooling`);
  const normalizedTooling = {
    repository: ascii(tooling.repository, `${label} tooling.repository`),
    workflow_path: ascii(tooling.workflow_path, `${label} tooling.workflow_path`),
    ref: qualifiedRef(tooling.ref, `${label} tooling.ref`),
    sha: sha(tooling.sha, `${label} tooling.sha`),
  };
  if (
    normalizedTooling.repository !== REPOSITORY ||
    normalizedTooling.workflow_path !== WORKFLOW_PATH
  ) {
    fail("release validation receipt tooling authority is unsupported");
  }
  const attempt = object(receipt.attempt, `${label} attempt`);
  exactKeys(attempt, ["workflow_name", "run_id", "run_attempt", "url"], `${label} attempt`);
  const attemptRunId = runId(attempt.run_id, `${label} attempt.run_id`);
  const normalizedAttempt = {
    workflow_name: ascii(attempt.workflow_name, `${label} attempt.workflow_name`),
    run_id: attemptRunId,
    run_attempt: positiveInteger(attempt.run_attempt, `${label} attempt.run_attempt`),
    url: exactRunUrl(attempt.url, attemptRunId, `${label} attempt.url`),
  };
  if (normalizedAttempt.workflow_name !== WORKFLOW_NAME) {
    fail(`release validation receipt attempt.workflow_name must be ${WORKFLOW_NAME}`);
  }
  const releasePlan = object(receipt.release_plan, `${label} release_plan`);
  exactKeys(
    releasePlan,
    ["schema", "purpose", "plan_digest", "lock_digest"],
    `${label} release_plan`,
  );
  const normalizedReleasePlan = {
    schema: ascii(releasePlan.schema, `${label} release_plan.schema`),
    purpose: ascii(releasePlan.purpose, `${label} release_plan.purpose`),
    plan_digest: digest(releasePlan.plan_digest, `${label} release_plan.plan_digest`),
    lock_digest: digest(releasePlan.lock_digest, `${label} release_plan.lock_digest`),
  };
  if (normalizedReleasePlan.schema !== "openclaw.release-plan.v1") {
    fail("release validation receipt release_plan.schema is unsupported");
  }
  const validation = object(receipt.validation, `${label} validation`);
  exactKeys(
    validation,
    ["intent", "profile", "soak", "allowed_groups", "rerun_group", "policy"],
    `${label} validation`,
  );
  if (!Array.isArray(validation.allowed_groups) || validation.allowed_groups.length === 0) {
    fail(`${label} validation.allowed_groups must be a non-empty array`);
  }
  const allowedGroups = sortedUnique(
    validation.allowed_groups.map((group, index) =>
      ascii(group, `${label} validation.allowed_groups[${index}]`),
    ),
    `${label} validation.allowed_groups`,
    (group) => group,
  );
  const policy = object(validation.policy, `${label} validation.policy`);
  exactKeys(policy, ["id", "fail_fast"], `${label} validation.policy`);
  const normalizedValidation = {
    intent: ascii(validation.intent, `${label} validation.intent`),
    profile: ascii(validation.profile, `${label} validation.profile`),
    soak: booleanValue(validation.soak, `${label} validation.soak`),
    allowed_groups: allowedGroups,
    rerun_group: ascii(validation.rerun_group, `${label} validation.rerun_group`),
    policy: {
      id: ascii(policy.id, `${label} validation.policy.id`),
      fail_fast: booleanValue(policy.fail_fast, `${label} validation.policy.fail_fast`),
    },
  };
  if (
    normalizedValidation.policy.id !== RELEASE_VALIDATION_POLICY_ID ||
    !allowedGroups.includes(normalizedValidation.rerun_group)
  ) {
    fail("release validation receipt validation policy or rerun group is unsupported");
  }
  releaseValidationIntentForPurpose(normalizedReleasePlan.purpose, normalizedValidation.intent);
  resolveReleaseValidationIntent(normalizedValidation.intent, {
    profile: normalizedValidation.profile,
    soak: normalizedValidation.soak,
  });
  const sourceAttempts = object(receipt.source_attempts, `${label} source_attempts`);
  exactKeys(
    sourceAttempts,
    ["execution_plan", "decision", "diagnostic_drain"],
    `${label} source_attempts`,
  );
  const normalizedSourceAttempts = {
    execution_plan: validateReceiptSourceAttempt(
      sourceAttempts.execution_plan,
      `${label} source_attempts.execution_plan`,
      false,
    ),
    decision: validateReceiptSourceAttempt(
      sourceAttempts.decision,
      `${label} source_attempts.decision`,
      true,
    ),
    diagnostic_drain: validateReceiptSourceAttempt(
      sourceAttempts.diagnostic_drain,
      `${label} source_attempts.diagnostic_drain`,
      true,
    ),
  };
  if (
    normalizedSourceAttempts.execution_plan.schema !== EXECUTION_PLAN_SCHEMA ||
    normalizedSourceAttempts.decision.schema !== DECISION_SCHEMA ||
    normalizedSourceAttempts.diagnostic_drain.schema !== DRAIN_SCHEMA ||
    normalizedSourceAttempts.execution_plan.parent_run_attempt >
      normalizedSourceAttempts.decision.parent_run_attempt ||
    normalizedSourceAttempts.decision.parent_run_attempt >
      normalizedSourceAttempts.diagnostic_drain.parent_run_attempt ||
    normalizedSourceAttempts.decision.source_parent_run_attempt !==
      normalizedSourceAttempts.execution_plan.parent_run_attempt ||
    normalizedSourceAttempts.diagnostic_drain.source_parent_run_attempt !==
      normalizedSourceAttempts.execution_plan.parent_run_attempt
  ) {
    fail("release validation receipt source attempt binding is invalid");
  }
  if (
    normalizedAttempt.run_attempt !==
    Math.max(
      normalizedSourceAttempts.decision.parent_run_attempt,
      normalizedSourceAttempts.diagnostic_drain.parent_run_attempt,
    )
  ) {
    fail("release validation receipt attempt differs from its terminal source attempts");
  }
  if (!Array.isArray(receipt.groups) || receipt.groups.length === 0) {
    fail(`${label} groups must be a non-empty array`);
  }
  const groups = sortedUnique(
    receipt.groups.map((group, index) => validateReceiptGroup(group, index, normalizedTooling.sha)),
    `${label} groups`,
    (group) => group.id,
  );
  const timestamps = object(receipt.timestamps, `${label} timestamps`);
  exactKeys(
    timestamps,
    ["started_at", "decision_at", "drain_completed_at", "sealed_at"],
    `${label} timestamps`,
  );
  const normalizedTimestamps = {
    started_at: timestamp(timestamps.started_at, `${label} timestamps.started_at`),
    decision_at: timestamp(timestamps.decision_at, `${label} timestamps.decision_at`),
    drain_completed_at: timestamp(
      timestamps.drain_completed_at,
      `${label} timestamps.drain_completed_at`,
    ),
    sealed_at: timestamp(timestamps.sealed_at, `${label} timestamps.sealed_at`),
  };
  const orderedTimes = [
    normalizedTimestamps.started_at,
    normalizedTimestamps.decision_at,
    normalizedTimestamps.drain_completed_at,
    normalizedTimestamps.sealed_at,
  ].map(Date.parse);
  if (orderedTimes.some((time, index) => index > 0 && orderedTimes[index - 1] > time)) {
    fail("release validation receipt timestamps are not chronological");
  }
  const result = {
    schema: RELEASE_VALIDATION_RECEIPT_SCHEMA,
    canonicalization: RELEASE_PLAN_CANONICALIZATION,
    target: normalizedTarget,
    tooling: normalizedTooling,
    attempt: normalizedAttempt,
    release_plan: normalizedReleasePlan,
    validation: normalizedValidation,
    source_attempts: normalizedSourceAttempts,
    groups,
    source_artifacts: validateReceiptArtifacts(receipt.source_artifacts, {
      attempt: normalizedAttempt,
      releasePlan: normalizedReleasePlan,
      sourceAttempts: normalizedSourceAttempts,
      timestamps: normalizedTimestamps,
    }),
    timestamps: normalizedTimestamps,
    lineage: validateLineageShape(receipt.lineage),
  };
  if (
    Buffer.byteLength(canonicalReleaseJson(result), "ascii") > RELEASE_VALIDATION_RECEIPT_MAX_BYTES
  ) {
    fail(`release validation receipt exceeds ${RELEASE_VALIDATION_RECEIPT_MAX_BYTES} bytes`);
  }
  return result;
}

export function verifyReleaseValidationReceiptLineage(
  receiptValue,
  { parentReceipt, rootReceipt } = {},
) {
  const receipt = validateReleaseValidationReceipt(receiptValue);
  const expected = buildLineage({
    parentReceipt,
    rootReceipt,
    validation: receipt.validation,
    startedAt: receipt.timestamps.started_at,
  });
  if (canonicalReleaseJson(receipt.lineage) !== canonicalReleaseJson(expected)) {
    fail("release validation receipt lineage differs from the supplied parent/root continuity");
  }
  return receipt.lineage;
}

export function verifyReleaseValidationReceipt(receiptValue, input) {
  const receipt = validateReleaseValidationReceipt(receiptValue);
  const expected = sealReleaseValidationReceipt(input);
  if (canonicalReleaseJson(receipt) !== canonicalReleaseJson(expected)) {
    fail("release validation receipt differs from its validated source objects");
  }
  verifiedReceipts.set(receipt, releaseValidationReceiptDigest(receipt));
  return receipt;
}

export function validateReleaseValidationReceiptReuseFreshness(receiptValue, optionsValue) {
  const receipt = authenticatedReceipt(receiptValue, "release validation receipt reuse candidate");
  const options = object(optionsValue, "release validation receipt reuse options");
  exactKeys(options, ["now_ms", "max_future_skew_ms"], "release validation receipt reuse options");
  const nowMs = nonNegativeInteger(options.now_ms, "release validation receipt reuse now_ms");
  const futureSkewMs = nonNegativeInteger(
    options.max_future_skew_ms,
    "release validation receipt reuse max_future_skew_ms",
  );
  const policy = RELEASE_VALIDATION_REUSE_POLICIES[receipt.validation.intent];
  const maxAgeMs = policy.max_age_ms;
  const cadenceMs = policy.cadence_ms;
  const sealedAtMs = Date.parse(receipt.timestamps.sealed_at);
  const sourceTimes = [
    receipt.timestamps.started_at,
    receipt.timestamps.decision_at,
    receipt.timestamps.drain_completed_at,
    receipt.timestamps.sealed_at,
    ...receipt.source_artifacts.map((artifact) => artifact.created_at),
  ].map(Date.parse);
  const futureBoundaryMs = nowMs + futureSkewMs;
  if (
    !Number.isSafeInteger(futureBoundaryMs) ||
    sourceTimes.some((value) => value > futureBoundaryMs)
  ) {
    fail("release validation receipt reuse evidence is newer than the allowed future skew");
  }
  const policyExpiryMs = sealedAtMs + Math.min(maxAgeMs, cadenceMs);
  if (!Number.isSafeInteger(policyExpiryMs)) {
    fail("release validation receipt reuse policy expiry exceeds safe integer range");
  }
  const artifactExpiryMs = Math.min(
    ...receipt.source_artifacts.map((artifact) => Date.parse(artifact.expires_at)),
  );
  const expiresAtMs = Math.min(policyExpiryMs, artifactExpiryMs);
  if (nowMs >= expiresAtMs) {
    fail("release validation receipt reuse evidence is expired");
  }
  return {
    intent: receipt.validation.intent,
    age_ms: Math.max(0, nowMs - sealedAtMs),
    max_age_ms: maxAgeMs,
    cadence_ms: cadenceMs,
    expires_at_ms: expiresAtMs,
  };
}

export function canonicalReleaseValidationReceiptJson(value) {
  return canonicalReleaseJson(validateReleaseValidationReceipt(value));
}

export function releaseValidationReceiptDigest(value) {
  return releaseCanonicalDigest(validateReleaseValidationReceipt(value));
}

export function parseReleaseValidationReceiptJson(text) {
  return parseCanonicalReleaseJson(text, {
    label: "release validation receipt JSON",
    maxBytes: RELEASE_VALIDATION_RECEIPT_MAX_BYTES,
    validate: validateReleaseValidationReceipt,
  });
}

function validateReleaseValidationReceiptLocator(value) {
  const label = "release validation receipt locator";
  const envelope = object(value, label);
  exactKeys(
    envelope,
    ["schema", "canonicalization", "receipt_digest", "locator", "sealed_at"],
    label,
  );
  if (
    envelope.schema !== RELEASE_VALIDATION_RECEIPT_LOCATOR_SCHEMA ||
    envelope.canonicalization !== RELEASE_PLAN_CANONICALIZATION
  ) {
    fail("release validation receipt locator schema or canonicalization is unsupported");
  }
  const locator = object(envelope.locator, `${label} coordinates`);
  exactKeys(
    locator,
    [
      "repository",
      "run_id",
      "run_attempt",
      "artifact_id",
      "artifact_name",
      "entry_name",
      "archive_digest",
      "url",
    ],
    `${label} coordinates`,
  );
  const locatorRunId = runId(locator.run_id, `${label} run_id`);
  const artifactId = runId(locator.artifact_id, `${label} artifact_id`);
  const normalizedLocator = {
    repository: ascii(locator.repository, `${label} repository`),
    run_id: locatorRunId,
    run_attempt: positiveInteger(locator.run_attempt, `${label} run_attempt`),
    artifact_id: artifactId,
    artifact_name: ascii(locator.artifact_name, `${label} artifact_name`),
    entry_name: ascii(locator.entry_name, `${label} entry_name`),
    archive_digest: digest(locator.archive_digest, `${label} archive_digest`),
    url: exactArtifactUrl(locator.url, locatorRunId, artifactId, `${label} url`),
  };
  if (
    normalizedLocator.repository !== REPOSITORY ||
    normalizedLocator.entry_name !== "release-validation-receipt.json" ||
    normalizedLocator.artifact_name !==
      `release-validation-receipt-${locatorRunId}-${normalizedLocator.run_attempt}`
  ) {
    fail("release validation receipt locator coordinates are unsupported");
  }
  return {
    schema: RELEASE_VALIDATION_RECEIPT_LOCATOR_SCHEMA,
    canonicalization: RELEASE_PLAN_CANONICALIZATION,
    receipt_digest: digest(envelope.receipt_digest, `${label} receipt_digest`),
    locator: normalizedLocator,
    sealed_at: timestamp(envelope.sealed_at, `${label} sealed_at`),
  };
}

export function createReleaseValidationReceiptLocator(receiptValue, locatorValue) {
  const receipt = validateReleaseValidationReceipt(receiptValue);
  const result = validateReleaseValidationReceiptLocator({
    schema: RELEASE_VALIDATION_RECEIPT_LOCATOR_SCHEMA,
    canonicalization: RELEASE_PLAN_CANONICALIZATION,
    receipt_digest: releaseValidationReceiptDigest(receipt),
    locator: locatorValue,
    sealed_at: receipt.timestamps.sealed_at,
  });
  if (
    result.locator.run_id !== receipt.attempt.run_id ||
    result.locator.run_attempt !== receipt.attempt.run_attempt
  ) {
    fail("release validation receipt locator attempt differs from its receipt");
  }
  return result;
}

export function validateReleaseValidationReceiptLocatorForReceipt(locatorValue, receiptValue) {
  const locator = validateReleaseValidationReceiptLocator(locatorValue);
  const receipt = validateReleaseValidationReceipt(receiptValue);
  if (
    locator.receipt_digest !== releaseValidationReceiptDigest(receipt) ||
    locator.locator.run_id !== receipt.attempt.run_id ||
    locator.locator.run_attempt !== receipt.attempt.run_attempt ||
    locator.sealed_at !== receipt.timestamps.sealed_at
  ) {
    fail("release validation receipt locator differs from its receipt");
  }
  return locator;
}

export function canonicalReleaseValidationReceiptLocatorJson(value) {
  return canonicalReleaseJson(validateReleaseValidationReceiptLocator(value));
}

export function parseReleaseValidationReceiptLocatorJson(text) {
  return parseCanonicalReleaseJson(text, {
    label: "release validation receipt locator JSON",
    maxBytes: RELEASE_VALIDATION_RECEIPT_LOCATOR_MAX_BYTES,
    validate: validateReleaseValidationReceiptLocator,
  });
}

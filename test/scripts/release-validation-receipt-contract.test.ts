import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalAsciiJson } from "../../scripts/lib/canonical-json.mjs";
import { createReleasePlanLock } from "../../scripts/release-plan-contract.mjs";
import * as githubAuthenticator from "../../scripts/release-validation-github-artifact-authenticator.mjs";
import {
  downloadAndAuthenticateGitHubReleaseValidationArtifact,
  isAuthenticatedGitHubReleaseValidationArtifactEvidence,
  validateReleaseValidationArtifactEvidence,
} from "../../scripts/release-validation-github-artifact-authenticator.mjs";
import * as receiptContract from "../../scripts/release-validation-receipt-contract.mjs";
import {
  canonicalReleaseValidationReceiptJson,
  canonicalReleaseValidationReceiptLocatorJson,
  createReleaseValidationReceiptLocator,
  parseReleaseValidationReceiptJson,
  parseReleaseValidationReceiptLocatorJson,
  releaseValidationReceiptDigest,
  sealReleaseValidationReceipt,
  validateReleaseValidationExecutionPlanSource,
  validateReleaseValidationReceipt,
  validateReleaseValidationReceiptLocatorForReceipt,
  validateReleaseValidationReceiptReuseFreshness,
  validateReleaseValidationStateSource,
  verifyReleaseValidationReceipt,
  verifyReleaseValidationReceiptLineage,
} from "../../scripts/release-validation-receipt-contract.mjs";
import type {
  ReleaseValidationExecutionPlanSource,
  ReleaseValidationReceiptSealInput,
  ReleaseValidationSourceArtifact,
  ReleaseValidationStateGroup,
  ReleaseValidationStateJob,
  ReleaseValidationStateSource,
  ReleaseValidationVerifiedArtifactEvidence,
} from "../../scripts/release-validation-receipt-contract.mjs";

const TARGET_SHA = "a".repeat(40);
const TOOLING_SHA = "b".repeat(40);
const PARENT_RUN_ID = "9001";
const PARENT_RUN_URL = `https://github.com/openclaw/openclaw/actions/runs/${PARENT_RUN_ID}`;
const sourceFixture = JSON.parse(
  readFileSync(resolve("test/fixtures/release-plan-v1.source.json"), "utf8"),
) as Record<string, unknown>;

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString().replace(".000Z", "Z");
}

function exactBytesDigest(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalReleaseJson(value: unknown): string {
  return canonicalAsciiJson(value);
}

function releaseCanonicalDigest(value: unknown): `sha256:${string}` {
  return exactBytesDigest(canonicalReleaseJson(value));
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(name: string, bytes: Buffer): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const checksum = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE((0o100600 * 0x10000) >>> 0, 38);
  const centralOffset = local.length + nameBytes.length + bytes.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBytes, bytes, central, nameBytes, end]);
}

function job(
  runId: string,
  id: string,
  name: string,
  policy: "advisory" | "blocking",
  status: "completed" | "in_progress",
  conclusion: "failure" | "success" | null,
  completedAt: string | null,
): ReleaseValidationStateJob {
  return {
    name,
    policy,
    status,
    conclusion,
    started_at: "2026-08-21T09:05:00Z",
    completed_at: completedAt,
    url: `https://github.com/openclaw/openclaw/actions/runs/${runId}/job/${id}`,
  };
}

function stateGroup(
  id: string,
  runId: string,
  status: "completed" | "in_progress",
  conclusion: "failure" | "success" | null,
  completedAt: string | null,
  jobs: ReleaseValidationStateJob[],
): ReleaseValidationStateGroup {
  return {
    id,
    run_id: runId,
    run_attempt: 1,
    status,
    conclusion,
    completed_at: completedAt,
    url: `https://github.com/openclaw/openclaw/actions/runs/${runId}`,
    jobs,
  };
}

function executionPlanFixture(): ReleaseValidationExecutionPlanSource {
  return {
    schema: "openclaw.full-release-execution-plan.v1",
    parent_run_id: PARENT_RUN_ID,
    parent_run_attempt: 1,
    workflow_ref: `refs/tags/release-publish/${TOOLING_SHA.slice(0, 12)}-123`,
    workflow_sha: TOOLING_SHA,
    target_sha: TARGET_SHA,
    release_profile: "beta",
    rerun_group: "all",
    fail_fast: false,
    started_at: "2026-08-21T09:00:00Z",
    groups: [
      {
        id: "normal-ci",
        mode: "blocking",
        policy: "required-success",
        workflow_path: ".github/workflows/ci.yml",
        run_id: "9101",
        run_attempt: 1,
        workflow_sha: TOOLING_SHA,
        url: "https://github.com/openclaw/openclaw/actions/runs/9101",
      },
      {
        id: "performance",
        mode: "diagnostic",
        policy: "advisory",
        workflow_path: ".github/workflows/openclaw-performance.yml",
        run_id: "9102",
        run_attempt: 1,
        workflow_sha: TOOLING_SHA,
        url: "https://github.com/openclaw/openclaw/actions/runs/9102",
      },
      {
        id: "release-checks",
        mode: "blocking",
        policy: "required-success",
        workflow_path: ".github/workflows/openclaw-release-checks.yml",
        run_id: "9103",
        run_attempt: 1,
        workflow_sha: TOOLING_SHA,
        url: "https://github.com/openclaw/openclaw/actions/runs/9103",
      },
    ],
  };
}

function decisionFixture(
  executionPlan: ReleaseValidationExecutionPlanSource,
): ReleaseValidationStateSource {
  return {
    schema: "openclaw.full-release-decision.v2",
    parent_run_id: PARENT_RUN_ID,
    parent_run_attempt: 2,
    source_parent_run_attempt: 1,
    workflow_ref: executionPlan.workflow_ref,
    workflow_sha: TOOLING_SHA,
    target_sha: TARGET_SHA,
    execution_plan_digest: releaseCanonicalDigest(executionPlan),
    observed_at: "2026-08-21T10:00:00Z",
    groups: [
      stateGroup("normal-ci", "9101", "completed", "success", "2026-08-21T09:25:00Z", [
        job("9101", "1", "test", "blocking", "completed", "success", "2026-08-21T09:25:00Z"),
      ]),
      stateGroup("performance", "9102", "in_progress", null, null, [
        job("9102", "2", "bench", "advisory", "in_progress", null, null),
      ]),
      stateGroup("release-checks", "9103", "completed", "success", "2026-08-21T09:50:00Z", [
        job("9103", "3", "package", "blocking", "completed", "success", "2026-08-21T09:50:00Z"),
      ]),
    ],
  };
}

function diagnosticDrainFixture(
  decision: ReleaseValidationStateSource,
): ReleaseValidationStateSource {
  const normalCi = structuredClone(decision.groups[0]!);
  const releaseChecks = structuredClone(decision.groups[2]!);
  return {
    ...structuredClone(decision),
    schema: "openclaw.full-release-diagnostic-drain.v2",
    observed_at: "2026-08-21T10:30:00Z",
    groups: [
      normalCi,
      stateGroup("performance", "9102", "completed", "failure", "2026-08-21T10:20:00Z", [
        job("9102", "2", "bench", "advisory", "completed", "failure", "2026-08-21T10:20:00Z"),
      ]),
      releaseChecks,
    ],
  };
}

type FixtureBase = Omit<
  ReleaseValidationReceiptSealInput,
  "parentReceipt" | "rootReceipt" | "sourceArtifacts"
>;
type Fixture = FixtureBase & {
  sourceArtifacts: ReleaseValidationVerifiedArtifactEvidence[];
};

type RawArtifactEvidence = ReleaseValidationSourceArtifact & {
  entry_bytes: string;
};

function githubArtifactDownloadFixture(evidence: RawArtifactEvidence) {
  const archiveBytes = createZip(evidence.entry_name, Buffer.from(evidence.entry_bytes, "ascii"));
  const normalizedEvidence = { ...evidence, archive_digest: exactBytesDigest(archiveBytes) };
  const artifactMetadata = {
    id: Number(evidence.artifact_id),
    name: evidence.artifact_name,
    digest: exactBytesDigest(archiveBytes),
    created_at: evidence.created_at,
    expires_at: evidence.expires_at,
    expired: false,
    size_in_bytes: archiveBytes.length,
    workflow_run: { id: Number(evidence.run_id), head_sha: TOOLING_SHA },
  };
  const workflowRun = {
    id: Number(evidence.run_id),
    run_attempt: evidence.run_attempt,
    path: ".github/workflows/full-release-validation.yml",
    head_sha: TOOLING_SHA,
    head_branch: "main",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    repository: { full_name: "openclaw/openclaw" },
    head_repository: { full_name: "openclaw/openclaw" },
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith(`/actions/artifacts/${evidence.artifact_id}`)) {
      return Response.json(artifactMetadata);
    }
    if (url.endsWith(`/actions/runs/${evidence.run_id}/attempts/${evidence.run_attempt}`)) {
      return Response.json(workflowRun);
    }
    if (url.endsWith(`/actions/artifacts/${evidence.artifact_id}/zip`)) {
      return new Response(archiveBytes as unknown as BodyInit, {
        status: 200,
        headers: { "content-length": String(archiveBytes.length) },
      });
    }
    return new Response("unexpected", { status: 404 });
  }) as typeof fetch;
  return {
    params: {
      evidence: normalizedEvidence,
      expected: {
        repository: "openclaw/openclaw",
        workflowPath: ".github/workflows/full-release-validation.yml",
        workflowSha: TOOLING_SHA,
        artifactSizeBytes: archiveBytes.length,
        runStatePolicy: "completed-success" as const,
        workflowEvent: "workflow_dispatch",
        workflowHeadBranch: "main",
      },
      token: "test-token",
      nowMs: Math.min(
        Date.parse(evidence.expires_at) - 1,
        Date.parse(evidence.created_at) + 60 * 60 * 1000,
      ),
      retryAttempts: 1,
    },
    artifactMetadata,
    workflowRun,
    archiveBytes,
    fetchImpl,
  };
}

async function authenticateEvidence(
  evidence: RawArtifactEvidence,
): Promise<ReleaseValidationVerifiedArtifactEvidence> {
  return downloadFixture(githubArtifactDownloadFixture(evidence));
}

async function downloadFixture(
  fixture: ReturnType<typeof githubArtifactDownloadFixture>,
): Promise<ReleaseValidationVerifiedArtifactEvidence> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fixture.fetchImpl;
  try {
    return await downloadAndAuthenticateGitHubReleaseValidationArtifact(fixture.params);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function sourceArtifacts(
  fixture: FixtureBase,
): Promise<ReleaseValidationVerifiedArtifactEvidence[]> {
  const coordinates = [
    {
      kind: "decision",
      artifact_id: "9201",
      artifact_name: `full-release-decision-9001-${fixture.decision.parent_run_attempt}`,
      entry_name: "full-release-decision.json",
      run_attempt: fixture.decision.parent_run_attempt,
      content: fixture.decision,
      created_at: addSeconds(fixture.decision.observed_at, 60),
    },
    {
      kind: "diagnostic-drain",
      artifact_id: "9202",
      artifact_name: `full-release-diagnostics-9001-${fixture.diagnosticDrain.parent_run_attempt}`,
      entry_name: "full-release-diagnostic-manifest.json",
      run_attempt: fixture.diagnosticDrain.parent_run_attempt,
      content: fixture.diagnosticDrain,
      created_at: addSeconds(fixture.diagnosticDrain.observed_at, 60),
    },
    {
      kind: "execution-plan",
      artifact_id: "9203",
      artifact_name: "full-release-execution-plan-9001",
      entry_name: "full-release-execution-plan.json",
      run_attempt: fixture.executionPlan.parent_run_attempt,
      content: fixture.executionPlan,
      created_at: addSeconds(fixture.executionPlan.started_at, 60),
    },
    {
      kind: "release-plan-lock",
      artifact_id: "9204",
      artifact_name: `release-plan-lock-9001-${fixture.executionPlan.parent_run_attempt}`,
      entry_name: "release-plan-lock.json",
      run_attempt: fixture.executionPlan.parent_run_attempt,
      content: fixture.releasePlanLock,
      created_at: addSeconds(fixture.executionPlan.started_at, -60),
    },
  ] as const;
  const result: ReleaseValidationVerifiedArtifactEvidence[] = [];
  for (const artifact of coordinates) {
    const entryBytes = canonicalReleaseJson(artifact.content);
    result.push(
      await authenticateEvidence({
        kind: artifact.kind,
        artifact_id: artifact.artifact_id,
        artifact_name: artifact.artifact_name,
        entry_name: artifact.entry_name,
        run_id: PARENT_RUN_ID,
        run_attempt: artifact.run_attempt,
        archive_digest: `sha256:${"0".repeat(64)}`,
        content_digest: exactBytesDigest(entryBytes),
        created_at: artifact.created_at,
        expires_at: addSeconds(artifact.created_at, 7 * 24 * 60 * 60),
        url: `${PARENT_RUN_URL}/artifacts/${artifact.artifact_id}`,
        entry_bytes: entryBytes,
      }),
    );
  }
  return result;
}

function inputFixtureBase(): FixtureBase {
  const executionPlan = executionPlanFixture();
  const decision = decisionFixture(executionPlan);
  return {
    releasePlanLock: createReleasePlanLock(sourceFixture),
    executionPlan,
    decision,
    diagnosticDrain: diagnosticDrainFixture(decision),
    sealedAt: "2026-08-21T10:32:00Z",
  };
}

function mainDailyFixtureBase(): FixtureBase {
  return {
    ...inputFixtureBase(),
    releasePlanLock: createReleasePlanLock({
      ...sourceFixture,
      purpose: "main-qualification",
      tag: null,
      target_context_ref: TARGET_SHA,
      validation: {
        allowed_groups: ["all", "ci", "package"],
        intent: "main-daily",
        profile: "beta",
        soak: false,
      },
    }),
  };
}

let defaultSourceArtifacts: ReleaseValidationVerifiedArtifactEvidence[] = [];
let dailySourceArtifacts: ReleaseValidationVerifiedArtifactEvidence[] = [];

beforeAll(async () => {
  defaultSourceArtifacts = await sourceArtifacts(inputFixtureBase());
  dailySourceArtifacts = await sourceArtifacts(mainDailyFixtureBase());
});

function inputFixture(): Fixture {
  return { ...inputFixtureBase(), sourceArtifacts: [...defaultSourceArtifacts] };
}

async function refreshArtifacts(fixture: Fixture): Promise<Fixture> {
  fixture.sourceArtifacts = await sourceArtifacts(fixture);
  return fixture;
}

async function replaceEvidence(
  fixture: Fixture,
  index: number,
  mutate: (value: Record<string, any>) => void,
): Promise<void> {
  const value = structuredClone(fixture.sourceArtifacts[index]) as Record<string, any>;
  mutate(value);
  fixture.sourceArtifacts[index] = await authenticateEvidence(value as RawArtifactEvidence);
}

function mainDailyInputFixture(): Fixture {
  return { ...mainDailyFixtureBase(), sourceArtifacts: [...dailySourceArtifacts] };
}

async function shiftFixture(fixture: Fixture, seconds: number): Promise<Fixture> {
  const shiftObject = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (
        typeof entry === "string" &&
        (key === "started_at" || key === "completed_at" || key === "observed_at")
      ) {
        (value as Record<string, unknown>)[key] = addSeconds(entry, seconds);
      } else {
        shiftObject(entry);
      }
    }
  };
  shiftObject(fixture.executionPlan);
  shiftObject(fixture.decision);
  shiftObject(fixture.diagnosticDrain);
  fixture.decision.execution_plan_digest = releaseCanonicalDigest(fixture.executionPlan);
  fixture.diagnosticDrain.execution_plan_digest = releaseCanonicalDigest(fixture.executionPlan);
  fixture.sealedAt = addSeconds(fixture.sealedAt, seconds);
  return refreshArtifacts(fixture);
}

function locatorFixture(receipt: ReturnType<typeof sealReleaseValidationReceipt>) {
  return {
    repository: "openclaw/openclaw",
    run_id: receipt.attempt.run_id,
    run_attempt: receipt.attempt.run_attempt,
    artifact_id: "9301",
    artifact_name: `release-validation-receipt-${receipt.attempt.run_id}-${receipt.attempt.run_attempt}`,
    entry_name: "release-validation-receipt.json",
    archive_digest: `sha256:${"9".repeat(64)}`,
    url: `${receipt.attempt.url}/artifacts/9301`,
  };
}

describe("release validation receipt source sealer", () => {
  it("does not expose caller-controlled evidence branding", () => {
    expect(receiptContract).not.toHaveProperty("verifyReleaseValidationArtifactEvidence");
    expect(githubAuthenticator).not.toHaveProperty("authenticateGitHubReleaseValidationArtifact");
  });

  it("derives the release-valid receipt from the locked plan and source evidence", () => {
    const input = inputFixture();
    expect(
      input.sourceArtifacts.every(isAuthenticatedGitHubReleaseValidationArtifactEvidence),
    ).toBe(true);
    const receipt = sealReleaseValidationReceipt(input);

    expect(receipt.target).toEqual({
      repository: "openclaw/openclaw",
      ref: "refs/tags/v2026.8.1-beta.2",
      sha: TARGET_SHA,
    });
    expect(receipt.tooling).toEqual(input.releasePlanLock.plan.tooling);
    expect(receipt.release_plan).toEqual({
      schema: "openclaw.release-plan.v1",
      purpose: "beta-publish",
      plan_digest: input.releasePlanLock.digest,
      lock_digest: releaseCanonicalDigest(input.releasePlanLock),
    });
    expect(receipt.validation).toEqual({
      intent: "release-beta",
      profile: "beta",
      soak: false,
      allowed_groups: ["all", "ci", "package"],
      rerun_group: "all",
      policy: { id: "openclaw.release-validation-policy.v1", fail_fast: false },
    });
    expect(receipt).not.toHaveProperty("outcome");
    expect(receipt.groups).toEqual(
      input.executionPlan.groups.map((group, index) => {
        const observed = input.diagnosticDrain.groups[index]!;
        return {
          ...group,
          conclusion: observed.conclusion,
          completed_at: observed.completed_at,
          jobs: observed.jobs,
        };
      }),
    );
    expect(verifyReleaseValidationReceipt(receipt, input)).toEqual(receipt);
  });

  it("rejects self-declared receipt changes even when the changed receipt is structurally valid", () => {
    const input = inputFixture();
    const receipt = sealReleaseValidationReceipt(input);
    const mutations = [
      (value: Record<string, any>) => (value.target.sha = "c".repeat(40)),
      (value: Record<string, any>) => (value.tooling.sha = "c".repeat(40)),
      (value: Record<string, any>) => (value.release_plan.plan_digest = `sha256:${"c".repeat(64)}`),
      (value: Record<string, any>) => (value.validation.allowed_groups = ["all", "ci"]),
      (value: Record<string, any>) => (value.groups[0].policy = "optional"),
      (value: Record<string, any>) => (value.groups[0].jobs[0].name = "other"),
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(receipt) as unknown as Record<string, any>;
      mutate(changed);
      expect(() => verifyReleaseValidationReceipt(changed, input)).toThrow();
    }
  });

  it("binds execution target, tooling, profile, and selected group to the ReleasePlan lock", async () => {
    const mutations = [
      (value: Fixture) => (value.executionPlan.target_sha = "c".repeat(40)),
      (value: Fixture) => (value.executionPlan.workflow_sha = "c".repeat(40)),
      (value: Fixture) => (value.executionPlan.release_profile = "full"),
      (value: Fixture) => (value.executionPlan.rerun_group = "performance"),
    ];
    for (const mutate of mutations) {
      const input = inputFixture();
      mutate(input);
      input.decision.execution_plan_digest = releaseCanonicalDigest(input.executionPlan);
      input.diagnosticDrain.execution_plan_digest = releaseCanonicalDigest(input.executionPlan);
      await refreshArtifacts(input);
      expect(() => sealReleaseValidationReceipt(input)).toThrow(/validated ReleasePlan|tooling/);
    }
  });

  it("requires every blocking job and run to succeed before Decision", async () => {
    const mutations = [
      (value: Fixture) => (value.decision.groups[0]!.status = "in_progress"),
      (value: Fixture) => (value.decision.groups[0]!.conclusion = "failure"),
      (value: Fixture) => (value.decision.groups[0]!.conclusion = "neutral"),
      (value: Fixture) => (value.decision.groups[0]!.jobs[0]!.status = "in_progress"),
      (value: Fixture) => (value.decision.groups[0]!.jobs[0]!.conclusion = "failure"),
      (value: Fixture) => (value.decision.groups[0]!.jobs[0]!.conclusion = "skipped"),
      (value: Fixture) =>
        (value.decision.groups[0]!.jobs[0]!.completed_at = "2026-08-21T10:01:00Z"),
    ];
    for (const mutate of mutations) {
      const input = inputFixture();
      mutate(input);
      await refreshArtifacts(input);
      expect(() => sealReleaseValidationReceipt(input)).toThrow(
        /blocking (group|job)|inconsistent/,
      );
    }
  });

  it("requires monotonic execution, Decision, and Drain attempts", async () => {
    const lateExecution = inputFixture();
    lateExecution.executionPlan.parent_run_attempt = 3;
    lateExecution.decision.source_parent_run_attempt = 3;
    lateExecution.diagnosticDrain.source_parent_run_attempt = 3;
    lateExecution.decision.execution_plan_digest = releaseCanonicalDigest(
      lateExecution.executionPlan,
    );
    lateExecution.diagnosticDrain.execution_plan_digest =
      lateExecution.decision.execution_plan_digest;
    await refreshArtifacts(lateExecution);
    expect(() => sealReleaseValidationReceipt(lateExecution)).toThrow(
      "source attempt or timestamp order",
    );

    const earlyDrain = inputFixture();
    earlyDrain.decision.parent_run_attempt = 3;
    await refreshArtifacts(earlyDrain);
    expect(() => sealReleaseValidationReceipt(earlyDrain)).toThrow(
      "source attempt or timestamp order",
    );
  });

  it("requires diagnostic completion before Drain and immutable blocking evidence after Decision", async () => {
    const incomplete = inputFixture();
    incomplete.diagnosticDrain.groups[1]!.jobs[0]!.status = "in_progress";
    incomplete.diagnosticDrain.groups[1]!.jobs[0]!.conclusion = null;
    incomplete.diagnosticDrain.groups[1]!.jobs[0]!.completed_at = null;
    await refreshArtifacts(incomplete);
    expect(() => sealReleaseValidationReceipt(incomplete)).toThrow(/drained job|inconsistent/);

    const changed = inputFixture();
    changed.diagnosticDrain.groups[0]!.jobs[0]!.completed_at = "2026-08-21T09:26:00Z";
    changed.diagnosticDrain.groups[0]!.completed_at = "2026-08-21T09:26:00Z";
    await refreshArtifacts(changed);
    expect(() => sealReleaseValidationReceipt(changed)).toThrow("blocking job changed");

    const omitted = inputFixture();
    omitted.diagnosticDrain.groups[0]!.jobs = [];
    await refreshArtifacts(omitted);
    expect(() => sealReleaseValidationReceipt(omitted)).toThrow(/non-empty array|blocking job/);

    const blockingDiagnostic = inputFixture();
    blockingDiagnostic.diagnosticDrain.groups[1]!.jobs[0]!.policy = "blocking";
    await refreshArtifacts(blockingDiagnostic);
    expect(() => sealReleaseValidationReceipt(blockingDiagnostic)).toThrow(
      "diagnostic group contains a blocking job",
    );
  });

  it("requires exact source artifact identities, coordinates, names, URLs, and digests", async () => {
    const mutations: Array<(value: Fixture) => Promise<void>> = [
      (value) =>
        replaceEvidence(value, 1, (artifact) => {
          artifact.artifact_id = "9201";
          artifact.url = `${PARENT_RUN_URL}/artifacts/9201`;
        }),
      (value) =>
        replaceEvidence(value, 0, (artifact) => {
          artifact.artifact_name = "full-release-decision-9001";
        }),
      (value) =>
        replaceEvidence(value, 0, (artifact) => {
          artifact.entry_name = "decision.json";
        }),
      (value) =>
        replaceEvidence(value, 0, (artifact) => {
          artifact.run_attempt = 1;
        }),
      (value) =>
        replaceEvidence(value, 0, (artifact) => {
          artifact.content_digest = `sha256:${"f".repeat(64)}`;
        }),
      (value) =>
        replaceEvidence(value, 0, (artifact) => {
          artifact.url = "https://github.com/openclaw/openclaw/actions/runs/9001/artifacts/9999";
        }),
      (value) =>
        replaceEvidence(value, 1, (artifact) => {
          artifact.created_at = "2026-08-21T10:29:59Z";
        }),
    ];
    for (const mutate of mutations) {
      const input = inputFixture();
      await expect(async () => {
        await mutate(input);
        sealReleaseValidationReceipt(input);
      }).rejects.toThrow(
        /unique|coordinates|must equal|timestamps|content_digest|exact GitHub Actions artifact/,
      );
    }
  });

  it("requires GitHub-authenticated evidence and hashes exact canonical entry bytes", () => {
    const input = inputFixture();
    const unverified = structuredClone(input.sourceArtifacts[0]!);
    input.sourceArtifacts[0] = unverified;
    expect(() => sealReleaseValidationReceipt(input)).toThrow(
      "must be authenticated artifact evidence",
    );

    const synthetic = structuredClone(inputFixture().sourceArtifacts[0]!);
    const callerValidated = (
      validateReleaseValidationArtifactEvidence as (
        ...args: unknown[]
      ) => ReturnType<typeof validateReleaseValidationArtifactEvidence>
    )(synthetic, () => true);
    expect(isAuthenticatedGitHubReleaseValidationArtifactEvidence(callerValidated)).toBe(false);
    input.sourceArtifacts[0] =
      callerValidated as unknown as ReleaseValidationVerifiedArtifactEvidence;
    expect(() => sealReleaseValidationReceipt(input)).toThrow(
      "must be authenticated artifact evidence",
    );

    const noncanonical = structuredClone(inputFixture().sourceArtifacts[0]!) as unknown as Record<
      string,
      any
    >;
    noncanonical.entry_bytes = `${JSON.stringify(inputFixture().decision, null, 2)}\n`;
    noncanonical.content_digest = exactBytesDigest(noncanonical.entry_bytes);
    expect(() => validateReleaseValidationArtifactEvidence(noncanonical)).toThrow(
      /compact printable ASCII|canonical bytes/,
    );

    const changed = inputFixture();
    const changedDecision = {
      ...changed.decision,
      observed_at: addSeconds(changed.decision.observed_at, 1),
    };
    const changedEvidence = structuredClone(changed.sourceArtifacts[0]!) as unknown as Record<
      string,
      any
    >;
    changedEvidence.entry_bytes = canonicalReleaseJson(changedDecision);
    changedEvidence.content_digest = exactBytesDigest(changedEvidence.entry_bytes);
    changed.sourceArtifacts[0] = validateReleaseValidationArtifactEvidence(
      changedEvidence,
    ) as unknown as ReleaseValidationVerifiedArtifactEvidence;
    expect(() => sealReleaseValidationReceipt(changed)).toThrow(
      "must be authenticated artifact evidence",
    );
  });

  it("rejects mismatched GitHub metadata, expiry, workflow identity, and archive bytes", async () => {
    const raw = structuredClone(
      inputFixture().sourceArtifacts[0]!,
    ) as unknown as RawArtifactEvidence;

    const expired = githubArtifactDownloadFixture(raw);
    (expired.artifactMetadata as Record<string, unknown>).expired = true;
    await expect(downloadFixture(expired)).rejects.toThrow(/metadata|immutable publication tuple/);

    const wrongCreated = githubArtifactDownloadFixture(raw);
    (wrongCreated.artifactMetadata as Record<string, unknown>).created_at = "2026-08-21T10:02:00Z";
    await expect(downloadFixture(wrongCreated)).rejects.toThrow("metadata differs");

    const wrongWorkflow = githubArtifactDownloadFixture(raw);
    (wrongWorkflow.workflowRun as Record<string, unknown>).path = ".github/workflows/ci.yml";
    await expect(downloadFixture(wrongWorkflow)).rejects.toThrow(/workflow run|workflow metadata/);

    for (const mutate of [
      (params: ReturnType<typeof githubArtifactDownloadFixture>) => {
        (params.artifactMetadata as Record<string, unknown>).id = 9999;
      },
      (params: ReturnType<typeof githubArtifactDownloadFixture>) => {
        (params.artifactMetadata as Record<string, unknown>).name = "wrong-name";
      },
      (params: ReturnType<typeof githubArtifactDownloadFixture>) => {
        (params.artifactMetadata as Record<string, unknown>).digest = `sha256:${"f".repeat(64)}`;
      },
      (params: ReturnType<typeof githubArtifactDownloadFixture>) => {
        (params.workflowRun as Record<string, unknown>).run_attempt = 99;
      },
      (params: ReturnType<typeof githubArtifactDownloadFixture>) => {
        (params.workflowRun as Record<string, any>).repository.full_name = "other/repo";
      },
    ]) {
      const mismatched = githubArtifactDownloadFixture(raw);
      mutate(mismatched);
      await expect(downloadFixture(mismatched)).rejects.toThrow(
        /metadata|immutable publication tuple|workflow run/,
      );
    }

    const unsupportedAuthority = githubArtifactDownloadFixture(raw);
    unsupportedAuthority.params.expected.repository = "other/repo";
    await expect(downloadFixture(unsupportedAuthority)).rejects.toThrow(
      /authority is unsupported|immutable publication tuple/,
    );

    const tamperedArchive = githubArtifactDownloadFixture(raw);
    tamperedArchive.archiveBytes.writeUInt8(tamperedArchive.archiveBytes.readUInt8(40) ^ 1, 40);
    await expect(downloadFixture(tamperedArchive)).rejects.toThrow(/artifact digest/);
  });
});

describe("release validation receipt lineage", () => {
  it("requires actual parent and root receipts for continuous same-intent lineage", async () => {
    const rootInput = inputFixture();
    const root = sealReleaseValidationReceipt(rootInput);
    expect(root.lineage).toEqual({
      generation: 0,
      root_receipt_digest: null,
      parent_receipt_digest: null,
    });
    expect(verifyReleaseValidationReceiptLineage(root)).toEqual(root.lineage);

    const childInput = await shiftFixture(inputFixture(), 86_400);
    expect(() =>
      sealReleaseValidationReceipt({
        ...childInput,
        parentReceipt: structuredClone(root),
      }),
    ).toThrow("must be an authenticated release validation receipt");
    const child = sealReleaseValidationReceipt({ ...childInput, parentReceipt: root });
    expect(child.lineage).toEqual({
      generation: 1,
      root_receipt_digest: releaseValidationReceiptDigest(root),
      parent_receipt_digest: releaseValidationReceiptDigest(root),
    });
    expect(
      verifyReleaseValidationReceiptLineage(child, { parentReceipt: root, rootReceipt: root }),
    ).toEqual(child.lineage);

    const grandchildInput = await shiftFixture(inputFixture(), 172_800);
    const grandchild = sealReleaseValidationReceipt({
      ...grandchildInput,
      parentReceipt: child,
      rootReceipt: root,
    });
    expect(grandchild.lineage.generation).toBe(2);
    expect(
      verifyReleaseValidationReceiptLineage(grandchild, {
        parentReceipt: child,
        rootReceipt: root,
      }),
    ).toEqual(grandchild.lineage);
    expect(() =>
      sealReleaseValidationReceipt({ ...grandchildInput, parentReceipt: child }),
    ).toThrow("actual root receipt");
  });

  it("rejects forged roots, different intent policy, late parents, and lineage-field tampering", async () => {
    const root = sealReleaseValidationReceipt(inputFixture());
    const childInput = await shiftFixture(inputFixture(), 86_400);
    const child = sealReleaseValidationReceipt({ ...childInput, parentReceipt: root });
    const grandchildInput = await shiftFixture(inputFixture(), 172_800);
    const unrelatedRoot = sealReleaseValidationReceipt({
      ...inputFixture(),
      sealedAt: "2026-08-21T10:33:00Z",
    });
    expect(() =>
      sealReleaseValidationReceipt({
        ...grandchildInput,
        parentReceipt: child,
        rootReceipt: unrelatedRoot,
      }),
    ).toThrow("does not continue");

    const differentIntent = sealReleaseValidationReceipt(mainDailyInputFixture());
    expect(() =>
      sealReleaseValidationReceipt({
        ...childInput,
        parentReceipt: differentIntent,
      }),
    ).toThrow("different intent policy");

    const changedAfterAuthentication = sealReleaseValidationReceipt(inputFixture());
    changedAfterAuthentication.validation.rerun_group = "ci";
    expect(() =>
      sealReleaseValidationReceipt({
        ...childInput,
        parentReceipt: changedAfterAuthentication,
      }),
    ).toThrow("changed after it was authenticated");

    expect(() => sealReleaseValidationReceipt({ ...inputFixture(), parentReceipt: root })).toThrow(
      "sealed after its child started",
    );

    const forged = structuredClone(child);
    forged.lineage.parent_receipt_digest = `sha256:${"f".repeat(64)}`;
    expect(() =>
      verifyReleaseValidationReceiptLineage(forged, {
        parentReceipt: root,
        rootReceipt: root,
      }),
    ).toThrow("differs from the supplied parent/root");
  });
});

describe("release validation receipt reuse freshness", () => {
  const sealedAtMs = Date.parse("2026-08-21T10:32:00Z");

  it("selects the intent policy and returns the bounded effective expiry", () => {
    const receipt = sealReleaseValidationReceipt(inputFixture());
    expect(
      validateReleaseValidationReceiptReuseFreshness(receipt, {
        now_ms: sealedAtMs + 60 * 60 * 1000,
        max_future_skew_ms: 60_000,
      }),
    ).toEqual({
      intent: "release-beta",
      age_ms: 60 * 60 * 1000,
      max_age_ms: 6 * 60 * 60 * 1000,
      cadence_ms: 6 * 60 * 60 * 1000,
      expires_at_ms: sealedAtMs + 6 * 60 * 60 * 1000,
    });
  });

  it("rejects invalid clocks and evidence beyond the allowed future skew", () => {
    const receipt = sealReleaseValidationReceipt(inputFixture());
    expect(() =>
      validateReleaseValidationReceiptReuseFreshness(structuredClone(receipt), {
        now_ms: sealedAtMs,
        max_future_skew_ms: 0,
      }),
    ).toThrow("authenticated release validation receipt");
    for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(() =>
        validateReleaseValidationReceiptReuseFreshness(receipt, {
          now_ms: nowMs,
          max_future_skew_ms: 60_000,
        }),
      ).toThrow("now_ms");
    }
    for (const futureSkewMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(() =>
        validateReleaseValidationReceiptReuseFreshness(receipt, {
          now_ms: sealedAtMs,
          max_future_skew_ms: futureSkewMs,
        }),
      ).toThrow("max_future_skew_ms");
    }
    expect(() =>
      validateReleaseValidationReceiptReuseFreshness(receipt, {
        now_ms: sealedAtMs - 61_000,
        max_future_skew_ms: 60_000,
      }),
    ).toThrow("future skew");
    expect(() =>
      validateReleaseValidationReceiptReuseFreshness(receipt, {
        now_ms: Number.MAX_SAFE_INTEGER,
        max_future_skew_ms: 1,
      }),
    ).toThrow("future skew");
  });

  it("expires at the policy window or earlier authenticated artifact expiry", async () => {
    const receipt = sealReleaseValidationReceipt(inputFixture());
    expect(() =>
      validateReleaseValidationReceiptReuseFreshness(receipt, {
        now_ms: sealedAtMs + 6 * 60 * 60 * 1000,
        max_future_skew_ms: 0,
      }),
    ).toThrow("expired");

    const artifactBoundInput = inputFixture();
    const shortLived = structuredClone(
      artifactBoundInput.sourceArtifacts[0]!,
    ) as unknown as RawArtifactEvidence;
    shortLived.expires_at = addSeconds("2026-08-21T10:32:00Z", 30 * 60);
    artifactBoundInput.sourceArtifacts[0] = await authenticateEvidence(shortLived);
    const artifactBoundReceipt = sealReleaseValidationReceipt(artifactBoundInput);
    expect(() =>
      validateReleaseValidationReceiptReuseFreshness(artifactBoundReceipt, {
        now_ms: sealedAtMs + 30 * 60 * 1000,
        max_future_skew_ms: 0,
      }),
    ).toThrow("expired");
  });

  it("uses fixed per-intent policy and rejects caller-supplied policy overrides", () => {
    const betaReceipt = sealReleaseValidationReceipt(inputFixture());
    expect(() =>
      validateReleaseValidationReceiptReuseFreshness(betaReceipt, {
        now_ms: sealedAtMs + 7 * 60 * 60 * 1000,
        max_future_skew_ms: 0,
      }),
    ).toThrow("expired");

    const dailyReceipt = sealReleaseValidationReceipt(mainDailyInputFixture());
    expect(
      validateReleaseValidationReceiptReuseFreshness(dailyReceipt, {
        now_ms: sealedAtMs + 7 * 60 * 60 * 1000,
        max_future_skew_ms: 0,
      }),
    ).toMatchObject({
      intent: "main-daily",
      max_age_ms: 24 * 60 * 60 * 1000,
      cadence_ms: 24 * 60 * 60 * 1000,
    });

    const optionsWithPolicyOverride = {
      now_ms: sealedAtMs,
      max_future_skew_ms: 0,
      policies: {},
    };
    expect(() =>
      validateReleaseValidationReceiptReuseFreshness(betaReceipt, optionsWithPolicyOverride),
    ).toThrow("keys must be exactly");
  });
});

describe("release validation receipt canonical bytes and locator", () => {
  it("rejects unknown fields, duplicate keys, noncanonical bytes, and digest tampering", () => {
    const input = inputFixture();
    const receipt = sealReleaseValidationReceipt(input);
    const text = canonicalReleaseValidationReceiptJson(receipt);
    expect(parseReleaseValidationReceiptJson(text)).toEqual(receipt);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.slice(0, -1)).toMatch(/^[\x20-\x7e]+$/u);

    expect(() => validateReleaseValidationReceipt({ ...receipt, extra: true })).toThrow(
      "keys must be exactly",
    );
    expect(() =>
      parseReleaseValidationReceiptJson(
        text.replace(
          '{"attempt":',
          `{"attempt":${canonicalReleaseJson(receipt.attempt).trim()},"attempt":`,
        ),
      ),
    ).toThrow(/duplicate key|canonical bytes/);
    expect(() => parseReleaseValidationReceiptJson(JSON.stringify(receipt, null, 2))).toThrow(
      /trailing LF|compact printable ASCII/,
    );

    const changed = structuredClone(receipt);
    changed.release_plan.lock_digest = `sha256:${"e".repeat(64)}`;
    expect(() => verifyReleaseValidationReceipt(changed, input)).toThrow();
  });

  it("binds the locator to exact receipt attempt, artifact coordinates, URL, and digest", () => {
    const receipt = sealReleaseValidationReceipt(inputFixture());
    const locator = createReleaseValidationReceiptLocator(receipt, locatorFixture(receipt));
    const text = canonicalReleaseValidationReceiptLocatorJson(locator);
    expect(parseReleaseValidationReceiptLocatorJson(text)).toEqual(locator);
    expect(validateReleaseValidationReceiptLocatorForReceipt(locator, receipt)).toEqual(locator);

    for (const mutate of [
      (value: Record<string, any>) => (value.receipt_digest = `sha256:${"e".repeat(64)}`),
      (value: Record<string, any>) => (value.locator.run_attempt = 1),
      (value: Record<string, any>) => (value.locator.artifact_name = "receipt"),
      (value: Record<string, any>) =>
        (value.locator.url =
          "https://github.com/openclaw/openclaw/actions/runs/9001/artifacts/9999"),
    ]) {
      const changed = structuredClone(locator) as unknown as Record<string, any>;
      mutate(changed);
      expect(() => validateReleaseValidationReceiptLocatorForReceipt(changed, receipt)).toThrow();
    }
  });

  it("strictly validates execution and state source schemas", () => {
    const input = inputFixture();
    expect(validateReleaseValidationExecutionPlanSource(input.executionPlan)).toEqual(
      input.executionPlan,
    );
    expect(validateReleaseValidationStateSource(input.decision, "decision")).toEqual(
      input.decision,
    );
    expect(() =>
      validateReleaseValidationExecutionPlanSource({ ...input.executionPlan, extra: true }),
    ).toThrow("keys must be exactly");
    expect(() =>
      validateReleaseValidationStateSource(
        { ...input.decision, schema: "openclaw.full-release-decision.v1" },
        "decision",
      ),
    ).toThrow("schema must be");
  });
});

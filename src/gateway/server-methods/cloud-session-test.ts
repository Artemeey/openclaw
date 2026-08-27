import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  CloudSessionTestResult,
  WizardStartParams,
} from "../../../packages/gateway-protocol/src/schema/wizard.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { hasPendingFollowupQueueWork } from "../../auto-reply/reply/queue/state.js";
import { resolveStateDir } from "../../config/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { hasErrnoCode } from "../../infra/errno.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import type { WizardSession } from "../../wizard/session.js";
import { beginCloudSessionTest } from "../worker-environments/cloud-session-test-cleanup.js";
import {
  assertCloudSessionTestOwner,
  completeCloudSessionTestCleanup,
} from "../worker-environments/cloud-session-test-record.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-record.js";
import { deriveEnvironmentIntent } from "../worker-environments/service-contract.js";
import { boundedWorkerError } from "../worker-environments/worker-error.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const CLOUD_SESSION_TEST_TIMEOUT_MS = 10 * 60_000;

async function createProofRepository(): Promise<string> {
  const root = path.join(resolveStateDir(), "cloud-test-workspaces");
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, "session-test-"));
  // This is retained product proof, not a state sidecar. Empty templates and
  // the shared Git wrapper prevent user Git hooks from running in the fixture.
  await requireGit(dir, ["init", "--template=", "-b", "main"]);
  await fs.writeFile(
    path.join(dir, "README.md"),
    "# OpenClaw cloud session test\n\nA retained workspace for one cloud roundtrip proof.\n",
    { flag: "wx" },
  );
  await requireGit(dir, ["add", "README.md"]);
  await requireGit(dir, [
    "-c",
    "user.name=OpenClaw",
    "-c",
    "user.email=cloud-test@openclaw.invalid",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    "Initialize cloud test workspace",
  ]);
  return dir;
}

export async function runCloudSessionTest(params: {
  options: GatewayRequestHandlerOptions;
  request: WizardStartParams;
  prompter: WizardPrompter;
  signal: AbortSignal;
  wizard: WizardSession;
}): Promise<void> {
  const { options, request, prompter, signal, wizard } = params;
  const { context, client, isWebchatConnect } = options;
  let result: CloudSessionTestResult = {
    stage: "confirmation",
    status: "running",
    cleanup: "not-allocated",
  };
  const publish = (patch: Partial<CloudSessionTestResult>) => {
    result = {
      ...result,
      ...patch,
      ...(patch.stage === "finished" ? { endedAt: Date.now() } : {}),
    };
    wizard.setCloudSessionTest(result);
    if (patch.message) {
      wizard.pushProgress(patch.message);
    }
  };
  wizard.setCloudSessionTest(result);
  let confirmed: boolean;
  try {
    confirmed = await prompter.confirm({
      message:
        "Run a cloud session test? This creates a temporary cloud worker and runs one model turn. Both cloud and model usage may be billed. OpenClaw will verify a file roundtrip and attempt worker teardown; failed cleanup stays pending for recovery.",
      initialValue: false,
    });
  } catch (error) {
    publish({
      stage: "finished",
      status: signal.aborted ? "cancelled" : "failed",
      message: boundedWorkerError(error),
    });
    return;
  }
  if (!confirmed) {
    publish({
      stage: "finished",
      status: "cancelled",
      message: "Test declined; no worker allocated.",
    });
    return;
  }
  if (signal.aborted) {
    publish({
      stage: "finished",
      status: "cancelled",
      message: "Test cancelled; no worker allocated.",
    });
    return;
  }
  const service = context.workerPlacementDispatchService;
  const placementReader = context.workerSessionPlacementService;
  const environments = context.workerEnvironmentService;
  if (
    !client ||
    client.connect.role !== "operator" ||
    client.internal?.syntheticClient ||
    !service?.reclaim ||
    !placementReader ||
    !environments ||
    !request.profileId
  ) {
    publish({
      stage: "finished",
      status: "failed",
      message: "Cloud test requires an operator and configured session worker lifecycle.",
    });
    return;
  }
  const operationId = `cloud-test:${randomUUID()}`;
  const environmentId = deriveEnvironmentIntent(operationId).environmentId;
  const agentId = request.agentId ?? resolveDefaultAgentId(context.getRuntimeConfig());
  let identity: { sessionKey: string; sessionId: string; agentId: string } | undefined;
  let handle: Awaited<ReturnType<typeof beginCloudSessionTest>> | undefined;
  let active: Extract<WorkerSessionPlacementRecord, { state: "active" }> | undefined;
  let passed = false;
  let testRunId: string | undefined;
  let failure: string | undefined;
  let abortTurn: (() => void) | undefined;
  let abortPending: Promise<unknown> | undefined;
  // Keep the admitted operator object and run every operation through the normal
  // router. Losing the browser socket does not replace it with an admin actor.
  const { handleGatewayRequest } = await import("../server-methods.js");
  const call = async (
    method: string,
    rpcParams: Record<string, unknown>,
    rpcContext = context,
    onAdmissionOwned?: () => Promise<boolean>,
  ) => {
    let response: Record<string, unknown> | undefined;
    let error: string | undefined;
    const req: GatewayRequestHandlerOptions["req"] = {
      type: "req",
      id: randomUUID(),
      method,
      params: rpcParams,
    };
    const invoke = async () =>
      handleGatewayRequest({
        req,
        context: rpcContext,
        client,
        isWebchatConnect,
        respond: (ok, payload, rpcError) => {
          if (!ok) {
            error = rpcError?.message ?? "Cloud test request failed";
          } else {
            response = asOptionalRecord(payload);
          }
        },
      });
    if (onAdmissionOwned) {
      const { withSessionSendAdmission } = await import("./sessions-messaging.js");
      await withSessionSendAdmission(req, onAdmissionOwned, invoke);
    } else {
      await invoke();
    }
    if (error || !response) {
      throw new Error(error ?? "Cloud test received no operation result");
    }
    return response;
  };
  const assertActive = () => {
    handle?.assertLive();
    if (!identity || !active) {
      throw new Error("Cloud test has no active placement");
    }
    const current = placementReader.getMany([identity.sessionId]).get(identity.sessionId);
    assertCloudSessionTestOwner(identity, operationId);
    const entry = loadSessionEntry({ ...identity, readConsistency: "latest" });
    const environment = environments.get(environmentId);
    if (
      entry?.sessionId !== identity.sessionId ||
      current?.state !== "active" ||
      current.generation !== active.generation ||
      current.environmentId !== environmentId ||
      current.activeOwnerEpoch !== active.activeOwnerEpoch ||
      environment?.state !== "attached" ||
      environment.ownerEpoch !== active.activeOwnerEpoch ||
      environment.attachedSessionIds.length !== 1 ||
      environment.attachedSessionIds[0] !== identity.sessionId
    ) {
      throw new Error("Cloud test placement changed; no further test work is authorized");
    }
    return current;
  };
  const cleanup = async (testIdentity: {
    sessionKey: string;
    sessionId: string;
    agentId: string;
  }) => {
    const expected = placementReader.getMany([testIdentity.sessionId]).get(testIdentity.sessionId);
    assertCloudSessionTestOwner(testIdentity, operationId);
    if (expected?.environmentId && expected.environmentId !== environmentId) {
      throw new Error("Cloud test placement was replaced; cleanup needs inspection");
    }
    if (
      active &&
      expected?.state === "active" &&
      (expected.generation !== active.generation ||
        expected.activeOwnerEpoch !== active.activeOwnerEpoch)
    ) {
      throw new Error("Cloud test active placement was replaced");
    }
    const expectedEnvironment = environments.get(environmentId);
    const assertCleanupEnvironment = () => {
      const environment = environments.get(environmentId);
      if (
        environment?.ownerEpoch !== expectedEnvironment?.ownerEpoch ||
        (expected?.activeOwnerEpoch !== null &&
          expected?.activeOwnerEpoch !== undefined &&
          environment?.ownerEpoch !== expected.activeOwnerEpoch) ||
        (environment &&
          environment.attachedSessionIds.length > 0 &&
          (environment.attachedSessionIds.length !== 1 ||
            environment.attachedSessionIds[0] !== testIdentity.sessionId))
      ) {
        throw new Error("Cloud test environment ownership changed");
      }
    };
    const beforeDrain = () => {
      assertCloudSessionTestOwner(testIdentity, operationId);
      assertCleanupEnvironment();
      const lastRunId = loadSessionEntry({
        ...testIdentity,
        readConsistency: "latest",
      })?.lastRunId;
      if (lastRunId && lastRunId !== testRunId) {
        throw new Error("Cloud test cleanup found an independent completed turn");
      }
      const current = placementReader.getMany([testIdentity.sessionId]).get(testIdentity.sessionId);
      if (
        hasPendingFollowupQueueWork([testIdentity.sessionKey, testIdentity.sessionId]) ||
        (current?.turnClaim &&
          (current.turnClaim.runId !== testRunId ||
            current.turnClaim.generation !== expected?.generation))
      ) {
        throw new Error(
          "Cloud test cleanup found independent session work; cleanup remains pending",
        );
      }
      if (
        !expected ||
        current?.generation !== expected.generation ||
        current.state !== expected.state ||
        current.environmentId !== expected.environmentId ||
        current.activeOwnerEpoch !== expected.activeOwnerEpoch
      ) {
        throw new Error("Cloud test cleanup placement changed");
      }
    };
    if (expected && expected.state !== "local" && expected.state !== "reclaimed") {
      await call(
        "sessions.reclaim",
        { key: testIdentity.sessionKey, agentId },
        {
          ...context,
          workerPlacementDispatchService: {
            ...service,
            reclaim: async (reclaimRequest, authorize) =>
              service.reclaim!(
                reclaimRequest,
                () => {
                  authorize?.();
                  assertCloudSessionTestOwner(testIdentity, operationId);
                  assertCleanupEnvironment();
                  const current = placementReader
                    .getMany([testIdentity.sessionId])
                    .get(testIdentity.sessionId);
                  const environment = environments.get(environmentId);
                  const generation =
                    expected?.state === "active" && current?.state === "draining"
                      ? expected.generation + 1
                      : expected?.generation;
                  if (
                    !current ||
                    current.generation !== generation ||
                    current.environmentId !== expected?.environmentId ||
                    current.activeOwnerEpoch !== expected?.activeOwnerEpoch ||
                    environment?.ownerEpoch !== expectedEnvironment?.ownerEpoch
                  ) {
                    throw new Error("Cloud test teardown owner changed");
                  }
                },
                beforeDrain,
              ),
          },
        },
      );
    }
    const assertReleased = () => {
      const environment = environments.get(environmentId);
      if (
        environment &&
        environment.state !== "destroyed" &&
        !(environment.state === "failed" && environment.leaseId === null)
      ) {
        throw new Error("Cloud test worker teardown is not verified; cleanup remains pending");
      }
      const stage = loadSessionEntry({ ...testIdentity, readConsistency: "latest" })
        ?.cloudSessionTestCleanup?.binding.stage;
      if (!environment && (active || (stage && stage !== "pending" && stage !== "provisioning"))) {
        throw new Error("Cloud test worker disappeared without teardown proof");
      }
    };
    await completeCloudSessionTestCleanup(testIdentity, operationId, assertReleased);
    publish({
      cleanup: active || environments.get(environmentId) ? "verified" : "not-allocated",
    });
  };
  try {
    publish({ stage: "creating", message: "Creating a session-owned test workspace." });
    const cwd = request.workspace ?? (await createProofRepository());
    signal.throwIfAborted();
    const created = await call("sessions.create", {
      agentId,
      ...(request.model ? { model: request.model } : {}),
      cwd,
      worktree: true,
      worktreeBaseRef: "HEAD",
      label: "Cloud session test",
    });
    if (typeof created.key !== "string" || typeof created.sessionId !== "string") {
      throw new Error("Cloud test session creation did not return its identity");
    }
    identity = { sessionKey: created.key, sessionId: created.sessionId, agentId };
    handle = await beginCloudSessionTest(identity, operationId);
    signal.addEventListener("abort", handle.close, { once: true });
    if (signal.aborted) {
      handle.close();
    }
    publish({
      sessionKey: identity.sessionKey,
      environmentId,
      stage: "allocating",
      cleanup: "pending",
      message: "Allocating and preparing the selected cloud worker.",
    });
    signal.throwIfAborted();
    await call(
      "sessions.dispatch",
      { key: identity.sessionKey, agentId, profileId: request.profileId },
      {
        ...context,
        workerPlacementDispatchService: {
          ...service,
          dispatch: async (dispatchRequest, transition, authorize) => {
            signal.throwIfAborted();
            const ownedRequest = { ...dispatchRequest, idempotencyKey: operationId };
            handle!.bindDispatchRequest(ownedRequest);
            const placed = await service.dispatch(ownedRequest, transition, () => {
              authorize?.();
              signal.throwIfAborted();
              handle?.assertLive();
            });
            active = placed;
            return placed;
          },
        },
      },
    );
    await handle.bindActive(assertActive(), assertActive);
    const initialPlacement = assertActive();
    if (initialPlacement.turnClaim) {
      throw new Error("Cloud test session already has independent work");
    }
    const worktree = managedWorktrees.findLiveByOwner("session", identity.sessionKey);
    const entry = loadSessionEntry({ ...identity, readConsistency: "latest" });
    if (!worktree || worktree.id !== entry?.worktree?.id) {
      throw new Error("Cloud test lost its managed workspace");
    }
    const nonce = randomUUID();
    const filename = `openclaw-cloud-test-${randomUUID()}.txt`;
    const proofPath = path.join(entry?.spawnedCwd ?? worktree.path, filename);
    try {
      await fs.lstat(proofPath);
      throw new Error("Cloud test proof file already exists");
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
    }
    signal.throwIfAborted();
    const runId = randomUUID();
    testRunId = runId;
    await handle.expectTurn(runId, assertActive);
    handle.expectProof({
      path: path.relative(worktree.path, proofPath).split(path.sep).join("/"),
      sha256: createHash("sha256").update(nonce).digest("hex"),
      size: Buffer.byteLength(nonce),
    });
    publish({
      stage: "running",
      message:
        "Running one agent turn in the remote managed workspace. Normal approvals still apply.",
    });
    const testSessionKey = identity.sessionKey;
    const message = `In the current managed workspace, create ${filename} containing exactly the following ASCII text, with no newline or other bytes: ${nonce}. Do not modify any other files. If you cannot write the file, report the failure.`;
    // Both browser retry and main-session recovery exclude the cleanup marker.
    const sendParams = {
      key: testSessionKey,
      agentId,
      idempotencyKey: runId,
      message,
      timeoutMs: CLOUD_SESSION_TEST_TIMEOUT_MS,
    };
    const sent = await call("sessions.send", sendParams, context, async () => {
      signal.throwIfAborted();
      const current = assertActive();
      const lastRunId = loadSessionEntry({ ...identity!, readConsistency: "latest" })?.lastRunId;
      if (
        current.turnClaim ||
        hasPendingFollowupQueueWork([testSessionKey, identity!.sessionId]) ||
        (lastRunId && lastRunId !== runId)
      ) {
        throw new Error("Cloud test session acquired independent work before test admission");
      }
      const admitted = context.chatAbortControllers.get(runId);
      const assertAdmission = () => {
        signal.throwIfAborted();
        assertActive();
        if (
          !admitted ||
          context.chatAbortControllers.get(runId) !== admitted ||
          admitted.controller.signal.aborted ||
          admitted.sessionId !== identity!.sessionId ||
          admitted.sessionKey !== testSessionKey ||
          !admitted.lifecycleGeneration
        ) {
          throw new Error("Cloud test lost its admitted turn owner");
        }
      };
      assertAdmission();
      await handle!.bindTurnAdmission(runId, admitted!.lifecycleGeneration!, assertAdmission);
      abortTurn = () => {
        abortPending ??= call("chat.abort", { sessionKey: testSessionKey, runId }).catch(
          (error: unknown) => {
            failure ??= boundedWorkerError(error);
          },
        );
      };
      signal.addEventListener("abort", abortTurn, { once: true });
      return true;
    });
    if (sent.runId !== runId) {
      throw new Error("Cloud test turn was not admitted with its requested identity");
    }
    let terminal: Record<string, unknown>;
    do {
      signal.throwIfAborted();
      terminal = await call("agent.wait", { runId, timeoutMs: 1000 });
      if (terminal.status === "pending") {
        await delay(500, undefined, { signal });
      }
    } while (terminal.status === "pending" || (terminal.status === "timeout" && !terminal.endedAt));
    if (terminal.status !== "ok" || terminal.stopReason === "suspended" || terminal.yielded) {
      throw new Error(
        "Cloud test did not prove a completed remote turn; inspect the test session and any pending approvals",
      );
    }
    // Terminal delivery can precede placement settlement. Wait for the real
    // claim owner to release its workspace result before inspecting the file.
    while (!handle.observedTurn(runId)) {
      const current = assertActive();
      if (current.turnClaim?.runId !== runId) {
        throw new Error("Cloud test has no completed remote placement admission");
      }
      await delay(100, undefined, { signal });
    }
    assertActive();
    if (!handle.observedRemoteProof(runId)) {
      throw new Error("Cloud test file was not proven in the accepted remote workspace result");
    }
    publish({
      stage: "verifying",
      message: "Verifying the reconciled remote file bytes on the Gateway.",
    });
    const proof = await fs.open(proofPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await proof.stat();
      if (!stat.isFile() || stat.size !== Buffer.byteLength(nonce)) {
        throw new Error("Cloud test roundtrip file size differs");
      }
      const bytes = Buffer.alloc(Buffer.byteLength(nonce) + 1);
      const read = await proof.read(bytes);
      if (
        read.bytesRead !== Buffer.byteLength(nonce) ||
        !bytes.subarray(0, read.bytesRead).equals(Buffer.from(nonce))
      ) {
        throw new Error("Cloud test roundtrip file bytes differ");
      }
    } finally {
      await proof.close();
    }
    passed = true;
  } catch (error) {
    failure = boundedWorkerError(error);
  } finally {
    if (abortPending) {
      await abortPending;
    }
    if (abortTurn) {
      signal.removeEventListener("abort", abortTurn);
    }
    if (identity && handle) {
      publish({
        stage: "cleanup",
        message: "Stopping the exact test worker and verifying teardown.",
      });
      try {
        await cleanup(identity);
      } catch (error) {
        // Preserve the turn failure while reporting teardown uncertainty separately.
        failure ??= boundedWorkerError(error);
        publish({ status: "cleanup-pending", cleanup: "pending" });
      } finally {
        signal.removeEventListener("abort", handle.close);
        handle.close();
      }
    }
    publish({
      stage: "finished",
      status:
        result.cleanup === "pending"
          ? "cleanup-pending"
          : signal.aborted
            ? "cancelled"
            : passed
              ? "passed"
              : "failed",
      message:
        result.cleanup === "pending"
          ? (failure ?? "Cleanup remains pending; inspect the test session.")
          : passed && !signal.aborted
            ? "Remote turn, file roundtrip, and worker teardown verified."
            : (failure ?? "Test cancelled."),
    });
  }
}

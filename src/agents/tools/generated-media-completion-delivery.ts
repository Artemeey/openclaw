import {
  bindDeliveryQueueEntry,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "../../infra/delivery-queue-sqlite-bound.js";
import { getDeliveryQueueEntryStatus } from "../../infra/delivery-queue-sqlite.js";
import { scheduleSessionDelivery } from "../../infra/session-delivery-queue-runtime.js";
import {
  prepareClaimedSessionDelivery,
  SESSION_DELIVERY_QUEUE_NAME,
  type QueuedSessionDelivery,
  type QueuedSessionDeliveryPayload,
  type SessionDeliverySettledOutcome,
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
} from "../../infra/session-delivery-queue-storage.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  parseGeneratedMediaTaskDetail,
  retainedGeneratedMediaArtifactsAvailable,
} from "../../tasks/generated-media-task-artifacts.js";
import {
  findTaskByRunId,
  getTaskById,
  getTaskDeliveryState,
  publishTaskRecordAfterAtomicStore,
  updateTaskRecordById,
} from "../../tasks/runtime-internal.js";
import {
  bindTaskRecord,
  upsertTaskRunRowInDatabase,
} from "../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";

const CLAIM_LEASE_MS = 125_000;
const RETAIN_BLOCKED_MEDIA_MS = 7 * 24 * 60 * 60_000;
const MAX_DELIVERY_GENERATION = 10;

type RecoveryResult = {
  ok: boolean;
  reason?: string;
  task?: TaskRecord;
  duplicateRisk?: boolean;
};

function isGeneratedMediaTask(task: TaskRecord | undefined): task is TaskRecord {
  return Boolean(
    task?.runtime === "cli" && task.runId && parseGeneratedMediaTaskDetail(task.detail),
  );
}

function commitQueueAndTask(entry: QueuedSessionDelivery, task: TaskRecord): boolean {
  const queue = bindDeliveryQueueEntry({
    queueName: SESSION_DELIVERY_QUEUE_NAME,
    entry,
    insertOnly: true,
  });
  const boundTask = bindTaskRecord(task);
  const claimed = runOpenClawStateWriteTransaction(
    (database) => {
      const inserted = upsertBoundDeliveryQueueEntryInDatabase(queue, database);
      if (!inserted) {
        return false;
      }
      upsertTaskRunRowInDatabase(database, boundTask);
      return inserted;
    },
    undefined,
    { operationLabel: "generated media completion delivery admission" },
  );
  publishTaskRecordAfterAtomicStore(task);
  return claimed;
}

export function admitCorrelatedGeneratedMediaSessionDelivery(params: {
  runId: string;
  payload: Extract<QueuedSessionDeliveryPayload, { kind: "agentTurn" }>;
  generation?: number;
}): { id: string; claimed: boolean; status: "pending" | "failed" | "completed" } {
  const ownedTask = findTaskByRunId(params.runId);
  if (!isGeneratedMediaTask(ownedTask)) {
    throw new Error(`generated media completion task not found: ${params.runId}`);
  }
  const detail = parseGeneratedMediaTaskDetail(ownedTask.detail);
  if (!detail) {
    throw new Error(`generated media completion detail not found: ${params.runId}`);
  }
  const generation = params.generation ?? detail.generation;
  const now = Date.now();
  const deadlineAt = now + RETAIN_BLOCKED_MEDIA_MS;
  const suffix = generation > 1 ? `:generation:${generation}` : "";
  const entry = prepareClaimedSessionDelivery(
    {
      ...params.payload,
      idempotencyKey: `${params.payload.idempotencyKey ?? params.payload.messageId}${suffix}`,
      messageId: `${params.payload.messageId}${suffix}`,
      owner: {
        kind: "generated_media_completion",
        runId: params.runId,
        taskId: ownedTask.taskId,
        generation,
        deadlineAt,
      },
    },
    CLAIM_LEASE_MS,
    now,
  );
  const projectedTask: TaskRecord = {
    ...ownedTask,
    deliveryStatus: "session_queued",
    detail: { ...detail, generation, queueId: entry.id },
    lastEventAt: now,
  };
  const claimed = commitQueueAndTask(entry, projectedTask);
  const status = getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, entry.id);
  return { id: entry.id, claimed, status: status ?? "completed" };
}

export async function settleCorrelatedGeneratedMediaDelivery(
  queued: QueuedSessionDelivery,
  outcome: SessionDeliverySettledOutcome,
): Promise<void> {
  if (queued.kind !== "agentTurn" || queued.owner?.kind !== "generated_media_completion") {
    return;
  }
  const task = getTaskById(queued.owner.taskId);
  const detail = parseGeneratedMediaTaskDetail(task?.detail);
  if (
    !task ||
    !detail ||
    detail.queueId !== queued.id ||
    detail.generation !== queued.owner.generation
  ) {
    return;
  }
  const now = Date.now();
  const next: TaskRecord = {
    ...task,
    status: "succeeded",
    deliveryStatus: outcome === "recovered" ? "delivered" : "failed",
    terminalOutcome: outcome === "recovered" ? "succeeded" : "blocked",
    ...(outcome === "recovered"
      ? { error: undefined }
      : {
          error: queued.lastError ?? "completion delivery failed",
          terminalSummary: "Task completed, but generated media delivery is blocked.",
          cleanupAfter: now + RETAIN_BLOCKED_MEDIA_MS,
        }),
    detail: {
      kind: detail.kind,
      version: detail.version,
      generation: detail.generation,
      result: detail.result,
      artifacts: detail.artifacts,
    },
    lastEventAt: now,
    endedAt: task.endedAt ?? now,
  };
  runOpenClawStateWriteTransaction(
    (database) => upsertTaskRunRowInDatabase(database, bindTaskRecord(next)),
    undefined,
    { operationLabel: "generated media completion delivery settlement" },
  );
  publishTaskRecordAfterAtomicStore(next);
}

export function resolveCorrelatedGeneratedMediaDelivery(
  queued: QueuedSessionDelivery,
): QueuedSessionDelivery {
  if (queued.kind !== "agentTurn" || queued.owner?.kind !== "generated_media_completion") {
    return queued;
  }
  const detail = parseGeneratedMediaTaskDetail(getTaskById(queued.owner.taskId)?.detail);
  if (Date.now() >= queued.owner.deadlineAt) {
    throw new SessionDeliveryDeadLetteredError("generated media delivery deadline expired");
  }
  if (!detail || detail.queueId !== queued.id || detail.generation !== queued.owner.generation) {
    throw new SessionDeliveryDeferredError("correlated generated media delivery owner mismatch");
  }
  return queued;
}

export async function retryGeneratedMediaCompletionDelivery(
  taskId: string,
): Promise<RecoveryResult> {
  const task = getTaskById(taskId);
  const detail = parseGeneratedMediaTaskDetail(task?.detail);
  if (!isGeneratedMediaTask(task) || !detail) {
    return { ok: false, reason: "task has no recoverable generated media completion" };
  }
  if (task.deliveryStatus === "session_queued" && detail.queueId) {
    const status = getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, detail.queueId);
    if (status !== "pending") {
      return { ok: false, reason: "generated media delivery is settling" };
    }
    await scheduleSessionDelivery(detail.queueId);
    return { ok: true, task: getTaskById(taskId) };
  }
  if (task.deliveryStatus !== "failed" || task.terminalOutcome !== "blocked") {
    return { ok: false, reason: "generated media delivery is not blocked" };
  }
  if (detail.generation >= MAX_DELIVERY_GENERATION) {
    return { ok: false, reason: "generated media delivery redrive limit reached" };
  }
  if (!(await retainedGeneratedMediaArtifactsAvailable(detail))) {
    return { ok: false, reason: "retained generated media is unavailable" };
  }
  const generation = detail.generation + 1;
  const nextDetail = {
    kind: detail.kind,
    version: detail.version,
    generation,
    result: detail.result,
    artifacts: detail.artifacts,
  };
  if (!task.runId) {
    return { ok: false, reason: "generated media delivery owner is unavailable" };
  }
  const current = task;
  const requesterOrigin = getTaskDeliveryState(taskId)?.requesterOrigin;
  const attachments = nextDetail.artifacts.map((artifact) => ({
    type: artifact.type,
    ...(artifact.path ? { path: artifact.path } : { url: artifact.url }),
    ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
    ...(artifact.name ? { name: artifact.name } : {}),
    ...(artifact.sizeBytes !== undefined ? { sizeBytes: artifact.sizeBytes } : {}),
  }));
  const mediaUrls = nextDetail.artifacts.flatMap((artifact) => artifact.path ?? artifact.url ?? []);
  const source: "image_generation" | "music_generation" | "video_generation" =
    current.taskKind === "image_generation"
      ? "image_generation"
      : current.taskKind === "music_generation"
        ? "music_generation"
        : "video_generation";
  const internalEvents = [
    {
      type: "task_completion" as const,
      source,
      childSessionKey: current.runId ?? current.taskId,
      childSessionId: current.taskId,
      announceType: "media generation task",
      taskLabel: current.task,
      status: "ok" as const,
      statusLabel: "completed successfully",
      result: nextDetail.result,
      attachments,
      mediaUrls,
      replyInstruction:
        "The generated media is ready for the original chat. Send every structured attachment from this event.",
    },
  ];
  const { deliverSubagentAnnouncement } =
    await import("../subagents/announce/subagent-announce-delivery.js");
  const delivery = await deliverSubagentAnnouncement({
    requesterSessionKey: current.requesterSessionKey,
    requesterAgentId: current.requesterAgentId,
    targetRequesterSessionKey: current.requesterSessionKey,
    triggerMessage: nextDetail.result,
    steerMessage: nextDetail.result,
    internalEvents,
    summaryLine: current.task,
    requesterSessionOrigin: requesterOrigin,
    requesterOrigin,
    completionDirectOrigin: requesterOrigin,
    directOrigin: requesterOrigin,
    sourceSessionKey: current.runId ?? current.taskId,
    sourceRunId: current.runId,
    sourceChannel: INTERNAL_MESSAGE_CHANNEL,
    sourceTool: current.sourceId?.split(":")[0] ?? "media_generate",
    requesterIsSubagent: false,
    expectsCompletionMessage: true,
    bestEffortDeliver: true,
    directIdempotencyKey: `generated-media:${current.taskId}:generation:${generation}`,
    generatedMediaDeliveryGeneration: generation,
  });
  if (!delivery.delivered && delivery.disposition !== "session_queued") {
    return { ok: false, reason: "generated media delivery could not be queued" };
  }
  return { ok: true, task: getTaskById(taskId), duplicateRisk: true };
}

export function dismissGeneratedMediaCompletionDelivery(taskId: string): RecoveryResult {
  const task = getTaskById(taskId);
  const detail = parseGeneratedMediaTaskDetail(task?.detail);
  if (!isGeneratedMediaTask(task) || !detail || task.deliveryStatus !== "failed") {
    return { ok: false, reason: "generated media delivery is not blocked" };
  }
  const now = Date.now();
  const updated = updateTaskRecordById(taskId, {
    deliveryStatus: "dismissed",
    terminalOutcome: "blocked",
    terminalSummary: "Task completed; generated media delivery was dismissed by the operator.",
    cleanupAfter: Math.max(task.cleanupAfter ?? 0, now + RETAIN_BLOCKED_MEDIA_MS),
    lastEventAt: now,
  });
  return { ok: Boolean(updated), ...(updated ? { task: updated } : {}) };
}

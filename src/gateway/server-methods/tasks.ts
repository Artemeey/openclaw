// Task gateway methods expose detached task list/get/cancel operations with
// bounded public summaries over the runtime task registry.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type TaskSummary,
  type TasksListParams,
  validateTasksCancelParams,
  validateTasksGetParams,
  validateTasksListParams,
  validateTasksRecoveryParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  dismissSubagentCompletionDelivery,
  retrySubagentCompletionDelivery,
} from "../../agents/subagents/completion/subagent-completion-delivery.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions.js";
import { getTaskById, listTaskRecordPage } from "../../tasks/runtime-internal.js";
import type { TaskStatus } from "../../tasks/task-registry.types.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { canAccessTaskRequesterSession } from "../task-session-access.js";
import { mapTaskSummary } from "./task-summary.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_TASKS_LIST_LIMIT = 100;
const MAX_TASKS_LIST_LIMIT = 500;
const MAX_TASKS_LIST_TRAVERSALS = 256;

type TaskLedgerStatus = TaskSummary["status"];
type TaskListTraversal = {
  emittedTaskIds: Set<string>;
  queryKey: string;
};

const taskListTraversalsByContext = new WeakMap<object, Map<string, TaskListTraversal>>();

const LEDGER_STATUS_TO_TASK_STATUSES: Record<TaskLedgerStatus, TaskStatus[]> = {
  queued: ["queued"],
  running: ["running"],
  completed: ["succeeded"],
  failed: ["failed", "lost"],
  timed_out: ["timed_out"],
  cancelled: ["cancelled"],
};

function normalizeTaskStatusFilter(status: TasksListParams["status"]): Set<TaskStatus> | null {
  if (!status) {
    return null;
  }
  const statuses = Array.isArray(status) ? status : [status];
  return new Set(statuses.flatMap((value) => LEDGER_STATUS_TO_TASK_STATUSES[value] ?? []));
}

function taskListQueryKey(params: {
  statuses: readonly TaskStatus[] | undefined;
  agentId: string | undefined;
  sessionKey: string | undefined;
  sessionAgentId: string | undefined;
}): string {
  return JSON.stringify([
    params.statuses?.toSorted() ?? null,
    normalizeOptionalString(params.agentId) ?? null,
    params.sessionKey ?? null,
    params.sessionAgentId ?? null,
  ]);
}

function takeTaskListTraversal(
  traversals: Map<string, TaskListTraversal>,
  cursor: string | undefined,
  queryKey: string,
): TaskListTraversal | null {
  if (cursor === undefined) {
    return { emittedTaskIds: new Set(), queryKey };
  }
  const traversal = traversals.get(cursor);
  if (!traversal || traversal.queryKey !== queryKey) {
    return null;
  }
  traversals.delete(cursor);
  return traversal;
}

function storeTaskListTraversal(
  traversals: Map<string, TaskListTraversal>,
  traversal: TaskListTraversal,
): string {
  // Keep abandoned traversals bounded without capping pages in an active one.
  // Single-use tokens make retries fail visibly instead of skipping a page.
  while (traversals.size >= MAX_TASKS_LIST_TRAVERSALS) {
    const oldestCursor = traversals.keys().next().value;
    if (oldestCursor === undefined) {
      break;
    }
    traversals.delete(oldestCursor);
  }
  let cursor = crypto.randomUUID();
  while (traversals.has(cursor)) {
    cursor = crypto.randomUUID();
  }
  traversals.set(cursor, traversal);
  return cursor;
}

// Control UI task methods expose the stable gateway protocol shape; helpers
// above keep runtime registry details out of the wire result.
export const tasksHandlers: GatewayRequestHandlers = {
  "tasks.list": ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateTasksListParams, "tasks.list", respond)) {
      return;
    }
    const statusFilter = normalizeTaskStatusFilter(params.status);
    const statuses = statusFilter ? [...statusFilter] : undefined;
    const limit = Math.min(params.limit ?? DEFAULT_TASKS_LIST_LIMIT, MAX_TASKS_LIST_LIMIT);
    const requestedSessionKey = normalizeOptionalString(params.sessionKey);
    const cfg = context.getRuntimeConfig();
    let sessionKey: string | undefined;
    let sessionAgentId: string | undefined;
    if (requestedSessionKey) {
      const sessionOwner = resolveRequestedSessionAgentId(
        cfg,
        requestedSessionKey,
        normalizeOptionalString(params.agentId),
      );
      if (!sessionOwner.ok) {
        respond(false, undefined, sessionOwner.error);
        return;
      }
      sessionAgentId = sessionOwner.agentId;
      sessionKey = canonicalizeMainSessionAlias({
        cfg,
        agentId: sessionOwner.agentId,
        sessionKey: requestedSessionKey,
      });
    }
    const agentId = sessionKey ? undefined : normalizeOptionalString(params.agentId);
    const queryKey = taskListQueryKey({
      statuses,
      agentId,
      sessionKey,
      sessionAgentId,
    });
    let traversals = taskListTraversalsByContext.get(context);
    if (!traversals) {
      traversals = new Map();
      taskListTraversalsByContext.set(context, traversals);
    }
    const traversal = takeTaskListTraversal(traversals, params.cursor, queryKey);
    if (!traversal) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid or expired tasks.list cursor; restart pagination without a cursor",
        ),
      );
      return;
    }
    // The ledger pages by last activity so an old long-running task that just
    // finished still surfaces first. Selection stays inside the registry so
    // only the bounded wire page pays for defensive record cloning.
    const page = listTaskRecordPage({
      limit,
      excludedTaskIds: traversal.emittedTaskIds,
      statuses,
      agentId,
      sessionKey,
      sessionAgentId,
      cfg,
      filter: (task) => canAccessTaskRequesterSession({ cfg, client, task }),
    });
    for (const task of page.tasks) {
      traversal.emittedTaskIds.add(task.taskId);
    }
    respond(true, {
      tasks: page.tasks.map((task) => mapTaskSummary(task)),
      ...(page.hasMore ? { nextCursor: storeTaskListTraversal(traversals, traversal) } : {}),
    });
  },
  "tasks.get": ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateTasksGetParams, "tasks.get", respond)) {
      return;
    }
    const taskId = params.taskId;
    const task = getTaskById(taskId);
    if (
      !task ||
      !canAccessTaskRequesterSession({ cfg: context.getRuntimeConfig(), client, task })
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${taskId}`),
      );
      return;
    }
    // The potentially longer task input is lookup-only. List and event payloads
    // stay compact while detail views can show the operator what was requested.
    respond(true, { task: mapTaskSummary(task, { includePrompt: true }) });
  },
  "tasks.cancel": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateTasksCancelParams, "tasks.cancel", respond)) {
      return;
    }
    const taskId = params.taskId;
    const reason = normalizeOptionalString(params.reason);
    const { cancelDetachedTaskRunByIdCore } =
      await import("../../tasks/task-executor-cancel.runtime.js");
    const cfg = context.getRuntimeConfig();
    const task = getTaskById(taskId);
    if (task && !canAccessTaskRequesterSession({ access: "write", cfg, client, task })) {
      respond(true, { found: false, cancelled: false });
      return;
    }
    const result = await cancelDetachedTaskRunByIdCore({
      cfg,
      taskId,
      ...(reason ? { reason } : {}),
    });
    respond(true, {
      found: result.found,
      cancelled: result.cancelled,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.task ? { task: mapTaskSummary(result.task) } : {}),
    });
  },
  "tasks.retry": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateTasksRecoveryParams, "tasks.retry", respond)) {
      return;
    }
    const results = [];
    const cfg = context.getRuntimeConfig();
    for (const taskId of params.taskIds) {
      const task = getTaskById(taskId);
      if (task && !canAccessTaskRequesterSession({ access: "write", cfg, client, task })) {
        results.push({ taskId, ok: false, reason: "task not found" });
        continue;
      }
      const result = await retrySubagentCompletionDelivery(taskId);
      results.push({
        taskId,
        ok: result.ok,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.duplicateRisk ? { duplicateRisk: true } : {}),
        ...(result.task ? { task: mapTaskSummary(result.task, { includePrompt: true }) } : {}),
      });
    }
    respond(true, { results });
  },
  "tasks.dismiss": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateTasksRecoveryParams, "tasks.dismiss", respond)) {
      return;
    }
    const { discardSubagentTerminalDelivery } =
      await import("../../agents/subagents/registry/subagent-registry.js");
    const results = [];
    const cfg = context.getRuntimeConfig();
    for (const taskId of params.taskIds) {
      const task = getTaskById(taskId);
      if (task && !canAccessTaskRequesterSession({ access: "write", cfg, client, task })) {
        results.push({ taskId, ok: false, reason: "task not found" });
        continue;
      }
      const result = await dismissSubagentCompletionDelivery(taskId, {
        discardTerminalDelivery: discardSubagentTerminalDelivery,
      });
      results.push({
        taskId,
        ok: result.ok,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.task ? { task: mapTaskSummary(result.task, { includePrompt: true }) } : {}),
      });
    }
    respond(true, { results });
  },
};

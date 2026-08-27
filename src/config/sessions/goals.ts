// Session goal state tracks objective progress and token budgets in the session store.
import crypto from "node:crypto";
import {
  recordSessionGoalChanged,
  type SessionStateActorType,
} from "../../sessions/session-state-events.js";
import { formatTokenCount } from "../../utils/token-format.js";
import { loadSessionEntryReadOnly, patchSessionEntryCore } from "./session-accessor.js";
import { projectSessionGoalCreate } from "./session-goal-create.js";
import { resolveFreshSessionTotalTokens } from "./types.js";
import type { SessionEntry, SessionGoal, SessionGoalStatus } from "./types.js";

type SessionGoalSnapshot = {
  status: "missing" | "found";
  goal?: SessionGoal;
};

type SessionGoalStoreOptions = {
  sessionKey: string;
  storePath?: string;
  now?: number;
  fallbackEntry?: SessionEntry;
  persist?: boolean;
  actor?: { type: SessionStateActorType; id?: string };
  agentId?: string;
};

type CreateSessionGoalOptions = SessionGoalStoreOptions & {
  objective: string;
  tokenBudget?: number;
  assertCommitAllowed?: () => void;
};

type SessionGoalMutationOptions = SessionGoalStoreOptions & {
  expectedGoalId?: string;
  assertCommitAllowed?: () => void;
};

type UpdateSessionGoalStatusOptions = SessionGoalMutationOptions & {
  status: Extract<SessionGoalStatus, "active" | "paused" | "blocked" | "complete">;
  note?: string;
};

type SessionGoalTransition =
  | { action: "edit"; objective: string }
  | { action: "pause" | "resume" | "complete" | "block"; note?: string };

export const MODEL_UPDATABLE_SESSION_GOAL_STATUSES = ["complete", "blocked"] as const;

const TERMINAL_GOAL_STATUSES = new Set<SessionGoalStatus>(["complete"]);

function nowMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function normalizeTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function resolveEntryFreshTotalTokens(
  entry: Pick<SessionEntry, "totalTokens" | "totalTokensFresh" | "totalTokensVersion">,
): number | undefined {
  return normalizeTokenCount(resolveFreshSessionTotalTokens(entry));
}

function normalizeObjective(objective: string): string {
  const normalized = objective.trim();
  if (!normalized) {
    throw new Error("objective required");
  }
  return normalized;
}

function cloneGoal(goal: SessionGoal): SessionGoal {
  return { ...goal };
}

function recordGoalChange(
  options: SessionGoalStoreOptions,
  entry: SessionEntry,
  summary: string,
): void {
  recordSessionGoalChanged({
    sessionKey: options.sessionKey,
    entry,
    actor: options.actor,
    agentId: options.agentId,
    summary,
  });
}

export function resolveSessionGoalDisplayState(
  entry: Pick<SessionEntry, "goal" | "totalTokens" | "totalTokensFresh" | "totalTokensVersion">,
  now?: number,
  options?: { adoptFreshBaseline?: boolean },
): SessionGoal | undefined {
  return accountGoalUsage(entry, nowMs(now), options);
}

function accountGoalUsage(
  entry: Pick<SessionEntry, "goal" | "totalTokens" | "totalTokensFresh" | "totalTokensVersion">,
  now: number,
  options?: { adoptFreshBaseline?: boolean },
): SessionGoal | undefined {
  // `goal` is introduced here as a core-owned slot; no shipped plugin-owned
  // goal state exists to migrate, and plugin slot registration now reserves it.
  const goal = entry.goal;
  if (!goal) {
    return undefined;
  }
  const totalTokens = resolveEntryFreshTotalTokens(entry);
  const hasFreshStart = goal.tokenStartFresh !== false;
  // Old entries may have a stale token baseline; display-only reads can hold it, while persisted
  // reads adopt the fresh total so future budget checks use current accounting.
  const shouldHoldStaleStart = !hasFreshStart && options?.adoptFreshBaseline === false;
  const shouldAdoptFreshStart =
    !shouldHoldStaleStart && totalTokens !== undefined && !hasFreshStart;
  const tokenStart = shouldAdoptFreshStart
    ? totalTokens
    : (normalizeTokenCount(goal.tokenStart) ?? totalTokens ?? 0);
  const tokensUsed =
    totalTokens === undefined || shouldAdoptFreshStart || shouldHoldStaleStart
      ? goal.tokensUsed
      : Math.max(goal.tokensUsed, Math.max(0, totalTokens - tokenStart));
  const next: SessionGoal = {
    ...goal,
    tokenStart,
    tokenStartFresh: hasFreshStart || shouldAdoptFreshStart,
    tokensUsed,
  };
  if (
    next.status === "active" &&
    next.tokenBudget !== undefined &&
    tokensUsed >= next.tokenBudget
  ) {
    next.status = "budget_limited";
    next.budgetLimitedAt = now;
    next.updatedAt = now;
  }
  return next;
}

function goalsEqual(a: SessionGoal | undefined, b: SessionGoal | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function requireExpectedGoal(goal: SessionGoal | undefined, expectedGoalId: string): SessionGoal {
  if (!goal) {
    throw new Error("goal not found");
  }
  if (goal.id !== expectedGoalId) {
    throw new Error("goal changed");
  }
  return goal;
}

export { projectSessionGoalCreate } from "./session-goal-create.js";

export function projectSessionGoalTransition(
  entry: SessionEntry,
  params: { expectedGoalId: string; now: number; transition: SessionGoalTransition },
): { goal: SessionGoal } {
  const transition: SessionGoalTransition =
    params.transition.action === "edit"
      ? { ...params.transition, objective: normalizeObjective(params.transition.objective) }
      : params.transition;
  const accounted = requireExpectedGoal(accountGoalUsage(entry, params.now), params.expectedGoalId);
  if (TERMINAL_GOAL_STATUSES.has(accounted.status)) {
    const remainsComplete = transition.action === "complete" && accounted.status === "complete";
    if (!remainsComplete) {
      throw new Error(`goal is already ${accounted.status}`);
    }
  }

  if (transition.action === "edit") {
    return {
      goal: {
        ...accounted,
        objective: transition.objective,
        updatedAt: params.now,
      },
    };
  }

  const status =
    transition.action === "resume"
      ? "active"
      : transition.action === "pause"
        ? "paused"
        : transition.action === "block"
          ? "blocked"
          : "complete";
  const resetsBudgetWindow =
    status === "active" &&
    (accounted.status === "budget_limited" ||
      accounted.status === "usage_limited" ||
      (accounted.tokenBudget !== undefined && accounted.tokensUsed >= accounted.tokenBudget));
  // Resuming from a limited state starts a new budget window at the current fresh token count.
  const freshTokenStart = resetsBudgetWindow ? resolveEntryFreshTotalTokens(entry) : undefined;
  const next: SessionGoal = {
    ...accounted,
    status,
    updatedAt: params.now,
    ...(transition.note ? { lastStatusNote: transition.note } : {}),
    ...(status === "paused" ? { pausedAt: params.now } : {}),
    ...(status === "blocked" ? { blockedAt: params.now } : {}),
    ...(status === "complete" ? { completedAt: params.now } : {}),
  };
  if (resetsBudgetWindow) {
    next.tokenStart = freshTokenStart ?? 0;
    next.tokenStartFresh = freshTokenStart !== undefined;
    next.tokensUsed = 0;
    delete next.budgetLimitedAt;
    delete next.usageLimitedAt;
  }
  if (
    next.status === "active" &&
    next.tokenBudget !== undefined &&
    next.tokensUsed >= next.tokenBudget
  ) {
    next.status = "budget_limited";
    next.budgetLimitedAt = params.now;
  }
  return { goal: next };
}

function projectSessionGoalClear(
  entry: SessionEntry,
  params: { expectedGoalId: string },
): { goal: undefined } {
  requireExpectedGoal(entry.goal, params.expectedGoalId);
  return { goal: undefined };
}

export function formatSessionGoalStatus(goal: SessionGoal | undefined): string {
  if (!goal) {
    return "No goal for this session.\nStart one with /goal start <objective>.";
  }
  const budget =
    goal.tokenBudget === undefined
      ? ""
      : `\nToken budget: ${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`;
  const note = goal.lastStatusNote ? `\nNote: ${goal.lastStatusNote}` : "";
  const commands = resolveGoalCommandHint(goal.status);
  return [
    "Goal",
    `Status: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Tokens used: ${formatTokenCount(goal.tokensUsed)}`,
    ...(budget ? [budget.slice(1)] : []),
    ...(note ? [note.slice(1)] : []),
    "",
    `Commands: ${commands}`,
  ].join("\n");
}

function resolveGoalCommandHint(status: SessionGoalStatus): string {
  switch (status) {
    case "active":
      return "/goal edit <objective>, /goal pause, /goal complete, /goal clear";
    case "paused":
    case "blocked":
    case "usage_limited":
    case "budget_limited":
      return "/goal resume, /goal edit <objective>, /goal clear";
    case "complete":
      return "/goal clear";
  }
  return "/goal";
}

export async function getSessionGoal(
  options: SessionGoalStoreOptions,
): Promise<SessionGoalSnapshot> {
  const now = nowMs(options.now);
  if (options.persist === false) {
    // Status rendering should not write incidental budget/baseline adoption unless callers opt in.
    const entry =
      loadSessionEntryReadOnly({ sessionKey: options.sessionKey, storePath: options.storePath }) ??
      options.fallbackEntry;
    const projected = entry
      ? resolveSessionGoalDisplayState(entry, now, { adoptFreshBaseline: false })
      : undefined;
    return projected ? { status: "found", goal: projected } : { status: "missing" };
  }
  let goal: SessionGoal | undefined;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      const accounted = accountGoalUsage(entry, now);
      goal = accounted ? cloneGoal(accounted) : undefined;
      if (!accounted || goalsEqual(accounted, entry.goal)) {
        return null;
      }
      return { goal: accounted };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  if (!result || !goal) {
    return { status: "missing" };
  }
  return { status: "found", goal };
}

export async function createSessionGoal(options: CreateSessionGoalOptions): Promise<SessionGoal> {
  const objective = normalizeObjective(options.objective);
  const now = nowMs(options.now);
  let created: SessionGoal | undefined;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      const patch = projectSessionGoalCreate(entry, {
        goalId: crypto.randomUUID(),
        now,
        objective,
        tokenBudget: options.tokenBudget,
      });
      created = patch.goal;
      return patch;
    },
    {
      fallbackEntry: options.fallbackEntry,
      ...(options.assertCommitAllowed ? { assertCommitAllowed: options.assertCommitAllowed } : {}),
    },
  );
  if (!result || !created) {
    throw new Error("session not found");
  }
  recordGoalChange(options, result, "goal created");
  return cloneGoal(created);
}

export async function updateSessionGoalStatus(
  options: UpdateSessionGoalStatusOptions,
): Promise<SessionGoal> {
  const now = nowMs(options.now);
  let updated: SessionGoal | undefined;
  let foundSession = false;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      foundSession = true;
      const expectedGoalId = options.expectedGoalId ?? entry.goal?.id;
      if (expectedGoalId === undefined) {
        throw new Error("goal not found");
      }
      const action =
        options.status === "active"
          ? "resume"
          : options.status === "paused"
            ? "pause"
            : options.status === "blocked"
              ? "block"
              : "complete";
      const patch = projectSessionGoalTransition(entry, {
        expectedGoalId,
        now,
        transition: { action, ...(options.note ? { note: options.note } : {}) },
      });
      updated = patch.goal;
      return patch;
    },
    options.assertCommitAllowed ? { assertCommitAllowed: options.assertCommitAllowed } : {},
  );
  if (!result || !updated) {
    throw new Error(foundSession ? "goal not found" : "session not found");
  }
  recordGoalChange(options, result, `goal status changed to ${updated.status}`);
  return cloneGoal(updated);
}

export async function updateSessionGoalObjective(
  options: SessionGoalMutationOptions & { objective: string },
): Promise<SessionGoal> {
  const objective = normalizeObjective(options.objective);
  const now = nowMs(options.now);
  let updated: SessionGoal | undefined;
  let foundSession = false;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      foundSession = true;
      const expectedGoalId = options.expectedGoalId ?? entry.goal?.id;
      if (expectedGoalId === undefined) {
        throw new Error("goal not found");
      }
      const patch = projectSessionGoalTransition(entry, {
        expectedGoalId,
        now,
        transition: { action: "edit", objective },
      });
      updated = patch.goal;
      return patch;
    },
    options.assertCommitAllowed ? { assertCommitAllowed: options.assertCommitAllowed } : {},
  );
  if (!result || !updated) {
    throw new Error(foundSession ? "goal not found" : "session not found");
  }
  recordGoalChange(options, result, "goal objective changed");
  return cloneGoal(updated);
}

export async function clearSessionGoal(options: SessionGoalMutationOptions): Promise<boolean> {
  let removed = false;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      if (!entry.goal) {
        if (options.expectedGoalId !== undefined) {
          throw new Error("goal not found");
        }
        return null;
      }
      const patch = projectSessionGoalClear(entry, {
        expectedGoalId: options.expectedGoalId ?? entry.goal.id,
      });
      removed = true;
      return patch;
    },
    options.assertCommitAllowed ? { assertCommitAllowed: options.assertCommitAllowed } : {},
  );
  if (result && removed) {
    recordGoalChange(options, result, "goal cleared");
  }
  return Boolean(result && removed);
}

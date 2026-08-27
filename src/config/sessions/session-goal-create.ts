import { resolveFreshSessionTotalTokens } from "./types.js";
import type { SessionEntry, SessionGoal } from "./types.js";

function normalizeTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function resolveFreshTotalTokens(entry: SessionEntry): number | undefined {
  return normalizeTokenCount(resolveFreshSessionTotalTokens(entry));
}

export function projectSessionGoalCreate(
  entry: SessionEntry,
  params: { goalId: string; now: number; objective: string; tokenBudget?: number },
): { goal: SessionGoal } {
  const objective = params.objective.trim();
  if (!objective) {
    throw new Error("objective required");
  }
  if (entry.goal) {
    throw new Error("goal already exists");
  }
  const tokenBudget = normalizeTokenCount(params.tokenBudget);
  const freshTotal = resolveFreshTotalTokens(entry);
  return {
    goal: {
      schemaVersion: 1,
      id: params.goalId,
      objective,
      status: "active",
      createdAt: params.now,
      updatedAt: params.now,
      tokenStart: freshTotal ?? 0,
      tokenStartFresh: freshTotal !== undefined,
      tokensUsed: 0,
      ...(tokenBudget && tokenBudget > 0 ? { tokenBudget } : {}),
      continuationTurns: 0,
    },
  };
}

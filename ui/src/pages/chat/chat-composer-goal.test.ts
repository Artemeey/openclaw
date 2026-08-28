/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionGoal } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { renderChatGoal, clearGoalElapsedTimers } from "./components/chat-composer-goal.ts";
import { getChatComposerState, resetChatComposerState } from "./components/chat-composer-state.ts";
import type { ChatGoalManagementProps } from "./components/chat-composer-types.ts";

const goal: SessionGoal = {
  schemaVersion: 1,
  id: "goal-timing",
  objective: "Verify the deployment",
  status: "active",
  createdAt: 1_000,
  updatedAt: 61_000,
  tokenStart: 0,
  tokensUsed: 100,
  continuationTurns: 0,
};

function mountGoal(initial: SessionGoal, management?: ChatGoalManagementProps) {
  const container = document.createElement("div");
  document.body.append(container);
  const state = getChatComposerState("goal-timing");
  const draw = (value: SessionGoal | undefined, nextManagement = management) =>
    render(
      renderChatGoal(state, value, {
        canAct: Boolean(nextManagement),
        paneId: "goal-timing",
        management: nextManagement,
        onGoalEdit: () => {},
        requestUpdate: () => {},
      }),
      container,
    );
  const part = draw(initial);
  return {
    container,
    draw,
    part,
    elapsed: () => container.querySelector(".agent-chat__goal-elapsed")?.textContent,
  };
}

describe("goal elapsed presentation", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    vi.useFakeTimers();
    vi.setSystemTime(121_000);
  });

  afterEach(() => {
    clearGoalElapsedTimers();
    resetChatComposerState();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it.each([
    ["active", "2m"],
    ["paused", "1m"],
    ["blocked", "1m"],
    ["usage_limited", "1m"],
    ["budget_limited", "1m"],
    ["complete", "1m"],
  ] as const)("renders elapsed time immediately for %s goals", (status, elapsed) => {
    const view = mountGoal({ ...goal, status });
    expect(view.elapsed()).toBe(elapsed);
  });

  it("replaces a live tick with the authoritative stop time and resumes ticking", () => {
    const view = mountGoal(goal);
    vi.advanceTimersByTime(1_000);
    expect(view.elapsed()).toBe("2m");

    view.draw({ ...goal, status: "paused", pausedAt: 46_000 });
    expect(view.elapsed()).toBe("45s");
    vi.advanceTimersByTime(60_000);
    expect(view.elapsed()).toBe("45s");

    view.draw(goal);
    expect(view.elapsed()).toBe("3m");
    vi.advanceTimersByTime(60_000);
    expect(view.elapsed()).toBe("4m");

    view.draw({ ...goal, status: "complete", completedAt: 151_000 });
    expect(view.elapsed()).toBe("2m");
    vi.advanceTimersByTime(60_000);
    expect(view.elapsed()).toBe("2m");
  });

  it("retires the active timer when the goal is removed", () => {
    const view = mountGoal(goal);
    expect(vi.getTimerCount()).toBe(1);
    view.draw(undefined);
    expect(view.container.querySelector(".agent-chat__goal")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires and resumes the active timer with the rendered host connection", () => {
    const view = mountGoal(goal);
    view.part.setConnected(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    view.part.setConnected(true);
    expect(view.elapsed()).toBe("3m");
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("goal management presentation", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    clearGoalElapsedTimers();
    resetChatComposerState();
    document.body.replaceChildren();
  });

  it("makes the management group focusable and disables every control while pending", () => {
    const view = mountGoal(goal, {
      pending: true,
      error: null,
      editObjective: null,
      onEditStart: () => {},
      onUpdate: () => {},
      onClear: () => {},
    });

    const group = view.container.querySelector<HTMLElement>(".agent-chat__goal");
    const buttons = [...view.container.querySelectorAll<HTMLButtonElement>("button")];
    expect(group?.tabIndex).toBe(-1);
    expect(group?.getAttribute("aria-busy")).toBe("true");
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });

  it("keeps a failed edit visible and retryable", async () => {
    const onUpdate = vi.fn();
    const view = mountGoal(goal, {
      pending: false,
      error: "Goal update failed",
      editObjective: "Retry deployment verification",
      onEditChange: () => {},
      onEditCancel: () => {},
      onUpdate,
      onClear: () => {},
    });

    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("Goal update failed");
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Edit goal"]');
    expect(input?.value).toBe("Retry deployment verification");
    await Promise.resolve();
    expect(input).toBe(document.activeElement);
    input?.closest("form")?.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    expect(onUpdate).toHaveBeenCalledWith({
      action: "edit",
      objective: "Retry deployment verification",
    });
  });
});

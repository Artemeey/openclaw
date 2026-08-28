/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComposerProps } from "./chat-composer.test-support.ts";
import { getChatComposerState, resetChatComposerState } from "./components/chat-composer-state.ts";
import { renderChatComposer } from "./components/chat-composer.ts";

function mount(paneId: string, overrides: Parameters<typeof createComposerProps>[0] = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const props = createComposerProps({ paneId, goalStartAvailable: true, ...overrides });
  const draw = () => render(renderChatComposer(props), container);
  draw();
  return { container, props, draw };
}

afterEach(() => {
  resetChatComposerState();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Goal composer mode", () => {
  it("renders a removable mode without changing the draft or attachments", () => {
    const onDraftChange = vi.fn();
    const view = mount("goal-mode", {
      draft: "multiline\nobjective",
      attachments: [{ id: "attachment-1", name: "proof.txt", mimeType: "text/plain" } as never],
      onDraftChange,
    });
    getChatComposerState("goal-mode").goalMode = true;
    view.draw();

    expect(view.container.querySelector(".agent-chat__goal-mode")?.textContent).toContain("Goal");
    expect(view.container.querySelector("textarea")?.getAttribute("placeholder")).toBe(
      "Describe your goal; measurable outcomes help",
    );
    view.container
      .querySelector<HTMLButtonElement>('button[aria-label="Remove Goal mode"]')
      ?.click();
    expect(getChatComposerState("goal-mode").goalMode).toBe(false);
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("removes Goal mode with Escape before aborting a run", () => {
    const onAbort = vi.fn();
    const view = mount("goal-escape", { canAbort: true, onAbort, draft: "keep me" });
    getChatComposerState("goal-escape").goalMode = true;
    view.draw();
    const input = view.container.querySelector<HTMLTextAreaElement>("textarea")!;

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(getChatComposerState("goal-escape").goalMode).toBe(false);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("keeps mode until the structured send owns the durable queue row", () => {
    let admitted: (() => void) | undefined;
    const onGoalStart = vi.fn((onDurableAdmission: () => void) => {
      admitted = onDurableAdmission;
    });
    const view = mount("goal-submit", { draft: "ship safely", onGoalStart });
    getChatComposerState("goal-submit").goalMode = true;
    view.draw();

    view.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.click();
    expect(onGoalStart).toHaveBeenCalledOnce();
    expect(getChatComposerState("goal-submit").goalMode).toBe(true);
    admitted?.();
    expect(getChatComposerState("goal-submit").goalMode).toBe(false);
  });

  it("keeps Goal submission ahead of the active-run modifier steer shortcut", () => {
    const onGoalStart = vi.fn();
    const onSend = vi.fn();
    const view = mount("goal-steer", {
      canAbort: true,
      draft: "goal objective",
      followUpMode: "queue",
      onAbort: vi.fn(),
      onGoalStart,
      onSend,
    });
    getChatComposerState("goal-steer").goalMode = true;
    view.draw();
    const input = view.container.querySelector<HTMLTextAreaElement>("textarea")!;

    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
    );
    expect(onGoalStart).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("retains mode while capability is temporarily unknown", () => {
    const view = mount("goal-reconnect");
    getChatComposerState("goal-reconnect").goalMode = true;
    view.props.goalStartAvailable = undefined;
    view.draw();

    expect(view.container.querySelector(".agent-chat__goal-mode")).not.toBeNull();
  });

  it("isolates mode by pane and session presentation", () => {
    const first = mount("pane-a:session-a");
    const second = mount("pane-b:session-b");
    getChatComposerState("pane-a:session-a").goalMode = true;
    first.draw();
    second.draw();

    expect(first.container.querySelector(".agent-chat__goal-mode")).not.toBeNull();
    expect(second.container.querySelector(".agent-chat__goal-mode")).toBeNull();
  });
});

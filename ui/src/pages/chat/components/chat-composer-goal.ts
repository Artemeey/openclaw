import { html, nothing, svg, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { SessionGoal } from "../../../api/types.ts";
import { strokeIcon } from "../../../components/icons-tools.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  formatGoalDetail,
  formatGoalElapsed,
  formatGoalStatusLabel,
  formatGoalUsage,
  goalElapsedMs,
} from "../../../lib/session-goal.ts";
import { paneDomId } from "./chat-composer-dom.ts";
import type { ChatComposerState, ChatGoalManagementProps } from "./chat-composer-types.ts";

const goalElapsedTimers = new Map<HTMLElement, ReturnType<typeof setInterval>>();
const focusedGoalEditInputs = new WeakSet<HTMLInputElement>();
const goalIcon = strokeIcon(svg` <path d="M12 13V2l8 4-8 4" />
  <path d="M20.561 10.222a9 9 0 1 1-12.55-5.29" />
  <path d="M8.002 9.997a5 5 0 1 0 8.9 2.02" />`);

function clearGoalElapsedTimer(el: HTMLElement) {
  const timer = goalElapsedTimers.get(el);
  if (timer !== undefined) {
    clearInterval(timer);
    goalElapsedTimers.delete(el);
  }
}

// Ticks the elapsed span in place so an idle active goal does not force
// full chat re-renders every second.
function createGoalElapsedRef(goal: SessionGoal) {
  let bound: HTMLElement | null = null;
  return (element: Element | undefined) => {
    if (bound) {
      clearGoalElapsedTimer(bound);
      bound = null;
    }
    if (!(element instanceof HTMLElement)) {
      return;
    }
    element.textContent = formatGoalElapsed(goalElapsedMs(goal, Date.now()));
    if (goal.status !== "active") {
      return;
    }
    bound = element;
    const timer = setInterval(() => {
      // Tests and detached renders can drop the pill without a final ref call.
      if (!element.isConnected) {
        clearGoalElapsedTimer(element);
        return;
      }
      element.textContent = formatGoalElapsed(goalElapsedMs(goal, Date.now()));
    }, 1000);
    goalElapsedTimers.set(element, timer);
  };
}

type ChatGoalActions = {
  canAct: boolean;
  paneId: string;
  management?: ChatGoalManagementProps;
  onGoalCommand?: (command: string) => void;
  onGoalEdit?: (goal: SessionGoal) => void;
  requestUpdate: () => void;
};

function renderChatGoalActionButton(options: {
  className: string;
  label: string;
  icon: TemplateResult;
  disabled?: boolean;
  onClick: () => void;
}): TemplateResult {
  return html`
    <openclaw-tooltip content=${options.label}>
      <button
        class="agent-chat__goal-action ${options.className}"
        type="button"
        aria-label=${options.label}
        ?disabled=${options.disabled}
        @click=${options.onClick}
      >
        ${options.icon}
      </button>
    </openclaw-tooltip>
  `;
}

export function renderChatGoal(
  state: ChatComposerState,
  goal: SessionGoal | undefined,
  actions: ChatGoalActions,
): TemplateResult | typeof nothing {
  if (!goal) {
    return nothing;
  }
  const elapsed = formatGoalElapsed(goalElapsedMs(goal, Date.now()));
  const usage = formatGoalUsage(goal);
  const expanded = state.goalExpandedId === goal.id;
  const management = actions.management;
  const pending = management?.pending === true;
  const editing = management?.editObjective !== null && management?.editObjective !== undefined;
  const canUpdate = actions.canAct && Boolean(management?.onUpdate || actions.onGoalCommand);
  const canClear = actions.canAct && Boolean(management?.onClear || actions.onGoalCommand);
  const canResume =
    goal.status === "paused" ||
    goal.status === "blocked" ||
    goal.status === "usage_limited" ||
    goal.status === "budget_limited";
  const toggleExpanded = () => {
    state.goalExpandedId = expanded ? null : goal.id;
    actions.requestUpdate();
  };
  const updateGoal = (action: "pause" | "resume" | "complete") => {
    if (management?.onUpdate) {
      management.onUpdate({ action });
      return;
    }
    actions.onGoalCommand?.(`/goal ${action}`);
  };
  const editGoal = () => {
    if (management?.onUpdate && management.onEditStart) {
      management.onEditStart(goal.objective);
      return;
    }
    actions.onGoalEdit?.(goal);
  };
  const clearGoal = () => {
    if (management?.onClear) {
      management.onClear();
      return;
    }
    actions.onGoalCommand?.("/goal clear");
  };
  const detailExpanded = expanded || editing;
  return html`
    <div
      class="agent-chat__goal agent-chat__goal--${goal.status}"
      data-expanded=${String(detailExpanded)}
      role="group"
      id=${paneDomId(actions.paneId, "goal-management")}
      aria-label=${formatGoalDetail(goal)}
      aria-busy=${pending ? "true" : "false"}
      tabindex="-1"
    >
      <div class="agent-chat__goal-row">
        <span class="agent-chat__goal-icon">${goalIcon}</span>
        <span class="agent-chat__goal-copy">
          <span class="agent-chat__goal-label">${formatGoalStatusLabel(goal.status)}</span>
          <span class="agent-chat__goal-objective">${goal.objective}</span>
        </span>
        <span class="agent-chat__goal-elapsed" ${ref(createGoalElapsedRef(goal))}></span>
        <span class="agent-chat__goal-actions">
          ${canUpdate &&
          (management?.onEditStart || actions.onGoalEdit) &&
          goal.status !== "complete" &&
          !editing
            ? renderChatGoalActionButton({
                className: "agent-chat__goal-edit",
                label: t("chat.goals.edit"),
                icon: icons.penLine,
                disabled: pending,
                onClick: editGoal,
              })
            : nothing}
          ${canUpdate && goal.status === "active"
            ? renderChatGoalActionButton({
                className: "agent-chat__goal-pause",
                label: t("chat.goals.pause"),
                icon: icons.pause,
                disabled: pending,
                onClick: () => updateGoal("pause"),
              })
            : nothing}
          ${canUpdate && canResume
            ? renderChatGoalActionButton({
                className: "agent-chat__goal-resume",
                label: t("chat.goals.resume"),
                icon: icons.play,
                disabled: pending,
                onClick: () => updateGoal("resume"),
              })
            : nothing}
          ${canUpdate && goal.status !== "complete"
            ? renderChatGoalActionButton({
                className: "agent-chat__goal-complete",
                label: t("chat.goals.complete"),
                icon: icons.check,
                disabled: pending,
                onClick: () => updateGoal("complete"),
              })
            : nothing}
          ${canClear
            ? renderChatGoalActionButton({
                className: "agent-chat__goal-clear",
                label: t("chat.goals.clear"),
                icon: icons.trash,
                disabled: pending,
                onClick: clearGoal,
              })
            : nothing}
          <button
            class="agent-chat__goal-action agent-chat__goal-expand"
            type="button"
            aria-expanded=${expanded ? "true" : "false"}
            aria-label=${t(expanded ? "chat.goals.hideDetails" : "chat.goals.showDetails")}
            ?disabled=${pending}
            @click=${toggleExpanded}
          >
            ${expanded ? icons.chevronDown : icons.chevronRight}
          </button>
        </span>
      </div>
      ${management?.error
        ? html`<div class="agent-chat__goal-detail-note" role="alert">${management.error}</div>`
        : nothing}
      <div
        class="agent-chat__goal-detail"
        data-expanded=${String(detailExpanded)}
        aria-hidden=${String(!detailExpanded)}
        ?inert=${!detailExpanded}
      >
        <div class="agent-chat__goal-detail-content">
          ${editing
            ? html`<form
                @submit=${(event: SubmitEvent) => {
                  event.preventDefault();
                  const objective = management.editObjective?.trim();
                  if (objective) {
                    management.onUpdate?.({ action: "edit", objective });
                  }
                }}
              >
                <input
                  class="agent-chat__goal-edit-input"
                  aria-label=${t("chat.goals.edit")}
                  .value=${management.editObjective ?? ""}
                  ?disabled=${pending}
                  ${ref((element) => {
                    if (
                      element instanceof HTMLInputElement &&
                      !focusedGoalEditInputs.has(element)
                    ) {
                      focusedGoalEditInputs.add(element);
                      queueMicrotask(() => element.focus({ preventScroll: true }));
                    }
                  })}
                  @input=${(event: InputEvent) => {
                    if (event.currentTarget instanceof HTMLInputElement) {
                      management.onEditChange?.(event.currentTarget.value);
                    }
                  }}
                />
                <button
                  class="agent-chat__goal-action"
                  type="submit"
                  aria-label=${t("common.save")}
                  ?disabled=${pending || !management.editObjective?.trim()}
                >
                  ${icons.check}
                </button>
                <button
                  class="agent-chat__goal-action"
                  type="button"
                  aria-label=${t("common.cancel")}
                  ?disabled=${pending}
                  @click=${management.onEditCancel}
                >
                  ${icons.x}
                </button>
              </form>`
            : html`<div class="agent-chat__goal-detail-objective">${goal.objective}</div>`}
          ${goal.lastStatusNote
            ? html`<div class="agent-chat__goal-detail-note">${goal.lastStatusNote}</div>`
            : nothing}
          <div class="agent-chat__goal-detail-meta">
            ${usage ? `${usage} · ${elapsed}` : elapsed}
          </div>
        </div>
      </div>
    </div>
  `;
}

export function clearGoalElapsedTimers(): void {
  for (const timer of goalElapsedTimers.values()) {
    clearInterval(timer);
  }
  goalElapsedTimers.clear();
}

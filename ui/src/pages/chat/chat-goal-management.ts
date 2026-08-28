import type { SessionsGoalClearResult, SessionsGoalUpdateResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type { ChatGoalManagementProps, ChatGoalUpdate } from "./components/chat-composer-types.ts";

type GoalManagementTarget = {
  client: GatewayBrowserClient;
  sessions: Pick<SessionCapability, "patchRowLocal">;
  sessionKey: string;
  agentId: string;
  goalId: string;
  canUpdate: boolean;
  canClear: boolean;
  requestUpdate: () => void;
};

type GoalManagementState = {
  client: GatewayBrowserClient;
  targetKey: string;
  generation: number;
  pending: boolean;
  error: string | null;
  editObjective: string | null;
  retry?: { requestKey: string; operationId: string };
};

const states = new WeakMap<object, GoalManagementState>();

function readState(owner: object, target: GoalManagementTarget): GoalManagementState {
  const targetKey = `${target.sessionKey}\0${target.agentId}\0${target.goalId}`;
  const current = states.get(owner);
  if (current?.targetKey === targetKey) {
    current.client = target.client;
    return current;
  }
  const next = {
    client: target.client,
    targetKey,
    generation: (current?.generation ?? 0) + 1,
    pending: false,
    error: null,
    editObjective: null,
  };
  states.set(owner, next);
  return next;
}

export function createChatGoalManagementProps(
  owner: object,
  target: GoalManagementTarget,
): ChatGoalManagementProps | undefined {
  if (!target.canUpdate && !target.canClear) {
    return undefined;
  }
  const state = readState(owner, target);
  const ownsState = () => states.get(owner) === state;
  const setState = (patch: Partial<GoalManagementState>) => {
    Object.assign(state, patch);
    target.requestUpdate();
  };
  const run = async (request: ChatGoalUpdate | { action: "clear" }) => {
    if (state.pending) {
      return;
    }
    const generation = state.generation;
    const requestKey = JSON.stringify(request);
    const operationId =
      state.retry?.requestKey === requestKey ? state.retry.operationId : generateUUID();
    state.retry = { requestKey, operationId };
    setState({ pending: true, error: null });
    try {
      if (request.action === "clear") {
        await target.client.request<SessionsGoalClearResult>("sessions.goal.clear", {
          sessionKey: target.sessionKey,
          agentId: target.agentId,
          goalId: target.goalId,
          operationId,
        });
        if (ownsState() && state.generation === generation) {
          target.sessions.patchRowLocal(target.sessionKey, { goal: undefined });
          state.retry = undefined;
        }
      } else {
        const result = await target.client.request<SessionsGoalUpdateResult>(
          "sessions.goal.update",
          {
            sessionKey: target.sessionKey,
            agentId: target.agentId,
            goalId: target.goalId,
            operationId,
            ...request,
          },
        );
        if (ownsState() && state.generation === generation) {
          target.sessions.patchRowLocal(target.sessionKey, { goal: result.goal });
          state.editObjective = null;
          state.retry = undefined;
        }
      }
    } catch (error) {
      if (ownsState() && state.generation === generation) {
        state.error = formatUiError(error);
      }
    } finally {
      if (ownsState() && state.generation === generation) {
        state.pending = false;
        target.requestUpdate();
      }
    }
  };
  return {
    pending: state.pending,
    error: state.error,
    editObjective: state.editObjective,
    onEditStart: target.canUpdate
      ? (objective) => setState({ editObjective: objective, error: null })
      : undefined,
    onEditChange: target.canUpdate
      ? (objective) => setState({ editObjective: objective })
      : undefined,
    onEditCancel: target.canUpdate
      ? () => setState({ editObjective: null, error: null })
      : undefined,
    onUpdate: target.canUpdate ? (update) => void run(update) : undefined,
    onClear: target.canClear ? () => void run({ action: "clear" }) : undefined,
  };
}

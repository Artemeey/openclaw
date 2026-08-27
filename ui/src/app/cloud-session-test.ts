import type {
  CloudSessionTestResult,
  WizardNextResult,
  WizardStartParams,
  WizardStartResult,
  WizardStatusResult,
  WizardStep,
} from "../../../packages/gateway-protocol/src/schema/wizard.js";
import { formatUiError } from "../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../lib/gateway-connection-lifecycle.ts";
import { isWizardNotFoundError } from "../lib/gateway-errors.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import type { ApplicationGateway } from "./gateway.ts";

export type CloudSessionTestState = {
  profileId: string;
  label: string;
  sourceRevision: string;
  sessionId?: string;
  phase: "starting" | "observing" | "reconnecting" | "interrupted" | "finished";
  step?: WizardStep;
  value?: unknown;
  result?: CloudSessionTestResult;
  answering: boolean;
  cancelling: boolean;
  error?: string;
};

export type ApplicationCloudSessionTest = {
  readonly state: CloudSessionTestState | null;
  readonly canStart: boolean;
  start(
    profileId: string,
    label: string,
    sourceRevision: string,
    context?: Pick<WizardStartParams, "agentId">,
  ): void;
  answer(value: unknown): void;
  setValue(value: unknown): void;
  cancel(): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
};

// One in-memory observation handle survives route changes. Only the Gateway owns
// allocation and cleanup; losing a browser request must never cancel that owner.
export function createApplicationCloudSessionTest(
  gateway: ApplicationGateway,
): ApplicationCloudSessionTest {
  const lifecycle = createGatewayConnectionLifecycle(gateway.snapshot);
  const listeners = new Set<() => void>();
  let state: CloudSessionTestState | null = null;
  let gatewayUrl = gateway.connection.gatewayUrl;
  let connectionRevision = gateway.connectionRevision;
  let recoveryScope = gateway.snapshot.client?.recoveryScope;
  let bootId: string | undefined;
  let generation = 0;
  let request: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => listeners.forEach((listener) => listener());
  const available = (method: string) =>
    canCallGatewayMethod(gateway.snapshot, method, "operator.admin");
  const stopObserving = () => {
    generation += 1;
    request?.abort();
    request = undefined;
    clearTimeout(timer);
  };
  const interrupted = (error?: string) => {
    stopObserving();
    if (state) {
      state = {
        ...state,
        phase: "interrupted",
        step: undefined,
        value: undefined,
        answering: false,
        error,
      };
    }
    publish();
  };
  const schedule = (method: "wizard.next" | "wizard.status") => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (state?.sessionId && state.phase === "observing") {
        void run(method, { sessionId: state.sessionId });
      }
    }, 500);
  };
  const accept = (result: WizardNextResult | WizardStatusResult) => {
    if (!state) {
      return;
    }
    const done = "done" in result ? result.done : result.status !== "running";
    const step = "step" in result ? result.step : undefined;
    const proof = result.cloudSessionTest ?? state.result;
    state = {
      ...state,
      result: proof,
      step,
      value: step?.initialValue,
      answering: false,
      error: result.error,
      phase: done ? "finished" : "observing",
    };
    // A transport terminal state is not cleanup proof. Keep a pending cleanup
    // visible even when the wizard has finished or expired.
    if (!done) {
      schedule(state.cancelling ? "wizard.status" : "wizard.next");
    } else if (proof?.cleanup === "pending") {
      state = { ...state, phase: "observing" };
      schedule("wizard.status");
    }
    if (step && step.executor !== "gateway" && step.type !== "progress") {
      clearTimeout(timer);
    }
    publish();
  };
  async function run(method: string, params: unknown) {
    const scope = lifecycle.capture();
    if (!scope || !state || !available(method)) {
      interrupted();
      return;
    }
    const currentGeneration = generation;
    const abort = new AbortController();
    request = abort;
    const current = () => lifecycle.isCurrent(scope) && generation === currentGeneration;
    try {
      const result = await scope.client.request<
        WizardStartResult | WizardNextResult | WizardStatusResult
      >(method, params, { signal: abort.signal, timeoutMs: null });
      if (!current() || !state) {
        return;
      }
      if ("sessionId" in result) {
        state = { ...state, sessionId: result.sessionId };
      }
      accept(result);
    } catch (error) {
      if (current()) {
        interrupted(isWizardNotFoundError(error) ? undefined : formatUiError(error).slice(0, 1024));
      }
    } finally {
      if (request === abort) {
        request = undefined;
      }
    }
  }
  const unsubscribe = gateway.subscribe((snapshot) => {
    const nextRecoveryScope =
      snapshot.phase === "connected" && snapshot.client?.recoveryScopeReady
        ? snapshot.client.recoveryScope
        : recoveryScope;
    const identityChanged =
      connectionRevision !== gateway.connectionRevision ||
      gatewayUrl !== gateway.connection.gatewayUrl ||
      nextRecoveryScope !== recoveryScope;
    connectionRevision = gateway.connectionRevision;
    gatewayUrl = gateway.connection.gatewayUrl;
    recoveryScope = nextRecoveryScope;
    const changed = lifecycle.transition(snapshot);
    if (identityChanged) {
      stopObserving();
      state = null;
      bootId = undefined;
      publish();
      return;
    }
    if (!state || state.phase === "interrupted" || state.phase === "finished") {
      return;
    }
    if (snapshot.phase === "connected" && snapshot.hello?.server?.bootId !== bootId) {
      interrupted();
    } else if (changed) {
      stopObserving();
      state = {
        ...state,
        phase: "reconnecting",
        step: undefined,
        value: undefined,
        answering: false,
      };
      publish();
    }
    if (
      state?.phase === "reconnecting" &&
      snapshot.phase === "connected" &&
      snapshot.client?.recoveryScopeReady
    ) {
      if (state.sessionId) {
        state = { ...state, phase: "observing" };
        void run("wizard.status", { sessionId: state.sessionId });
      } else {
        interrupted();
      }
    }
  });
  const owner: ApplicationCloudSessionTest = {
    get state() {
      return state;
    },
    get canStart() {
      return Boolean(
        gateway.snapshot.client?.recoveryScopeReady &&
        ["wizard.start", "wizard.next", "wizard.status", "wizard.cancel"].every(available) &&
        (!state ||
          (state.phase === "finished" &&
            state.result &&
            state.result.status !== "running" &&
            state.result.cleanup !== "pending")),
      );
    },
    start(profileId, label, sourceRevision, context) {
      if (!owner.canStart) {
        return;
      }
      stopObserving();
      bootId = gateway.snapshot.hello?.server?.bootId;
      state = {
        profileId,
        label,
        sourceRevision,
        phase: "starting",
        answering: false,
        cancelling: false,
      };
      publish();
      const params: WizardStartParams = { flow: "cloud-session-test", profileId, ...context };
      void run("wizard.start", params);
    },
    answer(value) {
      if (
        !state?.sessionId ||
        !state.step ||
        state.phase !== "observing" ||
        state.answering ||
        state.cancelling
      ) {
        return;
      }
      const answer = { stepId: state.step.id, value };
      stopObserving();
      state = { ...state, answering: true, value: undefined };
      publish();
      void run("wizard.next", { sessionId: state.sessionId, answer });
    },
    setValue(value) {
      if (state?.step && !state.answering) {
        state = { ...state, value };
        publish();
      }
    },
    cancel() {
      if (!state?.sessionId || state.phase !== "observing" || state.cancelling) {
        return;
      }
      stopObserving();
      state = { ...state, cancelling: true, step: undefined, value: undefined, answering: false };
      publish();
      void run("wizard.cancel", { sessionId: state.sessionId });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      stopObserving();
      lifecycle.dispose();
      unsubscribe();
      listeners.clear();
      state = null;
    },
  };
  return owner;
}

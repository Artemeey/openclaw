import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { setRuntimeAuthProfileStoreSnapshot } from "../agents/auth-profiles/runtime-snapshots.js";
import * as preparedModelRuntime from "../agents/prepared-model-runtime.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import * as agentHandlerHelpers from "./agent-turn/agent-handler-helpers.js";
import { installConnectedSessionStoreGatewaySuite } from "./test-helpers.connected-session-store.js";
import {
  agentCommandMock,
  agentDiscoveryMock,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const gatewaySuite = installConnectedSessionStoreGatewaySuite("openclaw-gw-auth-refresh-", {
  client: {
    id: "gateway-client",
    version: "1.0.0",
    platform: "test",
    mode: "backend",
  },
});

type AgentRpcFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: {
    runId?: string;
    status?: string;
    stopReason?: string;
    timeoutPhase?: string;
    providerStarted?: boolean;
  };
  error?: { code?: string; message?: string };
};

function sendAgentRpc(socket: WebSocket, params: { agentId: string; runId: string }) {
  const accepted = onceMessage<AgentRpcFrame>(
    socket,
    (frame) =>
      frame.type === "res" && frame.id === params.runId && frame.payload?.status === "accepted",
  );
  const final = onceMessage<AgentRpcFrame>(
    socket,
    (frame) =>
      frame.type === "res" && frame.id === params.runId && frame.payload?.status !== "accepted",
  );
  socket.send(
    JSON.stringify({
      type: "req",
      id: params.runId,
      method: "agent",
      params: {
        agentId: params.agentId,
        message: `dispatch ${params.runId}`,
        idempotencyKey: params.runId,
      },
    }),
  );
  return { accepted, final };
}

function agentCommandCallsFor(runId: string) {
  return vi
    .mocked(agentCommandMock)
    .mock.calls.filter(([options]) => (options as { runId?: string }).runId === runId);
}

async function prepareAuthDispatchAgents(affectedAgentId: string) {
  testState.agentsConfig = {
    list: [{ id: "main", default: true }, { id: affectedAgentId }],
  };
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [{ id: "claude-opus-4-6", provider: "anthropic", input: ["text"] }];
  const { clearConfigCache, clearRuntimeConfigSnapshot, getRuntimeConfig } =
    await import("../config/io.js");
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await prepareGatewayReplyRuntimeForTest({ force: true });
  const config = getRuntimeConfig();
  return {
    agentDir: resolveAgentDir(config, affectedAgentId),
    runtime: await preparedModelRuntime.loadPublishedGatewayReplyDispatchRuntime({
      agentId: affectedAgentId,
    }),
  };
}

describe("gateway agent auth refresh dispatch", () => {
  beforeEach(() => {
    vi.mocked(agentCommandMock).mockClear();
  });

  afterEach(() => {
    testState.agentsConfig = undefined;
  });

  test("keeps an accepted run on its runtime while the next run uses the replacement", async () => {
    const affectedAgentId = "auth-pinned";
    const admittedRunId = "idem-agent-auth-pinned";
    const subsequentRunId = "idem-agent-auth-next";
    const before = await prepareAuthDispatchAgents(affectedAgentId);
    const acquireRuntimeLease =
      preparedModelRuntime.acquireAgentRunPreparedModelRuntime.bind(preparedModelRuntime);
    const acquireSpy = vi
      .spyOn(preparedModelRuntime, "acquireAgentRunPreparedModelRuntime")
      .mockImplementation(async (...args) => await acquireRuntimeLease(...args));
    const executionGate = createDeferred();
    const executionSpy = vi
      .spyOn(agentHandlerHelpers, "yieldAfterAgentAcceptedAck")
      .mockImplementation(async () => await executionGate.promise);
    const published = createDeferred();
    const unregister = preparedModelRuntime.registerPreparedModelRuntimePublicationListener(
      (event) => {
        if (event.phase === "published") {
          published.resolve();
        }
      },
    );
    try {
      const admitted = sendAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId: admittedRunId,
      });
      await admitted.accepted;
      expect(acquireSpy).toHaveBeenCalledOnce();
      expect(acquireSpy.mock.calls[0]?.[0]).toMatchObject({
        config: before.runtime?.config,
        agentId: before.runtime?.agentId,
        agentDir: before.runtime?.agentDir,
      });
      expect(acquireSpy.mock.calls[0]?.[1]?.pluginGeneration).toBe(
        before.runtime?.pluginGeneration,
      );

      setRuntimeAuthProfileStoreSnapshot(
        {
          version: 1,
          profiles: {
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "replacement-generation-key",
            },
          },
        },
        before.agentDir,
      );
      await published.promise;
      const after = await preparedModelRuntime.loadPublishedGatewayReplyDispatchRuntime({
        agentId: affectedAgentId,
      });
      expect(after).not.toBe(before.runtime);

      executionGate.resolve();
      await expect(admitted.final).resolves.toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });
      expect(acquireSpy).toHaveBeenCalledOnce();

      const subsequent = sendAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId: subsequentRunId,
      });
      await subsequent.accepted;
      await expect(subsequent.final).resolves.toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });
      expect(acquireSpy).toHaveBeenCalledTimes(2);
      expect(acquireSpy.mock.calls[1]?.[0]).toMatchObject({
        config: after?.config,
        agentId: after?.agentId,
        agentDir: after?.agentDir,
      });
      expect(acquireSpy.mock.calls[1]?.[1]?.pluginGeneration).toBe(after?.pluginGeneration);
    } finally {
      executionGate.resolve();
      unregister();
      acquireSpy.mockRestore();
      executionSpy.mockRestore();
    }
  });

  test("aborts one affected waiter without cancelling shared auth publication", async () => {
    const affectedAgentId = "auth-wait";
    const abortedRunId = "idem-agent-auth-aborted";
    const waitingRunId = "idem-agent-auth-waiting";
    const siblingRunId = "idem-agent-auth-sibling";
    const subsequentRunId = "idem-agent-auth-subsequent";
    const before = await prepareAuthDispatchAgents(affectedAgentId);
    const activeWorkBefore = getActiveGatewayRootWorkCount();
    const publicationGate = createDeferred<{ agentDir: string; wrote: false }>();
    const modelsConfig = await import("../agents/models-config.js");
    const ensureOpenClawModelsJson = modelsConfig.ensureOpenClawModelsJson;
    const ensureSpy = vi
      .spyOn(modelsConfig, "ensureOpenClawModelsJson")
      .mockImplementation(async (config, agentDir, options) =>
        agentDir === before.agentDir
          ? await publicationGate.promise
          : await ensureOpenClawModelsJson(config, agentDir, options),
      );
    const published = createDeferred();
    const unregister = preparedModelRuntime.registerPreparedModelRuntimePublicationListener(
      (event) => {
        if (event.phase === "published") {
          published.resolve();
        }
      },
    );
    try {
      setRuntimeAuthProfileStoreSnapshot(
        {
          version: 1,
          profiles: {
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "fresh-generation-key",
            },
          },
        },
        before.agentDir,
      );

      const aborted = sendAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId: abortedRunId,
      });
      const waiting = sendAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId: waitingRunId,
      });
      let abortedAccepted = false;
      let waitingAccepted = false;
      void aborted.accepted.then(
        () => {
          abortedAccepted = true;
        },
        () => undefined,
      );
      void waiting.accepted.then(() => {
        waitingAccepted = true;
      });
      const sibling = sendAgentRpc(gatewaySuite.ws, { agentId: "main", runId: siblingRunId });
      await sibling.accepted;
      await expect(sibling.final).resolves.toMatchObject({ ok: true, payload: { status: "ok" } });
      expect(agentCommandCallsFor(siblingRunId)).toHaveLength(1);
      expect(agentCommandCallsFor(abortedRunId)).toHaveLength(0);
      expect(agentCommandCallsFor(waitingRunId)).toHaveLength(0);
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(activeWorkBefore + 2));
      await Promise.resolve();
      expect(abortedAccepted).toBe(false);
      expect(waitingAccepted).toBe(false);

      const abort = await rpcReq(gatewaySuite.ws, "chat.abort", {
        sessionKey: `agent:${affectedAgentId}:main`,
        runId: abortedRunId,
      });
      expect(abort).toMatchObject({
        ok: true,
        payload: { aborted: true, runIds: [abortedRunId] },
      });
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(activeWorkBefore + 1));
      await expect(aborted.final).resolves.toMatchObject({
        ok: true,
        payload: {
          status: "timeout",
          stopReason: "rpc",
          timeoutPhase: "queue",
          providerStarted: false,
        },
      });
      await expect(
        Promise.race([waiting.final.then(() => "settled"), Promise.resolve("pending")]),
      ).resolves.toBe("pending");

      publicationGate.resolve({ agentDir: before.agentDir, wrote: false });
      await published.promise;
      const after = await preparedModelRuntime.loadPublishedGatewayReplyDispatchRuntime({
        agentId: affectedAgentId,
      });
      expect(after).not.toBe(before.runtime);
      await waiting.accepted;
      await expect(waiting.final).resolves.toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });
      const affectedCalls = agentCommandCallsFor(waitingRunId);
      expect(affectedCalls).toHaveLength(1);
      expect(affectedCalls[0]?.[4]).toMatchObject({
        config: after?.config,
        pluginGeneration: after?.pluginGeneration,
      });
      const subsequent = sendAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId: subsequentRunId,
      });
      await subsequent.accepted;
      await expect(subsequent.final).resolves.toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });
      expect(agentCommandCallsFor(subsequentRunId)).toHaveLength(1);
      expect(getActiveGatewayRootWorkCount()).toBe(activeWorkBefore);
    } finally {
      publicationGate.resolve({ agentDir: before.agentDir, wrote: false });
      unregister();
      ensureSpy.mockRestore();
    }
  });

  test("never reuses an affected projection after auth publication rejects", async () => {
    const affectedAgentId = "auth-reject";
    const runId = "idem-agent-auth-reject";
    const before = await prepareAuthDispatchAgents(affectedAgentId);
    const modelsConfig = await import("../agents/models-config.js");
    const ensureOpenClawModelsJson = modelsConfig.ensureOpenClawModelsJson;
    const ensureSpy = vi
      .spyOn(modelsConfig, "ensureOpenClawModelsJson")
      .mockImplementation(async (config, agentDir, options) => {
        if (agentDir === before.agentDir) {
          throw new Error("auth publication rejected");
        }
        return await ensureOpenClawModelsJson(config, agentDir, options);
      });
    const failed = createDeferred();
    const unregister = preparedModelRuntime.registerPreparedModelRuntimePublicationListener(
      (event) => {
        if (event.phase === "failed") {
          failed.resolve();
        }
      },
    );
    try {
      setRuntimeAuthProfileStoreSnapshot(
        {
          version: 1,
          profiles: {
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "rejected-generation-key",
            },
          },
        },
        before.agentDir,
      );
      await failed.promise;
      await expect(
        preparedModelRuntime.loadPublishedGatewayReplyDispatchRuntime({ agentId: affectedAgentId }),
      ).rejects.toThrow(
        `prepared reply dispatch runtime owner was not published for ${affectedAgentId}`,
      );

      const dispatched = sendAgentRpc(gatewaySuite.ws, { agentId: affectedAgentId, runId });
      let accepted = false;
      void dispatched.accepted.then(
        () => {
          accepted = true;
        },
        () => undefined,
      );
      await expect(dispatched.final).resolves.toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: expect.stringContaining(
            `prepared reply dispatch runtime owner was not published for ${affectedAgentId}`,
          ),
        },
      });
      await Promise.resolve();
      expect(accepted).toBe(false);
      expect(agentCommandCallsFor(runId)).toHaveLength(0);
    } finally {
      unregister();
      ensureSpy.mockRestore();
    }
  });
});

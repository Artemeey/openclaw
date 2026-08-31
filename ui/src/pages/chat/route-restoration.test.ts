// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsResolveResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { AgentsListResult } from "../../api/types.ts";
import { resolveInitialApplicationLocation } from "../../app/bootstrap-location.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadChatRoute } from "./route-loader.ts";

const savedKey = "agent:research:thread:12345678-0000-4000-8000-000000000001";

function restoreContext(
  options: {
    defaultId?: string;
    agentIds?: string[];
    mainKey?: string;
    resolve?: () => Promise<SessionsResolveResult>;
  } = {},
) {
  const defaultId = options.defaultId ?? "main";
  const mainKey = options.mainKey ?? "main";
  const roster: AgentsListResult = {
    defaultId,
    mainKey,
    scope: "per-sender",
    agents: (options.agentIds ?? ["main", "research"]).map((id) => ({ id })),
  };
  const request = vi.fn(
    async (_method: string, _params: unknown): Promise<SessionsResolveResult> =>
      options.resolve ? options.resolve() : { ok: false },
  );
  const gateway = {
    snapshot: {
      phase: "connected",
      client: { request },
      hello: { snapshot: { sessionDefaults: { defaultAgentId: defaultId, mainKey } } },
    } as unknown as ApplicationContext["gateway"]["snapshot"],
    subscribe: vi.fn(() => () => undefined),
  };
  const context = {
    basePath: "/openclaw",
    agents: { state: { agentsList: roster }, ensureList: vi.fn(async () => roster) },
    agentSelection: { state: { selectedId: defaultId } },
    gateway,
    sessions: {
      state: { result: { sessions: [] } },
      list: vi.fn(async () => ({ sessions: [], hasMore: false })),
    },
  } as unknown as ApplicationContext;
  const initialLocation = (sessionKey: string) =>
    resolveInitialApplicationLocation({
      location: { pathname: "/openclaw/", search: "?draft=hello", hash: "#kept" },
      basePath: context.basePath,
      sessionKey,
      gateway: context.gateway,
      agentsList: () => context.agents.state.agentsList,
      signal: new AbortController().signal,
    });
  return { context, gateway, initialLocation, request };
}

describe("remembered session restoration", () => {
  afterEach(() => vi.useRealTimers());
  it.each([
    { key: savedKey, agentIds: ["main", "research"], owner: "research", requests: 1 },
    {
      key: "agent:research:matrix:channel:!CaseSensitive",
      agentIds: ["main", "research"],
      owner: "research",
      requests: 1,
    },
    { key: savedKey, agentIds: ["main"], owner: "main", requests: 0 },
    {
      key: "agent:research:catalog:native:local:Thread-A",
      agentIds: ["main"],
      owner: "main",
      requests: 0,
    },
    {
      key: "agent:research:workspace",
      agentIds: ["main", "research"],
      owner: "research",
      requests: 0,
    },
  ])(
    "recovers $key to $owner with agents $agentIds",
    async ({ key, agentIds, owner, requests }) => {
      const { context, initialLocation, request } = restoreContext({
        agentIds,
        mainKey: "workspace",
      });
      const location = await initialLocation(key);
      await expect(
        loadChatRoute(context, location, "chat", new AbortController().signal),
      ).resolves.toMatchObject({
        kind: "session",
        sessionKey: `agent:${owner}:workspace`,
        draft: "hello",
        canonicalLocation: {
          pathname: `/openclaw/chat/${owner}`,
          search: "?draft=hello",
          hash: "#kept",
        },
      });
      expect(request).toHaveBeenCalledTimes(requests);
    },
  );

  it.each([savedKey, "agent:research:standup"])(
    "restores %s outside the list window through canonicalization",
    async (restoredKey) => {
      vi.useFakeTimers();
      const { context, initialLocation, request } = restoreContext({
        resolve: async () => ({ ok: true, key: restoredKey, agentId: "research" }),
      });
      const location = await initialLocation(restoredKey);
      const data = await loadChatRoute(context, location, "chat", new AbortController().signal);
      expect(request).toHaveBeenCalledExactlyOnceWith("sessions.resolve", {
        key: restoredKey,
        agentId: "research",
        allowMissing: true,
      });
      expect(data).toMatchObject({ kind: "session", sessionKey: restoredKey });
      if (!("kind" in data) || data.kind !== "session" || !data.canonicalLocation) {
        throw new Error("Expected a canonical restored session");
      }
      // The initial route's component graph can take longer than a navigation handoff.
      await vi.advanceTimersByTimeAsync(3_000);
      data.prepareCanonicalLocation?.();
      await expect(
        loadChatRoute(context, data.canonicalLocation, "chat", new AbortController().signal),
      ).resolves.toMatchObject({
        kind: "session",
        sessionKey: restoredKey,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(context.sessions.list).not.toHaveBeenCalled();
    },
  );

  it("validates a remembered former default agent after the first handshake", async () => {
    const { context, gateway, initialLocation, request } = restoreContext({
      defaultId: "research",
      agentIds: ["research"],
    });
    const connected = context.gateway.snapshot;
    gateway.snapshot = { ...connected, phase: "connecting", client: null, hello: null };
    context.agents.state.agentsList = null;
    const location = await initialLocation("agent:main:main");
    gateway.snapshot = connected;
    await expect(
      loadChatRoute(context, location, "chat", new AbortController().signal),
    ).resolves.toMatchObject({
      kind: "session",
      sessionKey: "agent:research:main",
      canonicalLocation: {
        pathname: "/openclaw/chat/research",
        search: "?draft=hello",
        hash: "#kept",
      },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a native catalog source on its catalog route without a stored-session lookup", async () => {
    const { context, initialLocation, request } = restoreContext();
    const key = "agent:research:catalog:native:local:Thread-A";
    const location = await initialLocation(key);
    await expect(
      loadChatRoute(context, location, "chat", new AbortController().signal),
    ).resolves.toMatchObject({
      kind: "session",
      sessionKey: key,
      agentId: "research",
      canonicalLocation: {
        pathname: "/openclaw/chat/research",
        search: "?draft=hello&catalog=native&host=local&thread=Thread-A",
        hash: "#kept",
      },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["request failure", "navigation abort"])(
    "does not replace remembered state after %s",
    async (failure) => {
      const controller = new AbortController();
      const error = new Error(failure);
      const { context, initialLocation } = restoreContext({
        resolve: async () => {
          if (failure === "request failure") {
            throw error;
          }
          controller.abort(error);
          return { ok: false };
        },
      });
      const location = await initialLocation(savedKey);
      await expect(loadChatRoute(context, location, "chat", controller.signal)).rejects.toBe(error);
    },
  );
});

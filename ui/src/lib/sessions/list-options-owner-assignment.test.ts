import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";

function sessionsResult(sessions: SessionsListResult["sessions"], ts: number): SessionsListResult {
  return {
    ts,
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function createSessions(client: GatewayBrowserClient, key: string) {
  return createSessionCapability({
    snapshot: {
      client,
      phase: "connected" as const,
      sessionKey: key,
      assistantAgentId: "main",
      hello: null,
      selfUser: null,
    },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });
}

describe("session owner assignment list reconciliation", () => {
  it("refreshes an active owner filter that gains the assigned session", async () => {
    const key = "agent:main:new-owner-filter";
    const ada = { type: "human" as const, id: "profile-ada", label: "Ada" };
    const bob = { type: "human" as const, id: "profile-bob", label: "Bob" };
    const assignedOwner = { actor: ada, assignedBy: ada, assignedAt: 20 };
    const replacement = deferred<SessionsListResult>();
    const managedScope = { agentId: "main", ownerId: ada.id };
    let managedCalls = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.assignOwner") {
        return { ok: true, key, owner: assignedOwner };
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const managed =
        typeof params === "object" &&
        params !== null &&
        "ownerId" in params &&
        params.ownerId === ada.id;
      if (!managed) {
        return sessionsResult([{ key, kind: "direct", updatedAt: 20, owner: assignedOwner }], 20);
      }
      managedCalls += 1;
      return managedCalls === 1
        ? { ...sessionsResult([], 10), owners: [bob] }
        : await replacement.promise;
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);
    const stop = sessions.subscribeList(managedScope, () => undefined);

    await sessions.refreshList({ ...managedScope, force: true });
    expect(sessions.listSnapshot(managedScope).result?.sessions).toHaveLength(0);

    await sessions.assignOwner(key, ada, { agentId: "main" });

    await vi.waitFor(() => expect(managedCalls).toBe(2));
    expect(sessions.listSnapshot(managedScope).result?.owners).toBeUndefined();

    replacement.resolve({
      ...sessionsResult([{ key, kind: "direct", updatedAt: 20, owner: assignedOwner }], 20),
      owners: [ada],
    });
    await vi.waitFor(() =>
      expect(sessions.listSnapshot(managedScope).result?.sessions[0]?.owner).toEqual(assignedOwner),
    );
    stop();
    sessions.dispose();
  });

  it("carries a newer owner through an older managed-list response", async () => {
    const key = "agent:main:superseded-managed-owner";
    const ada = { type: "human" as const, id: "profile-ada", label: "Ada" };
    const bob = { type: "human" as const, id: "profile-bob", label: "Bob" };
    const carol = { type: "human" as const, id: "profile-carol", label: "Carol" };
    const oldOwner = { actor: bob, assignedBy: bob, assignedAt: 10 };
    const assignedOwner = { actor: ada, assignedBy: ada, assignedAt: 20 };
    const supersedingOwner = { actor: carol, assignedBy: carol, assignedAt: 30 };
    const staleManagedResponse = deferred<SessionsListResult>();
    const managedReplacement = deferred<SessionsListResult>();
    const managedScope = { agentId: "main", search: "superseded-managed-owner" };
    let managedCalls = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.assignOwner") {
        return { ok: true, key, owner: assignedOwner };
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const managed =
        typeof params === "object" &&
        params !== null &&
        "search" in params &&
        params.search === managedScope.search;
      if (!managed) {
        return {
          ...sessionsResult([{ key, kind: "direct", updatedAt: 30, owner: supersedingOwner }], 30),
          owners: [carol],
        };
      }
      managedCalls += 1;
      if (managedCalls === 2) {
        return await staleManagedResponse.promise;
      }
      if (managedCalls === 3) {
        return await managedReplacement.promise;
      }
      return {
        ...sessionsResult([{ key, kind: "direct", updatedAt: 10, owner: oldOwner }], 10),
        owners: [ada, bob],
      };
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);
    const stop = sessions.subscribeList(managedScope, () => undefined);

    await sessions.refreshList({ ...managedScope, force: true });
    const staleRefresh = sessions.refreshList({ ...managedScope, force: true });
    await vi.waitFor(() => expect(managedCalls).toBe(2));
    await sessions.assignOwner(key, ada, { agentId: "main" });

    staleManagedResponse.resolve({
      ...sessionsResult([{ key, kind: "direct", updatedAt: 10, owner: oldOwner }], 10),
      owners: [ada, bob],
    });
    await vi.waitFor(() => expect(managedCalls).toBe(3));
    expect(sessions.listSnapshot(managedScope).result?.sessions[0]?.owner).toEqual(
      supersedingOwner,
    );
    expect(sessions.listSnapshot(managedScope).result?.owners).toBeUndefined();

    managedReplacement.resolve({
      ...sessionsResult([{ key, kind: "direct", updatedAt: 30, owner: supersedingOwner }], 30),
      owners: [carol],
    });
    await staleRefresh;
    expect(sessions.listSnapshot(managedScope).result?.owners).toEqual([carol]);
    stop();
    sessions.dispose();
  });

  it("retains the confirmed owner until the matching managed list catches up", async () => {
    const key = "agent:main:managed-owner";
    const ada = { type: "human" as const, id: "profile-ada", label: "Ada" };
    const bob = { type: "human" as const, id: "profile-bob", label: "Bob" };
    const oldOwner = { actor: bob, assignedBy: ada, assignedAt: 10 };
    const assignedOwner = { actor: ada, assignedBy: ada, assignedAt: 20 };
    const staleManagedResponse = deferred<SessionsListResult>();
    const managedReplacement = deferred<SessionsListResult>();
    const managedScope = { agentId: "main", search: "managed-owner" };
    let managedCalls = 0;
    let primaryCalls = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.assignOwner") {
        return { ok: true, key, owner: assignedOwner };
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const managed =
        typeof params === "object" &&
        params !== null &&
        "search" in params &&
        params.search === managedScope.search;
      if (!managed) {
        primaryCalls += 1;
        return {
          ...sessionsResult([{ key, kind: "direct", updatedAt: 30, owner: assignedOwner }], 30),
          owners: [ada],
        };
      }
      managedCalls += 1;
      if (managedCalls === 2) {
        return await staleManagedResponse.promise;
      }
      if (managedCalls === 3) {
        return await managedReplacement.promise;
      }
      return {
        ...sessionsResult([{ key, kind: "direct", updatedAt: 10, owner: oldOwner }], 10),
        owners: [ada, bob],
      };
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);
    const stop = sessions.subscribeList(managedScope, () => undefined);

    await sessions.refreshList({ ...managedScope, force: true });
    const staleRefresh = sessions.refreshList({ ...managedScope, force: true });
    await vi.waitFor(() => expect(managedCalls).toBe(2));
    await expect(sessions.assignOwner(key, ada, { agentId: "main" })).resolves.toEqual(
      assignedOwner,
    );
    await vi.waitFor(() => expect(primaryCalls).toBeGreaterThanOrEqual(1));

    staleManagedResponse.resolve({
      ...sessionsResult([{ key, kind: "direct", updatedAt: 10, owner: oldOwner }], 10),
      owners: [ada, bob],
    });
    await vi.waitFor(() => expect(managedCalls).toBe(3));
    expect(sessions.listSnapshot(managedScope).result?.sessions[0]?.owner).toEqual(assignedOwner);
    expect(sessions.listSnapshot(managedScope).result?.owners).toBeUndefined();

    managedReplacement.resolve({
      ...sessionsResult([{ key, kind: "direct", updatedAt: 20, owner: assignedOwner }], 20),
      owners: [ada],
    });
    await staleRefresh;
    expect(sessions.listSnapshot(managedScope).result?.sessions[0]?.owner).toEqual(assignedOwner);
    expect(sessions.listSnapshot(managedScope).result?.owners).toEqual([ada]);
    stop();
    sessions.dispose();
  });
});

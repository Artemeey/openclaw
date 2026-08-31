// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";
import type { SessionListSnapshot } from "./session-capability.ts";

const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 200;

function rowCategory(result: SessionsListResult | null, key: string): string | null {
  return result?.sessions.find((row) => row.key === key)?.category ?? null;
}

function sessionChangedPayload(key: string, category: string) {
  return {
    sessionKey: key,
    reason: "send",
    key,
    kind: "direct",
    updatedAt: 3,
    category,
  };
}

function categoryHarness(options: {
  patchResponse: (call: number) => Promise<unknown>;
  serverCategory: () => string;
}) {
  const key = "agent:main:alpha";
  let patchCalls = 0;
  let listTs = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.patch") {
      patchCalls += 1;
      return await options.patchResponse(patchCalls);
    }
    if (method === "sessions.list") {
      listTs += 1;
      return sessionsResult(
        [{ key, kind: "direct", updatedAt: 1, category: options.serverCategory() }],
        listTs,
      );
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const harness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  return { ...harness, key };
}

describe("session category mutations", () => {
  it("keeps a pending category through a stale Gateway event and list refresh", async () => {
    vi.useFakeTimers();
    try {
      const committed = createDeferred<unknown>();
      let serverCategory = "Alpha";
      const { gateway, key, emitEvent } = categoryHarness({
        patchResponse: () => committed.promise,
        serverCategory: () => serverCategory,
      });
      const sessions = createSessionCapability(gateway);

      await sessions.refresh({ force: true });
      const operation = sessions.patch(key, { category: "Beta" });
      expect(rowCategory(sessions.state.result, key)).toBe("Beta");

      const stalePayload = sessionChangedPayload(key, "Alpha");
      sessions.reconcileChanged(stalePayload);
      expect(rowCategory(sessions.state.result, key)).toBe("Beta");

      emitEvent({ type: "event", event: "sessions.changed", payload: stalePayload });
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
      expect(rowCategory(sessions.state.result, key)).toBe("Beta");

      serverCategory = "Beta";
      committed.resolve({ ok: true, key, path: "", entry: {} });
      await expect(operation).resolves.toBeTruthy();
      expect(rowCategory(sessions.state.result, key)).toBe("Beta");
      sessions.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls a rejected category back across primary and filtered lists", async () => {
    const { gateway, key } = categoryHarness({
      patchResponse: () => Promise.reject(new Error("category rejected")),
      serverCategory: () => "Alpha",
    });
    const sessions = createSessionCapability(gateway);
    const filtered: SessionListSnapshot[] = [];
    const stopFiltered = sessions.subscribeList({ archivedFilter: "all" }, (snapshot) => {
      filtered.push(snapshot);
    });
    const filteredCategory = () => rowCategory(filtered.at(-1)?.result ?? null, key);

    await sessions.refresh({ force: true });
    await sessions.refreshList({ archivedFilter: "all", force: true });
    const operation = sessions.patch(key, { category: "Beta" });
    expect(rowCategory(sessions.state.result, key)).toBe("Beta");
    expect(filteredCategory()).toBe("Beta");

    await expect(operation).rejects.toThrow("category rejected");
    expect(rowCategory(sessions.state.result, key)).toBe("Alpha");
    expect(filteredCategory()).toBe("Alpha");
    expect(sessions.state.error).toContain("category rejected");
    stopFiltered();
    sessions.dispose();
  });

  it("rolls a failed move back to the category an overlapping move confirmed", async () => {
    const firstCommitted = createDeferred<unknown>();
    const secondRejected = createDeferred<unknown>();
    let serverCategory = "Alpha";
    const { gateway, key } = categoryHarness({
      patchResponse: (call) => (call === 1 ? firstCommitted.promise : secondRejected.promise),
      serverCategory: () => serverCategory,
    });
    const sessions = createSessionCapability(gateway);

    await sessions.refresh({ force: true });
    const first = sessions.patch(key, { category: "Beta" });
    const second = sessions.patch(key, { category: "Gamma" });
    expect(rowCategory(sessions.state.result, key)).toBe("Gamma");

    serverCategory = "Beta";
    firstCommitted.resolve({ ok: true, key, path: "", entry: {} });
    await expect(first).resolves.toBeTruthy();
    expect(rowCategory(sessions.state.result, key)).toBe("Gamma");

    secondRejected.reject(new Error("second move rejected"));
    await expect(second).rejects.toThrow("second move rejected");
    expect(rowCategory(sessions.state.result, key)).toBe("Beta");
    sessions.dispose();
  });
});

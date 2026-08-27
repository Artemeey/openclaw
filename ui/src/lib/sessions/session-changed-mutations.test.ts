// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";

const KEY = "agent:main:alpha";

function changedError(successorSessionId?: string): Error {
  const error = new Error(`Session ${KEY} changed before deletion. Retry.`);
  Object.assign(error, {
    name: "GatewayRequestError",
    gatewayCode: "INVALID_REQUEST",
    details: {
      code: "SESSION_CHANGED",
      ...(successorSessionId ? { successorSessionId } : {}),
    },
  });
  return error;
}

function changedHarness(mutation: "sessions.patch" | "sessions.delete", error: Error) {
  let listCalls = 0;
  const request = vi.fn(async (method: string) => {
    if (method === mutation) {
      throw error;
    }
    if (method === "sessions.list") {
      listCalls += 1;
      return sessionsResult([{ key: KEY, kind: "direct", updatedAt: 1 }], listCalls);
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  return { gateway, listCalls: () => listCalls };
}

describe("session-changed mutation rejections", () => {
  it.each([
    {
      name: "names a continuation when the Gateway proved lineage",
      successorSessionId: "sess-successor",
      copy: "continued as a new session",
    },
    {
      name: "reports a replacement when it did not",
      successorSessionId: undefined,
      copy: "was replaced",
    },
  ])("$name", async ({ successorSessionId, copy }) => {
    const { gateway, listCalls } = changedHarness(
      "sessions.patch",
      changedError(successorSessionId),
    );
    const sessions = createSessionCapability(gateway);

    await sessions.refresh({ force: true });
    const before = listCalls();

    await expect(sessions.patch(KEY, { pinned: true })).resolves.toEqual(
      successorSessionId ? { kind: "continued", successorSessionId } : { kind: "replaced" },
    );

    // The published row is provably stale, so the owner refreshes it rather than
    // leaving every caller to notice.
    expect(listCalls()).toBeGreaterThan(before);
    expect(sessions.state.error).toContain(copy);
    expect(sessions.state.error).toContain(KEY);
    sessions.dispose();
  });

  it("refreshes the stale row when a delete is rejected", async () => {
    const { gateway, listCalls } = changedHarness("sessions.delete", changedError());
    const sessions = createSessionCapability(gateway);

    await sessions.refresh({ force: true });
    const before = listCalls();

    await expect(sessions.delete(KEY)).resolves.toEqual({ kind: "replaced" });

    expect(listCalls()).toBeGreaterThan(before);
    expect(sessions.state.error).toContain("was replaced");
    sessions.dispose();
  });

  it("treats an old Gateway rejection without structured details as a generic failure", async () => {
    const error = new Error(`Session ${KEY} changed before deletion. Retry.`);
    const { gateway, listCalls } = changedHarness("sessions.patch", error);
    const sessions = createSessionCapability(gateway);

    await sessions.refresh({ force: true });
    const before = listCalls();

    await expect(sessions.patch(KEY, { pinned: true })).resolves.toEqual({
      kind: "failed",
      error,
    });
    expect(listCalls()).toBe(before);
    expect(sessions.state.error).toBe(String(error));
    sessions.dispose();
  });

  it("preserves each result in a mixed delete batch", async () => {
    const continuedKey = "agent:main:continued";
    const replacedKey = "agent:main:replaced";
    const failedKey = "agent:main:failed";
    const failure = new Error("delete denied");
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.delete") {
        const key = (params as { key?: string } | undefined)?.key;
        if (key === continuedKey) {
          throw changedError("sess-successor");
        }
        if (key === replacedKey) {
          throw changedError();
        }
        if (key === failedKey) {
          throw failure;
        }
        return { ok: true, deleted: true };
      }
      if (method === "sessions.list") {
        return sessionsResult([], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const sessions = createSessionCapability(gateway);

    await expect(
      sessions.deleteMany([
        { key: KEY },
        { key: continuedKey },
        { key: replacedKey },
        { key: failedKey },
      ]),
    ).resolves.toEqual([
      { kind: "applied", key: KEY, deleted: true },
      { kind: "continued", key: continuedKey, successorSessionId: "sess-successor" },
      { kind: "replaced", key: replacedKey },
      { kind: "failed", key: failedKey, error: failure },
    ]);
    sessions.dispose();
  });
});

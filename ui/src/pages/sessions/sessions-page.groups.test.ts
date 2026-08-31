/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { showInputDialog } from "../../components/input-dialog.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import type { SessionGroupMutationResult } from "../../lib/sessions/session-capability.ts";
import {
  createContext,
  createGateway,
  createRenderedPage,
  createSessions,
} from "./sessions-page.test-support.ts";

vi.mock("../../components/input-dialog.ts", () => ({ showInputDialog: vi.fn() }));

const SESSION_KEY = "agent:main:move-me";
const SESSION_ID = "original-session";

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showInputDialog).mockReset();
  vi.restoreAllMocks();
});

async function mountGroupsPage(groupsPut: () => Promise<SessionGroupMutationResult>) {
  const sessions = createSessions({
    groupsPut: vi.fn(groupsPut),
    patch: vi.fn(async () => ({ key: SESSION_KEY })),
  } as unknown as Partial<SessionCapability>);
  const mutableGateway = createGateway({} as GatewayBrowserClient);
  mutableGateway.emit({
    hello: {
      auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
      features: { methods: ["sessions.groups.put", "sessions.patch"] },
    } as ApplicationGatewaySnapshot["hello"],
  });
  const page = await createRenderedPage(createContext(mutableGateway.gateway, sessions), {
    count: 1,
    sessions: [{ key: SESSION_KEY, sessionId: SESSION_ID, archived: false }],
  } as SessionsListResult);
  // The dialog itself is covered by input-dialog.test.ts; here it only stands in
  // for the operator submitting a name. A recorded message is what keeps the real
  // dialog open, so the outcome of each submit is captured rather than dropped.
  const submitMessages: Array<string | null | undefined> = [];
  vi.mocked(showInputDialog).mockImplementation(async (options) => {
    submitMessages.push(await options.submit?.("Client work"));
    return "Client work";
  });
  return { mutableGateway, page, sessions, submitMessages };
}

describe("sessions page new group", () => {
  it("assigns the session without prewriting the group catalog", async () => {
    const { page, sessions } = await mountGroupsPage(async () => "completed");

    await page.requestNewCategory(SESSION_KEY);

    expect(sessions.groupsPut).not.toHaveBeenCalled();
    expect(sessions.patch).toHaveBeenCalledOnce();
    expect(sessions.patch).toHaveBeenCalledWith(
      SESSION_KEY,
      { category: "Client work" },
      { agentId: undefined, expectedSessionId: SESSION_ID },
    );
  });

  it("closes the dialog when the operator navigates away from the page", async () => {
    const { page, sessions } = await mountGroupsPage(async () => "completed");
    let dialogSignal: AbortSignal | undefined;
    vi.mocked(showInputDialog).mockImplementation(async (options) => {
      dialogSignal = options.signal;
      // Sit open the way a dialog waiting on the operator does.
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return null;
    });

    const opened = page.requestNewCategory(SESSION_KEY);
    await vi.waitFor(() => expect(dialogSignal).toBeDefined());
    expect(dialogSignal?.aborted).toBe(false);

    // The dialog mounts on document.body, so detaching the page has to close it
    // rather than leave it over wherever the operator landed.
    page.remove();
    await opened;

    expect(dialogSignal?.aborted).toBe(true);
    expect(sessions.groupsPut).not.toHaveBeenCalled();
  });

  it("keeps the live dialog abortable when a second open overlaps it", async () => {
    const { page, sessions } = await mountGroupsPage(async () => "completed");
    const signals: Array<AbortSignal | undefined> = [];
    vi.mocked(showInputDialog).mockImplementation(async (options) => {
      signals.push(options.signal);
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return null;
    });

    const first = page.requestNewCategory(SESSION_KEY);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    // A reentrant open must not install a controller of its own: clearing it on
    // the way out would strand the dialog that is actually on screen.
    const second = page.requestNewCategory(SESSION_KEY);
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    page.remove();
    await Promise.all([first, second]);

    expect(signals[0]?.aborted).toBe(true);
    expect(sessions.groupsPut).not.toHaveBeenCalled();
  });

  it("captures the selected identity before the dialog's lazy load", async () => {
    const { page, sessions } = await mountGroupsPage(async () => "completed");
    const pending = page.requestNewCategory(SESSION_KEY);
    page.result = {
      count: 1,
      sessions: [{ key: SESSION_KEY, sessionId: "replacement-session" }],
    } as SessionsListResult;
    await pending;
    expect(sessions.patch).toHaveBeenCalledWith(
      SESSION_KEY,
      { category: "Client work" },
      { agentId: undefined, expectedSessionId: SESSION_ID },
    );
  });

  it("creates an empty group without a selected row", async () => {
    const { page, sessions, submitMessages } = await mountGroupsPage(async () => "completed");
    await page.requestNewCategory();
    expect(sessions.groupsPut).toHaveBeenCalledWith(["Client work"]);
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(submitMessages).toEqual([null]);
  });

  it("keeps the name retryable when the assignment fails", async () => {
    const { page, sessions, submitMessages } = await mountGroupsPage(async () => "completed");
    vi.mocked(sessions.patch).mockRejectedValueOnce(new Error("Group assignment rejected"));
    await page.requestNewCategory(SESSION_KEY);
    expect(sessions.groupsPut).not.toHaveBeenCalled();
    expect(sessions.patch).toHaveBeenCalledOnce();
    expect(submitMessages).toEqual(["Group assignment rejected"]);
  });

  it("asks for a refresh instead of starting an unbound move", async () => {
    const { page, sessions } = await mountGroupsPage(async () => "completed");
    page.result = { count: 1, sessions: [{ key: SESSION_KEY }] } as SessionsListResult;
    await page.requestNewCategory(SESSION_KEY);
    expect(showInputDialog).not.toHaveBeenCalled();
    expect(sessions.groupsPut).not.toHaveBeenCalled();
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(page.error).toBe("Refresh");
  });

  it("keeps an empty-group name retryable when the catalog write turns stale", async () => {
    const { page, sessions, submitMessages } = await mountGroupsPage(async () => "stale");

    await page.requestNewCategory();

    expect(sessions.groupsPut).toHaveBeenCalledOnce();
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(submitMessages).toEqual([
      "Gateway connection replaced before the group was saved. Try again.",
    ]);
  });
});

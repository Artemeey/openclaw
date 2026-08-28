import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RespondFn } from "./types.js";

const executeSessionPatch = vi.fn();
const handleTrustedInternalChatSend = vi.fn();

vi.mock("./sessions-patch-engine.js", () => ({ executeSessionPatch }));
vi.mock("./chat-send-handler.js", () => ({ handleTrustedInternalChatSend }));

const { sessionRestartTurnHandlers } = await import("./sessions-restart-turn.js");

function invokeRestart(params: Record<string, unknown>, scopes: string[] = ["operator.write"]) {
  const respond = vi.fn<RespondFn>();
  return {
    respond,
    run: sessionRestartTurnHandlers["sessions.restartTurn"]!({
      req: { type: "req", id: "request-1", method: "sessions.restartTurn" },
      params,
      respond,
      context: {} as never,
      client: { connect: { scopes } } as never,
      isWebchatConnect: () => false,
    }),
  };
}

describe("sessions.restartTurn", () => {
  beforeEach(() => {
    executeSessionPatch.mockReset().mockResolvedValue({
      ok: true,
      result: {
        key: "agent:main:main",
        entry: { sessionId: "session-1" },
      },
    });
    handleTrustedInternalChatSend.mockReset().mockImplementation(async (options) => {
      options.respond(true, { runId: "run-next", status: "started" });
    });
  });

  it("patches permissions before restarting the exact active turn", async () => {
    const { respond, run } = invokeRestart({
      key: "agent:main:main",
      runId: "run-current",
      reason: "permission-change",
      permissionMode: "workspace",
      idempotencyKey: "restart-1",
    });

    await run;

    expect(executeSessionPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: { key: "agent:main:main", permissionMode: "workspace" },
      }),
    );
    expect(handleTrustedInternalChatSend).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          idempotencyKey: "restart-1",
          message: expect.stringContaining("Permissions changed to Workspace"),
          queueMode: "interrupt",
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          suppressCommandInterpretation: true,
          systemInputProvenance: {
            kind: "internal_system",
            sourceSessionKey: "agent:main:main",
            sourceTool: "permission_change_restart",
          },
        }),
      }),
      undefined,
      { expectedInterruptRunId: "run-current" },
    );
    expect(executeSessionPatch.mock.invocationCallOrder[0]).toBeLessThan(
      handleTrustedInternalChatSend.mock.invocationCallOrder[0]!,
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: true,
        interruptedRunId: "run-current",
        runId: "run-next",
        status: "started",
      },
      undefined,
    );
  });

  it("requires operator.admin before selecting full access", async () => {
    const { respond, run } = invokeRestart({
      key: "agent:main:main",
      runId: "run-current",
      reason: "permission-change",
      permissionMode: "full",
      idempotencyKey: "restart-1",
    });

    await run;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "FORBIDDEN",
        details: expect.objectContaining({ code: "MISSING_SCOPE" }),
      }),
    );
    expect(executeSessionPatch).not.toHaveBeenCalled();
    expect(handleTrustedInternalChatSend).not.toHaveBeenCalled();
  });
});

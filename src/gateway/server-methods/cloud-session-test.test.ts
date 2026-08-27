import { describe, expect, it, vi } from "vitest";
import { WizardSession } from "../../wizard/session.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { runCloudSessionTest } from "./cloud-session-test.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

describe("cloud session test consent boundary", () => {
  it("does not touch session or provider services when consent is absent, malformed, or declined", async () => {
    const touched = vi.fn(() => {
      throw new Error("No service access before consent");
    });
    const context = new Proxy(createDirectChatContext(), { get: touched });
    const options: GatewayRequestHandlerOptions = {
      req: { type: "req", id: "consent", method: "wizard.start" },
      params: {},
      context,
      client: null,
      isWebchatConnect: () => false,
      respond: vi.fn(),
    };
    const session = new WizardSession((prompter, signal, wizard) =>
      runCloudSessionTest({
        options,
        request: { flow: "cloud-session-test", profileId: "development" },
        prompter,
        signal,
        wizard,
      }),
    );
    const confirm = await session.next();
    expect(confirm.step).toMatchObject({ type: "confirm", initialValue: false });
    expect(confirm.step?.message).toMatch(/cloud and model usage may be billed/i);
    expect(touched).not.toHaveBeenCalled();
    for (const answer of ["yes", "false", 1, {}, null]) {
      expect(await session.answer(confirm.step!.id, answer)).toContain("yes or no");
      expect(touched).not.toHaveBeenCalled();
    }
    await session.answer(confirm.step!.id, false);
    await session.whenSettled();
    expect(touched).not.toHaveBeenCalled();
    expect(session.getCloudSessionTest()).toMatchObject({
      status: "cancelled",
      cleanup: "not-allocated",
      endedAt: expect.any(Number),
    });
  });
});

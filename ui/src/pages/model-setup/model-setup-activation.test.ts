/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createFirstRunContext,
  detection,
  mountPage,
} from "./model-setup-first-run.test-support.ts";

describe("ModelSetupPage first-run activation ownership", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem(
      "openclaw-device-identity-v1",
      JSON.stringify({ version: 1, privateKey: "test-device-key" }),
    );
    await i18n.setLocale("en");
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it.each(["manual key", "provider sign-in"])(
    "requires an explicit current-model choice after losing a %s activation reply",
    async (entry) => {
      const { context, client, request, snapshot, publishGatewaySnapshot } =
        createFirstRunContext();
      let releaseActivation: ((value: unknown) => void) | undefined;
      const activatedMethod = entry === "manual key" ? "openclaw.setup.activate" : "wizard.next";
      request.mockImplementation(async (method) => {
        if (method === "openclaw.setup.auth.start") {
          return { sessionId: "auth", done: false, status: "running" };
        }
        if (method === activatedMethod) {
          return await new Promise((resolve) => {
            releaseActivation = resolve;
          });
        }
        if (method === "openclaw.setup.detect") {
          return { ...detection, configuredModel: "provider/current", setupComplete: true };
        }
        if (method === "openclaw.setup.verify") {
          return { ok: true, modelRef: "provider/current", latencyMs: 31 };
        }
        if (method === "wizard.cancel") {
          return { status: "cancelled" };
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            manualProviders: [{ id: "provider-key", label: "Provider key" }],
            authOptions: [
              { id: "provider-login", label: "Provider login", kind: "oauth", featured: true },
            ],
          },
        },
        client,
        firstRun: true,
      });
      if (entry === "manual key") {
        const input = page.querySelector<HTMLInputElement>('input[type="password"]')!;
        input.value = "test-only-provider-key";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        page.querySelector<HTMLButtonElement>(".model-setup__manual .btn.primary")!.click();
      } else {
        page
          .querySelector<HTMLButtonElement>('[data-auth-choice="provider-login"] button')!
          .click();
      }
      await waitForFast(() => expect(releaseActivation).toBeTypeOf("function"));
      const receipt = localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")!;
      expect(JSON.parse(receipt).modelRef).toBeNull();
      expect(receipt).not.toContain("test-only-provider-key");
      expect(receipt).not.toContain("provider-login");
      publishGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
      await page.updateComplete;
      publishGatewaySnapshot({ ...snapshot, hello: { ...snapshot.hello } });
      await waitForFast(() => expect(page.textContent).toContain("Verify & use selected model"));
      expect(
        request.mock.calls.filter(([method]) => method === "openclaw.setup.verify"),
      ).toHaveLength(0);
      expect(context.navigate).not.toHaveBeenCalled();
      page.querySelector<HTMLButtonElement>(".model-setup__recovery .btn.primary")!.click();
      await waitForFast(() =>
        expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" }),
      );
      releaseActivation?.(
        entry === "manual key"
          ? { ok: true, modelRef: "provider/late-other" }
          : { done: true, status: "done", modelActivation: { modelRef: "provider/late-other" } },
      );
      await page.updateComplete;
      expect(request.mock.calls.filter(([method]) => method === activatedMethod)).toHaveLength(1);
      expect(context.navigate).toHaveBeenCalledOnce();
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBeNull();
    },
  );

  it.each(["auth", "Gateway", "agent", "route"])(
    "fences a successful manual reply after its %s owner changes",
    async (changed) => {
      const { context, client, request } = createFirstRunContext();
      let release: ((value: unknown) => void) | undefined;
      request.mockImplementation(async (method) => {
        if (method === "openclaw.setup.activate") {
          return await new Promise((resolve) => {
            release = resolve;
          });
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: { ...detection, manualProviders: [{ id: "provider", label: "Provider" }] },
        },
        client,
        firstRun: true,
      });
      const input = page.querySelector<HTMLInputElement>('input[type="password"]')!;
      input.value = "test-only-key";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      page.querySelector<HTMLButtonElement>(".model-setup__manual .btn.primary")!.click();
      await waitForFast(() => expect(release).toBeTypeOf("function"));
      if (changed === "auth") {
        context.gateway.connection.token = "replacement-auth";
      }
      if (changed === "Gateway") {
        context.gateway.connection.gatewayUrl = "ws://different.example";
      }
      if (changed === "agent") {
        context.agentSelection.state.selectedId = "research";
      }
      if (changed === "route") {
        page.routeData = { ...page.routeData! };
      }
      await page.updateComplete;
      release?.({ ok: true, modelRef: "provider/previous", latencyMs: 31 });
      await waitForFast(() => expect(context.runtimeConfig.runExternalMutation).toHaveResolved());
      await page.updateComplete;
      expect(page.textContent).not.toContain("Connection verified");
      expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(context.navigate).not.toHaveBeenCalled();
    },
  );

  it.each(["cancelled", "running"])(
    "only releases first-run intent after confirmed wizard cancellation (%s)",
    async (cancelStatus) => {
      const { context, client, request } = createFirstRunContext();
      request.mockImplementation(async (method) => {
        if (method === "openclaw.setup.auth.start") {
          return { sessionId: "auth", done: false, status: "running" };
        }
        if (method === "wizard.next") {
          return {
            done: false,
            status: "running",
            step: { id: "login", type: "text", message: "Complete login" },
          };
        }
        if (method === "wizard.cancel") {
          return { status: cancelStatus };
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            authOptions: [
              { id: "provider-login", label: "Provider", kind: "oauth", featured: true },
            ],
          },
        },
        client,
        firstRun: true,
      });
      page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-login"] button')!.click();
      await waitForFast(() => expect(page.textContent).toContain("Complete login"));
      const cancel = [
        ...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button"),
      ].find((button) => button.textContent?.trim() === "Cancel")!;
      cancel.click();
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("wizard.cancel", expect.anything()),
      );
      await page.updateComplete;
      const button = page.querySelector<HTMLButtonElement>(
        '[data-auth-choice="provider-login"] button',
      )!;
      await waitForFast(() => expect(button.disabled).toBe(cancelStatus !== "cancelled"));
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1") === null).toBe(
        cancelStatus === "cancelled",
      );
      expect(context.navigate).not.toHaveBeenCalled();
    },
  );
});

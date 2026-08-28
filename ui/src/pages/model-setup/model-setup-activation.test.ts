/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  clearFirstRunActivationReceipt,
  persistFirstRunActivationReceipt,
  readFirstRunActivationReceipt,
} from "./first-run-activation-receipt.ts";
import { FirstRunSetup } from "./first-run-setup.ts";
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
          // This request crossed the commit point: cancellation is unconfirmed,
          // and the late activation response below can still report success.
          return { status: "running" };
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

  it.each(["same page", "new page", "new authenticated context"])(
    "does not clear a replacement sign-in after late cancellation (%s)",
    async (replacement) => {
      const original = createFirstRunContext();
      const cancelled = createDeferred<unknown>();
      const result = {
        ...detection,
        authOptions: [
          { id: "provider-login", label: "Provider", kind: "oauth" as const, featured: true },
        ],
      };
      const respond = async (method: string) => {
        if (method === "openclaw.setup.auth.start") {
          return { done: false, status: "running" };
        }
        if (method === "wizard.next") {
          return {
            done: false,
            status: "running",
            step: { id: "login", type: "text", message: "Complete login" },
          };
        }
        if (method === "wizard.cancel") {
          return await cancelled.promise;
        }
        if (method === "openclaw.setup.detect") {
          return result;
        }
        throw new Error(`Unexpected method ${method}`);
      };
      original.request.mockImplementation(respond);
      let { page } = await mountPage(original.context, {
        state: { phase: "ready", result },
        client: original.client,
        firstRun: true,
      });
      const signIn = () =>
        page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-login"] button')!;
      signIn().click();
      await waitForFast(() => expect(page.textContent).toContain("Complete login"));
      [...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")]
        .find((button) => button.textContent?.trim() === "Cancel")!
        .click();
      await waitForFast(() =>
        expect(original.request).toHaveBeenCalledWith("wizard.cancel", expect.anything()),
      );
      // Explicitly leaving first-run setup releases its intent. Re-entering is
      // a distinct attempt; the old cancellation acknowledgement is still pending.
      page.routeData = { ...page.routeData!, firstRun: false };
      await page.updateComplete;
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBeNull();
      const next = replacement === "new authenticated context" ? createFirstRunContext() : original;
      if (next !== original) {
        next.context.gateway.connection.token = "replacement-test-auth";
        next.request.mockImplementation(respond);
      }
      if (replacement !== "same page") {
        page.remove();
        ({ page } = await mountPage(next.context, {
          state: { phase: "ready", result },
          client: next.client,
          firstRun: true,
        }));
      } else {
        page.routeData = { ...page.routeData!, firstRun: true };
        await page.updateComplete;
      }
      signIn().click();
      await waitForFast(() => expect(page.textContent).toContain("Complete login"));
      const receipt = localStorage.getItem("openclaw.modelSetup.pendingActivation.v1");
      expect(receipt).not.toBeNull();
      cancelled.resolve({ status: "cancelled" });
      await waitForFast(() =>
        expect(original.request).toHaveResolvedTimes(original.request.mock.calls.length),
      );
      await page.updateComplete;
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBe(receipt);
      expect(page.textContent).toContain("Complete login");
      expect(original.context.navigate).not.toHaveBeenCalled();
      expect(next.context.navigate).not.toHaveBeenCalled();
    },
  );

  it("retires an expired activation during synchronous receipt notification without reviving it", () => {
    const { context } = createFirstRunContext();
    const routeData = {
      firstRun: true,
      state: { phase: "ready" as const, result: detection },
      connection: {
        client: context.gateway.snapshot.client,
        hello: context.gateway.snapshot.hello,
        agentId: "main",
      },
    };
    const setup = new FirstRunSetup({
      context: () => context,
      routeData: () => routeData,
      pageState: () => routeData.state,
      actionsDisabled: () => false,
      canUseSetup: () => true,
      canVerify: () => true,
      verify: async () => undefined,
      activate: async () => undefined,
      setVerifyState: () => undefined,
      setActivationState: () => undefined,
      setRefreshWarning: () => undefined,
    });
    const notify = vi.fn();
    const unsubscribe = setup.subscribe(notify);
    try {
      const activation = setup.beginActivation({ kind: "provider-auth" });
      expect(activation).not.toBeNull();
      vi.spyOn(Date, "now").mockReturnValue(activation!.deadlineMs + 1);
      expect(() =>
        setup.recordActivation(activation, { ok: true, modelRef: "synthetic/model" }),
      ).not.toThrow();
      expect(notify).toHaveBeenCalledOnce();
      expect(setup.unresolved).toBe(false);
      expect(setup.ownsActivation(activation)).toBe(false);
      setup.finishActivation({ ok: true, modelRef: "synthetic/model" }, "provider-auth", null);
      expect(context.navigate).not.toHaveBeenCalled();
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBeNull();
    } finally {
      unsubscribe();
      setup.dispose();
    }
  });

  const retirements = [
    "auth",
    "Gateway",
    "agent",
    "client",
    "hello",
    "route",
    "expiry",
    "removal",
    "replacement",
  ] as const;
  it.each(
    ["manual key", "provider sign-in"].flatMap((entry) =>
      ["reply", "refresh"].flatMap((boundary) =>
        retirements.map((changed) => ({ entry, boundary, changed })),
      ),
    ),
  )(
    "fences $entry success when $changed retires it during $boundary",
    async ({ entry, boundary, changed }) => {
      const reply = createDeferred<unknown>();
      const refreshing = createDeferred();
      const refresh = createDeferred();
      const { context, client, request } = createFirstRunContext(undefined, async () => {
        refreshing.resolve();
        await refresh.promise;
      });
      const activatedMethod = entry === "manual key" ? "openclaw.setup.activate" : "wizard.next";
      request.mockImplementation(async (method) => {
        if (method === "openclaw.setup.auth.start") {
          return { done: false, status: "running" };
        }
        if (method === activatedMethod) {
          return await reply.promise;
        }
        if (method === "openclaw.setup.detect") {
          return detection;
        }
        if (method === "wizard.cancel") {
          return { status: "running" };
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            manualProviders: [{ id: "provider", label: "Provider" }],
            authOptions: [
              { id: "provider-login", label: "Provider", kind: "oauth", featured: true },
            ],
          },
        },
        client,
        firstRun: true,
      });
      if (entry === "manual key") {
        const input = page.querySelector<HTMLInputElement>('input[type="password"]')!;
        input.value = "test-only-key";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        page.querySelector<HTMLButtonElement>(".model-setup__manual .btn.primary")!.click();
      } else {
        page
          .querySelector<HTMLButtonElement>('[data-auth-choice="provider-login"] button')!
          .click();
      }
      await waitForFast(() =>
        expect(request.mock.calls.some(([method]) => method === activatedMethod)).toBe(true),
      );
      const success =
        entry === "manual key"
          ? { ok: true, modelRef: "provider/previous", latencyMs: 31 }
          : {
              done: true,
              status: "done",
              modelActivation: { modelRef: "provider/previous", latencyMs: 31 },
            };
      if (boundary === "refresh") {
        reply.resolve(success);
        await refreshing.promise;
      }
      if (changed === "auth") {
        context.gateway.connection.token = "replacement-auth";
      }
      if (changed === "Gateway") {
        context.gateway.connection.gatewayUrl = "ws://different.example";
      }
      if (changed === "agent") {
        context.agentSelection.state.selectedId = "research";
      }
      if (changed === "client") {
        const replacementClient = createFirstRunContext();
        replacementClient.request.mockResolvedValue(detection);
        context.gateway.snapshot.client = replacementClient.client;
      }
      if (changed === "hello") {
        context.gateway.snapshot.hello = { ...context.gateway.snapshot.hello! };
      }
      if (changed === "route") {
        page.routeData = { ...page.routeData! };
      }
      if (changed === "expiry") {
        const receipt = readFirstRunActivationReceipt(context)!;
        vi.spyOn(Date, "now").mockReturnValue(receipt.deadlineMs + 1);
      }
      if (changed === "removal") {
        clearFirstRunActivationReceipt();
      }
      const replacement =
        changed === "replacement"
          ? persistFirstRunActivationReceipt(
              {
                ...context,
                gateway: {
                  ...context.gateway,
                  connection: { ...context.gateway.connection, token: "replacement-auth" },
                },
              },
              { kind: "provider-auth", modelRef: "provider/replacement" },
            )
          : null;
      await page.updateComplete;
      reply.resolve(success);
      refresh.resolve();
      await waitForFast(() =>
        expect(context.runtimeConfig.runExternalMutation).toHaveResolvedWith(
          expect.objectContaining({ ok: true }),
        ),
      );
      await page.updateComplete;
      expect(page.textContent).not.toContain("Connection verified");
      expect(page.textContent).not.toContain("Cannot read properties");
      expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(context.navigate).not.toHaveBeenCalled();
      if (replacement) {
        expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBe(
          JSON.stringify(replacement),
        );
      }
    },
  );

  it.each(["active", "replacement"])(
    "cleans up a definitive rejection without losing failure feedback or replacement ownership (%s)",
    async (ownership) => {
      const { context, client, request } = createFirstRunContext();
      const rejected = createDeferred<unknown>();
      request.mockReturnValue(rejected.promise);
      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            candidates: [
              {
                kind: "openai-api-key",
                label: "Provider",
                detail: "Available",
                modelRef: "provider/model",
                recommended: true,
                credentials: true,
              },
            ],
          },
        },
        client,
        firstRun: true,
      });
      await waitForFast(() => expect(request).toHaveBeenCalledOnce());
      const replacement =
        ownership === "replacement"
          ? persistFirstRunActivationReceipt(
              {
                ...context,
                gateway: {
                  ...context.gateway,
                  connection: { ...context.gateway.connection, token: "replacement-auth" },
                },
              },
              { kind: "provider-auth", modelRef: "provider/replacement" },
            )
          : null;
      rejected.resolve({ ok: false, status: "auth", error: "Provider rejected this test key" });
      await waitForFast(() =>
        expect(context.runtimeConfig.runExternalMutation).toHaveResolvedWith(
          expect.objectContaining({ ok: true }),
        ),
      );
      await page.updateComplete;
      if (ownership === "active") {
        expect(page.textContent).toContain("Provider rejected this test key");
      } else {
        expect(page.textContent).not.toContain("Provider rejected this test key");
      }
      expect(page.textContent).not.toContain("Cannot read properties");
      expect(page.textContent).not.toContain("Connection verified");
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBe(
        replacement ? JSON.stringify(replacement) : null,
      );
      expect(context.navigate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["cancelled", "in place"],
    ["running", "in place"],
    ["cancelled", "route reset"],
    ["cancelled", "reconnect"],
    ["cancelled", "unmount"],
    ["running", "unmount"],
    ["unknown", "unmount"],
    ["absent", "unmount"],
  ])(
    "only releases first-run intent after confirmed wizard cancellation (%s, %s)",
    async (cancelStatus, lifecycle) => {
      const { context, client, request, snapshot, publishGatewaySnapshot } =
        createFirstRunContext();
      const cancelled = createDeferred<unknown>();
      const result = {
        ...detection,
        authOptions: [
          { id: "provider-login", label: "Provider", kind: "oauth" as const, featured: true },
        ],
      };
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
          return await cancelled.promise;
        }
        if (method === "openclaw.setup.detect") {
          return result;
        }
        throw new Error(`Unexpected method ${method}`);
      });
      let { page } = await mountPage(context, {
        state: { phase: "ready", result },
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
      expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).not.toBeNull();
      if (lifecycle === "route reset") {
        page.routeData = { ...page.routeData! };
      } else if (lifecycle === "reconnect") {
        publishGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
        await page.updateComplete;
        publishGatewaySnapshot({ ...snapshot, hello: { ...snapshot.hello } });
      } else if (lifecycle === "unmount") {
        page.remove();
      }
      await page.updateComplete;
      if (cancelStatus === "absent") {
        cancelled.reject(new Error("wizard not found"));
      } else {
        cancelled.resolve(cancelStatus === "unknown" ? {} : { status: cancelStatus });
      }
      await waitForFast(() => {
        const cancelIndex = request.mock.calls.findIndex(([method]) => method === "wizard.cancel");
        expect(request.mock.settledResults[cancelIndex]?.type).toBe(
          cancelStatus === "absent" ? "rejected" : "fulfilled",
        );
      });
      if (lifecycle === "unmount") {
        ({ page } = await mountPage(context, {
          state: { phase: "ready", result },
          client,
          firstRun: true,
        }));
      }
      await waitForFast(() => {
        const button = page.querySelector<HTMLButtonElement>(
          '[data-auth-choice="provider-login"] button',
        );
        expect(button).not.toBeNull();
        expect(button!.disabled).toBe(cancelStatus !== "cancelled");
      });
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1") === null).toBe(
        cancelStatus === "cancelled",
      );
      expect(context.navigate).not.toHaveBeenCalled();
    },
  );
});

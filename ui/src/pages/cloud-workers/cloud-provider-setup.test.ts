import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapApplication } from "../../app/bootstrap.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import {
  cloudSetupDescription,
  cloudSetupFeatureMethods,
  cloudSetupMethods,
  cloudSetupPlugin,
  cloudSetupWorkerId,
  configResponse,
} from "../../e2e/cloud-workers-settings.test-support.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./cloud-provider-setup.ts";

afterEach(() => vi.restoreAllMocks());

async function mountSetup(
  options: { separateRevision?: boolean; failRefresh?: boolean; multipleOwners?: boolean } = {},
) {
  const application = bootstrapApplication({
    sessionPathBuilderReady: new Promise<void>(() => {}),
  });
  let enabled = false;
  let applied = false;
  let revision = "before";
  const listeners = new Set<Parameters<ApplicationGateway["subscribe"]>[0]>();
  const request = vi.fn(async (method: string, params?: unknown) => {
    switch (method) {
      case "config.get":
        if (enabled && options.failRefresh) {
          throw new Error("Configuration refresh rejected");
        }
        return {
          ...configResponse(
            { plugins: { entries: { [cloudSetupPlugin.id]: { enabled } } } },
            options.separateRevision ? `source-${revision}` : revision,
          ),
          configRevisionHash: revision,
          appliedConfigHash: applied ? revision : "before",
        };
      case "plugins.list":
        return {
          plugins: [
            { ...cloudSetupPlugin, enabled, state: enabled ? "enabled" : "disabled" },
            ...(options.multipleOwners
              ? [{ ...cloudSetupPlugin, id: "other-owner", name: "Other owner" }]
              : []),
          ],
          diagnostics: [],
          mutationAllowed: true,
        };
      case "plugins.setEnabled":
        expect(params).toEqual({ pluginId: cloudSetupPlugin.id, enabled: true });
        enabled = true;
        revision = "enabled";
        return { ok: true, plugin: cloudSetupPlugin, restartRequired: false };
      case cloudSetupMethods.describe:
        return cloudSetupDescription;
      default:
        throw new Error(`Unexpected request: ${method}`);
    }
  });
  const client = createTestGatewayClient(request);
  const hello = () => ({
    ...gatewayHelloForMethods(
      applied ? cloudSetupFeatureMethods : ["plugins.list", "plugins.setEnabled", "config.patch"],
    ),
    server: { version: "test", connId: "test", bootId: "unchanged-process" },
  });
  let snapshot: ApplicationGateway["snapshot"] = {
    ...application.context.gateway.snapshot,
    client,
    phase: "connected",
    hello: hello(),
  };
  const gateway: ApplicationGateway = {
    ...application.context.gateway,
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const publish = (next: ApplicationGateway["snapshot"]) => {
    snapshot = next;
    for (const listener of listeners) {
      listener(next);
    }
  };
  const reconnect = vi.spyOn(client, "forceReconnect").mockImplementation(() => {
    publish({ ...snapshot, phase: "reconnecting", hello: null });
    publish({ ...snapshot, phase: "connected", hello: hello() });
  });
  const config = createRuntimeConfigCapability(gateway);
  const host = createApplicationContextProvider({
    ...application.context,
    gateway,
    runtimeConfig: config,
    getCloudSessionTest: () => null,
  });
  const page = document.createElement("openclaw-cloud-provider-setup");
  host.append(page);
  document.body.append(host);
  await waitForFast(() => expect(page.textContent).toContain("Enable"));
  return {
    page,
    request,
    reconnect,
    config,
    gateway,
    apply: () => {
      applied = true;
    },
    changeRevision: () => {
      revision = "other-edit";
    },
    changeAuth: () =>
      publish({ ...snapshot, hello: gatewayHelloForMethods([], ["operator.read"]) }),
    unmount: () => host.remove(),
    changeOwner: () => {
      const select = page.querySelector<HTMLSelectElement>('select[aria-label="Cloud plugin"]');
      if (!select) {
        throw new Error("Cloud plugin chooser missing");
      }
      select.value = `other-owner/${cloudSetupWorkerId}`;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    enable: () => {
      const button = [...page.querySelectorAll("button")].find(
        (entry) => entry.textContent?.trim() === "Enable",
      );
      if (!button) {
        throw new Error("Enable button missing");
      }
      button.click();
    },
    dispose: () => {
      host.remove();
      config.dispose();
      application.stop();
    },
  };
}

describe("cloud setup hot enable", () => {
  it.each([false, true])(
    "refreshes stale methods only after the enabled revision applies (separate revision: %s)",
    async (separateRevision) => {
      const setup = await mountSetup({ separateRevision });
      try {
        expect(setup.request.mock.calls.some(([method]) => method === "plugins.setEnabled")).toBe(
          false,
        );
        setup.enable();
        await waitForFast(() =>
          expect(setup.config.state.configSnapshot?.configRevisionHash).toBe("enabled"),
        );
        expect(setup.reconnect).not.toHaveBeenCalled();
        expect(
          setup.request.mock.calls.some(([method]) => method === cloudSetupMethods.describe),
        ).toBe(false);
        setup.apply();
        await waitForFast(() => expect(setup.reconnect).toHaveBeenCalledTimes(1));
        await waitForFast(() => expect(setup.page.textContent).toContain("Local dependency"));
        expect(setup.gateway.snapshot.hello?.server?.bootId).toBe("unchanged-process");
        expect(
          setup.request.mock.calls.filter(([method]) => method === "plugins.setEnabled"),
        ).toHaveLength(1);
        expect(
          setup.request.mock.calls.some(([method]) =>
            ["environments.create", "wizard.start", "secrets.store.set"].includes(method),
          ),
        ).toBe(false);
      } finally {
        setup.dispose();
      }
    },
  );

  it.each(["config", "auth", "unmount", "owner"])(
    "does not refresh a stale enable continuation after %s changes",
    async (change) => {
      const setup = await mountSetup({ multipleOwners: change === "owner" });
      try {
        setup.enable();
        await waitForFast(() => expect(setup.config.state.configSnapshot?.hash).toBe("enabled"));
        await waitForFast(() =>
          expect(setup.page.textContent).toContain("Cloud setup is not active yet."),
        );
        if (change === "config") {
          setup.changeRevision();
        }
        if (change === "auth") {
          setup.changeAuth();
        }
        if (change === "unmount") {
          setup.unmount();
        }
        if (change === "owner") {
          setup.changeOwner();
        }
        setup.apply();
        await setup.config.refresh();
        expect(setup.reconnect).not.toHaveBeenCalled();
        expect(
          setup.request.mock.calls.some(([method]) => method === cloudSetupMethods.describe),
        ).toBe(false);
      } finally {
        setup.dispose();
      }
    },
  );

  it("retains the committed-enable refresh failure without reconnecting or hiding the error", async () => {
    const setup = await mountSetup({ failRefresh: true });
    try {
      setup.enable();
      await waitForFast(() =>
        expect(setup.page.textContent).toContain("Configuration refresh rejected"),
      );
      expect(setup.reconnect).not.toHaveBeenCalled();
      expect(
        setup.request.mock.calls.filter(([method]) => method === "plugins.setEnabled"),
      ).toHaveLength(1);
    } finally {
      setup.dispose();
    }
  });
});

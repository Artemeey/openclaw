import { afterEach, describe, expect, it, vi } from "vitest";
import { configResponse } from "../../e2e/cloud-workers-settings.test-support.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  clickRowAction,
  createContext,
  createGateway,
  createPlugin,
  createPluginsRouteData,
  createResult,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

afterEach(resetPluginsPageTestState);

describe("Plugins hot-enable readiness", () => {
  it.each(["applied", "later mutation", "disconnect", "unmount"])(
    "waits for hot-applied policy before refreshing hello: %s",
    async (continuation) => {
      let enabled = false;
      let applied = false;
      const plugin = () => createPlugin({ enabled, state: enabled ? "enabled" : "disabled" });
      const request = vi.fn(async (method: string) => {
        if (method === "config.get") {
          return {
            ...configResponse({}, enabled ? "enabled-source" : "before"),
            configRevisionHash: enabled ? "enabled-revision" : "before",
            appliedConfigHash: applied ? "enabled-revision" : "before",
          };
        }
        if (method === "plugins.setEnabled") {
          if (enabled) {
            throw new Error("Later mutation rejected");
          }
          enabled = true;
          return { ok: true, plugin: plugin(), restartRequired: false };
        }
        if (method === "plugins.list") {
          return createResult(plugin());
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const client = createTestGatewayClient(request);
      const harness = createGateway(client);
      const connect = vi.spyOn(harness.gateway, "connect");
      const reconnect = vi.spyOn(client, "forceReconnect").mockImplementation(() => {
        harness.emit(client, false);
        harness.emit(client, true);
      });
      const runtimeConfig = createRuntimeConfigCapability(harness.gateway);
      await runtimeConfig.ensureLoaded();
      const { page } = await mountPage(
        { ...createContext(harness.gateway), runtimeConfig },
        createPluginsRouteData(harness.gateway),
      );
      try {
        await clickRowAction(page, '[data-plugin-id="workboard"]', "Enable");
        await waitForFast(() => expect(page.busy["plugin:workboard"]).toBeUndefined());
        expect(page.result?.plugins[0]?.enabled).toBe(true);
        expect(request.mock.calls.some(([method]) => method === "plugins.list")).toBe(true);
        expect(connect).not.toHaveBeenCalled();
        expect(reconnect).not.toHaveBeenCalled();
        if (continuation === "later mutation") {
          await clickRowAction(page, '[data-plugin-id="workboard"]', "Disable");
          await waitForFast(() => expect(page.textContent).toContain("Later mutation rejected"));
        } else if (continuation === "disconnect") {
          harness.emit(client, false);
        } else if (continuation === "unmount") {
          page.remove();
        }
        applied = true;
        await runtimeConfig.refresh();
        if (continuation === "applied") {
          await waitForFast(() => expect(reconnect).toHaveBeenCalledOnce());
        } else {
          expect(reconnect).not.toHaveBeenCalled();
        }
        expect(connect).not.toHaveBeenCalled();
      } finally {
        page.remove();
        runtimeConfig.dispose();
      }
    },
  );
});

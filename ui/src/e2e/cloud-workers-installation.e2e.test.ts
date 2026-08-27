import { expect, it } from "vitest";
import { installMockGateway, waitForConfirmModal } from "../test-helpers/control-ui-e2e.ts";
import {
  cloudSetupDescription,
  cloudSetupFeatureMethods,
  cloudSetupMethods,
  cloudSetupPlugin,
  configResponse,
} from "./cloud-workers-settings.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Cloud dependency installation diagnostics",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("wraps failed installation guidance without hiding it beneath the recovery action", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 1040 } },
      async ({ page }) => {
        const message =
          "The release archive format was rejected before installation. Check for an OpenClaw update, or use a compatible executable already installed on the Gateway through PATH or Advanced settings. No cloud machine was allocated.";
        const dependency = { ...cloudSetupDescription.dependency, state: "missing" };
        const gateway = await installMockGateway(page, {
          featureMethods: cloudSetupFeatureMethods,
          methodResponses: {
            "plugins.list": { plugins: [cloudSetupPlugin], diagnostics: [], mutationAllowed: true },
            "config.get": configResponse({}, "setup-1"),
            [cloudSetupMethods.describe]: { ...cloudSetupDescription, dependency },
            [cloudSetupMethods.install]: {
              status: "failed",
              dependency,
              diagnostics: [
                { code: "archive_rejected", severity: "error", message, action: "install" },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
        await page
          .getByRole("button", { name: "Install compatible dependency", exact: true })
          .click();
        const dialog = await waitForConfirmModal(page);
        await dialog
          .getByRole("button", { name: "Install compatible dependency", exact: true })
          .click();
        const guidance = page.getByText(message, { exact: true });
        await guidance.waitFor();
        await page
          .locator(".settings-row")
          .filter({ has: guidance })
          .getByText("Diagnostics", { exact: true })
          .waitFor();
        const geometry = await guidance.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const control = element
            .closest(".settings-row")
            ?.querySelector("button")
            ?.getBoundingClientRect();
          return {
            height: rect.height,
            lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
            right: rect.right,
            controlLeft: control?.left,
            overflow: element.scrollWidth > element.clientWidth,
          };
        });
        expect(geometry.height).toBeGreaterThan(geometry.lineHeight * 2);
        expect(geometry.controlLeft).toBeDefined();
        expect(geometry.right).toBeLessThan(geometry.controlLeft!);
        expect(geometry.overflow).toBe(false);
        expect(await gateway.getRequests(cloudSetupMethods.install)).toHaveLength(1);
        expect(await gateway.getRequests("environments.create")).toHaveLength(0);
        expect(await page.getByText("Compatible", { exact: true }).count()).toBe(0);
        await page.getByRole("button", { name: "Manage plugins", exact: true }).last().click();
        await page.waitForURL((url) => url.pathname === "/settings/plugins");
      },
    );
  });
});

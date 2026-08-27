// Control UI E2E proves that command grammar does not duplicate model-control interaction.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI thinking argument completion",
});

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

suite.define(() => {
  it.each([
    ["elevated full", "/elevated full"],
    ["exec gateway", "/exec gateway"],
  ])("executes inline /%s separately from the draft", async (typedCommand, sentCommand) => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["chat.send"],
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible" });
      await expect.poll(() => composer.isEnabled()).toBe(true);

      await composer.fill(`Keep this /${typedCommand}`);
      await composer.press("Enter");

      const request = await gateway.waitForRequest("chat.send");
      expect((request.params as { message?: unknown }).message).toBe(sentCommand);
      await expect.poll(() => composer.inputValue()).toBe("Keep this ");
    });
  });

  it.each(VIEWPORTS)(
    "keeps thinking-level input textual for the model-control owner ($name)",
    async (viewport) => {
      await suite.withPage({ viewport }, async ({ page }) => {
        const browserErrors: string[] = [];
        page.on("console", (message) => {
          if (message.type() === "error") {
            browserErrors.push(message.text());
          }
        });
        page.on("pageerror", (error) => browserErrors.push(error.message));

        const gateway = await installMockGateway(page, {
          models: [
            {
              id: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              provider: "openai",
              thinkingLevels: [
                { id: "off", label: "off" },
                { id: "minimal", label: "minimal" },
                { id: "low", label: "low" },
                { id: "medium", label: "medium" },
                { id: "high", label: "high" },
                { id: "xhigh", label: "xhigh" },
                { id: "max", label: "max" },
                { id: "ultra", label: "ultra" },
              ],
            },
          ],
          methodResponses: {
            "sessions.list": {
              count: 1,
              defaults: {
                contextTokens: 200_000,
                model: "gpt-5.6-sol",
                modelProvider: "openai",
              },
              path: "",
              sessions: [
                {
                  key: "main",
                  kind: "direct",
                  model: "gpt-5.6-sol",
                  modelProvider: "openai",
                  updatedAt: Date.now(),
                },
              ],
              ts: Date.now(),
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible" });
        await expect.poll(() => composer.isEnabled()).toBe(true);

        await composer.fill("/think");
        await composer.press("Tab");

        await expect.poll(() => composer.inputValue()).toBe("/think ");
        expect(await page.locator(".slash-menu[role='listbox']").count()).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          viewport.width,
        );
        expect(browserErrors).toEqual([]);

        await composer.fill("/think ultra");
        await composer.press("Enter");
        const patchRequest = await gateway.waitForRequest("sessions.patch");
        expect(patchRequest.params).toMatchObject({
          key: "main",
          thinkingLevel: "ultra",
        });

        const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        if (artifactDir) {
          await fs.mkdir(artifactDir, { recursive: true });
          await page.screenshot({
            path: path.join(artifactDir, `think-arguments-${viewport.name}.png`),
            fullPage: true,
          });
        }
      });
    },
  );
});

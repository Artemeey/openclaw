import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI command activation" });

const commands = [
  {
    acceptsArgs: true,
    args: [
      {
        choices: ["staging", "production"],
        description: "Deployment target",
        name: "target",
        required: true,
        type: "string",
      },
    ],
    description: "Deploy a build.",
    name: "deploy",
    scope: "both",
    source: "plugin",
    textAliases: ["/deploy", "/ship"],
  },
  {
    acceptsArgs: true,
    description: "Draft release notes.",
    name: "release-notes",
    scope: "both",
    skillModelVisible: true,
    source: "skill",
    textAliases: ["/release-notes"],
  },
] as const;

suite.define(() => {
  it("converges typed and sheet activation while preserving remote raw tails", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        ...(artifactDir
          ? { recordVideo: { dir: artifactDir, size: { width: 1280, height: 900 } } }
          : {}),
      },
      async ({ page }) => {
        if (artifactDir) {
          await fs.mkdir(artifactDir, { recursive: true });
        }
        const gateway = await installMockGateway(page, {
          deferredMethods: ["chat.send"],
          methodResponses: {
            "chat.startup": {
              agentsList: {
                agents: [{ id: "main", name: "OpenClaw" }],
                defaultId: "main",
                mainKey: "main",
                scope: "agent",
              },
              messages: [],
              metadata: { commands: [...commands], models: [] },
              sessionId: "command-activation-session",
              thinkingLevel: null,
            },
            "commands.list": { commands: [...commands] },
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible" });
        await expect.poll(() => composer.isEnabled()).toBe(true);

        await composer.fill("/ship");
        await composer.press("Enter");
        await expect.poll(() => composer.inputValue()).toBe("/ship ");
        expect(await page.locator(".slash-menu[aria-label='Command arguments']").count()).toBe(0);
        if (artifactDir) {
          await page.screenshot({
            path: path.join(artifactDir, "typed-alias-command.png"),
            fullPage: true,
          });
          await page.waitForTimeout(600);
        }

        await composer.fill("/");
        const deploy = page
          .locator(".slash-menu[role='listbox']")
          .getByRole("option")
          .filter({ hasText: "/deploy" });
        await deploy.click();
        await expect.poll(() => composer.inputValue()).toBe("/deploy ");
        expect(await page.locator(".slash-menu[aria-label='Command arguments']").count()).toBe(0);
        if (artifactDir) {
          await page.screenshot({
            path: path.join(artifactDir, "sheet-selected-command.png"),
            fullPage: true,
          });
          await page.waitForTimeout(600);
        }

        const rawCommand = "/deploy target=staging --note 'first ship'";
        await composer.fill(rawCommand);
        if (artifactDir) {
          await page.screenshot({
            path: path.join(artifactDir, "remote-raw-command.png"),
            fullPage: true,
          });
          await page.waitForTimeout(600);
        }
        await composer.press("Enter");
        const request = await gateway.waitForRequest("chat.send");
        expect((request.params as { message?: unknown }).message).toBe(rawCommand);
      },
    );
  });

  it("keeps plugin and skill commands textual on mobile", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: { "commands.list": { commands: [...commands] } },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("/release-notes");
      await composer.press("Enter");

      await expect.poll(() => composer.inputValue()).toBe("/release-notes ");
      expect(await page.locator(".slash-menu[aria-label='Command arguments']").count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
    });
  });
});

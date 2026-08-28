import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI Goal mode" });
const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
const activeGoal = {
  schemaVersion: 1,
  id: "goal-active",
  objective: "Ship the Goal UI",
  status: "active",
  createdAt: Date.now() - 15_000,
  updatedAt: Date.now(),
  tokenStart: 0,
  tokensUsed: 10,
  continuationTurns: 0,
} as const;

suite.define(() => {
  it("starts a Goal from human text", async () => {
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
          featureCapabilities: ["session-goal-start-v1"],
          deferredMethods: ["chat.send"],
          methodResponses: {
            "chat.startup": {
              messages: [],
              metadata: { models: [] },
              sessionId: "goal-mode-session",
              thinkingLevel: null,
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible" });
        if (artifactDir) {
          await page.screenshot({ path: path.join(artifactDir, "goal-normal-desktop.png") });
        }

        await composer.fill("/");
        await page
          .locator(".slash-menu[role='listbox']")
          .getByRole("option")
          .filter({ hasText: "/goal" })
          .click();
        await page.locator(".agent-chat__goal-mode").waitFor();
        expect(await composer.inputValue()).toBe("");
        if (artifactDir) {
          await page.screenshot({ path: path.join(artifactDir, "goal-mode-desktop.png") });
        }

        const objective = "/ship this\nwith measurable outcomes";
        await composer.fill(objective);
        await composer.press("Control+Enter");
        const request = await gateway.waitForRequest("chat.send");
        expect(request.params).toMatchObject({
          message: objective,
          intent: { kind: "session-goal-start", version: 1 },
        });
        expect(request.params).not.toHaveProperty("deliver");
        expect(request.params).not.toHaveProperty("queueMode");
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        expect(await composer.inputValue()).toBe(objective);
        expect(await page.locator(".agent-chat__goal-mode").count()).toBe(1);
        if (artifactDir) {
          await page.screenshot({ path: path.join(artifactDir, "goal-submitting-desktop.png") });
        }
        await gateway.resolveDeferred("chat.send", {
          runId: (request.params as { idempotencyKey: string }).idempotencyKey,
          goalId: "goal-e2e",
          status: "started",
        });
        await expect.poll(() => composer.inputValue()).toBe("");
        await expect.poll(() => page.locator(".agent-chat__goal-mode").count()).toBe(0);
        await gateway.emitChatFinal({
          runId: (request.params as { idempotencyKey: string }).idempotencyKey,
          text: "Goal accepted.",
        });
      },
    );
  });

  it("keeps Goal mode visible when admission fails", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureCapabilities: ["session-goal-start-v1"],
        deferredMethods: ["chat.send"],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("/goal");
      await composer.press("Enter");
      await composer.fill("Keep this objective after failure");
      await composer.press("Control+Enter");
      await gateway.waitForRequest("chat.send");
      await gateway.rejectDeferred("chat.send", {
        code: "UNAVAILABLE",
        message: "session has active or queued work",
        retryable: true,
      });

      await page.locator(".agent-chat__goal-mode").waitFor();
      expect(await composer.inputValue()).toBe("Keep this objective after failure");
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "goal-failure-desktop.png") });
      }
    });
  });

  it("manages an active Goal through typed RPCs without chat turns", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["sessions.goal.update", "sessions.goal.clear"],
        methodResponses: {
          "sessions.list": {
            ts: 2,
            path: "",
            count: 1,
            defaults: { model: "gpt-5.6-luna", modelProvider: "openai", contextTokens: 128_000 },
            sessions: [
              { key: "main", kind: "direct", label: "Main", updatedAt: 2, goal: activeGoal },
            ],
          },
          "sessions.goal.update": {
            ok: true,
            sessionKey: "main",
            operationId: "ignored-by-fixture",
            goal: { ...activeGoal, status: "paused", pausedAt: 3, updatedAt: 3 },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const goal = page.locator(".agent-chat__goal");
      await goal.getByText("Pursuing goal", { exact: true }).waitFor();
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("/goal");
      await composer.press("Enter");
      await expect.poll(() => goal.getAttribute("data-expanded")).toBe("true");
      await expect
        .poll(() => goal.evaluate((element) => element === document.activeElement))
        .toBe(true);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "goal-active-desktop.png") });
      }
      await goal.getByRole("button", { name: "Edit goal" }).click();
      await goal.getByRole("textbox", { name: "Edit goal" }).waitFor();
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "goal-management-desktop.png") });
      }
      await goal.getByRole("button", { name: "Cancel" }).click();
      await goal.getByRole("button", { name: "Pause goal" }).click();
      const update = await gateway.waitForRequest("sessions.goal.update");
      expect(update.params).toMatchObject({
        sessionKey: "main",
        goalId: "goal-active",
        action: "pause",
      });
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it("keeps an explicit Goal tail on the textual path", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureCapabilities: ["session-goal-start-v1"],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("/goal status");
      await composer.press("Control+Enter");

      const textual = await gateway.waitForRequest("chat.send");
      expect(textual.params).toMatchObject({ message: "/goal status" });
      expect(textual.params).not.toHaveProperty("intent");
    });
  });

  it("keeps Goal activation textual without capability on mobile", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("/goal");
      await composer.press("Enter");

      await expect.poll(() => composer.inputValue()).toBe("/goal ");
      expect(await page.locator(".agent-chat__goal-mode").count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
    });
  });

  it("renders removable Goal mode without mobile overflow", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureCapabilities: ["session-goal-start-v1"],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("/goal");
      await composer.press("Enter");
      await page.locator(".agent-chat__goal-mode").waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "goal-mode-mobile.png") });
      }
    });
  });

  it("keeps active Goal management reachable on mobile", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["sessions.goal.update", "sessions.goal.clear"],
        methodResponses: {
          "sessions.list": {
            ts: 2,
            path: "",
            count: 1,
            defaults: { model: "gpt-5.6-luna", modelProvider: "openai", contextTokens: 128_000 },
            sessions: [
              { key: "main", kind: "direct", label: "Main", updatedAt: 2, goal: activeGoal },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const goal = page.locator(".agent-chat__goal");
      await goal.getByText("Pursuing goal", { exact: true }).waitFor();
      await goal.getByRole("button", { name: "Edit goal" }).click();
      await goal.getByRole("textbox", { name: "Edit goal" }).waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "goal-management-mobile.png") });
      }
    });
  });

  it("drops Goal mode on reload while preserving its text as an ordinary draft", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureCapabilities: ["session-goal-start-v1"],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("/goal");
      await composer.press("Enter");
      await composer.fill("Draft survives reload");
      await page.reload();

      await composer.waitFor({ state: "visible" });
      await expect.poll(() => composer.inputValue()).toBe("Draft survives reload");
      expect(await page.locator(".agent-chat__goal-mode").count()).toBe(0);
    });
  });
});

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelAuthStatusResult } from "../api/types.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { modelPickerValue, selectModelPicker } from "./model-providers.e2e.test-helpers.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
const artifactDir = path.resolve(".artifacts/control-ui-e2e/model-providers");

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI Models reconnect mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    if (recordVisuals) {
      await mkdir(artifactDir, { recursive: true });
    }
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("reloads the selected agent and clears a failed model draft after reconnect", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1280 },
      ...(recordVisuals
        ? { recordVideo: { dir: artifactDir, size: { height: 1000, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const initialConfig = {
      agents: { defaults: { model: "openai/initial-model" } },
    };
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      featureMethods: ["chat.metadata", "chat.startup", "config.patch"],
      methodResponses: {
        "agents.list": {
          agents: [
            { id: "main", name: "Main" },
            { id: "writer", name: "Writer" },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "config.get": {
          config: initialConfig,
          sourceConfig: initialConfig,
          hash: "model-providers-reconnect-1",
          issues: [],
          raw: JSON.stringify(initialConfig),
          valid: true,
        },
        "models.list": {
          models: [
            { id: "initial-model", name: "Initial Model", provider: "openai", available: true },
            { id: "saved-model", name: "Saved Model", provider: "openai", available: true },
            { id: "failed-draft", name: "Failed Draft", provider: "openai", available: true },
          ],
        },
        "models.authStatus": {
          ts: Date.now(),
          providers: [
            {
              provider: "openai",
              authProvider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai:writer", type: "oauth", status: "ok" }],
            },
          ],
        } satisfies ModelAuthStatusResult,
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const agentPicker = page.locator(".agent-scope-control openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker.locator('wa-dropdown-item[aria-label="Writer"]').click();
      await expect
        .poll(async () => (await agentPicker.locator(".agent-select__label").textContent())?.trim())
        .toBe("Writer");
      await expect
        .poll(() => modelPickerValue(page.locator(".model-providers__defaults wa-select").first()))
        .toBe("openai/initial-model");

      const primary = page.locator(".model-providers__defaults wa-select").first();
      const savedConfig = {
        agents: { defaults: { model: "openai/saved-model" } },
      };
      await gateway.setMethodResponse("config.get", {
        config: savedConfig,
        sourceConfig: savedConfig,
        hash: "model-providers-reconnect-saved",
        issues: [],
        raw: JSON.stringify(savedConfig),
        valid: true,
      });
      await selectModelPicker(primary, "openai/saved-model");
      await page
        .locator(".settings-section", {
          has: page.getByRole("heading", { name: "Default models" }),
        })
        .getByRole("button", { name: "Save" })
        .click();
      await expect
        .poll(async () =>
          page.getByRole("status").filter({ hasText: "Default models saved" }).count(),
        )
        .toBeGreaterThan(0);

      await selectModelPicker(primary, "openai/failed-draft");
      await gateway.deferNext("config.patch");
      await page
        .locator(".settings-section", {
          has: page.getByRole("heading", { name: "Default models" }),
        })
        .getByRole("button", { name: "Save" })
        .click();
      await gateway.waitForRequest("config.patch");
      await gateway.rejectDeferred("config.patch", {
        code: "INVALID_REQUEST",
        message: "synthetic model save rejected",
      });
      await page.getByRole("alert").filter({ hasText: "synthetic model save rejected" }).waitFor();
      if (recordVisuals) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "05-reconnect-save-error.png"),
        });
      }

      const reconnectedConfig = {
        agents: { defaults: { model: "openai/reconnected-model" } },
      };
      await gateway.setMethodResponse("config.get", {
        config: reconnectedConfig,
        sourceConfig: reconnectedConfig,
        hash: "model-providers-reconnect-2",
        issues: [],
        raw: JSON.stringify(reconnectedConfig),
        valid: true,
      });
      await gateway.setMethodResponse("models.list", {
        models: [
          {
            id: "reconnected-model",
            name: "Reconnected Model",
            provider: "openai",
            available: true,
          },
        ],
      });
      const authRequestCount = (await gateway.getRequests("models.authStatus")).length;
      await gateway.closeLatest(1012, "model provider reconnect proof");
      await expect
        .poll(async () => (await gateway.getRequests("models.authStatus")).length)
        .toBeGreaterThan(authRequestCount);
      await expect
        .poll(() => modelPickerValue(page.locator(".model-providers__defaults wa-select").first()))
        .toBe("openai/reconnected-model");
      await expect.poll(() => page.getByRole("alert").count()).toBe(0);
      await expect
        .poll(async () => (await agentPicker.locator(".agent-select__label").textContent())?.trim())
        .toBe("Writer");
      for (const request of (await gateway.getRequests("models.authStatus")).slice(
        authRequestCount,
      )) {
        expect(request.params).toEqual(expect.objectContaining({ agentId: "writer" }));
      }
      if (recordVisuals) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "06-reconnected-model.png"),
        });
      }
    } finally {
      await context.close();
    }
  });
});

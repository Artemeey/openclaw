import path from "node:path";
import { expect, it } from "vitest";
import {
  cloudSetupDescription,
  cloudSetupFeatureMethods,
  cloudSetupMethods,
  cloudSetupPlugin,
  cloudSetupWorkerId,
  configResponse,
} from "./cloud-workers-settings.test-support.ts";
import {
  captureUiProof,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  waitForCommittedNewSessionDraft,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("lets a newer durable prompt and file beat a stale navigation handoff", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    try {
      const sessionKey = "agent:main:existing-session";
      const staleText = "stale draft from the first page";
      const durableText = "newer durable draft from the second page";
      const staleFileName = "favicon-32.png";
      const durableFileName = "apple-touch-icon.png";
      const pageA = await context.newPage();
      await installMockGateway(pageA, {
        methodResponses: {
          "sessions.list": createdSessionListResult(sessionKey),
        },
      });
      await pageA.goto(`${suite.server.baseUrl}chat`);
      const existingSession = pageA
        .locator(".sidebar-recent-session")
        .filter({ hasText: "Created session" });
      await existingSession.waitFor();
      await pageA.locator(".sidebar-brand__new-thread").click();
      await pageA.waitForURL(
        (url) => url.pathname.endsWith("/new") && url.search === "?agent=main",
      );

      const messageA = pageA.locator(".new-session-page__message");
      await messageA.fill(staleText);
      await pageA
        .locator(".agent-chat__photo-input")
        .setInputFiles(path.join(process.cwd(), "ui/public/favicon-32.png"));
      await pageA.getByRole("button", { name: `Open image ${staleFileName}` }).waitFor();
      await captureUiProof(pageA, "new-session-draft-before-navigation.png");

      await existingSession.click();
      await pageA.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey));

      const pageB = await context.newPage();
      await installMockGateway(pageB);
      await pageB.goto(`${suite.server.baseUrl}new?agent=main`);
      const messageB = pageB.locator(".new-session-page__message");
      await expect.poll(() => messageB.inputValue()).toBe(staleText);
      await pageB.getByRole("button", { name: `Open image ${staleFileName}` }).waitFor();

      await messageB.fill(durableText);
      await pageB.getByRole("button", { name: "Remove attachment" }).click();
      await pageB
        .locator(".agent-chat__photo-input")
        .setInputFiles(path.join(process.cwd(), "ui/public/apple-touch-icon.png"));
      await pageB.getByRole("button", { name: `Open image ${durableFileName}` }).waitFor();
      await waitForCommittedNewSessionDraft(pageB, durableText, 1);
      await pageB.reload();
      await expect.poll(() => messageB.inputValue()).toBe(durableText);
      await pageB.getByRole("button", { name: `Open image ${durableFileName}` }).waitFor();
      await expect(
        pageB.getByRole("button", { name: `Open image ${staleFileName}` }).count(),
      ).resolves.toBe(0);
      await pageB.close();

      await pageA.locator(".sidebar-brand__new-thread").click();
      await pageA.waitForURL(
        (url) => url.pathname.endsWith("/new") && url.search === "?agent=main",
      );
      await expect.poll(() => messageA.inputValue()).toBe(durableText);
      await pageA.getByRole("button", { name: `Open image ${durableFileName}` }).waitFor();
      await expect(
        pageA.getByRole("button", { name: `Open image ${staleFileName}` }).count(),
      ).resolves.toBe(0);
      await captureUiProof(pageA, "new-session-draft-restored.png");
      await pageA.close();

      const freshPage = await context.newPage();
      await installMockGateway(freshPage);
      await freshPage.goto(`${suite.server.baseUrl}new?agent=main`);
      await expect
        .poll(() => freshPage.locator(".new-session-page__message").inputValue())
        .toBe(durableText);
      await freshPage.getByRole("button", { name: `Open image ${durableFileName}` }).waitFor();
      await expect(
        freshPage.getByRole("button", { name: `Open image ${staleFileName}` }).count(),
      ).resolves.toBe(0);
    } finally {
      await context.close();
    }
  });

  it.each([false, true])(
    "retains draft selections through cloud setup (incognito=%s)",
    async (incognito) => {
      const context = await suite.browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 1000 },
      });
      const page = await context.newPage();
      const profiles = [
        {
          id: "existing-cloud",
          providerId: cloudSetupWorkerId,
          machines: [
            { id: "small", label: "Small", default: true },
            { id: "larger", label: "Larger" },
          ],
        },
        { id: "created-cloud", providerId: cloudSetupWorkerId },
      ];
      const config = {
        tools: { web: { search: { provider: "brave" } } },
        cloudWorkers: {
          profiles: Object.fromEntries(
            profiles.map((profile) => [profile.id, { provider: profile.providerId }]),
          ),
        },
      };
      const gateway = await installMockGateway(page, {
        workspace: "/workspace",
        workspaceGit: true,
        featureMethods: [
          ...cloudSetupFeatureMethods,
          "chat.metadata",
          "chat.startup",
          "sessions.create",
          "sessions.dispatch",
          "projects.list",
          "worktrees.branches",
        ],
        models: [
          { id: "gpt-5.6-luna", provider: "openai", name: "GPT-5.6 Luna", available: true },
          {
            id: "claude-fable-5",
            provider: "anthropic",
            name: "Claude Fable 5",
            available: true,
            contextWindows: [
              { id: "200k", label: "200K", contextWindow: 200_000 },
              { id: "1m", label: "1M", contextWindow: 1_000_000 },
            ],
            contextWindowDefault: "1m",
          },
        ],
        methodResponses: {
          "config.get": { ...configResponse(config, "draft-setup"), runtimeConfig: config },
          "plugins.list": { plugins: [cloudSetupPlugin], diagnostics: [], mutationAllowed: true },
          "environments.list": { environments: [], profiles },
          "worktrees.branches": {
            branches: [{ name: "main", kind: "local" }],
            defaultBranch: "main",
            repositoryStatus: "git",
          },
          [cloudSetupMethods.describe]: {
            ...cloudSetupDescription,
            profiles: [
              {
                profileId: "created-cloud",
                provider: "native-provider",
                label: "Created cloud",
                settings: {},
              },
            ],
          },
        },
      });
      try {
        await page.goto(`${suite.server.baseUrl}new?agent=main`);
        await gateway.waitForRequest("environments.list");
        expect((await gateway.waitForRequest("worktrees.branches")).params).toEqual({
          repoRoot: "/workspace",
          includeRepositoryStatus: true,
        });
        if (incognito) {
          await page.getByRole("switch", { name: "Incognito", exact: true }).click();
        }
        const where = page.locator("#new-session-where-trigger");
        await where.click();
        const cloud = page.getByRole("button", { name: "Cloud · existing-cloud", exact: true });
        await expect.poll(() => cloud.isEnabled()).toBe(true);
        await cloud.click();
        await where.click();
        await page.getByRole("button", { name: "Larger", exact: true }).click();
        await page.keyboard.press("Escape");
        await expect.poll(() => where.getAttribute("data-machine-class")).toBe("larger");

        const model = page.locator('[data-chat-model-select="true"]');
        await model.click();
        await page.locator('[data-chat-model-option="anthropic/claude-fable-5"]').click();
        await model.click();
        await page.locator('[data-chat-context-window-toggle="200k"]').click();
        await page.keyboard.press("Escape");
        const permission = page.locator('[data-chat-permission-select="true"]');
        await permission.click();
        await page.locator('[data-chat-permission-option="full"]').click();
        const composer = page.locator(".new-session-page__composer");
        await composer.getByRole("button", { name: "Add attachment" }).click();
        const menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
        await menu.getByRole("menuitemcheckbox", { name: "Web search" }).click();
        await page.keyboard.press("Escape");
        await page.locator(".new-session-page__message").fill("keep this cloud setup draft");
        await page
          .locator(".agent-chat__photo-input")
          .setInputFiles(path.join(process.cwd(), "ui/public/favicon-32.png"));
        await page.getByRole("button", { name: "Open image favicon-32.png" }).waitFor();
        await page.locator("#new-session-project-trigger").click();
        const project = page.locator("wa-popover.new-session-page__project-popover");
        await project.getByText("Advanced", { exact: true }).click();
        await project.getByLabel("Base branch").fill("release/draft");
        await project.getByLabel("Checkout name").fill("retained-checkout");
        await page.keyboard.press("Escape");

        await where.click();
        await page.getByRole("button", { name: "Set up cloud…", exact: true }).click();
        await page.waitForURL((url) => url.pathname.endsWith("/settings/cloud-workers"));
        expect(new URL(page.url()).searchParams.get("agent")).toBe("main");
        expect(page.url()).not.toContain("keep+this");
        await page
          .locator(".settings-section", {
            has: page.getByRole("heading", { name: "Created cloud", exact: true }),
          })
          .getByRole("button", { name: "Start session", exact: true })
          .click();
        await page.waitForURL(
          (url) =>
            url.pathname.endsWith("/new") &&
            url.searchParams.get("cloudProfile") === "created-cloud",
        );
        await expect
          .poll(() => page.locator(".new-session-page__message").inputValue())
          .toBe("keep this cloud setup draft");
        await page.getByRole("button", { name: "Open image favicon-32.png" }).waitFor();
        await expect.poll(() => where.getAttribute("data-cloud-profile")).toBe("created-cloud");
        await expect.poll(() => permission.getAttribute("data-chat-select-value")).toBe("full");
        await expect
          .poll(() =>
            page
              .getByRole("switch", { name: "Incognito", exact: true })
              .getAttribute("aria-checked"),
          )
          .toBe(String(incognito));
        await expect.poll(() => model.textContent()).toContain("Claude Fable 5");
        await expect
          .poll(() => page.locator("[data-chat-model-context-badge]").textContent())
          .toContain("200K");
        await expect
          .poll(() => composer.locator(".new-session-page__selection-status").textContent())
          .toContain("1 override");
        await page.locator("#new-session-project-trigger").click();
        await project.getByText("Advanced", { exact: true }).click();
        await expect
          .poll(() => project.getByLabel("Base branch").inputValue())
          .toBe("release/draft");
        await expect
          .poll(() => project.getByLabel("Checkout name").inputValue())
          .toBe("retained-checkout");
        await page.keyboard.press("Escape");
        await where.click();
        await page.getByRole("button", { name: "Cloud · existing-cloud", exact: true }).click();
        await expect.poll(() => where.getAttribute("data-machine-class")).toBe("larger");
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        expect(await gateway.getRequests("environments.create")).toHaveLength(0);
        if (incognito) {
          await page.reload();
          await expect.poll(() => page.locator(".new-session-page__message").inputValue()).toBe("");
          expect(
            await page.getByRole("button", { name: "Open image favicon-32.png" }).count(),
          ).toBe(0);
        }
      } finally {
        await context.close();
      }
    },
  );
});

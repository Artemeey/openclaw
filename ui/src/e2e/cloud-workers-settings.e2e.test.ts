import type { Page } from "playwright";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { WorkerSetupPrepareParamsSchema } from "../../../packages/gateway-protocol/src/index.js";
import type {
  CloudSessionTestResult,
  WizardNextResult,
  WizardStartResult,
} from "../../../packages/gateway-protocol/src/schema/wizard.js";
import { installMockGateway, waitForConfirmModal } from "../test-helpers/control-ui-e2e.ts";
import {
  cloudSetupCheck,
  cloudSetupDescription,
  cloudSetupFeatureMethods,
  cloudSetupMethods,
  cloudSetupPlugin,
  cloudSetupWorkerId,
  configResponse,
  requestRaw,
} from "./cloud-workers-settings.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createdSessionListResult } from "./new-session-page.test-support.ts";
import { waitForSettledFormControls } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Guided cloud session setup",
  startServerBeforeBrowser: true,
});

async function openConnectionForm(page: Page) {
  await page.getByRole("button", { name: "Add cloud provider" }).click();
  const name = page.getByLabel("Connection name");
  const token = page.getByLabel("Provider API token", { exact: true });
  await name.fill("Build connection");
  await token.fill("fake-cloud-token");
  await page.getByLabel("Organization", { exact: true }).fill("fake-organization");
  await waitForSettledFormControls(page, [
    { locator: name, value: "Build connection" },
    { locator: token, value: "fake-cloud-token" },
    { locator: page.getByLabel("Organization", { exact: true }), value: "fake-organization" },
  ]);
  return token;
}

function setupResponses() {
  return {
    "plugins.list": { plugins: [cloudSetupPlugin], diagnostics: [], mutationAllowed: true },
    "config.get": configResponse({}, "setup-1"),
    "secrets.store.set": { ok: true, reloaded: true },
    "environments.list": { environments: [], profiles: [] },
    [cloudSetupMethods.describe]: cloudSetupDescription,
    [cloudSetupMethods.check]: cloudSetupCheck,
  };
}

const testSessionKey = "agent:main:cloud-test-311110b1-d827-4269-bb68-9b15099c0bc4";
const testConfirmation: WizardStartResult = {
  sessionId: "cloud-test-wizard",
  done: false,
  status: "running",
  step: {
    id: "cost-consent",
    type: "confirm",
    executor: "client",
    initialValue: false,
    message:
      "This test runs one remote model turn. Both cloud and model usage may be billed. Cleanup must be verified.",
  },
  cloudSessionTest: { stage: "confirmation", status: "running", cleanup: "not-allocated" },
};
function testProgress(proof: Partial<CloudSessionTestResult>, done = false): WizardNextResult {
  return {
    done,
    status: done ? "done" : "running",
    ...(!done
      ? { step: { id: "test-progress", type: "progress" as const, executor: "gateway" as const } }
      : {}),
    cloudSessionTest: {
      sessionKey: testSessionKey,
      stage: "running",
      status: "running",
      cleanup: "pending",
      ...proof,
    },
  };
}
function testProfileConfig(suspendAfter = "15m") {
  return { cloudWorkers: { profiles: { guided: { provider: cloudSetupWorkerId, suspendAfter } } } };
}

async function openConfiguredProfile(page: Page) {
  const profile = {
    profileId: "guided",
    connectionId: "shared",
    label: "Test connection",
    provider: "native-provider",
    settings: {},
    suspendAfter: "15m",
  };
  const gateway = await installMockGateway(page, {
    featureMethods: [
      ...cloudSetupFeatureMethods,
      "wizard.start",
      "wizard.next",
      "wizard.status",
      "wizard.cancel",
    ],
    methodResponses: {
      ...setupResponses(),
      "config.get": configResponse(testProfileConfig(), "setup-1"),
      [cloudSetupMethods.describe]: { ...cloudSetupDescription, profiles: [profile] },
      "sessions.list": createdSessionListResult(testSessionKey),
      "wizard.start": testConfirmation,
    },
  });
  await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
  await page.getByText("Suspend after 15m idle", { exact: true }).waitFor();
  return gateway;
}

async function changeProfileConfig(
  page: Page,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  suspendAfter: string,
  revision: string,
) {
  await gateway.setMethodResponse(
    "config.get",
    configResponse(testProfileConfig(suspendAfter), revision),
  );
  await gateway.emitGatewayEvent("config.changed", { hash: revision, ts: Date.now() });
  await page.getByText(`Suspend after ${suspendAfter} idle`, { exact: true }).waitFor();
}

async function openTestProfile(page: Page) {
  const gateway = await openConfiguredProfile(page);
  await page.getByRole("button", { name: "Run test session", exact: true }).click();
  expect((await gateway.waitForRequest("wizard.start")).params).toEqual({
    flow: "cloud-session-test",
    profileId: "guided",
  });
  await page.getByText(testConfirmation.step!.message!, { exact: true }).waitFor();
  return gateway;
}

async function confirmRunningTest(
  page: Page,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
) {
  await gateway.deferNext("wizard.next");
  await page.getByRole("button", { name: "Confirm and run test", exact: true }).click();
  expect((await gateway.waitForRequest("wizard.next")).params).toEqual({
    sessionId: "cloud-test-wizard",
    answer: { stepId: "cost-consent", value: true },
  });
  await gateway.deferNext("wizard.next");
  await gateway.resolveDeferred(
    "wizard.next",
    testProgress({ message: "The remote turn is running." }),
  );
  await page.getByText("The remote turn is running.", { exact: true }).waitFor();
  await gateway.waitForRequest("wizard.next", { after: 1 });
}

suite.define(() => {
  it("preselects the only guided provider and keeps unsupported choices in Advanced", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: cloudSetupFeatureMethods,
        methodResponses: {
          ...setupResponses(),
          [cloudSetupMethods.describe]: {
            ...cloudSetupDescription,
            providers: [
              ...cloudSetupDescription.providers,
              {
                ...cloudSetupDescription.providers[0],
                id: "manual",
                label: "Manual native backend",
                compatibility: "advanced",
              },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page.getByRole("button", { name: "Add cloud provider" }).click();
      await expect
        .poll(() => page.getByLabel("Connection name").inputValue())
        .toBe("Native provider");
      expect(await page.getByRole("combobox", { name: "Cloud plugin", exact: true }).count()).toBe(
        0,
      );
      expect(
        await page.getByRole("combobox", { name: "Cloud provider", exact: true }).count(),
      ).toBe(0);
      expect(await page.getByText("Manual native backend", { exact: true }).count()).toBe(0);
      expect(await page.getByLabel("Organization", { exact: true }).isVisible()).toBe(true);
      expect(await page.getByLabel("Prepared image", { exact: true }).isVisible()).toBe(true);
      expect(await page.getByLabel("CPU count", { exact: true }).count()).toBe(0);
      await page.getByRole("button", { name: "Advanced", exact: true }).first().waitFor();
    });
  });

  it("offers only guided choices when more than one provider is available", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const provider = cloudSetupDescription.providers[0];
      await installMockGateway(page, {
        featureMethods: cloudSetupFeatureMethods,
        methodResponses: {
          ...setupResponses(),
          [cloudSetupMethods.describe]: {
            ...cloudSetupDescription,
            providers: [
              provider,
              { ...provider, id: "second-guided", label: "Second guided provider" },
              {
                ...provider,
                id: "manual",
                label: "Manual native backend",
                compatibility: "advanced",
              },
              {
                ...provider,
                id: "unsupported",
                label: "Unsupported backend",
                compatibility: "unsupported",
              },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page.getByRole("button", { name: "Add cloud provider" }).click();
      const chooser = page.getByRole("combobox", { name: "Cloud provider", exact: true });
      await chooser.waitFor();
      expect(await chooser.locator("option").allTextContents()).toEqual([
        "Choose a provider…",
        "Native provider",
        "Second guided provider",
      ]);
      await chooser.selectOption("second-guided");
      await expect
        .poll(() => page.getByLabel("Connection name").inputValue())
        .toBe("Second guided provider");
    });
  });

  it("waits for false-by-default server consent and declines without allocating", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await openTestProfile(page);
      expect(await gateway.getRequests("wizard.next")).toHaveLength(0);
      expect(
        await page.locator("openclaw-cloud-provider-setup button.primary:visible").count(),
      ).toBe(1);
      await gateway.deferNext("wizard.next");
      await page.getByRole("button", { name: "No", exact: true }).click();
      expect((await gateway.waitForRequest("wizard.next")).params).toEqual({
        sessionId: "cloud-test-wizard",
        answer: { stepId: "cost-consent", value: false },
      });
      await gateway.resolveDeferred("wizard.next", {
        done: true,
        status: "done",
        cloudSessionTest: { stage: "finished", status: "cancelled", cleanup: "not-allocated" },
      });
      await page.getByText("Test cancelled", { exact: true }).waitFor();
      await page.getByText("No worker allocated", { exact: true }).waitFor();
      for (const method of [
        "environments.create",
        "sessions.create",
        "sessions.dispatch",
        "sessions.send",
        "wizard.cancel",
      ]) {
        expect(await gateway.getRequests(method)).toHaveLength(0);
      }
      expect(await gateway.getRequests("wizard.start")).toHaveLength(1);
    });
  });

  it("retains progress across the ordinary session link and requires verified cleanup to pass", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await openTestProfile(page);
      await confirmRunningTest(page, gateway);
      await page.getByRole("link", { name: "Open test session", exact: true }).click();
      await page.waitForURL((url) => !url.pathname.endsWith("settings/cloud-workers"));
      expect(await gateway.getRequests("wizard.cancel")).toHaveLength(0);
      await page.goBack();
      await page.getByText("The remote turn is running.", { exact: true }).waitFor();
      expect(await gateway.getRequests("wizard.start")).toHaveLength(1);
      await gateway.deferNext("wizard.status");
      await gateway.resolveDeferred(
        "wizard.next",
        testProgress({ stage: "finished", status: "passed", cleanup: "pending" }, true),
      );
      await gateway.waitForRequest("wizard.status");
      await page.getByText("Waiting for verified cleanup", { exact: true }).waitFor();
      expect(await page.getByText("Passed · cleanup verified", { exact: true }).count()).toBe(0);
      await gateway.resolveDeferred("wizard.status", {
        status: "done",
        cloudSessionTest: testProgress(
          { stage: "finished", status: "passed", cleanup: "verified" },
          true,
        ).cloudSessionTest,
      });
      await page.getByText("Passed · cleanup verified", { exact: true }).first().waitFor();
      await page.getByText("Cleanup verified", { exact: true }).waitFor();
      await changeProfileConfig(page, gateway, "20m", "setup-edited");
      await page.getByText("Previous test passed · cleanup verified", { exact: true }).waitFor();
      await page.getByText("Not tested", { exact: true }).waitFor();
      expect(await page.getByText("Passed · cleanup verified", { exact: true }).count()).toBe(0);
      await page.getByRole("link", { name: "Open test session", exact: true }).waitFor();
      expect(await gateway.getRequests("wizard.start")).toHaveLength(1);
      expect(await gateway.getRequests("wizard.cancel")).toHaveLength(0);
      expect(await gateway.getRequests("environments.create")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    });
  });

  it("keeps an active test observable when config changes without certifying the new settings", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await openTestProfile(page);
      await confirmRunningTest(page, gateway);
      await changeProfileConfig(page, gateway, "20m", "setup-during-test");
      await page
        .getByText(
          "This test belongs to a previous configuration. It does not verify the current settings.",
          { exact: false },
        )
        .waitFor();
      await page.getByText("The remote turn is running.", { exact: false }).waitFor();
      await page.getByRole("link", { name: "Open test session", exact: true }).waitFor();
      await gateway.resolveDeferred(
        "wizard.next",
        testProgress({ stage: "finished", status: "passed", cleanup: "verified" }, true),
      );
      await page.getByText("Previous test passed · cleanup verified", { exact: true }).waitFor();
      await page.getByText("Not tested", { exact: true }).waitFor();
      expect(await page.getByText("Passed · cleanup verified", { exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("wizard.cancel")).toHaveLength(0);
      expect(await gateway.getRequests("wizard.start")).toHaveLength(1);
    });
  });

  it("invalidates completed and in-flight read-only checks when config changes", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await openConfiguredProfile(page);
      const check = page.getByRole("button", { name: "Check connection", exact: true });
      await check.click();
      expect((await gateway.waitForRequest(cloudSetupMethods.check)).params).toEqual({
        profileId: "guided",
      });
      await page.getByText("Verified", { exact: true }).waitFor();
      await changeProfileConfig(page, gateway, "20m", "setup-check-2");
      expect(await page.getByText("Verified", { exact: true }).count()).toBe(0);
      expect(
        await page.getByText("Configured · not proven reachable", { exact: true }).count(),
      ).toBe(0);
      await gateway.deferNext(cloudSetupMethods.check);
      await check.click();
      await gateway.waitForRequest(cloudSetupMethods.check, { after: 1 });
      await changeProfileConfig(page, gateway, "25m", "setup-check-3");
      await gateway.resolveDeferred(cloudSetupMethods.check, cloudSetupCheck);
      await page
        .getByRole("alert")
        .filter({ hasText: "Configuration changed during the check" })
        .waitFor();
      expect(await page.getByText("Verified", { exact: true }).count()).toBe(0);
      await check.click();
      await gateway.waitForRequest(cloudSetupMethods.check, { after: 2 });
      await page.getByText("Verified", { exact: true }).waitFor();
      expect(await gateway.getRequests("wizard.start")).toHaveLength(0);
      expect(await gateway.getRequests("environments.create")).toHaveLength(0);
    });
  });

  it("requests cancellation explicitly and keeps cleanup pending until the Gateway settles", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await openTestProfile(page);
      await confirmRunningTest(page, gateway);
      await gateway.deferNext("wizard.cancel");
      await page.getByRole("button", { name: "Cancel test", exact: true }).click();
      expect((await gateway.waitForRequest("wizard.cancel")).params).toEqual({
        sessionId: "cloud-test-wizard",
      });
      await page
        .getByText("Cancellation requested · waiting for cleanup", { exact: true })
        .waitFor();
      // The old observation response cannot overrule a newer cancellation request.
      await gateway.resolveDeferred(
        "wizard.next",
        testProgress({ stage: "finished", status: "passed", cleanup: "verified" }, true),
      );
      await gateway.deferNext("wizard.status");
      await gateway.resolveDeferred("wizard.cancel", {
        status: "cancelled",
        cloudSessionTest: testProgress({ stage: "cleanup", status: "cleanup-pending" })
          .cloudSessionTest,
      });
      await gateway.waitForRequest("wizard.status");
      await page.getByText("Cleanup pending", { exact: true }).waitFor();
      expect(await page.getByText("Passed · cleanup verified", { exact: true }).count()).toBe(0);
      await gateway.resolveDeferred("wizard.status", {
        status: "cancelled",
        cloudSessionTest: testProgress(
          { stage: "finished", status: "cancelled", cleanup: "verified" },
          true,
        ).cloudSessionTest,
      });
      await page.getByText("Test cancelled", { exact: true }).waitFor();
      await page.getByText("Cleanup verified", { exact: true }).waitFor();
      expect(await gateway.getRequests("wizard.cancel")).toHaveLength(1);
    });
  });

  it.each(["restart", "wizard-not-found"])(
    "retains the session link after %s without restarting or claiming cleanup",
    async (reason) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const gateway = await openTestProfile(page);
        await confirmRunningTest(page, gateway);
        const describes = (await gateway.getRequests(cloudSetupMethods.describe)).length;
        if (reason === "restart") {
          await gateway.setGatewayBootId("new-cloud-test-boot");
        } else {
          await gateway.deferNext("wizard.status");
        }
        await gateway.closeLatest(1012, "Test connection interrupted");
        await gateway.waitForRequest(cloudSetupMethods.describe, { after: describes });
        if (reason === "wizard-not-found") {
          await gateway.waitForRequest("wizard.status");
          await gateway.rejectDeferred("wizard.status", {
            code: "INVALID_REQUEST",
            message: "wizard not found",
            details: { code: "WIZARD_NOT_FOUND" },
          });
        }
        await page.getByText("Test observation interrupted", { exact: true }).waitFor();
        await page.getByRole("link", { name: "Open test session", exact: true }).waitFor();
        expect(await page.getByText("Passed · cleanup verified", { exact: true }).count()).toBe(0);
        expect(await page.getByText("Cleanup verified", { exact: true }).count()).toBe(0);
        expect(await gateway.getRequests("wizard.start")).toHaveLength(1);
        expect(await gateway.getRequests("wizard.cancel")).toHaveLength(0);
        expect(
          await page.getByRole("button", { name: "Run test session", exact: true }).isDisabled(),
        ).toBe(true);
      });
    },
  );

  it("stores a masked credential, saves references through CAS, and checks without allocation", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: "/workspace",
      workspaceGit: true,
      featureMethods: [...cloudSetupFeatureMethods, "worktrees.branches"],
      methodResponses: {
        ...setupResponses(),
        "worktrees.branches": {
          branches: [{ name: "main", kind: "local" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      const token = await openConnectionForm(page);
      expect(await token.getAttribute("type")).toBe("password");
      const credentialLink = page.getByRole("link", {
        name: "Get Provider API token",
        exact: true,
      });
      expect(await credentialLink.getAttribute("href")).toBe(
        "https://provider.example.test/settings/keys",
      );
      expect(await credentialLink.getAttribute("target")).toBe("_blank");
      expect(await credentialLink.getAttribute("rel")).toContain("noopener");
      expect(await credentialLink.getAttribute("rel")).toContain("noreferrer");
      expect(await page.getByLabel("Machine class", { exact: true }).count()).toBe(0);
      await page
        .getByRole("button", { name: "1 advanced setting hidden Show advanced", exact: true })
        .click();
      await page.getByLabel("CPU count", { exact: true }).fill("3");
      await waitForSettledFormControls(page, [
        { locator: page.getByLabel("CPU count", { exact: true }), value: "3" },
      ]);
      await gateway.deferNext(cloudSetupMethods.prepare);
      await gateway.deferNext("config.patch");
      await page
        .locator("openclaw-cloud-provider-setup")
        .getByRole("button", { name: "Save", exact: true })
        .click();
      const secret = await gateway.waitForRequest("secrets.store.set");
      expect(secret.params).toMatchObject({
        kind: "secret",
        value: "fake-cloud-token",
        name: expect.stringMatching(/^CLOUD_[A-F0-9]{32}$/),
      });
      const prepare = await gateway.waitForRequest(cloudSetupMethods.prepare);
      if (!Value.Check(WorkerSetupPrepareParamsSchema, prepare.params)) {
        throw new Error("Expected prepare request");
      }
      const params = prepare.params;
      expect(params.profileId).toBe("build-connection");
      expect(params.connectionId).toMatch(/^cloud-[a-f0-9-]{36}$/);
      expect(params).toMatchObject({
        provider: "native-provider",
        label: "Build connection",
        settings: { cpu: 3, image: "small-image", organizationId: "fake-organization" },
        credentials: { apiToken: { source: "store", provider: "default" } },
      });
      expect(params.settings).not.toHaveProperty("class");
      expect(JSON.stringify(params)).not.toContain("fake-cloud-token");
      await expect.poll(() => token.inputValue()).toBe("");
      expect(await token.isDisabled()).toBe(true);
      const patch = {
        cloudWorkers: {
          profiles: {
            [params.profileId]: {
              provider: cloudSetupWorkerId,
              settings: { ...params.settings, connectionId: params.connectionId },
            },
          },
        },
      };
      await gateway.resolveDeferred(cloudSetupMethods.prepare, {
        status: "prepared",
        saved: false,
        profileId: params.profileId,
        connectionId: params.connectionId,
        patch,
        restartRequired: true,
      });
      const request = await gateway.waitForRequest("config.patch");
      expect(request.params).toMatchObject({ baseHash: "setup-1" });
      expect(requestRaw(request)).toEqual(patch);
      expect(JSON.stringify(request.params)).not.toContain("fake-cloud-token");
      await gateway.setMethodResponse("config.get", {
        ...configResponse(patch, "setup-2"),
        appliedConfigHash: "setup-1",
      });
      await gateway.resolveDeferred("config.patch", { ok: true, hash: "setup-2", config: patch });
      await page
        .getByText(
          "Saved. Apply the configuration using the Settings restart action, then reconnect to continue.",
          { exact: true },
        )
        .first()
        .waitFor();
      await expect
        .poll(() => page.getByRole("button", { name: "Check connection" }).isDisabled())
        .toBe(true);
      expect(await gateway.getRequests(cloudSetupMethods.check)).toHaveLength(0);

      await gateway.setMethodResponse("config.get", configResponse(patch, "setup-2"));
      await gateway.setMethodResponse(cloudSetupMethods.describe, {
        ...cloudSetupDescription,
        profiles: [
          {
            profileId: params.profileId,
            connectionId: params.connectionId,
            label: "Build connection",
            provider: params.provider,
            settings: params.settings,
          },
        ],
      });
      const describes = (await gateway.getRequests(cloudSetupMethods.describe)).length;
      await gateway.setGatewayBootId("cloud-setup-restarted");
      await gateway.closeLatest(1012, "Apply completed");
      await gateway.waitForRequest(cloudSetupMethods.describe, { after: describes });
      await expect
        .poll(() => page.getByRole("button", { name: "Check connection" }).isEnabled())
        .toBe(true);
      await page.getByRole("button", { name: "Check connection" }).click();
      await gateway.waitForRequest(cloudSetupMethods.check);
      await page.getByText("Configured · not proven reachable", { exact: true }).waitFor();
      await page.getByText("Not tested", { exact: true }).waitFor();
      for (const method of [
        "environments.create",
        "sessions.create",
        "sessions.dispatch",
        "environments.destroy",
        "secrets.store.delete",
      ]) {
        expect(await gateway.getRequests(method)).toHaveLength(0);
      }
      await gateway.setMethodResponse("environments.list", {
        environments: [],
        profiles: [{ id: params.profileId, providerId: cloudSetupWorkerId }],
      });
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get("cloudProfile"))
        .toBe(params.profileId);
      expect(page.url()).not.toContain("fake-cloud-token");
      const place = page.locator("#new-session-where-trigger");
      await expect.poll(() => place.getAttribute("data-cloud-profile")).toBe("build-connection");
      expect(await place.textContent()).toContain("build-connection");
      await place.click();
      await page.getByRole("button", { name: "Local", exact: true }).click();
      await expect.poll(() => place.getAttribute("data-cloud-profile")).toBeNull();
      await place.click();
      await page.getByRole("button", { name: "Cloud · build-connection", exact: true }).click();
      await expect.poll(() => place.getAttribute("data-cloud-profile")).toBe("build-connection");
      await expect.poll(() => place.textContent()).toContain("build-connection");
    } finally {
      await context.close();
    }
  });

  it("requires explicit enable and dependency consent and waits for advertised methods", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const disabled = { ...cloudSetupPlugin, enabled: false, state: "disabled" };
    const gateway = await installMockGateway(page, {
      featureMethods: cloudSetupFeatureMethods,
      methodResponses: {
        ...setupResponses(),
        "plugins.list": { plugins: [disabled], diagnostics: [], mutationAllowed: true },
        "plugins.setEnabled": { ok: true, plugin: cloudSetupPlugin, restartRequired: true },
        [cloudSetupMethods.describe]: {
          ...cloudSetupDescription,
          dependency: { ...cloudSetupDescription.dependency, state: "missing" },
        },
        [cloudSetupMethods.install]: {
          status: "installed",
          dependency: cloudSetupDescription.dependency,
          diagnostics: [],
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page.getByRole("button", { name: "Enable", exact: true }).waitFor();
      expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);
      expect(await gateway.getRequests(cloudSetupMethods.describe)).toHaveLength(0);
      await page.getByRole("button", { name: "Enable", exact: true }).click();
      await gateway.waitForRequest("plugins.setEnabled");
      await page.getByText("Cloud setup is not active yet.", { exact: true }).waitFor();
      expect(await gateway.getRequests(cloudSetupMethods.describe)).toHaveLength(0);
      await gateway.setMethodResponse("plugins.list", {
        plugins: [cloudSetupPlugin],
        diagnostics: [],
        mutationAllowed: true,
      });
      await gateway.closeLatest(1012, "Plugin activated");
      await page
        .getByRole("button", { name: "Install compatible dependency", exact: true })
        .click();
      const dialog = await waitForConfirmModal(page);
      expect(await gateway.getRequests(cloudSetupMethods.install)).toHaveLength(0);
      await gateway.setMethodResponse(cloudSetupMethods.describe, cloudSetupDescription);
      await dialog
        .getByRole("button", { name: "Install compatible dependency", exact: true })
        .click();
      await gateway.waitForRequest(cloudSetupMethods.install);
      await page.getByText("Compatible", { exact: true }).waitFor();
      expect(await gateway.getRequests("environments.create")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("rejects a prepared patch after an intervening config edit and prepares again with retained refs", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: cloudSetupFeatureMethods,
        methodResponses: setupResponses(),
      });
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await openConnectionForm(page);
      await gateway.deferNext(cloudSetupMethods.prepare);
      await page
        .locator("openclaw-cloud-provider-setup")
        .getByRole("button", { name: "Save", exact: true })
        .click();
      const first = await gateway.waitForRequest(cloudSetupMethods.prepare);
      if (!Value.Check(WorkerSetupPrepareParamsSchema, first.params)) {
        throw new Error("Expected prepare request");
      }
      const params = first.params;
      const editedConfig = {
        cloudWorkers: {
          profiles: {
            retained: { provider: "other-worker", settings: { region: "preserved-region" } },
          },
        },
      };
      await gateway.setMethodResponse("config.get", configResponse(editedConfig, "setup-2"));
      await gateway.emitGatewayEvent("config.changed", { hash: "setup-2", ts: Date.now() });
      await page.getByRole("heading", { name: "retained", exact: true }).waitFor();
      const profile = {
        provider: cloudSetupWorkerId,
        settings: { ...params.settings, connectionId: params.connectionId },
      };
      const prepared = {
        status: "prepared",
        saved: false,
        profileId: params.profileId,
        connectionId: params.connectionId,
        patch: { cloudWorkers: { profiles: { [params.profileId]: profile } } },
        restartRequired: true,
      };
      await gateway.resolveDeferred(cloudSetupMethods.prepare, prepared);
      const failure = page
        .getByRole("alert")
        .filter({ hasText: "Configuration changed while preparing this connection" });
      await failure.waitFor();
      expect(await failure.textContent()).toContain("Credentials were stored securely");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      expect(await page.getByLabel("Provider API token", { exact: true }).inputValue()).toBe("");
      await gateway.deferNext(cloudSetupMethods.prepare);
      await gateway.deferNext("config.patch");
      await page
        .locator("openclaw-cloud-provider-setup")
        .getByRole("button", { name: "Save", exact: true })
        .click();
      const retry = await gateway.waitForRequest(cloudSetupMethods.prepare, { after: 1 });
      expect(retry.params).toEqual(params);
      expect(await gateway.getRequests("secrets.store.set")).toHaveLength(1);
      expect(await gateway.getRequests("secrets.store.delete")).toHaveLength(0);
      await gateway.resolveDeferred(cloudSetupMethods.prepare, prepared);
      const patch = await gateway.waitForRequest("config.patch");
      expect(patch.params).toMatchObject({ baseHash: "setup-2" });
      const saved = {
        cloudWorkers: {
          profiles: { ...editedConfig.cloudWorkers.profiles, [params.profileId]: profile },
        },
      };
      await gateway.setMethodResponse("config.get", configResponse(saved, "setup-3"));
      await gateway.resolveDeferred("config.patch", { ok: true, hash: "setup-3", config: saved });
      await page.getByRole("heading", { name: "Build connection", exact: true }).waitFor();
      expect(await page.getByLabel("Connection name", { exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("config.patch")).toHaveLength(1);
    });
  });

  it("reserves a readable ID across collisions and a partial save without overwriting a secret", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: cloudSetupFeatureMethods,
      methodResponses: {
        ...setupResponses(),
        "config.get": configResponse(
          {
            cloudWorkers: {
              profiles: {
                "build-connection": { provider: "another-worker" },
                "build-connection-2": { provider: "manual-worker", settings: { untouched: true } },
              },
            },
          },
          "setup-1",
        ),
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await openConnectionForm(page);
      await gateway.deferNext(cloudSetupMethods.prepare);
      await gateway.deferNext("config.patch");
      await page
        .locator("openclaw-cloud-provider-setup")
        .getByRole("button", { name: "Save", exact: true })
        .click();
      const prepare = await gateway.waitForRequest(cloudSetupMethods.prepare);
      if (!Value.Check(WorkerSetupPrepareParamsSchema, prepare.params)) {
        throw new Error("Expected prepare request");
      }
      const params = prepare.params;
      expect(prepare.params.profileId).toBe("build-connection-3");
      const profile = {
        provider: cloudSetupWorkerId,
        settings: { ...params.settings, connectionId: params.connectionId },
      };
      await gateway.resolveDeferred(cloudSetupMethods.prepare, {
        status: "prepared",
        saved: false,
        profileId: prepare.params.profileId,
        connectionId: prepare.params.connectionId,
        patch: { cloudWorkers: { profiles: { [params.profileId]: profile } } },
        restartRequired: true,
      });
      await gateway.waitForRequest("config.patch");
      await gateway.rejectDeferred("config.patch", {
        code: "UNAVAILABLE",
        message: "Source config changed",
      });
      await page
        .getByRole("alert")
        .filter({ hasText: "Credentials were stored securely" })
        .waitFor();
      expect(await page.getByLabel("Connection name").getAttribute("readonly")).not.toBeNull();
      await expect
        .poll(() => page.getByLabel("Provider API token", { exact: true }).isDisabled())
        .toBe(true);
      await gateway.deferNext(cloudSetupMethods.prepare);
      await page
        .locator("openclaw-cloud-provider-setup")
        .getByRole("button", { name: "Save", exact: true })
        .click();
      const retry = await gateway.waitForRequest(cloudSetupMethods.prepare, { after: 1 });
      expect(retry.params).toEqual(prepare.params);
      expect(await gateway.getRequests("secrets.store.set")).toHaveLength(1);
      expect(await gateway.getRequests("secrets.store.delete")).toHaveLength(0);
      await gateway.deferNext("config.patch");
      await gateway.resolveDeferred(cloudSetupMethods.prepare, {
        status: "prepared",
        saved: false,
        profileId: params.profileId,
        connectionId: params.connectionId,
        patch: { cloudWorkers: { profiles: { [params.profileId]: profile } } },
        restartRequired: true,
      });
      await gateway.waitForRequest("config.patch", { after: 1 });
      const saved = {
        cloudWorkers: {
          profiles: {
            "build-connection": { provider: "another-worker" },
            "build-connection-2": { provider: "manual-worker", settings: { untouched: true } },
            [params.profileId]: profile,
          },
        },
      };
      await gateway.setMethodResponse("config.get", configResponse(saved, "setup-lost-response"));
      await gateway.setMethodResponse(cloudSetupMethods.describe, {
        ...cloudSetupDescription,
        profiles: [
          {
            profileId: params.profileId,
            connectionId: params.connectionId,
            label: params.label,
            provider: params.provider,
            settings: params.settings,
          },
        ],
      });
      const describes = (await gateway.getRequests(cloudSetupMethods.describe)).length;
      await gateway.closeLatest(1012, "Saved response was lost");
      await gateway.waitForRequest(cloudSetupMethods.describe, { after: describes });
      await page.getByText("Profile ID: build-connection-3", { exact: true }).waitFor();
      await page
        .locator("openclaw-cloud-provider-setup")
        .getByRole("button", { name: "Save", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Profile build-connection-3 now exists" })
        .waitFor();
      expect(await gateway.getRequests("config.patch")).toHaveLength(2);
      expect(await gateway.getRequests(cloudSetupMethods.prepare)).toHaveLength(2);
      expect(await gateway.getRequests("secrets.store.set")).toHaveLength(1);
      expect(
        await page.getByRole("heading", { name: "Build connection", exact: true }).count(),
      ).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("names a second profile without renaming its shared connection or replacing credentials", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const credentials = {
        apiToken: { source: "store", provider: "default", id: "SHARED_CLOUD_TOKEN" },
      };
      const connection = { provider: "native-provider", label: "Shared connection", credentials };
      const oldProfile = {
        provider: cloudSetupWorkerId,
        settings: { connectionId: "shared", image: "old-image" },
      };
      const config = {
        cloudWorkers: { profiles: { "old-profile": oldProfile } },
        plugins: {
          entries: { [cloudSetupPlugin.id]: { config: { connections: { shared: connection } } } },
        },
      };
      const gateway = await installMockGateway(page, {
        featureMethods: cloudSetupFeatureMethods,
        methodResponses: {
          ...setupResponses(),
          "config.get": configResponse(config, "setup-1"),
          [cloudSetupMethods.describe]: {
            ...cloudSetupDescription,
            connections: [
              {
                ...connection,
                connectionId: "shared",
                state: "configured",
                profileIds: ["old-profile"],
              },
            ],
            profiles: [
              {
                profileId: "old-profile",
                connectionId: "shared",
                label: connection.label,
                provider: connection.provider,
                settings: oldProfile.settings,
              },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page.getByRole("button", { name: "Add cloud provider" }).click();
      await page.getByLabel("Saved connection", { exact: true }).selectOption("shared");
      const name = page.getByLabel("Connection name", { exact: true });
      expect(await name.inputValue()).toBe("Shared connection");
      expect(await name.getAttribute("readonly")).not.toBeNull();
      await page.getByLabel("Profile name", { exact: true }).fill("Build jobs");
      await page.getByLabel("Organization", { exact: true }).fill("fake-organization");
      await waitForSettledFormControls(page, [
        { locator: page.getByLabel("Profile name", { exact: true }), value: "Build jobs" },
        { locator: page.getByLabel("Organization", { exact: true }), value: "fake-organization" },
      ]);
      const token = page.getByLabel("Provider API token", { exact: true });
      expect(await token.isDisabled()).toBe(true);
      expect(await token.getAttribute("type")).toBe("password");
      expect(await token.inputValue()).toBe("");
      expect(await page.locator("body").textContent()).not.toContain("SHARED_CLOUD_TOKEN");
      await gateway.deferNext(cloudSetupMethods.prepare);
      await gateway.deferNext("config.patch");
      await page
        .locator("openclaw-cloud-provider-setup")
        .getByRole("button", { name: "Save", exact: true })
        .click();
      const prepare = await gateway.waitForRequest(cloudSetupMethods.prepare);
      expect(prepare.params).toMatchObject({
        connectionId: "shared",
        profileId: "build-jobs",
        label: "Shared connection",
        credentials,
      });
      const profile = {
        provider: cloudSetupWorkerId,
        settings: {
          connectionId: "shared",
          image: "small-image",
          organizationId: "fake-organization",
        },
      };
      await gateway.resolveDeferred(cloudSetupMethods.prepare, {
        status: "prepared",
        saved: false,
        profileId: "build-jobs",
        connectionId: "shared",
        restartRequired: true,
        patch: { cloudWorkers: { profiles: { "build-jobs": profile } } },
      });
      const patch = await gateway.waitForRequest("config.patch");
      expect(requestRaw(patch)).not.toHaveProperty("plugins");
      const saved = {
        ...config,
        cloudWorkers: { profiles: { "old-profile": oldProfile, "build-jobs": profile } },
      };
      await gateway.setMethodResponse("config.get", configResponse(saved, "setup-2"));
      await gateway.resolveDeferred("config.patch", { ok: true, hash: "setup-2", config: saved });
      await expect
        .poll(() => page.getByRole("heading", { name: "Shared connection", exact: true }).count())
        .toBe(2);
      await page.getByText("Profile ID: old-profile", { exact: true }).waitFor();
      await page.getByText("Profile ID: build-jobs", { exact: true }).waitFor();
      expect(await gateway.getRequests("secrets.store.set")).toHaveLength(0);
      expect(await gateway.getRequests("secrets.store.delete")).toHaveLength(0);
    });
  });

  it("clears plaintext and fences a stored-secret continuation after reconnect", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: cloudSetupFeatureMethods,
      methodResponses: setupResponses(),
    });
    try {
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await openConnectionForm(page);
      await gateway.deferNext("secrets.store.set");
      await page
        .locator("openclaw-cloud-provider-setup")
        .getByRole("button", { name: "Save", exact: true })
        .click();
      await gateway.waitForRequest("secrets.store.set");
      const describes = (await gateway.getRequests(cloudSetupMethods.describe)).length;
      await gateway.closeLatest(1012, "Credential flow interrupted");
      await gateway.waitForRequest(cloudSetupMethods.describe, { after: describes });
      await gateway.resolveDeferred("secrets.store.set", { ok: true, reloaded: true });
      await expect
        .poll(() => page.getByLabel("Provider API token", { exact: true }).inputValue())
        .toBe("");
      expect(await gateway.getRequests(cloudSetupMethods.prepare)).toHaveLength(0);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("shows unavailable setup with a reconnect action instead of inventing plugin methods", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["plugins.list", "config.patch"],
      methodResponses: setupResponses(),
    });
    try {
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page.getByText("Cloud setup is not active yet.", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Refresh", exact: true }).waitFor();
      expect(await gateway.getRequests(cloudSetupMethods.describe)).toHaveLength(0);
      expect(await page.getByLabel("Provider API token").count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});

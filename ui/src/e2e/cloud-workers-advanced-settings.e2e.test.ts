import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, waitForConfirmModal } from "../test-helpers/control-ui-e2e.ts";
import { configResponse, requestRaw } from "./cloud-workers-settings.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Cloud profiles through canonical Advanced settings",
  startServerBeforeBrowser: true,
});

async function revealRawConfig(page: Page) {
  await page.getByRole("button", { name: "Raw", exact: true }).click();
  const raw = page.getByPlaceholder("Raw config (JSON/JSON5)", { exact: true });
  expect(await raw.count()).toBe(0);
  await page.getByRole("button", { name: "Toggle raw config redaction", exact: true }).click();
  await raw.waitFor();
  return raw;
}
const initialConfig = {
  cloudWorkers: {
    profiles: {
      pending: {
        provider: "third-party-worker",
        install: "npm",
        suspendAfter: "30m",
        settings: {
          connectionId: "shared",
          region: "region-one",
          nativeSizing: { cpu: 3 },
          opaque: ["preserve"],
        },
        futureProfileField: { preserve: true },
      },
      retained: { provider: "other-worker", settings: { opaque: "retain" } },
    },
    projectProfiles: {
      "github.com/fixture/app": "pending",
      "github.com/fixture/docs": "pending",
      "github.com/fixture/retained": "retained",
    },
    futureCloudField: "preserve",
  },
  plugins: {
    entries: {
      "third-party-worker": {
        enabled: true,
        config: {
          connections: {
            shared: {
              provider: "native-provider",
              label: "Shared connection",
              credentials: {
                apiToken: { source: "store", provider: "default", id: "FAKE_SHARED_KEY" },
              },
            },
          },
        },
      },
    },
  },
};
const featureMethods = ["plugins.list", "config.patch", "config.set", "config.schema"];
function responses(config = initialConfig, hash = "manual-1") {
  return {
    "plugins.list": { plugins: [], diagnostics: [], mutationAllowed: true },
    "config.get": configResponse(config, hash),
    "config.schema": {
      generatedAt: "2026-08-26T00:00:00.000Z",
      version: "fixture",
      uiHints: {},
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          cloudWorkers: {
            type: "object",
            additionalProperties: true,
            properties: {
              profiles: {
                type: "object",
                additionalProperties: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    },
  };
}

suite.define(() => {
  it("keeps profiles without setup descriptors visible and edits their complete source in Advanced", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods,
        methodResponses: responses(),
      });
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      const profile = page.locator(".settings-section", {
        has: page.getByRole("heading", { name: "pending", exact: true }),
      });
      await profile.getByText("Provider: third-party-worker", { exact: true }).waitFor();
      await profile.getByText("Suspend after 30m idle", { exact: true }).waitFor();
      await profile.getByRole("button", { name: "Edit", exact: true }).click();
      await page.waitForURL(
        (url) =>
          url.pathname.endsWith("/settings/advanced") &&
          url.searchParams.get("section") === "cloudWorkers",
      );
      await gateway.waitForRequest("config.schema");
      const raw = await revealRawConfig(page);
      await expect.poll(async () => JSON.parse(await raw.inputValue())).toEqual(initialConfig);
      const edited = structuredClone(initialConfig);
      edited.cloudWorkers.profiles.pending.provider = "replacement-worker";
      edited.cloudWorkers.profiles.pending.settings.region = "region-two";
      await raw.fill(JSON.stringify(edited, null, 2));
      await gateway.deferNext("config.set");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const request = await gateway.waitForRequest("config.set");
      expect(request.params).toMatchObject({ baseHash: "manual-1" });
      expect(requestRaw(request)).toEqual(edited);
      expect(requestRaw(request)).not.toHaveProperty(
        "cloudWorkers.profiles.pending.settings.class",
      );
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await gateway.setMethodResponse("config.get", configResponse(edited, "manual-2"));
      await gateway.resolveDeferred("config.set", { hash: "manual-2" });
      await expect
        .poll(() => page.getByRole("button", { name: "Save", exact: true }).isDisabled())
        .toBe(true);
      await expect.poll(async () => JSON.parse(await raw.inputValue())).toEqual(edited);
      await page.goBack();
      await profile.getByText("Provider: replacement-worker", { exact: true }).waitFor();
      await profile.getByRole("button", { name: "Remove profile", exact: true }).waitFor();
    });
  });

  it("removes a confirmed profile and its project defaults without touching shared connections or keys", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods,
        methodResponses: responses(),
      });
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      const profile = page.locator(".settings-section", {
        has: page.getByRole("heading", { name: "pending", exact: true }),
      });
      await profile.getByRole("button", { name: "Remove profile", exact: true }).click();
      let confirmation = await waitForConfirmModal(page);
      await expect
        .poll(() => confirmation.textContent())
        .toContain("saved connection and credentials are retained");
      await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await profile.getByRole("button", { name: "Remove profile", exact: true }).click();
      confirmation = await waitForConfirmModal(page);
      await gateway.deferNext("config.patch");
      await confirmation.getByRole("button", { name: "Remove profile", exact: true }).click();
      const request = await gateway.waitForRequest("config.patch");
      expect(request.params).toMatchObject({ baseHash: "manual-1" });
      expect(requestRaw(request)).toEqual({
        cloudWorkers: {
          profiles: { pending: null },
          projectProfiles: { "github.com/fixture/app": null, "github.com/fixture/docs": null },
        },
      });
      const saved = {
        ...initialConfig,
        cloudWorkers: {
          ...initialConfig.cloudWorkers,
          profiles: { retained: initialConfig.cloudWorkers.profiles.retained },
          projectProfiles: { "github.com/fixture/retained": "retained" },
        },
      };
      await gateway.setMethodResponse("config.get", configResponse(saved, "manual-2"));
      await gateway.resolveDeferred("config.patch", { ok: true, hash: "manual-2", config: saved });
      await expect.poll(() => profile.count()).toBe(0);
      await page.getByRole("heading", { name: "retained", exact: true }).waitFor();
      for (const method of [
        "secrets.store.delete",
        "secrets.store.set",
        "environments.destroy",
        "sessions.reclaim",
      ]) {
        expect(await gateway.getRequests(method)).toHaveLength(0);
      }
      await page.getByRole("button", { name: "Advanced", exact: true }).click();
      const raw = await revealRawConfig(page);
      await expect.poll(async () => JSON.parse(await raw.inputValue())).toEqual(saved);
    });
  });

  it.each(["reconnect", "source change", "scope loss"])(
    "rejects a pending removal after %s",
    async (change) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods,
          methodResponses: responses(),
        });
        await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
        const profile = page.locator(".settings-section", {
          has: page.getByRole("heading", { name: "pending", exact: true }),
        });
        await profile.getByRole("button", { name: "Remove profile", exact: true }).click();
        const confirmation = await waitForConfirmModal(page);
        const reads = (await gateway.getRequests("config.get")).length;
        if (change === "source change") {
          const replacement = structuredClone(initialConfig);
          replacement.cloudWorkers.profiles.pending.provider = "replacement-worker";
          await gateway.setMethodResponse(
            "config.get",
            configResponse(replacement, "manual-replaced"),
          );
          await gateway.emitGatewayEvent("config.changed", {
            hash: "manual-replaced",
            ts: Date.now(),
          });
          await profile.getByText("Provider: replacement-worker", { exact: true }).waitFor();
        } else {
          if (change === "scope loss") {
            await gateway.setOperatorScopes(["operator.read"]);
          }
          await gateway.closeLatest(1012, "Profile confirmation interrupted");
          await gateway.waitForRequest("config.get", { after: reads });
          await expect
            .poll(() =>
              profile.getByRole("button", { name: "Remove profile", exact: true }).isEnabled(),
            )
            .toBe(change !== "scope loss");
        }
        await confirmation.getByRole("button", { name: "Remove profile", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "The profile was not removed" }).waitFor();
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        await profile.waitFor();
      });
    },
  );

  it("shows existing profiles to read-only operators without granting removal", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read"],
        featureMethods,
        methodResponses: responses(),
      });
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page
        .getByText("Administrator access is required to manage cloud worker profiles.", {
          exact: true,
        })
        .waitFor();
      await page.getByRole("heading", { name: "pending", exact: true }).waitFor();
      expect(
        await page
          .getByRole("button", { name: "Remove profile", exact: true })
          .first()
          .isDisabled(),
      ).toBe(true);
      expect(
        await page.getByRole("button", { name: "Add cloud provider", exact: true }).count(),
      ).toBe(0);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    });
  });
});

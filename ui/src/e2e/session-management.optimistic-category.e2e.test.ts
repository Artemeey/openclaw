import path from "node:path";
import { expect, it } from "vitest";
import {
  activateSelfRemovingControl,
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  openSessionMenuSubmenu,
  sessionRow,
  sessionsListResponse,
  uiProofArtifactDir,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

const sessionKey = "agent:main:move-me";
const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
const featureMethods = [
  "chat.metadata",
  "chat.startup",
  "sessions.groups.list",
  "sessions.groups.put",
  "sessions.patch",
];

suite.define(() => {
  it("moves a session while its category patch is still in flight and rolls rejection back", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: uiProofArtifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const gateway = await installMockGateway(page, {
      featureMethods,
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow(sessionKey, "Move me", baseTime, { category: "Alpha" }),
        ]),
      },
      sessionGroups: ["Alpha", "Beta"],
      sessionKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const source = page.locator(
        `[data-session-section="category:Alpha"] [data-session-key="${sessionKey}"]`,
      );
      const target = page.locator(`[data-session-section="category:Beta"]`);
      const targetRow = target.locator(`[data-session-key="${sessionKey}"]`);
      await source.waitFor({ state: "visible" });
      await target.waitFor({ state: "visible" });
      await captureUiProof(page, "category-move-before.png");
      if (captureUiProofEnabled) {
        await page.waitForTimeout(500);
      }

      const patchCount = (await gateway.getRequests("sessions.patch")).length;
      const listCount = (await gateway.getRequests("sessions.list")).length;
      await gateway.deferNext("sessions.patch", { key: sessionKey, category: "Beta" });
      await source.dragTo(target);
      await gateway.waitForRequest("sessions.patch", { after: patchCount });

      await expect.poll(() => targetRow.count()).toBe(1);
      expect(await source.count()).toBe(0);
      expect(await gateway.getRequests("sessions.list")).toHaveLength(listCount);
      await captureUiProof(page, "category-move-pending.png");
      if (captureUiProofEnabled) {
        await page.waitForTimeout(750);
      }

      await gateway.rejectDeferred("sessions.patch", { message: "category storage unavailable" });

      await expect.poll(() => source.count()).toBe(1);
      expect(await targetRow.count()).toBe(0);
      await expect
        .poll(() => page.locator("[data-sidebar-session-error]").textContent())
        .toContain("category storage unavailable");
      await captureUiProof(page, "category-move-rollback.png");
      if (captureUiProofEnabled) {
        await page.waitForTimeout(500);
      }
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(path.join(uiProofArtifactDir, "category-move-rollback.webm"));
      }
    }
  });

  it("creates no catalog orphan when a new-group assignment is rejected", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods,
      methodResponses: {
        "sessions.list": sessionsListResponse([sessionRow(sessionKey, "Move me", baseTime)]),
      },
      sessionKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const source = page.locator(
        `[data-session-section="ungrouped"] [data-session-key="${sessionKey}"]`,
      );
      await source.waitFor({ state: "visible" });
      await gateway.deferNext("sessions.patch", { key: sessionKey, category: "Gamma" });
      await source.hover();
      await source.getByRole("button", { name: "Open session menu" }).click();
      await openSessionMenuSubmenu(page, "Move to group");
      await activateSelfRemovingControl(page.getByRole("menuitem", { name: "New group…" }));

      const patchCount = (await gateway.getRequests("sessions.patch")).length;
      const input = page.getByLabel("New group name");
      await input.fill("Gamma");
      await input.press("Enter");
      await gateway.waitForRequest("sessions.patch", { after: patchCount });
      const gamma = page.locator(`[data-session-section="category:Gamma"]`);

      await expect.poll(() => gamma.locator(`[data-session-key="${sessionKey}"]`).count()).toBe(1);
      expect(await gateway.getRequests("sessions.groups.put")).toHaveLength(0);
      await captureUiProof(page, "category-new-group-pending.png");

      await gateway.rejectDeferred("sessions.patch", { message: "new group move rejected" });

      await expect.poll(() => source.count()).toBe(1);
      await expect.poll(() => gamma.count()).toBe(0);
      expect(await gateway.getRequests("sessions.groups.put")).toHaveLength(0);
      await expect
        .poll(() => page.locator('openclaw-modal-dialog [role="alert"]').textContent())
        .toContain("new group move rejected");
      await captureUiProof(page, "category-new-group-rollback.png");
    } finally {
      await context.close();
    }
  });
});

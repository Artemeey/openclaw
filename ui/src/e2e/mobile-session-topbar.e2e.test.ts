import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const proofPhase = process.env.OPENCLAW_UI_PROOF_PHASE;
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "mobile-session-topbar");

const session = {
  key: "agent:main:session-a",
  kind: "direct" as const,
  label: "Coordinate the mobile session topbar redesign",
  spawnedCwd: "/repo/openclaw",
  createdActor: { type: "human" as const, id: "profile-ada", label: "Ada" },
  owner: {
    actor: { type: "human" as const, id: "profile-ada", label: "Ada" },
  },
  participants: [
    { identity: { type: "profile" as const, id: "profile-bob" }, label: "Bob" },
    { identity: { type: "agent" as const, id: "research" }, label: "Research" },
  ],
  participantCount: 2,
  updatedAt: 1,
};

const boardSnapshot = {
  sessionKey: session.key,
  revision: 1,
  tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
  widgets: [
    {
      name: "progress",
      tabId: "main",
      title: "Progress",
      contentKind: "html",
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "pending",
      revision: 1,
      frameUrl: "about:blank#progress",
    },
  ],
};

suite.define(() => {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const face of ["chat", "dashboard"] as const) {
      it(`keeps the mobile board topbar stable in ${colorScheme} ${face} mode`, async () => {
        const context = await suite.newBrowserContext({
          colorScheme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 390, height: 844 },
        });
        const page = await context.newPage();
        await installMockGateway(page, {
          sessionKey: session.key,
          presenceUsers: [
            { self: true, id: "profile-ada", name: "Ada" },
            { id: "profile-zoe", name: "Zoe", watchedSessions: [session.key] },
          ],
          featureMethods: ["board.get", "chat.metadata", "chat.startup"],
          methodResponses: {
            "sessions.list": chatSessionListResponse([session], {
              owners: [
                { type: "human", id: "profile-ada", label: "Ada" },
                { type: "human", id: "profile-zoe", label: "Zoe" },
              ],
            }),
            "board.get": boardSnapshot,
          },
        });

        try {
          await page.goto(`${suite.server.baseUrl}chat`);
          const header = page.locator(".chat-pane__header").first();
          await header.waitFor();
          const switcher = header.locator(".chat-pane__face-switch");
          await switcher.waitFor();
          if (face === "dashboard") {
            await switcher.locator('wa-radio[value="dashboard"]').click();
            await page.locator(".board-session-surface:not([hidden])").waitFor();
          }
          if (proofPhase) {
            await mkdir(proofDir, { recursive: true });
            await page.screenshot({
              animations: "disabled",
              path: path.join(proofDir, `${proofPhase}-${colorScheme}-${face}.png`),
            });
          }

          const geometry = await header.evaluate((element) => {
            const row = element.querySelector<HTMLElement>(".chat-pane__topbar-row");
            const people = element.querySelector<HTMLElement>(".chat-pane__people");
            const faceSwitch = element.querySelector<HTMLElement>(".chat-pane__face-switch");
            const rect = (node: HTMLElement | null) =>
              node?.getBoundingClientRect().toJSON() ?? null;
            return {
              header: rect(element),
              row: rect(row),
              people: rect(people),
              switcher: rect(faceSwitch),
            };
          });

          expect(geometry.row).not.toBeNull();
          expect(geometry.people).not.toBeNull();
          expect(geometry.row!.right).toBeLessThanOrEqual(geometry.header!.right + 0.1);
          expect(geometry.people!.right).toBeLessThanOrEqual(geometry.row!.right + 0.1);
          expect(geometry.switcher).not.toBeNull();
          expect(geometry.switcher!.top).toBeGreaterThanOrEqual(geometry.row!.bottom - 0.1);
          expect(geometry.switcher!.width).toBeLessThan(geometry.header!.width * 0.75);
          expect(
            await switcher
              .locator("wa-radio")
              .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("value"))),
          ).toEqual(["chat", "dashboard"]);
          expect(await switcher.locator(".board-fullscreen-button").count()).toBe(0);
          if (colorScheme === "light" && face === "chat") {
            await page.setViewportSize({ width: 1280, height: 800 });
            await switcher.locator('wa-radio[value="split"]').waitFor();
            expect(
              await header
                .locator(".chat-pane__actions")
                .evaluate((element) => getComputedStyle(element).marginLeft),
            ).toBe("0px");
          }
          if (face === "dashboard") {
            const [headerBox, boardBox] = await Promise.all([
              header.boundingBox(),
              page
                .locator(".board-session-surface:not([hidden]) openclaw-board-view")
                .boundingBox(),
            ]);
            expect(headerBox).not.toBeNull();
            expect(boardBox).not.toBeNull();
            expect(boardBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height + 11);
          }
        } finally {
          await suite.closeBrowserContext(context);
        }
      });
    }
  }
});

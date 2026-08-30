import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createPlaybackMediaFixture } from "../../../test/fixtures/media-playback.js";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([
    { name: "dollar-home", source: "~/media/report-voice.mp3", root: "/home/us$&r/media" },
    {
      name: "posix-literal-backslash",
      source: "/tmp/openclaw/..\\report.mp3",
      root: "/tmp/openclaw",
    },
    {
      name: "posix-dot-segments",
      source: "/tmp/staging/../openclaw/report # 100%?.mp3",
      root: "/tmp/openclaw",
    },
    {
      name: "windows-dot-segments",
      source: "C:/Temp/../Users/test/media/report # 100%?.mp3",
      root: "c:/users/test/media",
    },
  ])("previews structured local audio with $name", async ({ name, source, root }) => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const requestedMediaUrls: URL[] = [];

    await page.route("**/__openclaw__/assistant-media?**", async (route) => {
      const url = new URL(route.request().url());
      requestedMediaUrls.push(url);
      if (url.searchParams.get("meta") === "1") {
        expect(route.request().headers().authorization).toBe("Bearer e2e-device-token");
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            available: true,
            mediaTicket: "ticket-local-media",
            mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          }),
        });
        return;
      }
      await route.fulfill({
        contentType: "audio/mpeg",
        body: createPlaybackMediaFixture("mp3"),
      });
    });

    await installMockGateway(page, {
      localMediaPreviewRoots: [root],
      historyMessages: [
        {
          id: `assistant-${name}-audio`,
          role: "assistant",
          content: [
            { type: "text", text: "Your recording" },
            {
              type: "attachment",
              attachment: {
                kind: "audio",
                label: "report-voice.mp3",
                mimeType: "audio/mpeg",
                url: source,
              },
            },
          ],
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const attachment = page.locator("openclaw-chat-audio-player");
      await attachment.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() => requestedMediaUrls.length, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(2);
      expect(requestedMediaUrls[0]?.searchParams.get("meta")).toBe("1");
      expect(requestedMediaUrls[0]?.searchParams.get("source")).toBe(source);
      expect(
        requestedMediaUrls
          .slice(1)
          .some((url) => url.searchParams.get("mediaTicket") === "ticket-local-media"),
      ).toBe(true);
      const downloadHref = await attachment
        .locator(".chat-assistant-attachment-card__download")
        .getAttribute("href");
      expect(downloadHref).toBeTruthy();
      const downloadUrl = new URL(downloadHref ?? "", suite.server.baseUrl);
      expect(downloadUrl.searchParams.get("mediaTicket")).toBe("ticket-local-media");
      expect(downloadUrl.searchParams.get("source")).toBe(source);
      await expect
        .poll(() =>
          attachment
            .locator("audio")
            .evaluate((element) => (element as HTMLMediaElement).readyState),
        )
        .toBeGreaterThanOrEqual(1);
      expect(await page.getByText("Outside allowed folders").count()).toBe(0);
    } finally {
      if (artifactDir) {
        await mkdir(artifactDir, { recursive: true });
        await page.screenshot({ fullPage: true, path: path.join(artifactDir, `${name}.png`) });
      }
      await suite.closeBrowserContext(context);
    }
  });
});

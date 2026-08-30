// Control UI tests cover local media preview path policy.
import { describe, expect, it } from "vitest";
import { isLocalAttachmentPreviewAllowed } from "./chat-message-local-media.ts";

describe("isLocalAttachmentPreviewAllowed", () => {
  it.each([
    ["POSIX return inside", "/tmp/other/../media/report.png", "/tmp/media", true],
    ["POSIX escape", "/tmp/media/../other/report.png", "/tmp/media", false],
    ["POSIX literal backslash", "/tmp/media/..\\report.png", "/tmp/media", true],
    ["POSIX backslash directory", "/tmp/media\\one/report.png", "/tmp/media\\one", true],
    ["POSIX backslash is not a child separator", "/tmp/media\\one/report.png", "/tmp/media", false],
    ["root dot segments", "/tmp/media/report.png", "/tmp/other/../media", true],
    ["literal URL punctuation", "/tmp/media/report # 100%?.png", "/tmp/media", true],
    ["literal encoded dots", "/tmp/media/%2e%2e/report.png", "/tmp/media", true],
    [
      "file URL encoded literal dots",
      "file:///tmp/media/%252e%252e/report.png",
      "/tmp/media",
      true,
    ],
    ["file URL encoded slash", "file:///tmp/media/sub%2freport.png", "/tmp/media", false],
    ["file URL remote host", "file://remote/tmp/media/report.png", "/tmp/media", false],
    [
      "Windows return inside",
      "C:/Temp/../Users/test/media/report.png",
      "c:/users/test/media",
      true,
    ],
    [
      "Windows backslashes",
      "C:\\Temp\\..\\Users\\test\\media\\report.png",
      "c:/users/test/media",
      true,
    ],
    [
      "Windows file URL drive prefix",
      "/C:/Temp/../Users/test/media/report.png",
      "C:/Users/test/media",
      true,
    ],
    ["Windows drive floor", "C:/../../Users/test/media/report.png", "c:/users/test/media", true],
    ["different Windows drive", "D:/Users/test/media/report.png", "c:/users/test/media", false],
    ["UNC return inside", "//server/share/tmp/../media/report.png", "//server/share/media", true],
    ["UNC share floor", "//server/share/../../other/report.png", "//server/other", false],
    [
      "UNC file URL remains blocked",
      "file://server/share/media/report.png",
      "//server/share/media",
      false,
    ],
    ["filesystem root remains blocked", "/tmp/media/report.png", "/", false],
    ["POSIX case remains significant", "/tmp/Media/report.png", "/tmp/media", false],
  ] as const)("compares %s", (_name, source, root, allowed) => {
    expect(isLocalAttachmentPreviewAllowed(source, [root])).toBe(allowed);
  });

  it("keeps literal $ patterns in home when expanding tilde sources", () => {
    const roots = ["/home/us$&r/media"];
    expect(isLocalAttachmentPreviewAllowed("~/media/report.png", roots)).toBe(true);
    expect(isLocalAttachmentPreviewAllowed("~/elsewhere/report.png", roots)).toBe(false);
  });
});

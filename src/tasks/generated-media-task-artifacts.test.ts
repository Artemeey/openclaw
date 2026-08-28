import { describe, expect, it } from "vitest";
import {
  createGeneratedMediaTaskDetail,
  parseGeneratedMediaTaskDetail,
} from "./generated-media-task-artifacts.js";

describe("generated media task artifacts", () => {
  it("bounds and round-trips structured local and remote artifacts", () => {
    const detail = createGeneratedMediaTaskDetail({
      result: "generated",
      attachments: [
        { type: "image", path: "/tmp/image.png", mimeType: "image/png", sizeBytes: 42 },
        { type: "video", url: "https://example.test/video.mp4", name: "video.mp4" },
      ],
      mediaUrls: ["/tmp/image.png"],
    });

    expect(parseGeneratedMediaTaskDetail(detail)).toEqual(detail);
    expect(detail.artifacts).toHaveLength(2);
  });
});

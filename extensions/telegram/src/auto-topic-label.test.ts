// Telegram tests cover auto topic label plugin behavior.
import { describe, expect, it, vi } from "vitest";

const generateConversationLabel = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/reply-dispatch-runtime", () => ({
  generateConversationLabel,
}));

import { resolveAutoTopicLabelConfig } from "./auto-topic-label-config.js";
import { generateTelegramTopicEdit } from "./auto-topic-label.js";

const EXPECTED_DEFAULT_PROMPT =
  "Generate a concise topic name of at most 10 characters from the user's first message. No emoji. Use the same language as the message, in sentence case.";

describe("resolveAutoTopicLabelConfig", () => {
  it("keeps automatic topic edits off unless configured", () => {
    expect(resolveAutoTopicLabelConfig(undefined, undefined)).toBeNull();
    expect(resolveAutoTopicLabelConfig(true, undefined)).toEqual({
      enabled: true,
      prompt: EXPECTED_DEFAULT_PROMPT,
    });
  });

  it("prefers direct config over account config", () => {
    expect(resolveAutoTopicLabelConfig(false, true)).toBeNull();
    expect(
      resolveAutoTopicLabelConfig({ prompt: "DM prompt" }, { prompt: "Account prompt" }),
    ).toEqual({
      enabled: true,
      prompt: "DM prompt",
    });
  });

  it("falls back to default prompt for empty object prompt", () => {
    expect(resolveAutoTopicLabelConfig({ enabled: true, prompt: "  " }, undefined)).toEqual({
      enabled: true,
      prompt: EXPECTED_DEFAULT_PROMPT,
    });
  });
});

describe("generateTelegramTopicEdit", () => {
  it("caps the name and maps the model choice to a Telegram-provided icon", async () => {
    generateConversationLabel.mockResolvedValue("NAME: Invoices overdue\nICON: 2");

    await expect(
      generateTelegramTopicEdit({
        userMessage: "Need help with invoices",
        prompt: "prompt",
        cfg: {},
        agentId: "billing",
        iconOptions: [
          { emoji: "📎", customEmojiId: "allowed-1" },
          { emoji: "💳", customEmojiId: "allowed-2" },
        ],
      }),
    ).resolves.toEqual({ name: "Invoices o", iconCustomEmojiId: "allowed-2" });

    expect(generateConversationLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: "Need help with invoices",
        cfg: {},
        agentId: "billing",
        maxLength: 128,
      }),
    );
    const prompt = generateConversationLabel.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain("1: 📎\n2: 💳");
    expect(prompt).not.toContain("allowed-1");
    expect(prompt).not.toContain("allowed-2");
  });

  it("rejects an icon choice outside Telegram's allowed list", async () => {
    generateConversationLabel.mockResolvedValue("NAME: Billing\nICON: 3");

    await expect(
      generateTelegramTopicEdit({
        userMessage: "Need help with invoices",
        prompt: "prompt",
        cfg: {},
        iconOptions: [{ emoji: "💳", customEmojiId: "allowed-1" }],
      }),
    ).resolves.toBeNull();
  });
});

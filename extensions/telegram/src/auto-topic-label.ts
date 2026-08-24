// Telegram plugin module implements auto topic label behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { generateConversationLabel } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
export { resolveAutoTopicLabelConfig } from "./auto-topic-label-config.js";

const TELEGRAM_TOPIC_NAME_MAX_CHARS = 10;
const TELEGRAM_TOPIC_ICON_LIMIT = 64;

function buildTopicEditPrompt(
  prompt: string,
  iconOptions: ReadonlyArray<{ emoji?: string; customEmojiId: string }>,
): string {
  const choices = iconOptions
    .slice(0, TELEGRAM_TOPIC_ICON_LIMIT)
    .map((option, index) => {
      const emoji = truncateUtf16Safe(option.emoji?.replace(/\s+/g, " ").trim() || "icon", 8);
      return `${index + 1}: ${emoji}`;
    })
    .join("\n");
  return `${prompt}

Choose the most relevant Telegram topic icon from the numbered options below.
Return exactly two lines with no quotes or code fences:
NAME: <topic name, at most ${TELEGRAM_TOPIC_NAME_MAX_CHARS} characters>
ICON: <option number>

Allowed Telegram topic icons:
${choices}`;
}

function parseTopicEdit(
  value: string,
  iconOptions: ReadonlyArray<{ customEmojiId: string }>,
): { name: string; iconCustomEmojiId: string } | null {
  const lines = value.replace(/\r/g, "").split("\n");
  const nameValue = lines
    .find((line) => /^\s*NAME\s*:/i.test(line))
    ?.replace(/^\s*NAME\s*:\s*/i, "");
  const iconValue = lines
    .find((line) => /^\s*ICON\s*:/i.test(line))
    ?.replace(/^\s*ICON\s*:\s*/i, "");
  const name = truncateUtf16Safe(
    nameValue?.replace(/\s+/g, " ").trim() ?? "",
    TELEGRAM_TOPIC_NAME_MAX_CHARS,
  );
  const iconSelection = iconValue?.trim() ?? "";
  const iconIndex = /^\d+$/.test(iconSelection) ? Number(iconSelection) - 1 : -1;
  const icon = Number.isInteger(iconIndex) ? iconOptions[iconIndex] : undefined;
  return name && icon ? { name, iconCustomEmojiId: icon.customEmojiId } : null;
}

export async function generateTelegramTopicEdit(params: {
  userMessage: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  iconOptions: ReadonlyArray<{ emoji?: string; customEmojiId: string }>;
}): Promise<{ name: string; iconCustomEmojiId: string } | null> {
  const iconOptions = params.iconOptions.slice(0, TELEGRAM_TOPIC_ICON_LIMIT);
  if (iconOptions.length === 0) {
    return null;
  }
  const generated = await generateConversationLabel({
    userMessage: params.userMessage,
    prompt: buildTopicEditPrompt(params.prompt, iconOptions),
    cfg: params.cfg,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    maxLength: 128,
  });
  return generated ? parseTopicEdit(generated, iconOptions) : null;
}

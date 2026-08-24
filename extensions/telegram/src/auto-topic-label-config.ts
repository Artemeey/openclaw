// Telegram helper module supports auto topic label config behavior.
import type {
  TelegramAccountConfig,
  TelegramDirectConfig,
} from "openclaw/plugin-sdk/config-contracts";

const AUTO_TOPIC_LABEL_DEFAULT_PROMPT =
  "Generate a concise topic name of at most 10 characters from the user's first message. No emoji. Use the same language as the message, in sentence case.";

export function resolveAutoTopicLabelConfig(
  directConfig?: TelegramDirectConfig["autoTopicLabel"],
  accountConfig?: TelegramAccountConfig["autoTopicLabel"],
): { enabled: true; prompt: string } | null {
  const config = directConfig ?? accountConfig;
  if (config === undefined || config === false) {
    return null;
  }
  if (config === true) {
    return { enabled: true, prompt: AUTO_TOPIC_LABEL_DEFAULT_PROMPT };
  }
  if (config.enabled === false) {
    return null;
  }
  return {
    enabled: true,
    prompt: config.prompt?.trim() || AUTO_TOPIC_LABEL_DEFAULT_PROMPT,
  };
}

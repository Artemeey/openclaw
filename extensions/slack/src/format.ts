// Slack helper module supports format behavior.
import { eastAsianWidthType } from "get-east-asian-width";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import {
  chunkTextForOutbound,
  FormatCapabilityProfile,
  markdownToIR,
  type MarkdownIR,
  type MarkdownLinkSpan,
  renderMarkdownIRChunksWithinLimit,
  renderMarkdownWithMarkers,
} from "openclaw/plugin-sdk/text-chunking";

// Escape special characters for Slack mrkdwn format.
// Preserve Slack's angle-bracket tokens so mentions and links stay intact.
export function escapeSlackMrkdwnSegment(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SLACK_ANGLE_TOKEN_RE = /<[^>\n]+>/g;

function isAllowedSlackAngleToken(token: string): boolean {
  return (
    token.startsWith("<") &&
    token.endsWith(">") &&
    /^(?:[@#!]|mailto:|tel:|https?:\/\/|slack:\/\/)/u.test(token.slice(1, -1))
  );
}

function escapeSlackMrkdwnContent(text: string): string {
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text;
  }

  SLACK_ANGLE_TOKEN_RE.lastIndex = 0;
  const out: string[] = [];
  let lastIndex = 0;

  for (
    let match = SLACK_ANGLE_TOKEN_RE.exec(text);
    match;
    match = SLACK_ANGLE_TOKEN_RE.exec(text)
  ) {
    const matchIndex = match.index ?? 0;
    out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex, matchIndex)));
    const token = match[0] ?? "";
    out.push(isAllowedSlackAngleToken(token) ? token : escapeSlackMrkdwnSegment(token));
    lastIndex = matchIndex + token.length;
  }

  out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex)));
  return out.join("");
}

function escapeSlackMrkdwnText(text: string): string {
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text;
  }

  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("> ")) {
        return `> ${escapeSlackMrkdwnContent(line.slice(2))}`;
      }
      return escapeSlackMrkdwnContent(line);
    })
    .join("\n");
}

function buildSlackLink(link: MarkdownLinkSpan, text: string) {
  const href = link.href.trim();
  if (!href) {
    return null;
  }
  const label = text.slice(link.start, link.end);
  const trimmedLabel = label.trim();
  const comparableHref = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
  const useMarkup =
    trimmedLabel.length > 0 && trimmedLabel !== href && trimmedLabel !== comparableHref;
  if (!useMarkup) {
    return null;
  }
  const safeHref = escapeSlackMrkdwnSegment(href);
  return {
    start: link.start,
    end: link.end,
    open: `<${safeHref}|`,
    close: ">",
  };
}

export type SlackMarkdownOptions = {
  tableMode?: MarkdownTableMode;
};

const SLACK_MRKDWN_WORD_CHARACTER_RE = /[\p{L}\p{M}\p{N}_]/u;
const SLACK_MRKDWN_PUNCTUATION_RE = /\p{P}/u;
const SLACK_MRKDWN_SYMBOL_RE = /\p{S}/u;
const SLACK_MRKDWN_CJK_SCRIPT_RE =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]/u;
const SLACK_MRKDWN_EMOJI_PRESENTATION_RE = /\p{Emoji_Presentation}/u;

function getCodePointBefore(text: string, index: number): string {
  if (index <= 0) {
    return "";
  }
  const lastCodeUnit = text.charCodeAt(index - 1);
  if (lastCodeUnit >= 0xdc00 && lastCodeUnit <= 0xdfff && index > 1) {
    const previousCodeUnit = text.charCodeAt(index - 2);
    if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff) {
      return text.slice(index - 2, index);
    }
  }
  return text[index - 1] ?? "";
}

function getCodePointAt(text: string, index: number): string {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

function isSlackCjkPunctuation(character: string): boolean {
  if (!SLACK_MRKDWN_PUNCTUATION_RE.test(character)) {
    return false;
  }
  if (SLACK_MRKDWN_CJK_SCRIPT_RE.test(character)) {
    return true;
  }
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return false;
  }
  const width = eastAsianWidthType(codePoint);
  return (
    width === "fullwidth" ||
    width === "halfwidth" ||
    (width === "wide" && !SLACK_MRKDWN_EMOJI_PRESENTATION_RE.test(character))
  );
}

function isUnsafeSlackEmphasisBoundary(character: string): boolean {
  if (SLACK_MRKDWN_WORD_CHARACTER_RE.test(character)) {
    return true;
  }
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined || codePoint <= 0x7f) {
    return false;
  }
  return SLACK_MRKDWN_SYMBOL_RE.test(character) || isSlackCjkPunctuation(character);
}

function makeSlackEmphasisStylesSafe(ir: MarkdownIR): MarkdownIR {
  const styles = ir.styles.filter((span) => {
    if (span.style !== "italic" && span.style !== "bold") {
      return true;
    }
    // Slack's parser can expose markers accepted by the CJK-friendly Markdown parser.
    // Drop only the affected style so transport syntax never leaks into visible text.
    return (
      !isUnsafeSlackEmphasisBoundary(getCodePointBefore(ir.text, span.start)) &&
      !isUnsafeSlackEmphasisBoundary(getCodePointAt(ir.text, span.end))
    );
  });
  return styles.length === ir.styles.length ? ir : { ...ir, styles };
}

const SLACK_FORMAT_PROFILE = FormatCapabilityProfile.define({
  mechanism: "markdown",
  constructs: {
    underline: "strip",
    spoiler: "fallback",
    codeLanguage: "fallback",
    heading: "fallback",
    bulletList: "fallback",
    orderedList: "fallback",
    taskList: "fallback",
    table: "fallback",
    image: "fallback",
  },
  chunk: { limit: 4000, unit: "chars", hardCap: 40_000 },
});

type SlackCodeMarker = "`" | "```";
const SLACK_ASSISTANT_TRANSCRIPT_PREFIX = "`Assistant:` ";

function tokenizeSlackMrkdwn(text: string): string[] {
  const tokens: string[] = [];
  for (let index = 0; index < text.length;) {
    if (text.startsWith("```", index)) {
      tokens.push("```");
      index += 3;
      continue;
    }
    const entity = ["&amp;", "&lt;", "&gt;"].find((candidate) => text.startsWith(candidate, index));
    if (entity) {
      tokens.push(entity);
      index += entity.length;
      continue;
    }
    if (text[index] === "<") {
      const end = text.indexOf(">", index + 1);
      const angleToken = end >= 0 ? text.slice(index, end + 1) : undefined;
      if (angleToken && !angleToken.includes("\n") && isAllowedSlackAngleToken(angleToken)) {
        tokens.push(angleToken);
        index += angleToken.length;
        continue;
      }
    }
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    index += character.length;
    if (character === "\\" && index < text.length) {
      const escapedCodePoint = text.codePointAt(index);
      if (escapedCodePoint !== undefined) {
        const escapedCharacter = String.fromCodePoint(escapedCodePoint);
        tokens.push(character + escapedCharacter);
        index += escapedCharacter.length;
        continue;
      }
    }
    tokens.push(character);
  }
  return tokens;
}

function resolveSlackCodeMarkerTransition(
  active: SlackCodeMarker | undefined,
  token: string,
): SlackCodeMarker | undefined | null {
  if (token === "```" && active !== "`") {
    return active === "```" ? undefined : "```";
  }
  if (token === "`" && active !== "```") {
    return active === "`" ? undefined : "`";
  }
  return null;
}

function scanSlackMrkdwn(text: string) {
  // Unmatched literal delimiters do not form spans; paired markers protect their entire content.
  const tokens = tokenizeSlackMrkdwn(text).map((token) => ({ text: token, marker: false }));
  const ranges: Array<[number, number]> = [];
  const opened = new Map<string, { offset: number; token: (typeof tokens)[number] }>();
  let activeCode: SlackCodeMarker | undefined;
  let offset = 0;
  for (const token of tokens) {
    const transition = resolveSlackCodeMarkerTransition(activeCode, token.text);
    const marker = transition !== null || (!activeCode && ["*", "_", "~"].includes(token.text));
    if (transition !== null) {
      activeCode = transition;
      token.marker = true;
    }
    if (marker) {
      const before = getCodePointBefore(text, offset);
      const after = getCodePointAt(text, offset + token.text.length);
      const wordBounded = token.text === "*" || token.text === "_";
      const eligible = (inside: string, outside: string) =>
        transition !== null ||
        (inside.length > 0 &&
          !/\s/u.test(inside) &&
          (!wordBounded || !isUnsafeSlackEmphasisBoundary(outside)));
      const start = opened.get(token.text);
      if (start && eligible(before, after)) {
        ranges.push([start.offset, offset + token.text.length]);
        start.token.marker = token.marker = true;
        opened.delete(token.text);
      } else if (eligible(after, before)) {
        // A literal delimiter must not consume the opener of a later real span.
        opened.set(token.text, { offset, token });
      }
    }
    if (token.text.length > 1) {
      ranges.push([offset, offset + token.text.length]);
    }
    offset += token.text.length;
  }
  return { tokens, ranges };
}

/** Native fields may separate only outside complete formatting spans or atomic tokens. */
export function slackMrkdwnTextBoundary(text: string): (offset: number) => boolean {
  const { ranges } = scanSlackMrkdwn(text);
  return (boundary) => !ranges.some(([start, end]) => start < boundary && boundary < end);
}

type SlackVisibleProjection = {
  text: string;
  excludedRanges: Array<{ start: number; end: number }>;
};

function maskSlackExcludedText(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line.trim() ? `x${" ".repeat(Math.max(0, line.length - 1))}` : " ".repeat(line.length),
    )
    .join("\n");
}

function maskSlackExcludedRanges(projection: SlackVisibleProjection): string {
  let masked = "";
  let cursor = 0;
  for (const range of projection.excludedRanges) {
    masked += projection.text.slice(cursor, range.start);
    masked += maskSlackExcludedText(projection.text.slice(range.start, range.end));
    cursor = range.end;
  }
  return masked + projection.text.slice(cursor);
}

function slackProjectionHasRoleHeader(projection: SlackVisibleProjection): boolean {
  return Boolean(
    markdownToIR(maskSlackExcludedRanges(projection), {
      assistantTranscriptRoleHeaders: true,
      autolink: false,
      blockquotePrefix: "",
      headingStyle: "none",
      linkify: false,
      tableMode: "off",
    }).annotations?.some((annotation) => annotation.type === "assistant_transcript_role"),
  );
}

function decodeSlackMrkdwnEntities(text: string): string {
  return text.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

type SlackDateDisplay = "fallback" | "token";

function projectSlackAngleToken(token: string, dateDisplay: SlackDateDisplay): string {
  const inner = token.slice(1, -1);
  if (inner.startsWith("!date^")) {
    const fallbackSeparator = inner.indexOf("|");
    const dateControl = fallbackSeparator === -1 ? inner : inner.slice(0, fallbackSeparator);
    const tokenString = dateControl.split("^")[2] ?? "";
    const fallback = fallbackSeparator === -1 ? "" : inner.slice(fallbackSeparator + 1);
    // Modern clients render tokenString; older clients render fallback.
    return decodeSlackMrkdwnEntities(
      dateDisplay === "fallback" ? fallback || tokenString : tokenString || fallback,
    );
  }
  const labelSeparator = inner.indexOf("|");
  if (labelSeparator >= 0) {
    return decodeSlackMrkdwnEntities(inner.slice(labelSeparator + 1));
  }
  if (inner.startsWith("@")) {
    return "@";
  }
  if (inner.startsWith("#")) {
    return "#";
  }
  if (inner.startsWith("!")) {
    return "!";
  }
  return decodeSlackMrkdwnEntities(inner);
}

function appendSlackVisibleProjection(
  projection: SlackVisibleProjection,
  visible: string,
  excluded: boolean,
): void {
  if (!visible) {
    return;
  }
  const start = projection.text.length;
  projection.text += visible;
  if (!excluded) {
    return;
  }
  const previous = projection.excludedRanges.at(-1);
  if (previous?.end === start) {
    previous.end = projection.text.length;
  } else {
    projection.excludedRanges.push({ start, end: projection.text.length });
  }
}

function projectSlackMrkdwnVisibleText(
  text: string,
  dateDisplay: SlackDateDisplay,
): SlackVisibleProjection {
  const projection: SlackVisibleProjection = { text: "", excludedRanges: [] };
  let activeMarker: SlackCodeMarker | undefined;
  let lineHasVisibleContent = false;

  for (const token of tokenizeSlackMrkdwn(text)) {
    const transition = resolveSlackCodeMarkerTransition(activeMarker, token);
    if (transition !== null) {
      activeMarker = transition;
      continue;
    }

    let visible = token;
    if (isAllowedSlackAngleToken(token)) {
      visible = activeMarker ? token : projectSlackAngleToken(token, dateDisplay);
    } else if (token === "&amp;" || token === "&lt;" || token === "&gt;") {
      visible = decodeSlackMrkdwnEntities(token);
    } else if (!activeMarker && (token === "*" || token === "_" || token === "~")) {
      visible = "";
    } else if (!activeMarker && token === ">" && !lineHasVisibleContent) {
      visible = "";
    } else if (token.startsWith("\\") && token.length > 1) {
      visible = token.slice(1);
    }

    appendSlackVisibleProjection(projection, visible, activeMarker !== undefined);
    for (const character of visible) {
      if (character === "\n") {
        lineHasVisibleContent = false;
      } else if (character !== " " && character !== "\t" && character !== "\r") {
        lineHasVisibleContent = true;
      }
    }
  }
  return projection;
}

function protectSlackAssistantTranscriptRoleHeaders(text: string): string {
  if (text.startsWith(SLACK_ASSISTANT_TRANSCRIPT_PREFIX)) {
    return text;
  }
  const tokenProjection = projectSlackMrkdwnVisibleText(text, "token");
  const fallbackProjection = projectSlackMrkdwnVisibleText(text, "fallback");
  if (
    !slackProjectionHasRoleHeader(tokenProjection) &&
    !slackProjectionHasRoleHeader(fallbackProjection)
  ) {
    return text;
  }
  // Target-native mrkdwn can reveal a header only after the Markdown parser ran.
  return `${SLACK_ASSISTANT_TRANSCRIPT_PREFIX}${text}`;
}

export const SLACK_RENDER_OPTIONS = {
  annotationMarkers: {
    assistant_transcript_role: {
      open: "`",
      close: "`",
      suppressNestedFormatting: true,
    },
  },
  styleMarkers: {
    bold: { open: "*", close: "*" },
    italic: { open: "_", close: "_" },
    strikethrough: { open: "~", close: "~" },
    code: { open: "`", close: "`" },
    code_block: { open: "```\n", close: "```" },
  },
  escapeText: escapeSlackMrkdwnText,
  buildLink: buildSlackLink,
};
function parseSlackMarkdown(markdown: string, options: SlackMarkdownOptions): MarkdownIR {
  return makeSlackEmphasisStylesSafe(
    markdownToIR(markdown ?? "", {
      assistantTranscriptRoleHeaders: true,
      linkify: false,
      autolink: false,
      headingStyle: "rich",
      blockquotePrefix: "> ",
      tableMode: options.tableMode,
    }),
  );
}

export function normalizeSlackOutboundText(
  markdown: string,
  options: SlackMarkdownOptions = {},
): string {
  const ir = parseSlackMarkdown(markdown, options);
  return protectSlackAssistantTranscriptRoleHeaders(
    renderMarkdownWithMarkers(ir, SLACK_RENDER_OPTIONS, SLACK_FORMAT_PROFILE),
  );
}

/** Chunk rendered Slack text with the same marker/atomic-token facts used for placement. */
export function chunkSlackMrkdwnText(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }
  const { tokens } = scanSlackMrkdwn(text);
  if (!tokens.some((token) => token.marker || token.text.length > 1)) {
    return chunkTextForOutbound(text, limit, { preserveWhitespace: true });
  }

  const chunks: string[] = [];
  const opened = new Map<string, boolean>();
  let active: string[] = [];
  let content = "";
  const close = () => active.toReversed().join("");
  const flush = () => {
    if (content && content !== active.join("")) {
      chunks.push(content + close());
    }
    content = "";
  };

  for (const { text: token, marker } of tokens) {
    let next = active;
    const closing = marker && opened.has(token);
    if (marker) {
      const enabled = closing
        ? opened.get(token)
        : (active.join("").length + token.length) * 2 < limit;
      if (closing) {
        opened.delete(token);
      } else {
        opened.set(token, Boolean(enabled));
      }
      if (!enabled) {
        continue;
      }
      next = closing ? active.filter((value) => value !== token) : [...active, token];
    }
    const nextOverhead = next.join("").length;
    if (content && content.length + token.length + nextOverhead > limit) {
      flush();
    }
    const prefix = active.join("");
    active = next;
    if (!content && closing) {
      continue;
    }
    const contentLimit = limit - prefix.length - nextOverhead;
    if (token.length > contentLimit) {
      flush();
      const inCode = opened.has("`") || opened.has("```");
      if (inCode && isAllowedSlackAngleToken(token)) {
        const value = active.length ? token : escapeSlackMrkdwnSegment(token);
        chunks.push(
          ...chunkTextForOutbound(value, Math.max(1, Math.floor(contentLimit)), {
            preserveWhitespace: true,
          }).map((fragment) => prefix + fragment + close()),
        );
      } else {
        chunks.push(...(token.length <= limit ? [token] : chunkTextForOutbound(token, limit)));
      }
      continue;
    }
    content ||= prefix;
    content += token;
  }
  flush();
  return chunks;
}

export function markdownToSlackMrkdwnChunks(
  markdown: string,
  limit: number,
  options: SlackMarkdownOptions = {},
): string[] {
  const ir = parseSlackMarkdown(markdown, options);
  return renderMarkdownIRChunksWithinLimit({
    ir,
    limit,
    renderChunk: (chunk) =>
      protectSlackAssistantTranscriptRoleHeaders(
        renderMarkdownWithMarkers(chunk, SLACK_RENDER_OPTIONS, SLACK_FORMAT_PROFILE),
      ),
    measureRendered: (rendered) => rendered.length,
  }).map(({ rendered }) => rendered);
}

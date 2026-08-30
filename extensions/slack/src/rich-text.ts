import {
  asNonArrayRecord,
  asOptionalRecord,
  normalizeOptionalString,
  readNonBlankString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  renderMarkdownWithMarkers,
  type MarkdownIR,
  type MarkdownStyle,
} from "openclaw/plugin-sdk/text-chunking";
import { escapeSlackMrkdwnSegment, SLACK_RENDER_OPTIONS } from "./format.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";

const styledRenderOptions = { ...SLACK_RENDER_OPTIONS, escapeText: (text: string) => text };

type RichTextOptions = { format: "plain" | "escaped" | "styled"; preserveReferences?: boolean };
const styles: Record<string, MarkdownStyle> = {
  bold: "bold",
  italic: "italic",
  strike: "strikethrough",
  code: "code",
};

const references: Record<string, readonly [string, string]> = {
  user: ["user_id", "@"],
  channel: ["channel_id", "#"],
  usergroup: ["usergroup_id", "!subteam^"],
  broadcast: ["range", "!"],
};

function appendRichText(target: MarkdownIR, value: MarkdownIR, separator = "") {
  if (!value.text) {
    return;
  }
  if (target.text) {
    target.text += separator;
  }
  const offset = target.text.length;
  target.text += value.text;
  for (const span of value.styles) {
    const previous = target.styles.findLast((candidate) => candidate.style === span.style);
    if (previous?.end === offset + span.start) {
      previous.end = offset + span.end;
    } else {
      target.styles.push({ ...span, start: span.start + offset, end: span.end + offset });
    }
  }
}

function projectRichText(
  value: unknown,
  options: RichTextOptions,
  preformatted = false,
): MarkdownIR | undefined {
  const element = asNonArrayRecord(value);
  const type = element.type;
  const styled = options.format === "styled";
  const read = options.format === "plain" ? readNonBlankString : normalizeOptionalString;
  const result: MarkdownIR = { text: "", styles: [], links: [] };
  const style = asOptionalRecord(element.style);
  const styleNames =
    styled && !preformatted
      ? Object.keys(style ?? {}).filter((name) => style?.[name] === true)
      : [];
  const supportedStyles = Object.entries(styles).filter(([name]) => styleNames.includes(name));
  const code = styled && (preformatted || styleNames.includes("code"));
  // Native layout, generated dates and unrepresentable styles remain barriers, not flattened facts.
  if (
    styled &&
    ((!["rich_text_section", "rich_text_preformatted", "text", "link", "emoji"].includes(
      String(type),
    ) &&
      !references[String(type)]) ||
      supportedStyles.length !== styleNames.length ||
      (styleNames.includes("code") && styleNames.length > 1) ||
      (!preformatted && code && typeof element.text === "string" && element.text.includes("`")))
  ) {
    return undefined;
  }
  if (
    Array.isArray(element.elements) &&
    (options.format === "plain" ||
      ["rich_text_section", "rich_text_list", "rich_text_quote", "rich_text_preformatted"].includes(
        String(type),
      ))
  ) {
    for (const child of element.elements) {
      const part = projectRichText(
        child,
        options,
        preformatted || type === "rich_text_preformatted",
      );
      if (!part) {
        return undefined;
      }
      appendRichText(result, part, type === "rich_text_list" ? "\n" : "");
    }
    if (styled && type === "rich_text_preformatted") {
      if (result.text.includes("```")) {
        return undefined;
      }
      result.styles = [{ start: 0, end: result.text.length, style: "code_block" }];
    }
    return result;
  }

  const literal =
    options.format === "plain"
      ? (text: string) => text
      : code
        ? escapeSlackMrkdwnSegment
        : escapeSlackMrkdwn;
  const reference =
    options.format === "plain" || styled || options.preserveReferences
      ? (text: string) => text
      : escapeSlackMrkdwn;
  const label = read(element.text);
  if (type === "text" && typeof element.text === "string") {
    result.text = literal(element.text);
  } else if (options.format === "plain" && label) {
    result.text = label;
  } else if (type === "link") {
    const url = read(element.url);
    result.text =
      styled && !preformatted && url
        ? `<${escapeSlackMrkdwnSegment(url)}${label && label !== url ? `|${escapeSlackMrkdwnSegment(label)}` : ""}>`
        : literal(label ?? url ?? "");
  } else if (type === "emoji") {
    const name = read(element.name);
    result.text = name ? `:${name}:` : "";
  } else if (type === "date") {
    result.text = literal(read(element.fallback) ?? "");
  } else {
    const [field, prefix] = references[String(type)] ?? [];
    const id = field ? read(element[field]) : undefined;
    result.text = id ? reference(`<${prefix}${id}>`) : "";
  }
  result.styles = supportedStyles.map(([, kind]) => ({
    start: 0,
    end: result.text.length,
    style: kind,
  }));
  return result;
}

/** One native traversal supplies table text, escaped accessibility, and styled comparison views. */
export function renderSlackRichTextFragments(
  value: unknown,
  options: RichTextOptions,
): (string | null)[] {
  return (Array.isArray(value) ? value : []).flatMap((element) => {
    const ir = projectRichText(element, options);
    if (!ir) {
      return [null];
    }
    const rendered =
      options.format === "styled" ? renderMarkdownWithMarkers(ir, styledRenderOptions) : ir.text;
    return rendered ? [rendered] : [];
  });
}

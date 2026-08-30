import type { LegacyInteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export type SlackAuthoredTextPlacement = "none" | "blocks" | "outside-blocks";

// Project producer plans the same way so trimmed chunk seams cannot duplicate authored text.
function normalizeSlackAuthoredTextFragments(fragments: readonly string[]): string[] {
  return fragments.map((fragment) => fragment.trim()).filter(Boolean);
}

function isSlackAuthoredTextRepresentedInFragments(
  text: string,
  rawFragments: readonly string[],
  authoredChunkPlans: readonly (readonly string[])[] = [],
): boolean {
  const fragments = normalizeSlackAuthoredTextFragments(rawFragments);
  for (const rawPlan of authoredChunkPlans) {
    const plan = normalizeSlackAuthoredTextFragments(rawPlan);
    if (
      plan.length > 0 &&
      fragments.some((_, start) =>
        plan.every((fragment, index) => fragment === fragments[start + index]),
      )
    ) {
      return true;
    }
  }
  // Legacy inline controls may split authored whitespace at fragment boundaries.
  // Consume only those separators; code/literal interiors and chunk seams stay exact.
  for (let start = 0; start < fragments.length; start += 1) {
    let remaining = text;
    for (const fragment of fragments.slice(start)) {
      if (!remaining.startsWith(fragment)) {
        break;
      }
      remaining = remaining.slice(fragment.length);
      if (!remaining) {
        return true;
      }
      if (!/^\s/u.test(remaining)) {
        break;
      }
      remaining = remaining.trimStart();
    }
  }
  return false;
}

/** Resolve placement from producer facts, before accessibility text changes the payload text. */
export function resolveSlackAuthoredTextPlacement(params: {
  text?: string;
  interactive?: LegacyInteractiveReply;
  renderedInBlocks?: boolean;
  renderedTextFragments?: readonly string[];
  authoredChunkPlans?: readonly (readonly string[])[];
}): SlackAuthoredTextPlacement {
  const text = normalizeOptionalString(params.text);
  if (!text) {
    return "none";
  }
  // Rendered facts own placement; raw legacy text is only a pre-render metadata source.
  const fragments =
    params.renderedTextFragments ??
    params.interactive?.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])) ??
    [];
  const isRepresentedInBlocks =
    params.renderedInBlocks ||
    isSlackAuthoredTextRepresentedInFragments(text, fragments, params.authoredChunkPlans);
  return isRepresentedInBlocks ? "blocks" : "outside-blocks";
}

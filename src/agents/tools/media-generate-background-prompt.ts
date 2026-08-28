export function buildMediaGenerationReplyInstruction(params: {
  status: "ok" | "error";
  completionLabel: string;
}) {
  if (params.status === "ok") {
    return [
      `The ${params.completionLabel} is ready for the original chat.`,
      "Follow the current visible-reply contract with a short user-facing caption and every structured generated attachment from this event.",
      "Keep internal task/session details private and do not copy the internal event text verbatim.",
    ].join(" ");
  }
  return [
    `${params.completionLabel[0]?.toUpperCase() ?? "T"}${params.completionLabel.slice(1)} generation task failed for the original chat.`,
    "Follow the current visible-reply contract with a concise user-facing failure message.",
    "Keep internal task/session details private and do not copy the internal event text verbatim.",
  ].join(" ");
}

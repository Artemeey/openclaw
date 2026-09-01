import { describe, expect, it } from "vitest";
import { transformHistoricalTranscriptEventJson } from "./state-migrations.transcript-directives-transform.js";

describe("transformHistoricalTranscriptEventJson", () => {
  it.each([
    { event: 1, name: "scalar", raw: "1" },
    { event: "text", name: "string", raw: '"text"' },
    {
      event: { type: "custom", value: 1 },
      name: "ordinary object",
      raw: '{"type":"custom","value":1}',
    },
  ])("leaves $name JSON unchanged", ({ event, raw }) => {
    expect(transformHistoricalTranscriptEventJson(raw, "owner")).toEqual({
      changed: false,
      event,
    });
  });

  it("preserves the parse owner and SyntaxError cause", () => {
    expect(() => transformHistoricalTranscriptEventJson("{", "session:4")).toThrow(
      expect.objectContaining({
        cause: expect.any(SyntaxError),
        message: "session:4 contains invalid transcript JSON",
      }),
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  buildCommandTextFromArgs,
  parseCommandInvocation,
  resolveCommandArgChoicesInScope,
} from "./commands-invocation.js";
import { defineChatCommand } from "./commands-registry.shared.js";

describe("canonical command invocation", () => {
  it("round-trips positional values through the canonical formatter", () => {
    const command = defineChatCommand({
      key: "release",
      textAlias: "/release",
      description: "Release a build.",
      args: [
        { name: "channel", description: "Channel", type: "string", required: true },
        {
          name: "notes",
          description: "Notes",
          type: "string",
          captureRemaining: true,
        },
      ],
    });
    const invocation = parseCommandInvocation(command, "/release beta first stable build");

    expect(invocation?.args?.values).toEqual({
      channel: "beta",
      notes: "first stable build",
    });
    expect(
      buildCommandTextFromArgs(command, {
        values: { channel: "beta", notes: "first stable build" },
      }),
    ).toBe("/release beta first stable build");
  });

  it("preserves raw tails byte-for-byte when the command owns its grammar", () => {
    const command = defineChatCommand({
      key: "configure",
      textAlias: "/configure",
      description: "Configure a value.",
      acceptsArgs: true,
      argsParsing: "none",
    });
    const text = "/configure   set path='two words'  ";
    const invocation = parseCommandInvocation(command, text);

    expect(invocation?.rawTail).toBe("   set path='two words'  ");
    expect(invocation?.text).toBe(text);
  });

  it("resolves dynamic choices only from the explicit owner scope", () => {
    const command = defineChatCommand({
      key: "deploy",
      textAlias: "/deploy",
      description: "Deploy.",
      args: [
        {
          name: "target",
          description: "Target",
          type: "string",
          choices: ({ model }) => [model ?? "default"],
        },
      ],
    });
    const arg = command.args?.[0];
    if (!arg) {
      throw new Error("expected target argument");
    }

    expect(resolveCommandArgChoicesInScope({ command, arg, scope: { model: "canary" } })).toEqual([
      { value: "canary", label: "canary" },
    ]);
  });
});

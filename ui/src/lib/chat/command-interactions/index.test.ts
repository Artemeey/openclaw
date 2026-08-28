import { describe, expect, it } from "vitest";
import { parseCommandInvocation } from "../../../../../src/auto-reply/commands-invocation.js";
import { defineChatCommand } from "../../../../../src/auto-reply/commands-registry.shared.js";
import type { SlashCommandDef } from "../commands.ts";
import {
  resolveCommandActivation,
  type CommandActivationContext,
  type ControlUiCommandInteractionProvider,
} from "./index.ts";

function createCommand(
  source: SlashCommandDef["source"],
  options: { local?: boolean; collect?: boolean } = {},
): SlashCommandDef {
  const definition = defineChatCommand({
    key: "deploy",
    textAlias: "/deploy",
    description: "Deploy.",
    args: [
      {
        name: "target",
        description: "Target",
        type: "string",
        required: true,
        choices: ["staging", "production"],
      },
    ],
    argsParsing: source === "native" ? undefined : "none",
  });
  return {
    key: "deploy",
    name: "deploy",
    aliases: ["ship"],
    description: "Deploy.",
    args: "<target>",
    source,
    executeLocal: options.local,
    definition,
    interaction: options.collect
      ? { kind: "collect-arguments" }
      : options.local
        ? { kind: "execute-action", action: { kind: "run-local-command" } }
        : undefined,
  };
}

function createContext(
  command: SlashCommandDef,
  options: Partial<Pick<CommandActivationContext, "source" | "trigger">> = {},
): CommandActivationContext {
  const invocation = parseCommandInvocation(command.definition!, "/deploy");
  if (!invocation) {
    throw new Error("expected invocation");
  }
  return {
    source: options.source ?? "sheet",
    trigger: options.trigger ?? "enter",
    command,
    invocation,
    resolveChoices: () => [
      { value: "staging", label: "Staging" },
      { value: "production", label: "Production" },
    ],
    placement: "standalone",
    goalStartAvailable: false,
  };
}

describe("command activation planning", () => {
  it.each(["native", "plugin", "skill"] as const)(
    "keeps %s commands textual without an explicit provider",
    (source) => {
      const context = createContext(createCommand(source));

      expect(resolveCommandActivation(context)).toMatchObject({
        kind: "insert-text",
        tailOwnership: source === "native" ? "canonical" : "raw",
      });
    },
  );

  it("does not execute a built-in merely because it declares arguments", () => {
    const command = createCommand("native");
    command.executeLocal = true;
    const context = createContext(command);

    expect(resolveCommandActivation(context).kind).toBe("insert-text");
  });

  it("collects arguments only for an explicit in-process opt-in", () => {
    const context = createContext(createCommand("native", { collect: true }));

    expect(resolveCommandActivation(context)).toMatchObject({
      kind: "collect-arguments",
      plan: { args: [{ name: "target", required: true }] },
    });
  });

  it("gives typed aliases and sheet selection the same provider input", () => {
    const command = createCommand("native");
    const seen: CommandActivationContext[] = [];
    const provider: ControlUiCommandInteractionProvider = {
      id: "capture",
      resolve(context) {
        seen.push(context);
        return null;
      },
    };

    resolveCommandActivation(createContext(command, { source: "typed" }), [provider]);
    resolveCommandActivation(createContext(command, { source: "sheet" }), [provider]);

    expect(
      seen.map(({ command: entry, invocation }) => [entry.key, invocation.commandKey]),
    ).toEqual([
      ["deploy", "deploy"],
      ["deploy", "deploy"],
    ]);
  });

  it("never lets Tab execute an activation provider", () => {
    const provider: ControlUiCommandInteractionProvider = {
      id: "execute",
      resolve: () => ({
        kind: "execute-action",
        action: { kind: "run-local-command", commandKey: "deploy" },
        confirmation: "none",
      }),
    };

    expect(
      resolveCommandActivation(createContext(createCommand("native"), { trigger: "tab" }), [
        provider,
      ]).kind,
    ).toBe("insert-text");
  });

  it.each([
    { name: "typed", source: "typed" as const },
    { name: "sheet", source: "sheet" as const },
  ])("activates Goal mode from a bare $name command", ({ source }) => {
    const command = createCommand("native");
    command.key = "goal";
    command.name = "goal";
    command.definition = defineChatCommand({
      key: "goal",
      textAlias: "/goal",
      description: "Goal",
    });
    const context = createContext(command, { source });
    context.invocation = parseCommandInvocation(command.definition, "/goal")!;
    context.goalStartAvailable = true;

    expect(resolveCommandActivation(context)).toEqual({
      kind: "activate-composer-mode",
      mode: { kind: "goal" },
    });
  });

  it("opens management for an existing Goal and keeps unsupported or inline use textual", () => {
    const command = createCommand("native");
    command.key = "goal";
    command.name = "goal";
    command.definition = defineChatCommand({
      key: "goal",
      textAlias: "/goal",
      description: "Goal",
    });
    const context = createContext(command);
    context.invocation = parseCommandInvocation(command.definition, "/goal")!;
    context.goal = { id: "goal-1" };

    expect(resolveCommandActivation(context)).toEqual({
      kind: "open-surface",
      surface: "goal-management",
      focus: "goal-1",
    });
    context.goal = undefined;
    expect(resolveCommandActivation(context).kind).toBe("insert-text");
    context.goalStartAvailable = true;
    context.placement = "inline";
    expect(resolveCommandActivation(context).kind).toBe("insert-text");
  });
});

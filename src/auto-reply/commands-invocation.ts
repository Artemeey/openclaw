/** Browser-safe parsing and serialization for canonical command invocations. */
import { expectDefined } from "@openclaw/normalization-core";
import type {
  ChatCommandDefinition,
  CommandArgChoiceContext,
  CommandArgDefinition,
  CommandArgValues,
  CommandArgs,
} from "./commands-registry.types.js";

export type CommandArgChoiceScope = Omit<CommandArgChoiceContext, "command" | "arg">;
export type ResolvedCommandArgChoice = { value: string; label: string };

export type CanonicalCommandInvocation = {
  commandKey: string;
  invokedName: string;
  rawTail: string;
  args?: CommandArgs;
  text: string;
  isExactBare: boolean;
};

/** Formats a command and optional raw argument string as slash-command text. */
export function buildCommandText(commandName: string, args?: string): string {
  const trimmedArgs = args?.trim();
  return trimmedArgs ? `/${commandName} ${trimmedArgs}` : `/${commandName}`;
}

function parsePositionalArgs(definitions: CommandArgDefinition[], raw: string): CommandArgValues {
  const values: CommandArgValues = {};
  const tokens = raw.trim().split(/\s+/u).filter(Boolean);
  let index = 0;
  for (const definition of definitions) {
    if (index >= tokens.length) {
      break;
    }
    if (definition.captureRemaining) {
      values[definition.name] = tokens.slice(index).join(" ");
      break;
    }
    values[definition.name] = expectDefined(tokens[index], "command argument token");
    index += 1;
  }
  return values;
}

function formatPositionalArgs(
  definitions: CommandArgDefinition[],
  values: CommandArgValues,
): string | undefined {
  const parts: string[] = [];
  for (const definition of definitions) {
    const value = values[definition.name];
    if (value == null) {
      continue;
    }
    const rendered = typeof value === "string" ? value.trim() : String(value);
    if (!rendered) {
      continue;
    }
    parts.push(rendered);
    if (definition.captureRemaining) {
      break;
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Parses raw command arguments according to the command definition. */
export function parseCommandArgs(
  command: ChatCommandDefinition,
  raw?: string,
): CommandArgs | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!command.args || command.argsParsing === "none") {
    return { raw: trimmed };
  }
  return { raw: trimmed, values: parsePositionalArgs(command.args, trimmed) };
}

/** Parses a known command without normalizing away its operator-authored tail. */
export function parseCommandInvocation(
  command: ChatCommandDefinition,
  text: string,
): CanonicalCommandInvocation | null {
  const match = text.match(/^\/([^\s:]+)([\s\S]*)$/u);
  if (!match) {
    return null;
  }
  const invokedName = expectDefined(match[1], "command invocation name");
  let rawTail = match[2] ?? "";
  if (rawTail.startsWith(":")) {
    rawTail = rawTail.slice(1);
  }
  return {
    commandKey: command.key,
    invokedName,
    rawTail,
    args: parseCommandArgs(command, rawTail),
    text,
    isExactBare: rawTail.length === 0,
  };
}

/** Serializes parsed command arguments back into a raw argument string. */
export function serializeCommandArgs(
  command: ChatCommandDefinition,
  args?: CommandArgs,
): string | undefined {
  if (!args) {
    return undefined;
  }
  const raw = args.raw?.trim();
  if (raw) {
    return raw;
  }
  if (!args.values || !command.args) {
    return undefined;
  }
  return command.formatArgs
    ? command.formatArgs(args.values)
    : formatPositionalArgs(command.args, args.values);
}

/** Builds slash-command text from a command definition and parsed args. */
export function buildCommandTextFromArgs(
  command: ChatCommandDefinition,
  args?: CommandArgs,
): string {
  return buildCommandText(command.nativeName ?? command.key, serializeCommandArgs(command, args));
}

/** Resolves static or provider-dependent choices against an explicit owner scope. */
export function resolveCommandArgChoicesInScope(params: {
  command: ChatCommandDefinition;
  arg: CommandArgDefinition;
  scope?: CommandArgChoiceScope;
}): ResolvedCommandArgChoice[] {
  const { command, arg } = params;
  if (!arg.choices) {
    return [];
  }
  const choices = Array.isArray(arg.choices)
    ? arg.choices
    : arg.choices({ ...params.scope, command, arg });
  return choices.map((choice) =>
    typeof choice === "string" ? { value: choice, label: choice } : choice,
  );
}

/** Resolves the explicitly configured argument-choice menu for a command. */
export function resolveCommandArgMenuInScope(params: {
  command: ChatCommandDefinition;
  args?: CommandArgs;
  scope?: CommandArgChoiceScope;
}): { arg: CommandArgDefinition; choices: ResolvedCommandArgChoice[]; title?: string } | null {
  const { command, args, scope } = params;
  if (!command.args || !command.argsMenu || command.argsParsing === "none") {
    return null;
  }
  const argSpec = command.argsMenu;
  const resolved =
    argSpec === "auto"
      ? command.args
          .map((arg) => ({
            arg,
            choices: resolveCommandArgChoicesInScope({ command, arg, scope }),
          }))
          .find((entry) => entry.choices.length > 0)
      : (() => {
          const arg = command.args?.find((entry) => entry.name === argSpec.arg);
          return arg
            ? { arg, choices: resolveCommandArgChoicesInScope({ command, arg, scope }) }
            : undefined;
        })();
  if (!resolved || resolved.choices.length === 0) {
    return null;
  }
  if (args?.values?.[resolved.arg.name] != null || (args?.raw && !args.values)) {
    return null;
  }
  const title = argSpec !== "auto" ? argSpec.title : undefined;
  return { ...resolved, title };
}

/** Formats the prompt title shown before an argument-choice menu. */
export function formatCommandArgMenuTitle(params: {
  command: ChatCommandDefinition;
  menu: NonNullable<ReturnType<typeof resolveCommandArgMenuInScope>>;
}): string {
  const { command, menu } = params;
  if (menu.title) {
    return menu.title;
  }
  const commandLabel = command.nativeName ?? command.key;
  if (typeof menu.arg.choices === "function") {
    const options = menu.choices
      .map((choice) => choice.label.trim())
      .filter(Boolean)
      .join(", ");
    return options.length > 0 && options.length <= 160
      ? `Choose ${menu.arg.name} for /${commandLabel}.\nOptions: ${options}.`
      : `Choose ${menu.arg.name} for /${commandLabel}.`;
  }
  return `Choose ${menu.arg.description || menu.arg.name} for /${commandLabel}.`;
}

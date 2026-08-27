import { parseCommandInvocation } from "../../../../../src/auto-reply/commands-invocation.js";
import {
  resolveCommandActivation,
  type CommandActivationPlan,
} from "../../../lib/chat/command-interactions/index.ts";
import type { SlashCommandDef } from "../../../lib/chat/commands.ts";
import type { SlashMenuHost, SlashMenuState } from "./chat-composer-slash-menu.ts";

function commandInvocationText(command: SlashCommandDef, state: SlashMenuState): string {
  const completion = state.slashMenuCompletion;
  if (!completion || completion.inline) {
    return `/${command.name}`;
  }
  const normalized = completion.query.toLowerCase();
  const selectedName = [command.name, ...(command.aliases ?? [])].find(
    (name) => name.toLowerCase() === normalized,
  );
  return `/${selectedName ?? command.name}`;
}

export function resolveComposerCommandActivation(
  command: SlashCommandDef,
  state: SlashMenuState,
  host: SlashMenuHost,
  source: "typed" | "sheet",
  trigger: "enter" | "pointer" | "tab",
  invocationText = commandInvocationText(command, state),
): CommandActivationPlan | null {
  if (!command.definition) {
    return null;
  }
  const invocation = parseCommandInvocation(command.definition, invocationText);
  if (!invocation) {
    return null;
  }
  return resolveCommandActivation({
    source,
    trigger,
    command,
    invocation,
    resolveChoices: () => host.resolveArgOptions(command).map((value) => ({ value, label: value })),
  });
}

export function applyComposerCommandActivation(
  plan: CommandActivationPlan,
  command: SlashCommandDef,
  state: SlashMenuState,
  host: SlashMenuHost,
  requestUpdate: () => void,
  resetState: (state: SlashMenuState) => void,
): void {
  if (plan.kind === "collect-arguments") {
    const firstArg = plan.plan.args[0];
    const choices = firstArg ? plan.plan.resolveChoices(firstArg) : [];
    if (firstArg && choices.length > 0) {
      host.commitDraft(`/${command.name} `);
      state.slashMenuMode = "args";
      state.slashMenuCommand = command;
      state.slashMenuArgItems = choices.map((choice) => choice.value);
      state.slashMenuOpen = true;
      state.slashMenuIndex = 0;
      state.slashMenuItems = [];
      requestUpdate();
      return;
    }
  }
  resetState(state);
  if (plan.kind === "execute-action") {
    host.commitDraft(`/${command.name}`);
    host.runCommand();
  } else if (plan.kind === "insert-text") {
    const acceptsTail = command.definition?.acceptsArgs === true;
    host.commitDraft(`${plan.invocation.text}${acceptsTail ? " " : ""}`);
  }
  requestUpdate();
}

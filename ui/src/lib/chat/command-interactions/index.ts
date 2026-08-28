import type {
  CanonicalCommandInvocation,
  ResolvedCommandArgChoice,
} from "../../../../../src/auto-reply/commands-invocation.js";
import type { CommandArgDefinition } from "../../../../../src/auto-reply/commands-registry.types.js";
import type { SlashCommandDef } from "../commands.ts";

type KnownControlUiSurface = "command-help" | "device-pairing" | "goal-management";
type StructuredCommandAction = { kind: "run-local-command"; commandKey: string };
type ComposerModeActivation = { kind: "goal" };
type KnownControlUiRoute = { path: string };

type ExplicitArgumentCollectionPlan = {
  args: readonly CommandArgDefinition[];
  resolveChoices: (arg: CommandArgDefinition) => ResolvedCommandArgChoice[];
};

export type CommandActivationPlan =
  | {
      kind: "insert-text";
      invocation: CanonicalCommandInvocation;
      tailOwnership: "raw" | "canonical";
    }
  | {
      kind: "collect-arguments";
      invocation: CanonicalCommandInvocation;
      plan: ExplicitArgumentCollectionPlan;
    }
  | { kind: "execute-action"; action: StructuredCommandAction; confirmation: "none" }
  | { kind: "activate-composer-mode"; mode: ComposerModeActivation }
  | { kind: "open-surface"; surface: KnownControlUiSurface; focus?: string }
  | { kind: "navigate"; target: KnownControlUiRoute };

export type CommandActivationContext = {
  source: "typed" | "sheet";
  trigger: "enter" | "pointer" | "tab";
  command: SlashCommandDef;
  invocation: CanonicalCommandInvocation;
  resolveChoices: (arg: CommandArgDefinition) => ResolvedCommandArgChoice[];
  placement: "standalone" | "inline";
  goal?: { id: string };
  goalStartAvailable: boolean;
};

export interface ControlUiCommandInteractionProvider {
  id: string;
  resolve(context: CommandActivationContext): CommandActivationPlan | null;
}

const localCommandProvider: ControlUiCommandInteractionProvider = {
  id: "local-command",
  resolve(context) {
    const interaction = context.command.interaction;
    if (interaction?.kind !== "execute-action" || !context.invocation.isExactBare) {
      return null;
    }
    return {
      kind: "execute-action",
      action: { ...interaction.action, commandKey: context.command.key },
      confirmation: "none",
    };
  },
};

const declaredInteractionProvider: ControlUiCommandInteractionProvider = {
  id: "declared-control-ui-interaction",
  resolve(context) {
    if (context.command.interaction?.kind !== "collect-arguments" || !context.command.definition) {
      return null;
    }
    return {
      kind: "collect-arguments",
      invocation: context.invocation,
      plan: {
        args: context.command.definition.args ?? [],
        resolveChoices: context.resolveChoices,
      },
    };
  },
};

const goalProvider: ControlUiCommandInteractionProvider = {
  id: "session-goal",
  resolve(context) {
    if (
      context.command.key !== "goal" ||
      context.placement !== "standalone" ||
      !context.invocation.isExactBare
    ) {
      return null;
    }
    if (context.goal) {
      return { kind: "open-surface", surface: "goal-management", focus: context.goal.id };
    }
    return context.goalStartAvailable
      ? { kind: "activate-composer-mode", mode: { kind: "goal" } }
      : null;
  },
};

const DEFAULT_PROVIDERS = [goalProvider, declaredInteractionProvider, localCommandProvider];

/** Resolves interaction policy separately from command grammar. */
export function resolveCommandActivation(
  context: CommandActivationContext,
  providers: readonly ControlUiCommandInteractionProvider[] = DEFAULT_PROVIDERS,
): CommandActivationPlan {
  for (const provider of providers) {
    const plan = provider.resolve(context);
    // Tab may enter collection, but it never executes or opens another owner.
    if (plan && (context.trigger !== "tab" || plan.kind === "collect-arguments")) {
      return plan;
    }
  }
  return {
    kind: "insert-text",
    invocation: context.invocation,
    tailOwnership:
      context.command.source === "native" && context.command.definition?.argsParsing !== "none"
        ? "canonical"
        : "raw",
  };
}

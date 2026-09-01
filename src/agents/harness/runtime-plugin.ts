/** Resolves the selected native harness from a run-owned plugin registry. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRouteOverridePresence } from "../../plugin-sdk/provider-model-types.js";
import {
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "../../plugins/config-state.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  pluginInstallPathMatchesRoot,
  type PluginVerificationFailureReason,
} from "../../plugins/runtime-degraded-state.js";
import { getPluginRuntimeLoadContext } from "../../plugins/runtime/load-context.js";
import {
  isDefaultAgentRuntimeId,
  OPENCLAW_AGENT_RUNTIME_ID,
  normalizeOptionalAgentRuntimeId,
} from "../agent-runtime-id.js";
import { isCliRuntimeAliasForProvider } from "../model-runtime-aliases.js";
import { resolveAgentHarnessPolicy } from "./policy.js";
import { resolveAgentHarnessOwnerPluginIds } from "./runtime-plugin-load-plan.js";

export { resolveAgentHarnessOwnerPluginIds } from "./runtime-plugin-load-plan.js";

export type AgentHarnessRuntimeAvailability =
  | {
      status: "available";
      ownerPluginIds: string[];
    }
  | {
      status: "unavailable";
      ownerPluginIds: string[];
      reason: "owner-plugin-not-activatable" | "owner-plugin-unverified" | "owner-plugin-degraded";
      detail: string;
    };

type AgentHarnessRuntimePayloadFailure = {
  pluginId: string;
  installPath?: string;
  reason: PluginVerificationFailureReason;
};

function describeMissingHarnessRegistration(
  runtime: string,
  pluginRegistry: PluginRegistry | undefined,
): string {
  const context = getPluginRuntimeLoadContext(pluginRegistry);
  const manifestOwnerPluginIds =
    context?.metadataSnapshot?.plugins
      .filter((plugin) =>
        plugin.activation?.onAgentHarnesses?.some(
          (candidate) => normalizeOptionalAgentRuntimeId(candidate) === runtime,
        ),
      )
      .map((plugin) => plugin.id) ?? [];
  const ownerPluginIds = [
    ...new Set(
      manifestOwnerPluginIds.length > 0
        ? manifestOwnerPluginIds
        : runtime === "codex"
          ? ["codex"]
          : [],
    ),
  ]
    .toSorted()
    .slice(0, 3);
  if (ownerPluginIds.length === 0) {
    return "Enable or reinstall the plugin that provides this runtime, restart the Gateway, then retry.";
  }

  const plugins = normalizePluginsConfig(context?.activationSourceConfig.plugins);
  const blockers: string[] = [];
  for (const pluginId of ownerPluginIds) {
    if (!plugins.enabled) {
      blockers.push(`Owner plugin "${pluginId}" is not activatable (plugins disabled)`);
      continue;
    }
    const plugin = context?.metadataSnapshot?.byPluginId.get(pluginId);
    if (!plugin) {
      blockers.push(`Owner plugin "${pluginId}" is absent from this prepared plugin generation`);
      continue;
    }
    const activation = resolveEffectivePluginActivationState({
      id: pluginId,
      origin: plugin.origin,
      config: plugins,
      rootConfig: context?.activationSourceConfig,
    });
    if (!activation.activated) {
      blockers.push(
        `Owner plugin "${pluginId}" is not activatable${activation.reason ? ` (${activation.reason})` : ""}`,
      );
    }
  }
  const ownerField = ownerPluginIds.length === 1 ? "ownerPluginId" : "ownerPluginIds";
  const reason = blockers.length > 0 ? "reason=owner-plugin-not-activatable, " : "";
  const detail = blockers.length > 0 ? blockers.join("; ") : "The owner plugin did not register";
  return `(${reason}${ownerField}=${ownerPluginIds.join(",")}). ${detail}. Run "openclaw doctor --fix" or select a model that does not require this runtime, restart the Gateway, then retry.`;
}

/**
 * Resolves whether manifest-owned harness code is loadable without importing it.
 * Callers must pass the result of a payload check performed for this invocation.
 */
export function resolveAgentHarnessRuntimeAvailability(params: {
  runtime: string;
  provider: string;
  config?: OpenClawConfig;
  workspaceDir: string;
  payloadFailures: readonly AgentHarnessRuntimePayloadFailure[];
  payloadCheckedPluginIds: readonly string[];
  selectedPluginRootDirs: ReadonlyMap<string, string>;
}): AgentHarnessRuntimeAvailability {
  const runtime = params.runtime.trim();
  const ownerPluginIds = resolveAgentHarnessOwnerPluginIds({
    ...params,
    runtime,
  });
  if (ownerPluginIds.length === 0) {
    return {
      status: "unavailable",
      ownerPluginIds,
      reason: "owner-plugin-not-activatable",
      detail: `No enabled plugin owns agent harness "${runtime}".`,
    };
  }
  const checkedPluginIds = new Set(params.payloadCheckedPluginIds);
  const unverifiedOwner = ownerPluginIds.find(
    (pluginId) => !params.selectedPluginRootDirs.has(pluginId) || !checkedPluginIds.has(pluginId),
  );
  if (unverifiedOwner) {
    return {
      status: "unavailable",
      ownerPluginIds,
      reason: "owner-plugin-unverified",
      detail: `Agent harness "${runtime}" owner plugin "${unverifiedOwner}" payload was not verified.`,
    };
  }
  const failedOwner = params.payloadFailures.find((failure) => {
    if (!ownerPluginIds.includes(failure.pluginId)) {
      return false;
    }
    const selectedRootDir = params.selectedPluginRootDirs.get(failure.pluginId);
    return selectedRootDir
      ? pluginInstallPathMatchesRoot(failure.installPath, selectedRootDir)
      : false;
  });
  if (failedOwner) {
    return {
      status: "unavailable",
      ownerPluginIds,
      reason: "owner-plugin-degraded",
      detail: `Agent harness "${runtime}" owner plugin "${failedOwner.pluginId}" is unavailable (${failedOwner.reason}).`,
    };
  }
  return { status: "available", ownerPluginIds };
}

/** Resolves the selected harness from the run-owned registry without loading or activating. */
export async function ensureSelectedAgentHarnessPlugin(params: {
  provider: string;
  modelId: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
  requestTransportOverrides?: ProviderRouteOverridePresence;
  workspaceDir: string;
  pluginRegistry: PluginRegistry | undefined;
}): Promise<void> {
  const pinnedHarnessId = normalizeOptionalAgentRuntimeId(params.agentHarnessId);
  const runtimeOverride = normalizeOptionalAgentRuntimeId(params.agentHarnessRuntimeOverride);
  const policy = resolveAgentHarnessPolicy({
    provider: params.provider,
    modelId: params.modelId,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    requestTransportOverrides: params.requestTransportOverrides,
  });
  const requestedRuntime = pinnedHarnessId ?? runtimeOverride;
  const runtime =
    requestedRuntime && !isDefaultAgentRuntimeId(requestedRuntime)
      ? requestedRuntime
      : policy.runtime;
  if (
    isDefaultAgentRuntimeId(runtime) ||
    runtime === OPENCLAW_AGENT_RUNTIME_ID ||
    isCliRuntimeAliasForProvider({
      runtime,
      provider: params.provider,
      cfg: params.config,
    })
  ) {
    return;
  }

  if (!params.pluginRegistry?.agentHarnesses.some((entry) => entry.harness.id === runtime)) {
    throw new Error(
      `Agent harness runtime "${runtime}" is unavailable because its plugin registration is missing from this prepared run. ${describeMissingHarnessRegistration(runtime, params.pluginRegistry)}`,
    );
  }
}

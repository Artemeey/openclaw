/** Shared command implementation for text and image model fallback lists. */
import { buildModelAliasIndex, resolveModelRefFromString } from "../../agents/model-selection.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { logConfigUpdated } from "../../config/logging.js";
import { resolveAgentModelFallbackValues, toAgentModelListLike } from "../../config/model-input.js";
import type { AgentModelEntryConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type RuntimeEnv, writeRuntimeJson, writeRuntimeStdout } from "../../runtime.js";
import { loadModelsConfig } from "./load-config.js";
import {
  DEFAULT_PROVIDER,
  ensureFlagCompatibility,
  mergePrimaryFallbackConfig,
  modelKey,
  resolveModelTarget,
  resolveModelKeysFromEntries,
  upsertCanonicalModelConfigEntry,
  updateConfig,
} from "./shared.js";

type DefaultsFallbackKey = "model" | "imageModel";

function fallbackLabel(key: DefaultsFallbackKey): string {
  return key === "imageModel" ? "Image fallback" : "Fallback";
}

function listCommandForFallbackKey(key: DefaultsFallbackKey): string {
  return key === "imageModel" ? "models image-fallbacks list" : "models fallbacks list";
}

function getFallbacks(cfg: OpenClawConfig, key: DefaultsFallbackKey): string[] {
  return resolveAgentModelFallbackValues(cfg.agents?.defaults?.[key]);
}

function patchDefaultsFallbacks(
  cfg: OpenClawConfig,
  params: { key: DefaultsFallbackKey; fallbacks: string[]; models?: Record<string, unknown> },
): OpenClawConfig {
  const existing = toAgentModelListLike(cfg.agents?.defaults?.[params.key]);
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        [params.key]: mergePrimaryFallbackConfig(existing, { fallbacks: params.fallbacks }),
        ...(params.models ? { models: params.models as never } : undefined),
      },
    },
  };
}

/** Lists fallback model refs for the selected defaults key. */
export async function listFallbacksCommand(
  key: DefaultsFallbackKey,
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = await loadModelsConfig({
    commandName: listCommandForFallbackKey(key),
    runtime,
  });
  const fallbacks = getFallbacks(cfg, key);

  if (opts.json) {
    writeRuntimeJson(runtime, { fallbacks });
    return;
  }
  if (opts.plain) {
    for (const entry of fallbacks) {
      writeRuntimeStdout(runtime, entry);
    }
    return;
  }

  runtime.log(`${fallbackLabel(key)}s (${fallbacks.length}):`);
  if (fallbacks.length === 0) {
    runtime.log("- none");
    return;
  }
  for (const entry of fallbacks) {
    runtime.log(`- ${entry}`);
  }
}

/** Adds a fallback model, creating the canonical model entry when needed. */
export async function addFallbackCommand(
  key: DefaultsFallbackKey,
  modelRaw: string,
  runtime: RuntimeEnv,
) {
  const updated = await updateConfig((cfg) => {
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const nextModels = {
      ...cfg.agents?.defaults?.models,
    } as Record<string, AgentModelEntryConfig>;
    const targetKey = upsertCanonicalModelConfigEntry(nextModels, resolved);
    const existing = getFallbacks(cfg, key);
    const existingKeys = resolveModelKeysFromEntries({ cfg, entries: existing });
    if (existingKeys.includes(targetKey)) {
      return cfg;
    }

    return patchDefaultsFallbacks(cfg, {
      key,
      fallbacks: [...existing, targetKey],
      models: nextModels,
    });
  });

  logConfigUpdated(runtime);
  runtime.log(`${fallbackLabel(key)}s: ${getFallbacks(updated, key).join(", ")}`);
}

/** Removes a fallback model by resolving aliases to the canonical provider/model key. */
export async function removeFallbackCommand(
  key: DefaultsFallbackKey,
  modelRaw: string,
  runtime: RuntimeEnv,
) {
  const updated = await updateConfig((cfg) => {
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const targetKey = modelKey(resolved.provider, resolved.model);
    const aliasIndex = buildModelAliasIndex({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    const existing = getFallbacks(cfg, key);
    // Fallback entries may be aliases or provider/model refs. Resolve each entry
    // before comparison so removing an alias removes the canonical target.
    const filtered = existing.filter((entry) => {
      const resolvedEntry = resolveModelRefFromString({
        raw: entry ?? "",
        defaultProvider: DEFAULT_PROVIDER,
        aliasIndex,
      });
      if (!resolvedEntry) {
        return true;
      }
      return modelKey(resolvedEntry.ref.provider, resolvedEntry.ref.model) !== targetKey;
    });

    if (filtered.length === existing.length) {
      throw new Error(
        `${fallbackLabel(key)} not found: ${targetKey}. Run ${formatCliCommand(`openclaw ${listCommandForFallbackKey(key)}`)} to see configured fallbacks.`,
      );
    }

    return patchDefaultsFallbacks(cfg, { key, fallbacks: filtered });
  });

  logConfigUpdated(runtime);
  runtime.log(`${fallbackLabel(key)}s: ${getFallbacks(updated, key).join(", ")}`);
}

/** Clears all fallback model refs for the selected defaults key. */
export async function clearFallbacksCommand(key: DefaultsFallbackKey, runtime: RuntimeEnv) {
  await updateConfig((cfg) => {
    return patchDefaultsFallbacks(cfg, { key, fallbacks: [] });
  });

  logConfigUpdated(runtime);
  runtime.log(`${fallbackLabel(key)} list cleared.`);
}

/** Resolves /model directive selections and auth profile overrides. */
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { ensureAuthProfileStore } from "../../agents/auth-profiles.js";
import {
  createModelManifestPluginContext,
  isModelKeyAllowedBySet,
  type ModelManifestPluginContext,
} from "../../agents/model-selection-shared.js";
import { type ModelAliasIndex, resolveModelRefFromString } from "../../agents/model-selection.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveProfileOverride } from "./directive-handling.auth-profile.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { type ModelDirectiveSelection, resolveModelDirectiveSelection } from "./model-selection.js";

function resolveStoredNumericProfileModelDirective(params: {
  raw: string;
  agentDir: string;
  cfg: OpenClawConfig;
  manifestPluginContext: ModelManifestPluginContext;
}): {
  modelRaw: string;
  profileId: string;
  profileProvider: string;
} | null {
  const trimmed = params.raw.trim();
  const lastSlash = trimmed.lastIndexOf("/");
  const profileDelimiter = trimmed.indexOf("@", lastSlash + 1);
  if (profileDelimiter <= 0) {
    return null;
  }

  const profileId = trimmed.slice(profileDelimiter + 1).trim();
  if (!/^\d{8}$/.test(profileId)) {
    return null;
  }

  const modelRaw = trimmed.slice(0, profileDelimiter).trim();
  if (!modelRaw) {
    return null;
  }

  const context = params.manifestPluginContext.getContext();
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
    config: params.cfg,
    workspaceDir: context.workspaceDir,
    pluginMetadataSnapshot: context.pluginMetadataSnapshot,
  });
  const profile = store.profiles[profileId];
  if (!profile) {
    return null;
  }

  return { modelRaw, profileId, profileProvider: profile.provider };
}

/** Resolves the requested model/profile override from parsed inline directives. */
export function resolveModelSelectionFromDirective(params: {
  directives: InlineDirectives;
  cfg: OpenClawConfig;
  agentDir: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: Array<{ provider: string; id?: string; name?: string }>;
  provider: string;
  agentId?: string;
  workspaceDir?: string;
  manifestPluginContext?: ModelManifestPluginContext;
}): {
  modelSelection?: ModelDirectiveSelection;
  profileOverride?: string;
  errorText?: string;
} {
  if (!params.directives.hasModelDirective || !params.directives.rawModelDirective) {
    if (params.directives.rawModelProfile) {
      return { errorText: "Auth profile override requires a model selection." };
    }
    return {};
  }

  const raw = params.directives.rawModelDirective.trim();
  if (/^default$/i.test(raw)) {
    return {
      modelSelection: {
        provider: params.defaultProvider,
        model: params.defaultModel,
        isDefault: true,
      },
    };
  }
  const manifestPluginContext =
    params.manifestPluginContext ??
    createModelManifestPluginContext({
      cfg: params.cfg,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
    });
  const storedNumericProfile =
    params.directives.rawModelProfile === undefined
      ? resolveStoredNumericProfileModelDirective({
          raw,
          agentDir: params.agentDir,
          cfg: params.cfg,
          manifestPluginContext,
        })
      : null;
  const storedNumericProfileSelection = storedNumericProfile
    ? resolveModelDirectiveSelection({
        raw: storedNumericProfile.modelRaw,
        defaultProvider: params.defaultProvider,
        defaultModel: params.defaultModel,
        aliasIndex: params.aliasIndex,
        allowedModelKeys: params.allowedModelKeys,
        cfg: params.cfg,
        agentId: params.agentId,
        workspaceDir: params.workspaceDir,
        manifestPluginContext,
        rawRuntime: params.directives.rawModelRuntime,
      })
    : null;
  const profileContext = storedNumericProfileSelection?.selection
    ? manifestPluginContext.getContext()
    : undefined;
  const authAliasLookupParams = {
    config: params.cfg,
    workspaceDir: profileContext?.pluginMetadataSnapshot
      ? profileContext.workspaceDir
      : params.workspaceDir,
    ...(profileContext?.pluginMetadataSnapshot
      ? {
          metadataSnapshot: {
            plugins: profileContext.pluginMetadataSnapshot.manifestRegistry.plugins,
          },
        }
      : {}),
  };
  const useStoredNumericProfile =
    Boolean(storedNumericProfileSelection?.selection) &&
    resolveProviderIdForAuth(
      storedNumericProfileSelection?.selection?.provider ?? "",
      authAliasLookupParams,
    ) ===
      resolveProviderIdForAuth(storedNumericProfile?.profileProvider ?? "", authAliasLookupParams);
  const modelRaw =
    useStoredNumericProfile && storedNumericProfile ? storedNumericProfile.modelRaw : raw;
  let modelSelection: ModelDirectiveSelection | undefined;

  if (/^[0-9]+$/.test(raw)) {
    return {
      errorText: [
        "Numeric model selection is not supported in chat.",
        "",
        "Browse: /models or /models <provider>",
        "Switch: /model <provider/model>",
      ].join("\n"),
    };
  }

  const explicit = resolveModelRefFromString({
    cfg: params.cfg,
    agentId: params.agentId,
    raw: modelRaw,
    defaultProvider: params.defaultProvider,
    aliasIndex: params.aliasIndex,
    manifestPluginContext,
  });
  if (explicit) {
    const explicitKey = buildModelCatalogRef(explicit.ref.provider, explicit.ref.model);
    if (
      params.allowedModelKeys.size === 0 ||
      isModelKeyAllowedBySet(params.allowedModelKeys, explicitKey)
    ) {
      modelSelection = {
        provider: explicit.ref.provider,
        model: explicit.ref.model,
        isDefault:
          explicit.ref.provider === params.defaultProvider &&
          explicit.ref.model === params.defaultModel,
        ...(explicit.alias ? { alias: explicit.alias } : {}),
      };
    }
  }

  if (!modelSelection) {
    const resolved = resolveModelDirectiveSelection({
      raw: modelRaw,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      aliasIndex: params.aliasIndex,
      allowedModelKeys: params.allowedModelKeys,
      cfg: params.cfg,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      manifestPluginContext,
      rawRuntime: params.directives.rawModelRuntime,
    });

    if (resolved.error) {
      return { errorText: resolved.error };
    }

    if (resolved.selection) {
      modelSelection = resolved.selection;
    }
  }

  let profileOverride: string | undefined;
  const rawProfile =
    params.directives.rawModelProfile ??
    (useStoredNumericProfile ? storedNumericProfile?.profileId : undefined);
  if (modelSelection && rawProfile) {
    const profileResolved = resolveProfileOverride({
      rawProfile,
      provider: modelSelection.provider,
      cfg: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      manifestPluginContext,
    });
    if (profileResolved.error) {
      return { errorText: profileResolved.error };
    }
    profileOverride = profileResolved.profileId;
  }

  return { modelSelection, profileOverride };
}

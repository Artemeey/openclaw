/** Prepared plugin metadata handoff for runtime model normalization. */
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { ModelRef, normalizeModelRef } from "../../agents/model-ref-shared.js";
import {
  createModelManifestPluginContext,
  type ModelManifestPluginContext,
} from "../../agents/model-selection-shared.js";
import { RUNTIME_MODEL_VISIBILITY_NORMALIZATION } from "../../agents/model-visibility-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** A producing branch owns either the selected ref or its deferred preparation. */
export type PreparedReplyModelRef = ModelRef | (() => ModelRef);

export function resolvePreparedReplyModelRef(ref: PreparedReplyModelRef): ModelRef {
  return typeof ref === "function" ? ref() : ref;
}

export type RuntimeModelNormalization = NonNullable<Parameters<typeof normalizeModelRef>[2]> & {
  manifestPluginContext?: ModelManifestPluginContext;
};

/** Carries the Gateway-owned metadata snapshot through one model-selection run. */
export function resolveRuntimeNormalization(
  cfg: OpenClawConfig,
  agentId?: string,
  params?: { workspaceDir?: string; manifestPluginContext?: ModelManifestPluginContext },
): RuntimeModelNormalization {
  const manifestPluginContext =
    params?.manifestPluginContext ??
    createModelManifestPluginContext({ cfg, agentId, workspaceDir: params?.workspaceDir });
  return {
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    ...manifestPluginContext.getContext(),
    manifestPluginContext,
  };
}

export function findSelectedCatalogEntry(params: {
  catalog?: readonly ModelCatalogEntry[];
  provider: string;
  model: string;
}): ModelCatalogEntry | undefined {
  const selectedKey = buildModelCatalogRef(params.provider, params.model);
  return params.catalog?.find(
    (entry) => buildModelCatalogRef(entry.provider, entry.id) === selectedKey,
  );
}

export function mergePreparedConfiguredCatalog(params: {
  configured: ModelCatalogEntry[];
  prepared?: readonly ModelCatalogEntry[];
}): ModelCatalogEntry[] {
  if (!params.prepared?.length) {
    return params.configured;
  }
  const preparedByKey = new Map(
    params.prepared.map((entry) => [buildModelCatalogRef(entry.provider, entry.id), entry]),
  );
  return params.configured.map((entry) => {
    const prepared = preparedByKey.get(buildModelCatalogRef(entry.provider, entry.id));
    // The prepared row owns runtime capabilities; the configured row limits
    // visibility and retains any authored metadata absent from that snapshot.
    return prepared ? { ...entry, ...prepared } : entry;
  });
}

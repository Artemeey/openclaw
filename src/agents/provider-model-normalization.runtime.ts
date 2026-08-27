/** Keeps executable provider hooks off the static model-reference import graph. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataRegistryView } from "../plugins/plugin-metadata-snapshot.types.js";

type ProviderRuntimeModule = typeof import("../plugins/provider-model-normalization.runtime.js");

const require = createRequire(import.meta.url);
let providerRuntimeModule: ProviderRuntimeModule | undefined;

function loadProviderRuntime(): ProviderRuntimeModule {
  if (!providerRuntimeModule) {
    // Source execution needs TS/tsconfig resolution; bundled chunks live at the
    // dist root and load the stable facade declared by tsdown, without source fallback.
    const filename = fileURLToPath(import.meta.url);
    const runtime = filename.endsWith(".ts")
      ? // SAFETY: tsx declares its synchronous require API at this CJS export.
        (require("tsx/cjs/api") as typeof import("tsx/cjs/api")).require(
          "../plugins/provider-model-normalization.runtime.ts",
          filename,
        )
      : require("./plugins/provider-model-normalization.runtime.js");
    // SAFETY: Both paths load the same core facade; tsdown declares its built entry.
    providerRuntimeModule = runtime as ProviderRuntimeModule;
  }
  return providerRuntimeModule;
}

/** Normalizes provider model ids through plugin runtime hooks when available. */
export function normalizeProviderModelIdWithRuntime(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
  plugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
  context: {
    provider: string;
    modelId: string;
  };
}): string | undefined {
  return loadProviderRuntime().normalizeProviderModelIdWithPlugin(params);
}

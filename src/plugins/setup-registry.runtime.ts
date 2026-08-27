/** Metadata lookup helpers for plugin setup CLI backend descriptors. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isInstalledPluginEnabled } from "./installed-plugin-index.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state.js";

type SetupCliBackendDescriptorEntry = {
  pluginId: string;
  backend: {
    id: string;
  };
};

type SetupCliBackendDescriptorLookupParams = {
  backend: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

const setupCliBackendDescriptors = new WeakMap<
  PluginMetadataSnapshot,
  SetupCliBackendDescriptorEntry[]
>();

function resolveSetupCliBackendDescriptors(
  params: Omit<SetupCliBackendDescriptorLookupParams, "backend"> = {},
): SetupCliBackendDescriptorEntry[] {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  const snapshot = resolvePluginMetadataSnapshot({
    ...(params.config ? { config: params.config } : {}),
    env,
    ...(workspaceDir ? { workspaceDir } : {}),
    allowWorkspaceScopedCurrent: true,
  });
  // Finite runtime views share an inventory fingerprint but not their allowed
  // manifests. Descriptor ownership follows the exact immutable snapshot.
  const cached = setupCliBackendDescriptors.get(snapshot);
  if (cached) {
    return cached;
  }
  const entries = snapshot.plugins.flatMap((plugin) => {
    if (!isInstalledPluginEnabled(snapshot.index, plugin.id)) {
      return [];
    }
    return [...plugin.cliBackends, ...(plugin.setup?.cliBackends ?? [])].map(
      (backendId) =>
        ({
          pluginId: plugin.id,
          backend: { id: backendId },
        }) satisfies SetupCliBackendDescriptorEntry,
    );
  });
  setupCliBackendDescriptors.set(snapshot, entries);
  return entries;
}

export function resolvePluginSetupCliBackendDescriptor(
  params: SetupCliBackendDescriptorLookupParams,
) {
  const normalized = normalizeProviderId(params.backend);
  return resolveSetupCliBackendDescriptors(params).find(
    (entry) => normalizeProviderId(entry.backend.id) === normalized,
  );
}

/** Resolve enabled setup CLI backend ids from one metadata snapshot. */
export function resolvePluginSetupCliBackendIds(
  params: Omit<SetupCliBackendDescriptorLookupParams, "backend"> = {},
): string[] {
  return resolveSetupCliBackendDescriptors(params).map((entry) => entry.backend.id);
}

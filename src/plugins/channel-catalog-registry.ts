// Maintains channel catalog entries advertised by plugins.
import { normalizeOptionalString as resolveOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { getCurrentPluginChannelCatalog } from "./current-plugin-metadata-state.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import type { PluginPackageChannel, PluginPackageInstall } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

export type PluginChannelCatalogEntry = {
  pluginId: string;
  origin: PluginOrigin;
  packageName?: string;
  workspaceDir?: string;
  rootDir: string;
  channel: PluginPackageChannel;
  install?: PluginPackageInstall;
};

export type ChannelCatalogParams = {
  origin?: PluginOrigin;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  extraPaths?: string[];
  /**
   * Optional override. Prepared catalogs require matching retained records;
   * cold callers load the ledger when omitted, except for bundled-only reads.
   */
  installRecords?: Record<string, PluginInstallRecord>;
  discovery?: PluginDiscoveryResult;
};

export type PreparedPluginChannelCatalog = {
  readonly read: (params: ChannelCatalogParams) => PluginChannelCatalogEntry[];
};

export function listChannelCatalogEntries(
  params: ChannelCatalogParams = {},
): PluginChannelCatalogEntry[] {
  if (!params.discovery) {
    const prepared = getCurrentPluginChannelCatalog();
    if (prepared) {
      return prepared.read(params);
    }
  }
  const discovery = params.discovery ?? discoverChannelCatalog(params);
  return discovery.candidates.flatMap((candidate) => {
    if (params.origin && candidate.origin !== params.origin) {
      return [];
    }
    const channel = candidate.packageManifest?.channel;
    if (!channel?.id) {
      return [];
    }
    const pluginId = resolveChannelCatalogPluginId(candidate);
    if (!pluginId) {
      return [];
    }
    return [
      {
        pluginId,
        origin: candidate.origin,
        packageName: candidate.packageName,
        workspaceDir: candidate.workspaceDir,
        rootDir: candidate.rootDir,
        channel,
        ...(candidate.packageManifest?.install
          ? { install: candidate.packageManifest.install }
          : {}),
      },
    ];
  });
}

function discoverChannelCatalog(params: ChannelCatalogParams): PluginDiscoveryResult {
  const installRecords = resolveInstallRecords(params);
  return discoverOpenClawPlugins({
    workspaceDir: params.workspaceDir,
    env: params.env,
    extraPaths: params.extraPaths,
    ...(installRecords && Object.keys(installRecords).length > 0 ? { installRecords } : {}),
  });
}

function resolveChannelCatalogPluginId(
  candidate: PluginDiscoveryResult["candidates"][number],
): string | undefined {
  return (
    resolveOptionalString(candidate.bundledManifest?.id) ??
    resolveOptionalString(candidate.bundledManifestId) ??
    resolveOptionalString(candidate.packageManifest?.plugin?.id) ??
    resolveOptionalString(candidate.idHint)
  );
}

function resolveInstallRecords(
  params: ChannelCatalogParams,
): Record<string, PluginInstallRecord> | undefined {
  if (params.installRecords) {
    return params.installRecords;
  }
  if (params.origin === "bundled") {
    return undefined;
  }
  try {
    return loadInstalledPluginIndexInstallRecordsSync(params.env ? { env: params.env } : {});
  } catch {
    // Cold inspection remains best-effort; the next operation retries the ledger.
    return undefined;
  }
}

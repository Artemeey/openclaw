// Holds current plugin metadata snapshots for process-scoped consumers.
import {
  setCurrentManifestModelIdNormalizationRecords,
  type ManifestModelIdNormalizationRecord,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PreparedPluginChannelCatalog } from "./channel-catalog-registry.js";
import type { PluginMetadataOwner } from "./plugin-metadata-collection.js";

export type CurrentPluginMetadataSnapshotRevision = symbol;

type CurrentPluginMetadataMutableState = {
  owner?: PluginMetadataOwner;
  channelCatalogReader?: () => PreparedPluginChannelCatalog | undefined;
  snapshot: unknown;
  configFingerprint: string | undefined;
  envFingerprint: string | undefined;
  defaultDiscoveryCompatible: boolean;
  compatiblePolicyHashes: readonly string[] | undefined;
  compatibleConfigFingerprints: readonly string[] | undefined;
  manifestModelIdNormalizationRecords: readonly ManifestModelIdNormalizationRecord[] | undefined;
  // Temporary snapshot owners compare this publication token before restoring;
  // lifecycle clears and newer publications must always win.
  revision: CurrentPluginMetadataSnapshotRevision;
  configIdentities: WeakSet<OpenClawConfig>;
};

export function getCurrentPluginMetadataOwner(): PluginMetadataOwner | undefined {
  return state.owner;
}

export function registerCurrentPluginChannelCatalogReader(
  reader: () => PreparedPluginChannelCatalog | undefined,
): void {
  state.channelCatalogReader = reader;
}

export function getCurrentPluginChannelCatalog(): PreparedPluginChannelCatalog | undefined {
  return state.channelCatalogReader?.();
}

/** Installs one lifecycle owner without letting an older disposer retire its replacement. */
export function installPluginMetadataOwner(owner: PluginMetadataOwner): () => void {
  state.owner = owner;
  return () => {
    if (state.owner === owner) {
      state.owner = undefined;
    }
    owner.dispose();
  };
}

// Process-scoped facts must survive dual module instances (ESM plus the lazy
// require bridge in plugin-metadata-snapshot.runtime.ts), so the state lives
// on a globalThis singleton like the scoped snapshot ALS.
const state = resolveGlobalSingleton<CurrentPluginMetadataMutableState>(
  Symbol.for("openclaw.currentPluginMetadataState"),
  () => ({
    snapshot: undefined,
    configFingerprint: undefined,
    envFingerprint: undefined,
    defaultDiscoveryCompatible: false,
    compatiblePolicyHashes: undefined,
    compatibleConfigFingerprints: undefined,
    manifestModelIdNormalizationRecords: undefined,
    revision: Symbol("plugin-metadata-snapshot"),
    configIdentities: new WeakSet<OpenClawConfig>(),
  }),
);

/** Owns config identity reuse for the current immutable metadata snapshot. */
export const currentPluginMetadataConfigIdentityCache = {
  add(config: OpenClawConfig): void {
    state.configIdentities.add(config);
  },
  capture(): WeakSet<OpenClawConfig> {
    return state.configIdentities;
  },
  clear(): void {
    state.configIdentities = new WeakSet();
  },
  has(config: OpenClawConfig): boolean {
    return state.configIdentities.has(config);
  },
  restore(identities: WeakSet<OpenClawConfig>): void {
    state.configIdentities = identities;
  },
};

/** Stores the process-current plugin metadata snapshot and compatible config fingerprints. */
export function setCurrentPluginMetadataSnapshotState(
  snapshot: unknown,
  configFingerprint: string | undefined,
  envFingerprint: string | undefined,
  defaultDiscoveryCompatible: boolean,
  compatiblePolicyHashes?: readonly string[],
  compatibleConfigFingerprints?: readonly string[],
  manifestModelIdNormalizationRecords?: readonly ManifestModelIdNormalizationRecord[],
): CurrentPluginMetadataSnapshotRevision {
  state.snapshot = snapshot;
  state.configFingerprint = snapshot ? configFingerprint : undefined;
  state.envFingerprint = snapshot ? envFingerprint : undefined;
  state.defaultDiscoveryCompatible = Boolean(snapshot && defaultDiscoveryCompatible);
  state.compatiblePolicyHashes = snapshot ? compatiblePolicyHashes : undefined;
  state.compatibleConfigFingerprints = snapshot ? compatibleConfigFingerprints : undefined;
  state.manifestModelIdNormalizationRecords = snapshot
    ? manifestModelIdNormalizationRecords
    : undefined;
  setCurrentManifestModelIdNormalizationRecords(state.manifestModelIdNormalizationRecords);
  state.revision = Symbol("plugin-metadata-snapshot");
  return state.revision;
}

/** Clears the process-current plugin metadata snapshot. */
function clearCurrentPluginMetadataSnapshotState(): CurrentPluginMetadataSnapshotRevision {
  state.snapshot = undefined;
  state.configFingerprint = undefined;
  state.envFingerprint = undefined;
  state.defaultDiscoveryCompatible = false;
  state.compatiblePolicyHashes = undefined;
  state.compatibleConfigFingerprints = undefined;
  state.manifestModelIdNormalizationRecords = undefined;
  setCurrentManifestModelIdNormalizationRecords(undefined);
  state.revision = Symbol("plugin-metadata-snapshot");
  return state.revision;
}

/** Clears the snapshot, its identity cache, and process-wide model normalization. */
export function clearCurrentPluginMetadataSnapshot(): void {
  currentPluginMetadataConfigIdentityCache.clear();
  clearCurrentPluginMetadataSnapshotState();
}

/** Returns the process-current plugin metadata snapshot state. */
export function getCurrentPluginMetadataSnapshotState(): {
  snapshot: unknown;
  configFingerprint: string | undefined;
  envFingerprint: string | undefined;
  defaultDiscoveryCompatible: boolean;
  compatiblePolicyHashes: readonly string[] | undefined;
  compatibleConfigFingerprints: readonly string[] | undefined;
  manifestModelIdNormalizationRecords: readonly ManifestModelIdNormalizationRecord[] | undefined;
  revision: CurrentPluginMetadataSnapshotRevision;
} {
  return {
    snapshot: state.snapshot,
    configFingerprint: state.configFingerprint,
    envFingerprint: state.envFingerprint,
    defaultDiscoveryCompatible: state.defaultDiscoveryCompatible,
    compatiblePolicyHashes: state.compatiblePolicyHashes,
    compatibleConfigFingerprints: state.compatibleConfigFingerprints,
    manifestModelIdNormalizationRecords: state.manifestModelIdNormalizationRecords,
    revision: state.revision,
  };
}

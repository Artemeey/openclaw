import type {
  SecretsStoreMutationResult,
  WorkerSetupCredential,
  WorkerSetupPrepareParams,
  WorkerSetupPrepareResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { readCloudWorkerProfiles } from "./cloud-worker-config.ts";

export type CloudConnectionDraft = WorkerSetupPrepareParams & {
  values: Record<string, string>;
  revealed: Record<string, boolean>;
  secretNames: Record<string, string>;
  storedSecret: boolean;
  reusingConnection: boolean;
  profileName: string;
};

/** The page captures identity; this sequence revalidates it across every durable request. */
export async function saveCloudConnection({
  client,
  config,
  draft,
  credentials,
  prepareMethod,
  isCurrent,
  canStoreSecret,
  onStored,
}: {
  client: GatewayBrowserClient;
  config: RuntimeConfigCapability;
  draft: CloudConnectionDraft;
  credentials: readonly WorkerSetupCredential[];
  prepareMethod: string;
  isCurrent: () => boolean;
  canStoreSecret: () => boolean;
  onStored: () => void;
}): Promise<{ prepared: WorkerSetupPrepareResult; params: WorkerSetupPrepareParams } | null> {
  for (const credential of credentials) {
    const value = draft.values[credential.key];
    if (draft.credentials[credential.key] || !value) {
      continue;
    }
    if (!isCurrent() || !canStoreSecret()) {
      throw new Error(t("cloudSetup.secretUnavailable"));
    }
    // Unique per credential, stable across retries; never replace a shared saved reference.
    const name = (draft.secretNames[credential.key] ??=
      `CLOUD_${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`);
    await client.request<SecretsStoreMutationResult>("secrets.store.set", {
      name,
      value,
      kind: "secret",
    });
    if (!isCurrent()) {
      return null;
    }
    draft.credentials[credential.key] = { source: "store", provider: "default", id: name };
    delete draft.values[credential.key];
    delete draft.revealed[credential.key];
    draft.storedSecret = true;
    onStored();
  }
  if (!isCurrent()) {
    return null;
  }
  if (
    readCloudWorkerProfiles(resolveEditableSnapshotConfig(config.state.configSnapshot)).some(
      (profile) => profile.id === draft.profileId,
    )
  ) {
    throw new Error(t("cloudSetup.profileExists", { id: draft.profileId }));
  }
  const params: WorkerSetupPrepareParams = {
    connectionId: draft.connectionId,
    profileId: draft.profileId,
    label: draft.reusingConnection ? draft.label : draft.label.trim(),
    provider: draft.provider,
    settings: draft.settings,
    credentials: draft.credentials,
  };
  const revision = config.state.configSnapshot?.hash;
  if (!revision) {
    throw new Error(t("cloudSetup.configUnavailable"));
  }
  // Prepare validates this source. A queued patch must not adopt a newer
  // revision, while the successful write may legitimately replace this hash.
  const canCommit = () => isCurrent() && config.state.configSnapshot?.hash === revision;
  const prepared = await client.request<WorkerSetupPrepareResult>(prepareMethod, params);
  if (!isCurrent()) {
    return null;
  }
  if (!canCommit()) {
    throw new Error(t("cloudSetup.prepareChanged"));
  }
  const saved = await config.patchFromSnapshot(() => ({
    options: {
      raw: prepared.patch,
      note: "cloud session connection",
      canDispatch: canCommit,
    },
  }));
  if (!isCurrent()) {
    return null;
  }
  if (!saved) {
    throw new Error(
      config.state.configSnapshot?.hash !== revision
        ? t("cloudSetup.prepareChanged")
        : (config.state.lastError ?? t("cloudWorkersPage.errors.saveFailed")),
    );
  }
  return { prepared, params };
}

import { consume } from "@lit/context";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type {
  PluginsListResult,
  WorkerSetupCheckResult,
  WorkerSetupDescribeResult,
  WorkerSetupDescriptor,
  WorkerSetupInstallResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { setPluginEnabled, type PluginCatalogItem } from "../../lib/plugins/index.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { cloudSetupSessionSearch } from "../new-session/draft-navigation-handoff.ts";
import { saveCloudConnection, type CloudConnectionDraft } from "./cloud-connection-save.ts";
import { renderCloudProviderSetup } from "./cloud-provider-setup-view.ts";
import { renderCloudSessionTest } from "./cloud-session-test-view.ts";
import {
  buildCloudWorkerDeletePatch,
  nextCloudWorkerProfileId,
  readCloudWorkerProfiles,
} from "./cloud-worker-config.ts";

export type CloudSetupOwner = { plugin: PluginCatalogItem; descriptor: WorkerSetupDescriptor };

class CloudProviderSetup extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context!: ApplicationContext;
  @state() private owners: CloudSetupOwner[] = [];
  @state() private selected = "";
  @state() private description: WorkerSetupDescribeResult | null = null;
  @state() private draft: CloudConnectionDraft | null = null;
  @state() private checks: Record<string, WorkerSetupCheckResult> = {};
  private checksRevision: string | null | undefined;
  @state() private busy = false;
  @state() private loaded = false;
  @state() private adding = false;
  @state() private advanced = false;
  @state() private waitingForRestart = false;
  @state() private mutationAllowed = false;
  @state() private error: string | null = null;
  @state() private notice: "saved" | "interrupted" | null = null;

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => {
      if (this.busy && this.draft) {
        this.notice = "interrupted";
      }
      this.clearPlaintext();
      this.description = null;
      this.checks = {};
      this.loaded = false;
      this.busy = false;
      this.waitingForRestart = false;
    },
    onIdentityChange: () => {
      this.draft = null;
      this.selected = "";
      this.owners = [];
      this.notice = null;
    },
    ensureInitialData: () => void this.load(),
  });
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.runtimeConfig,
      (config) => {
        this.checksRevision = config.state.configSnapshot?.hash;
        void config.ensureLoaded();
        return config.subscribe(() => {
          const revision = config.state.configSnapshot?.hash;
          if (revision !== this.checksRevision) {
            this.checks = {};
            this.checksRevision = revision;
          }
          this.requestUpdate();
        });
      },
    )
    .watch(
      () => this.context?.cloudSessionTest,
      (test, notify) => test.subscribe(notify),
    );

  override disconnectedCallback() {
    this.clearPlaintext();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private clearPlaintext() {
    if (this.draft) {
      this.draft.values = {};
      this.draft.revealed = {};
      this.draft = { ...this.draft };
    }
  }

  private owner() {
    return this.owners.find(
      ({ plugin, descriptor }) => `${plugin.id}/${descriptor.id}` === this.selected,
    );
  }

  private available(method: string) {
    return canCallGatewayMethod(this.gateway.snapshot, method, "operator.admin");
  }

  private canSave() {
    const owner = this.owner();
    return Boolean(
      owner &&
      this.canManageProfiles() &&
      !this.waitingForRestart &&
      this.description?.dependency.state === "available" &&
      this.available(owner.descriptor.methods.prepare) &&
      !this.context.runtimeConfig.state.configNeedsApply,
    );
  }

  private canManageProfiles() {
    const config = this.context?.runtimeConfig.state;
    return Boolean(
      !this.busy &&
      this.available("config.patch") &&
      config?.configSnapshot?.hash &&
      !config.configLoading &&
      !config.configSaving,
    );
  }

  private async deleteProfile(profileId: string, label: string) {
    const scope = this.gateway.capture();
    const config = this.context.runtimeConfig;
    const revision = config.state.configSnapshot?.hash;
    if (!scope || !revision || !this.canManageProfiles()) {
      return;
    }
    const isCurrent = () => this.gateway.isCurrent(scope) && this.context.runtimeConfig === config;
    const canDispatch = () =>
      isCurrent() &&
      this.available("config.patch") &&
      config.state.configSnapshot?.hash === revision;
    const confirmed = await showConfirmDialog({
      title: t("cloudWorkersPage.deleteTitle"),
      message: t("cloudWorkersPage.deleteConfirm", { profile: label }),
      confirmLabel: t("cloudSetup.removeProfile"),
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    // Confirmation belongs to this connection and source revision, not a replacement
    // profile with the same id that arrives while the dialog is open.
    if (!canDispatch() || !this.canManageProfiles()) {
      this.error = t("cloudWorkersPage.errors.deleteFailed");
      return;
    }
    this.busy = true;
    this.error = null;
    this.notice = null;
    try {
      const saved = await config.patchFromSnapshot((base) => {
        const result = buildCloudWorkerDeletePatch(base, profileId);
        return "error" in result
          ? { error: t("cloudWorkersPage.errors.profileMissing") }
          : {
              options: {
                raw: result.patch,
                note: `cloud session profile: remove ${profileId}`,
                canDispatch,
              },
            };
      });
      if (!isCurrent()) {
        return;
      }
      if (!saved) {
        throw new Error(config.state.lastError ?? t("cloudWorkersPage.errors.deleteFailed"));
      }
      if (this.description) {
        this.description = {
          ...this.description,
          profiles: this.description.profiles.filter((profile) => profile.profileId !== profileId),
        };
      }
      this.checks = Object.fromEntries(
        Object.entries(this.checks).filter(([id]) => id !== profileId),
      );
      this.notice = "saved";
    } catch (error) {
      if (isCurrent()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (isCurrent()) {
        this.busy = false;
      }
    }
  }

  private async load() {
    const scope = this.gateway.capture();
    if (!scope || this.busy || !this.available("plugins.list")) {
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      await this.context.runtimeConfig.ensureLoaded();
      if (!this.gateway.isCurrent(scope)) {
        return;
      }
      const catalog = await scope.client.request<PluginsListResult>("plugins.list", {});
      if (!this.gateway.isCurrent(scope)) {
        return;
      }
      this.owners = catalog.plugins.flatMap((plugin) =>
        (plugin.workerSetup ?? []).map((descriptor) => ({ plugin, descriptor })),
      );
      this.mutationAllowed = catalog.mutationAllowed;
      if (!this.owner()) {
        const requested = new URLSearchParams(window.location.search).get("plugin");
        const first = this.owners.find(({ plugin }) => plugin.id === requested) ?? this.owners[0];
        this.selected = first ? `${first.plugin.id}/${first.descriptor.id}` : "";
      }
      const owner = this.owner();
      if (
        owner?.plugin.enabled &&
        this.available(owner.descriptor.methods.describe) &&
        !this.waitingForRestart
      ) {
        const description = await scope.client.request<WorkerSetupDescribeResult>(
          owner.descriptor.methods.describe,
          {},
        );
        if (!this.gateway.isCurrent(scope)) {
          return;
        }
        this.description = description;
      }
      if (
        this.notice === "saved" &&
        !this.waitingForRestart &&
        !this.context.runtimeConfig.state.configNeedsApply
      ) {
        this.notice = null;
      }
      this.loaded = true;
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.busy = false;
        this.selectOnlyProvider();
      }
    }
  }

  private selectOwner(selected: string) {
    if (this.busy || this.draft?.profileId) {
      return;
    }
    this.clearPlaintext();
    this.selected = selected;
    this.draft = null;
    this.description = null;
    this.checks = {};
    this.error = null;
    this.notice = null;
    void this.load();
  }

  private async enable() {
    const scope = this.gateway.capture();
    const owner = this.owner();
    const config = this.context.runtimeConfig;
    if (
      !scope ||
      !owner ||
      this.busy ||
      !this.mutationAllowed ||
      !this.available("plugins.setEnabled")
    ) {
      return;
    }
    const isCurrent = () =>
      this.gateway.isCurrent(scope) &&
      this.context.runtimeConfig === config &&
      this.owner() === owner;
    this.busy = true;
    this.error = null;
    try {
      const result = await config.runExternalMutation(
        async (client) => {
          if (!isCurrent() || client !== scope.client) {
            throw new Error(t("cloudSetup.reconnect"));
          }
          return setPluginEnabled(client, owner.plugin.id, true);
        },
        { canDispatch: isCurrent },
      );
      if (!isCurrent()) {
        return;
      }
      if (!result.ok) {
        throw new Error(result.error);
      }
      this.owners = this.owners.map((entry) =>
        entry.plugin.id === owner.plugin.id
          ? { descriptor: entry.descriptor, plugin: result.value.plugin }
          : entry,
      );
      this.waitingForRestart = result.value.restartRequired;
      this.notice = this.waitingForRestart ? "saved" : null;
      if (!result.refresh.ok) {
        this.error = result.refresh.error;
      }
    } catch (error) {
      if (isCurrent()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.busy = false;
      }
    }
    if (this.gateway.isCurrent(scope) && !this.waitingForRestart) {
      void this.load();
    }
  }

  private async installDependency() {
    const scope = this.gateway.capture();
    const owner = this.owner();
    if (!scope || !owner || this.busy || !this.available(owner.descriptor.methods.install)) {
      return;
    }
    const isCurrent = () => this.gateway.isCurrent(scope) && this.owner() === owner;
    const confirmed = await showConfirmDialog({
      title: t("cloudSetup.installTitle"),
      message: t("cloudSetup.installConsent"),
      confirmLabel: t("cloudSetup.install"),
    });
    // Consent belongs to the exact Gateway and owner shown in the dialog.
    if (!confirmed || !isCurrent() || this.busy) {
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      const result = await scope.client.request<WorkerSetupInstallResult>(
        owner.descriptor.methods.install,
        {},
      );
      if (!isCurrent()) {
        return;
      }
      if (this.description) {
        this.description = {
          ...this.description,
          dependency: result.dependency,
          diagnostics: result.diagnostics,
        };
      }
      if (result.status === "failed") {
        this.error = t("cloudSetup.installFailed");
        return;
      }
    } catch (error) {
      if (isCurrent()) {
        this.error = formatUiError(error);
      }
      return;
    } finally {
      if (isCurrent()) {
        this.busy = false;
      }
    }
    if (isCurrent()) {
      void this.load();
    }
  }

  private selectProvider(providerId: string) {
    const provider = this.description?.providers.find((candidate) => candidate.id === providerId);
    if (!provider || provider.compatibility !== "guided" || this.busy || this.draft?.profileId) {
      return;
    }
    this.clearPlaintext();
    this.draft = {
      connectionId: `cloud-${crypto.randomUUID()}`,
      profileId: "",
      label: provider.label,
      profileName: provider.label,
      reusingConnection: false,
      provider: provider.id,
      settings: structuredClone(provider.defaults),
      credentials: {},
      values: {},
      revealed: {},
      secretNames: {},
      storedSecret: false,
    };
    this.error = null;
    this.notice = null;
  }

  private selectOnlyProvider() {
    const providers = this.description?.providers.filter(
      (provider) => provider.compatibility === "guided",
    );
    const provider = providers?.length === 1 ? providers[0] : undefined;
    if (this.adding && !this.draft && provider) {
      this.selectProvider(provider.id);
    }
  }

  private selectConnection(connectionId: string) {
    const connection = this.description?.connections.find(
      (entry) => entry.connectionId === connectionId,
    );
    if (!connection || !this.draft || this.busy || this.draft.profileId) {
      return;
    }
    this.clearPlaintext();
    this.draft = {
      ...this.draft,
      connectionId,
      label: connection.label,
      profileName: connection.label,
      reusingConnection: true,
      credentials: { ...connection.credentials },
      values: {},
      secretNames: {},
      storedSecret: false,
    };
  }

  private async save() {
    const scope = this.gateway.capture();
    const owner = this.owner();
    const draft = this.draft;
    const provider = this.description?.providers.find((entry) => entry.id === draft?.provider);
    const config = this.context.runtimeConfig;
    const description = this.description;
    if (
      !scope ||
      !owner ||
      !description ||
      !draft ||
      !provider ||
      provider.compatibility !== "guided" ||
      !this.canSave()
    ) {
      return;
    }
    if (
      !draft.label.trim() ||
      (draft.reusingConnection && !draft.profileName.trim()) ||
      provider.credentials.some(
        ({ key, required }) => required && !draft.credentials[key] && !draft.values[key]?.trim(),
      )
    ) {
      this.error = t("cloudSetup.required");
      return;
    }
    const source = resolveEditableSnapshotConfig(config.state.configSnapshot);
    if (!source) {
      this.error = t("cloudSetup.configUnavailable");
      return;
    }
    if (
      draft.profileId &&
      readCloudWorkerProfiles(source).some((profile) => profile.id === draft.profileId)
    ) {
      this.error = t("cloudSetup.profileExists", { id: draft.profileId });
      return;
    }
    // Reserve before any durable request. A retry must never pick another suffix
    // after a lost successful response or overwrite a newly claimed profile.
    draft.profileId ||= nextCloudWorkerProfileId(
      draft.reusingConnection ? draft.profileName : draft.label,
      source,
    );
    const isCurrent = () =>
      this.gateway.isCurrent(scope) &&
      this.context.runtimeConfig === config &&
      this.owner() === owner &&
      this.draft === draft;
    this.busy = true;
    this.error = null;
    this.notice = null;
    try {
      const saved = await saveCloudConnection({
        client: scope.client,
        config,
        draft,
        credentials: provider.credentials,
        prepareMethod: owner.descriptor.methods.prepare,
        isCurrent,
        canStoreSecret: () => this.available("secrets.store.set"),
        onStored: () => this.requestUpdate(),
      });
      if (!saved || !isCurrent()) {
        return;
      }
      const { prepared, params } = saved;
      this.waitingForRestart = prepared.restartRequired;
      this.notice = "saved";
      this.draft = null;
      this.adding = false;
      this.description = {
        ...description,
        profiles: [
          ...(this.description?.profiles ?? []).filter(
            (profile) => profile.profileId !== prepared.profileId,
          ),
          {
            profileId: prepared.profileId,
            connectionId: prepared.connectionId,
            label: params.label,
            provider: params.provider,
            settings: params.settings,
          },
        ],
      };
    } catch (error) {
      if (isCurrent()) {
        this.error = draft.storedSecret
          ? t("cloudSetup.partialSave", { error: formatUiError(error) })
          : formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.busy = false;
      }
    }
  }

  private async check(profileId: string) {
    const scope = this.gateway.capture();
    const owner = this.owner();
    const config = this.context.runtimeConfig;
    const revision = config.state.configSnapshot?.hash;
    if (
      !scope ||
      !owner ||
      !revision ||
      this.busy ||
      this.waitingForRestart ||
      this.context.runtimeConfig.state.configNeedsApply ||
      !this.available(owner.descriptor.methods.check)
    ) {
      return;
    }
    const isCurrent = () =>
      this.gateway.isCurrent(scope) &&
      this.owner() === owner &&
      this.context.runtimeConfig === config;
    this.busy = true;
    this.error = null;
    try {
      const result = await scope.client.request<WorkerSetupCheckResult>(
        owner.descriptor.methods.check,
        { profileId },
      );
      if (isCurrent()) {
        if (config.state.configSnapshot?.hash === revision) {
          this.checks = { ...this.checks, [profileId]: result };
        } else {
          this.error = t("cloudSetup.checkChanged");
        }
      }
    } catch (error) {
      if (isCurrent()) {
        this.error =
          config.state.configSnapshot?.hash === revision
            ? formatUiError(error)
            : t("cloudSetup.checkChanged");
      }
    } finally {
      if (isCurrent()) {
        this.busy = false;
      }
    }
  }

  override render() {
    const admin = hasOperatorAdminAccess(this.gateway.snapshot?.hello?.auth ?? null);
    const owner = this.owner();
    const awaitingApply =
      this.waitingForRestart || this.context.runtimeConfig.state.configNeedsApply;
    const source = resolveEditableSnapshotConfig(this.context.runtimeConfig.state.configSnapshot);
    return html`<div class="settings-stack">
      ${renderCloudProviderSetup({
        admin,
        profiles: readCloudWorkerProfiles(source),
        draftProfileId: this.draft
          ? this.draft.profileId ||
            nextCloudWorkerProfileId(
              this.draft.reusingConnection ? this.draft.profileName : this.draft.label,
              source,
            )
          : "",
        canManageProfiles: this.canManageProfiles(),
        onDelete: (profileId, label) => void this.deleteProfile(profileId, label),
        owners: this.owners,
        owner,
        selected: this.selected,
        description: this.description,
        draft: this.draft,
        checks: this.checks,
        configRevision: this.context.runtimeConfig.state.configSnapshot?.hash,
        adding: this.adding,
        advanced: this.advanced,
        loaded: this.loaded,
        busy: this.busy,
        error: this.error,
        notice: this.notice
          ? t(this.notice === "saved" ? "cloudSetup.applyRestart" : "cloudSetup.interrupted")
          : null,
        awaitingApply,
        canSave: this.canSave(),
        configUnavailable: !this.context.runtimeConfig.state.configSnapshot?.hash
          ? (this.context.runtimeConfig.state.lastError ?? t("cloudSetup.configUnavailable"))
          : null,
        available: (method) => this.available(method),
        mutationAllowed: this.mutationAllowed,
        test: this.context.cloudSessionTest.state,
        canTest:
          this.context.cloudSessionTest.canStart &&
          !this.adding &&
          Boolean(this.context.runtimeConfig.state.configSnapshot?.hash),
        onTest: (profileId, label) => {
          const revision = this.context.runtimeConfig.state.configSnapshot?.hash;
          if (revision) {
            this.context.cloudSessionTest.start(profileId, label, revision);
          }
        },
        onAdd: () => {
          this.adding = true;
          this.error = null;
          this.selectOnlyProvider();
        },
        onClose: () => {
          this.clearPlaintext();
          this.draft = null;
          this.adding = false;
          this.error = null;
        },
        onRefresh: () => void this.load(),
        onOwner: (value) => this.selectOwner(value),
        onEnable: () => void this.enable(),
        onInstall: () => void this.installDependency(),
        onProvider: (value) => this.selectProvider(value),
        onConnection: (value) => this.selectConnection(value),
        onDraft: (patch) => {
          if (this.draft && !this.busy) {
            this.draft = { ...this.draft, ...patch };
          }
        },
        onAdvanced: (value) => {
          this.advanced = value;
        },
        onSave: () => void this.save(),
        onCheck: (profileId) => void this.check(profileId),
        onStart: (profileId) =>
          this.context.navigate("new-session", {
            search: cloudSetupSessionSearch(window.location.search, profileId),
          }),
        idleStop: (profileId) => {
          const cloud = isRecord(source?.cloudWorkers) ? source.cloudWorkers : null;
          const profiles = isRecord(cloud?.profiles) ? cloud.profiles : null;
          const profile = isRecord(profiles?.[profileId]) ? profiles[profileId] : null;
          return typeof profile?.suspendAfter === "string" ? profile.suspendAfter : undefined;
        },
        onPlugins: () => this.context.navigate("plugins"),
        onAdvancedConfig: () =>
          this.context.navigate("advanced", { search: "?section=cloudWorkers" }),
        onConnectionSettings: () => this.context.navigate("connection"),
        onSecrets: () => this.context.navigate("secrets"),
        onEndpointSettings: () => this.context.navigate("advanced", { search: "?section=gateway" }),
      })}
      ${admin ? renderCloudSessionTest(this.context) : html``}
    </div>`;
  }
}

if (!customElements.get("openclaw-cloud-provider-setup")) {
  customElements.define("openclaw-cloud-provider-setup", CloudProviderSetup);
}

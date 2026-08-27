import { consume } from "@lit/context";
import { initialState, Task } from "@lit/task";
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import type { PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { FastMode, ModelsProbeResult } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { UsageRefreshPolicy } from "../usage/refresh-policy.ts";
import {
  modelProviderErrorMessage,
  runModelProviderConfigMutation,
  type ModelProviderConfigMutation,
  type ModelProviderConfigMutationResult,
} from "./config-mutation.ts";
import {
  buildSelectableDefaultModels,
  buildUnconfiguredProviderOptions,
  readModelProviderConfig,
  type DefaultModelSelection,
} from "./data.ts";
import {
  EMPTY_MODEL_PROVIDERS_DATA,
  loadModelProvidersData,
  MODEL_PROVIDERS_COST_DAYS,
  refreshModelProvidersAuthStatus,
  type ModelProvidersData,
} from "./load.ts";
import { readModelBehaviorConfig } from "./model-behavior.ts";
import {
  buildDefaultModelsPatch,
  buildProviderApiKeyPatch,
  DEFAULT_MODELS_REPLACE_PATHS,
} from "./mutations.ts";
import { renderModelProvidersPageChrome } from "./page-chrome.ts";
import { isMissingMethodError, mergeProbeResults } from "./probe-results.ts";
import { ProfileDeadlineController } from "./profile-deadline-controller.ts";
import {
  ProfileOrderController,
  readProviderProfileMutationAccess,
  type ProfileOrderDrafts,
} from "./profile-order-controller.ts";
import type { ModelProvidersRouteData } from "./route.ts";
import { renderModelProviders, type ModelProviderRowMessage } from "./view.ts";

export class ModelProvidersPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData: ModelProvidersRouteData | undefined;

  @state() private data: ModelProvidersData | null = null;
  @state() private busy: Record<string, boolean> = {};
  @state() private messages: Record<string, ModelProviderRowMessage> = {};
  @state() private probeResults: Record<string, ModelsProbeResult> = {};
  @state() private probeUnsupported = false;
  @state() private keyEditorProvider: string | null = null;
  @state() private keyDraft = "";
  @state() private addProviderOpen = false;
  @state() private addProviderId = "";
  @state() private addProviderKey = "";
  @state() private defaultsDraft: DefaultModelSelection | null = null;
  @state() private selectedAgentId = "";
  @state() private profileOrderDrafts: ProfileOrderDrafts = {};
  /** Client the current data was loaded from; a new client means stale data. */
  private dataClient: GatewayBrowserClient | null = null;
  // Null Task runs supersede stale work without counting as a real load.
  private loadClient: GatewayBrowserClient | null = null;
  private routeDataObserved = false;
  private refreshRequestId = 0;
  private appliedRefreshRequestId = 0;
  // Global config writes survive agent switches; their card state does not.
  private agentEpoch = 0;
  private probeEpochs = new Map<string, number>();
  private readonly profileDeadline = new ProfileDeadlineController(
    this,
    () => this.data,
    () =>
      void refreshModelProvidersAuthStatus(
        () => ({
          agentId: this.selectedAgentId,
          client: this.gateway.client,
          clientEpoch: this.gateway.epoch,
          connected: this.gateway.connected,
          data: this.data,
          dataClient: this.dataClient,
        }),
        (client, data) => this.adoptLoadedData(client, data),
      ),
  );
  private readonly refreshTask = new Task(this, {
    autoRun: false,
    task: (
      [client, agentId, force, requestId]: [GatewayBrowserClient | null, string, boolean, number],
      { signal },
    ) => {
      if (!client || !agentId) {
        return initialState;
      }
      this.refreshPolicy.beginLoad();
      return loadModelProvidersData(client, {
        agentId,
        ...(force ? { refresh: true } : {}),
        signal,
      }).then((data) => ({ client, data, requestId }));
    },
    onComplete: ({ client, data, requestId }) => {
      this.loadClient = null;
      this.adoptLoadedData(client, data);
      this.appliedRefreshRequestId = requestId;
      this.refreshPolicy.flushPending();
    },
    onError: () => {
      this.loadClient = null;
      this.refreshPolicy.flushPending();
    },
  });
  private readonly refreshPolicy = new UsageRefreshPolicy({
    isLoading: () => this.loadClient !== null,
    reload: () => void this.refresh({ force: false }),
  });
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => this.resetConnectionState(),
    invalidateRequests: () => this.invalidateRequests(),
    ensureInitialData: () => this.ensureInitialData(),
    onSnapshot: (change) => {
      if (change.initial) {
        this.resetConnectionState();
      } else if (change.connectionChanged && !change.identityChanged) {
        // Keep the last snapshot visible while the canonical reconnect load replaces it.
        this.resetConnectionState({ preserveVisibleData: true });
      }
      if (change.becameConnected && !change.initial) {
        this.refreshPolicy.request("reconnect");
      }
    },
    onPageActivation: () => this.refreshPolicy.request("focus"),
  });
  private readonly profileOrder = new ProfileOrderController({
    snapshot: () => this.context.gateway.snapshot,
    current: () => ({
      agentEpoch: this.agentEpoch,
      agentId: this.selectedAgentId,
      clientEpoch: this.gateway.epoch,
    }),
    isBusy: (key) => Boolean(this.busy[key]),
    isCurrentClient: (client, clientEpoch) => this.isCurrentClient(client, clientEpoch),
    prepareForMutation: () => {
      if (this.loadClient !== null) {
        this.invalidateRequests();
      }
    },
    refresh: () => this.refresh({ force: true, requireApplied: true }),
    clearProbe: (cardId) => this.clearProbe(cardId),
    getData: () => this.data,
    setData: (data) => (this.data = data),
    getDrafts: () => this.profileOrderDrafts,
    setDrafts: (drafts) => (this.profileOrderDrafts = drafts),
    setBusy: (key, value) => this.setBusy(key, value),
    setMessage: (key, message) => this.setMessage(key, message),
  });
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.runtimeConfig,
      (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
      (runtimeConfig) => {
        if (!runtimeConfig.state.configSnapshot && !runtimeConfig.state.configLoading) {
          void runtimeConfig.ensureLoaded().catch(() => undefined);
        }
      },
    )
    .watch(
      () => this.context?.overlays,
      (overlays, notify) => overlays.subscribe(notify),
    )
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
      () => this.syncSelectedAgent(),
    )
    .effect(
      () => this.context?.agentSelection,
      (selection) => selection.subscribe(() => this.syncSelectedAgent()),
    );

  override disconnectedCallback() {
    this.profileOrder.reset();
    this.profileDeadline.clear();
    this.subscriptions.clear();
    this.refreshPolicy.dispose();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues) {
    if (changed.has("routeData") && this.routeData !== undefined) {
      this.routeDataObserved = true;
      const selected = this.context.agentSelection.state.selectedId;
      const selectedAgentId = selected ? normalizeAgentId(selected) : "";
      this.setSelectedAgent(selectedAgentId);
      if (
        (this.routeData.agentId ?? "") === selectedAgentId &&
        this.gateway.isRouteDataCurrent(this.routeData)
      ) {
        this.adoptLoadedData(this.routeData.client, this.routeData.data);
      } else {
        this.data = null;
        this.dataClient = null;
        this.refreshPolicy.resetPayload();
      }
      this.ensureInitialData();
    }
  }

  private ensureInitialData() {
    if (
      !this.context.agents.state.agentsList &&
      !this.context.agents.state.agentsLoading &&
      !this.context.agents.state.agentsError
    ) {
      void this.context.agents.ensureList();
    }
    if (!this.routeDataObserved && this.routeData !== undefined) {
      return;
    }
    const client = this.gateway.client;
    if (
      !this.gateway.connected ||
      !client ||
      !this.selectedAgentId ||
      this.loadClient !== null ||
      (this.data !== null && this.data.updatedAt !== null && client === this.dataClient)
    ) {
      return;
    }
    void this.refresh({ force: false });
  }

  private adoptLoadedData(client: GatewayBrowserClient | null, data: ModelProvidersData) {
    this.profileOrder.applyData(data);
    this.dataClient = client;
    this.refreshPolicy.setLastLoadedAtMs(data.authStatus ? data.updatedAt : null);
    this.profileDeadline.scheduleUsageRefresh(data.authStatus?.usageRefreshPending === true);
  }

  private invalidateRequests() {
    this.refreshPolicy.interrupt();
    this.loadClient = null;
    void this.refreshTask.run([null, this.selectedAgentId, false, ++this.refreshRequestId]);
  }

  private resetConnectionState(options: { preserveVisibleData?: boolean } = {}) {
    this.profileDeadline.clear();
    if (!options.preserveVisibleData) {
      this.data = null;
      this.dataClient = null;
    }
    this.refreshPolicy.resetPayload();
    this.resetAgentScopeState();
    this.probeEpochs = new Map();
    this.probeUnsupported = false;
    this.defaultsDraft = null;
  }

  private resetAgentScopeState() {
    this.busy = {};
    this.messages = {};
    this.probeResults = {};
    this.closeKeyEditor();
    this.addProviderOpen = false;
    this.addProviderId = "";
    this.addProviderKey = "";
    this.profileOrder.reset();
  }

  private isCurrentClient(client: GatewayBrowserClient, epoch: number): boolean {
    return this.gateway.isCurrent({ client, epoch });
  }

  private setSelectedAgent(agentId: string): boolean {
    if (agentId === this.selectedAgentId) {
      return false;
    }
    this.selectedAgentId = agentId;
    this.profileDeadline.clear();
    this.agentEpoch += 1;
    this.resetAgentScopeState();
    return true;
  }

  private syncSelectedAgent() {
    const selected = this.context.agentSelection.state.selectedId;
    const agentId = selected ? normalizeAgentId(selected) : "";
    if (!this.setSelectedAgent(agentId)) {
      return;
    }
    this.invalidateRequests();
    this.data = null;
    this.dataClient = null;
    this.refreshPolicy.resetPayload();
    // probeEpochs stays: per-card counters must remain monotonic across agent
    // switches, or an in-flight probe from the old agent can reuse an epoch
    // and clobber a newer probe's state (A->B->A ABA race).
    this.requestUpdate();
    this.ensureInitialData();
  }

  private async refresh(opts: { force: boolean; requireApplied?: boolean }): Promise<void> {
    this.profileDeadline.clear();
    if (!this.selectedAgentId) {
      if (opts.requireApplied) {
        throw new Error("Provider refresh unavailable");
      }
      return;
    }
    const client = this.gateway.client;
    if (!this.gateway.connected || !client) {
      this.refreshPolicy.markLoadDeferred();
      if (opts.requireApplied) {
        throw new Error("Provider refresh unavailable");
      }
      return;
    }
    const requestId = ++this.refreshRequestId;
    if (opts.force) {
      this.refreshPolicy.resetPayload();
    }
    this.loadClient = client;
    await this.refreshTask.run([client, this.selectedAgentId, opts.force, requestId]);
    if (opts.requireApplied && this.appliedRefreshRequestId !== requestId) {
      throw new Error("Provider refresh was superseded");
    }
  }

  private mutationBlockedReason(): string | null {
    const snapshot = this.context.gateway.snapshot;
    if (snapshot.phase !== "connected") {
      return t("modelProviders.readOnly.disconnected");
    }
    if (!hasOperatorAdminAccess(snapshot.hello?.auth ?? null)) {
      return t("modelProviders.readOnly.adminRequired");
    }
    if (!snapshot.client || !this.selectedAgentId || !this.data?.config) {
      return t("modelProviders.configUnavailable");
    }
    return null;
  }

  private canMutate(): boolean {
    return this.mutationBlockedReason() === null && !this.configBusy();
  }

  private configBusy(): boolean {
    const runtimeState = this.context.runtimeConfig.state;
    const update = this.context.overlays.snapshot;
    return (
      runtimeState.configLoading ||
      runtimeState.configSaving ||
      runtimeState.configApplying ||
      update.updateRunning ||
      update.updateReconciliationPending
    );
  }

  private setBusy(key: string, value: boolean) {
    const next = { ...this.busy };
    if (value) {
      next[key] = true;
    } else {
      delete next[key];
    }
    this.busy = next;
  }

  private setMessage(key: string, message: ModelProviderRowMessage | null) {
    const next = { ...this.messages };
    if (message) {
      next[key] = message;
    } else {
      delete next[key];
    }
    this.messages = next;
  }

  private clearProbe(provider: string) {
    this.probeEpochs.set(provider, (this.probeEpochs.get(provider) ?? 0) + 1);
    this.setBusy(`probe:${provider}`, false);
    const next = { ...this.probeResults };
    delete next[provider];
    this.probeResults = next;
  }

  private async patchConfig(
    params: ModelProviderConfigMutation,
  ): Promise<ModelProviderConfigMutationResult> {
    if (!this.canMutate() || this.busy[params.key]) {
      return { ok: false };
    }
    const client = this.context.gateway.snapshot.client;
    if (!client) {
      return { ok: false };
    }
    const clientEpoch = this.gateway.epoch;
    const agentEpoch = this.agentEpoch;
    return runModelProviderConfigMutation(
      {
        runtimeConfig: this.context.runtimeConfig,
        agentEpoch,
        isCurrentClient: () => this.isCurrentClient(client, clientEpoch),
        isCurrentAgent: () => this.agentEpoch === agentEpoch,
        refreshProviders: () => this.refresh({ force: true }),
        setBusy: (busy) => this.setBusy(params.key, busy),
        setMessage: (message) => this.setMessage(params.key, message),
      },
      params,
    );
  }

  private openKeyEditor(provider: string) {
    this.keyEditorProvider = provider;
    this.keyDraft = "";
    this.setMessage(provider, null);
  }

  private closeKeyEditor() {
    this.keyEditorProvider = null;
    this.keyDraft = "";
  }

  private async saveKey(provider: string, configKey: string) {
    const apiKey = this.keyDraft.trim();
    if (!apiKey) {
      return;
    }
    this.clearProbe(provider);
    this.setMessage(provider, null);
    this.setMessage(`key:${provider}`, null);
    const result = await this.patchConfig({
      key: `key:${provider}`,
      raw: buildProviderApiKeyPatch(configKey, apiKey),
      note: t("modelProviders.notes.saveKey", { provider }),
      success: t("modelProviders.apiKey.saved"),
    });
    if (result.ok && this.agentEpoch === result.agentEpoch) {
      this.setMessage(`key:${provider}`, null);
      if (this.keyEditorProvider === provider && this.keyDraft.trim() === apiKey) {
        this.closeKeyEditor();
      }
      this.setMessage(provider, {
        kind: "success",
        text: t("modelProviders.apiKey.saved"),
        ...(result.warning ? { warning: result.warning } : {}),
      });
    }
  }

  private async removeKey(provider: string, configKey: string) {
    this.clearProbe(provider);
    this.setMessage(provider, null);
    this.setMessage(`key:${provider}`, null);
    const result = await this.patchConfig({
      key: `key:${provider}`,
      raw: buildProviderApiKeyPatch(configKey, null),
      note: t("modelProviders.notes.removeKey", { provider }),
      success: t("modelProviders.apiKey.removed"),
    });
    if (result.ok && this.agentEpoch === result.agentEpoch) {
      this.setMessage(`key:${provider}`, null);
      if (this.keyEditorProvider === provider) {
        this.closeKeyEditor();
      }
      this.setMessage(provider, {
        kind: "success",
        text: t("modelProviders.apiKey.removed"),
        ...(result.warning ? { warning: result.warning } : {}),
      });
    }
  }

  private async probe(cardId: string, providers: string[]) {
    const client = this.context.gateway.snapshot.client;
    const key = `probe:${cardId}`;
    if (!client || !this.canMutate() || this.busy[key] || this.probeUnsupported) {
      return;
    }
    const clientEpoch = this.gateway.epoch;
    const agentId = this.selectedAgentId;
    const agentEpoch = this.agentEpoch;
    const probeEpoch = (this.probeEpochs.get(cardId) ?? 0) + 1;
    this.probeEpochs.set(cardId, probeEpoch);
    const ownsProbe = () =>
      this.isCurrentClient(client, clientEpoch) &&
      this.agentEpoch === agentEpoch &&
      this.selectedAgentId === agentId &&
      this.probeEpochs.get(cardId) === probeEpoch;
    this.setBusy(key, true);
    this.setMessage(cardId, null);
    try {
      const results: ModelsProbeResult[] = [];
      for (const provider of providers) {
        if (!ownsProbe()) {
          return;
        }
        results.push(
          await client.request<ModelsProbeResult>("models.probe", { provider, agentId }),
        );
      }
      if (ownsProbe()) {
        this.probeResults = {
          ...this.probeResults,
          [cardId]: mergeProbeResults(cardId, results),
        };
      }
    } catch (error) {
      if (!ownsProbe()) {
        return;
      }
      if (isMissingMethodError(error)) {
        this.probeUnsupported = true;
        this.setMessage(cardId, {
          kind: "error",
          text: t("modelProviders.probe.unavailable"),
        });
      } else {
        this.setMessage(cardId, { kind: "error", text: modelProviderErrorMessage(error) });
      }
    } finally {
      if (ownsProbe()) {
        this.setBusy(key, false);
      }
    }
  }

  private async addProvider() {
    const provider = this.addProviderId;
    const apiKey = this.addProviderKey.trim();
    if (!provider || !apiKey) {
      return;
    }
    const result = await this.patchConfig({
      key: "add",
      raw: buildProviderApiKeyPatch(provider, apiKey),
      note: t("modelProviders.notes.addProvider", { provider }),
      success: t("modelProviders.add.saved", { provider }),
    });
    if (result.ok && this.agentEpoch === result.agentEpoch) {
      if (this.addProviderId === provider && this.addProviderKey.trim() === apiKey) {
        // A failed refresh leaves a new provider without a card. Keep its
        // success + warning visible in the open form instead of losing both.
        this.addProviderOpen = Boolean(result.warning);
        if (!result.warning) {
          this.addProviderId = "";
        }
        this.addProviderKey = "";
      }
      this.setMessage(provider, {
        kind: "success",
        text: t("modelProviders.add.saved", { provider }),
        ...(result.warning ? { warning: result.warning } : {}),
      });
    }
  }

  private async saveDefaultModels() {
    const selection = this.defaultsDraft;
    if (!selection?.primary) {
      return;
    }
    const result = await this.patchConfig({
      key: "defaults",
      raw: buildDefaultModelsPatch(selection.primary, selection.fallbacks, selection.utilityModel),
      note: t("modelProviders.notes.defaultModel"),
      success: t("modelProviders.defaults.saved"),
      replacePaths: DEFAULT_MODELS_REPLACE_PATHS,
    });
    // Keep the draft when fresh provider data is unavailable after commit.
    if (
      result.ok &&
      !result.warning &&
      this.agentEpoch === result.agentEpoch &&
      this.defaultsDraft === selection
    ) {
      this.defaultsDraft = null;
    }
  }

  override render() {
    const gatewaySnapshot = this.context.gateway.snapshot;
    const agentsState = this.context.agents.state;
    const agents = agentsState.agentsList?.agents ?? [];
    const rosterError = agentsState.agentsList ? null : agentsState.agentsError;
    const data = this.data ?? EMPTY_MODEL_PROVIDERS_DATA;
    const config = readModelProviderConfig(data.config);
    const defaults = this.defaultsDraft ?? config.defaults;
    const runtimeConfig = this.context.runtimeConfig;
    const runtimeState = runtimeConfig.state;
    const configObject =
      asConfigRecord(runtimeState.configForm ?? runtimeState.configSnapshot?.config) ??
      asConfigRecord(data.config) ??
      {};
    const agentsDefaults = asConfigRecord(asConfigRecord(configObject.agents)?.defaults);
    const modelBehavior = readModelBehaviorConfig(agentsDefaults);
    // This keeps the pre-move General busy gate sourced from the same update state.
    const cards = this.profileOrder.buildCards(data);
    const configuredProviderIds = new Set([
      ...config.providerIds,
      ...(data.authStatus?.providers
        .filter((provider) => Boolean(provider.apiKey) || provider.profiles.length > 0)
        .map((provider) => provider.provider) ?? []),
    ]);
    const probeAdvertised = isGatewayMethodAdvertised(gatewaySnapshot, "models.probe");
    const body = renderModelProviders({
      connected: gatewaySnapshot.phase === "connected",
      loading: gatewaySnapshot.phase === "connected" && this.data === null && !rosterError,
      refreshing: this.loadClient !== null,
      error: rosterError ?? data.error ?? data.catalogError,
      updatedAt: data.updatedAt,
      costDays: MODEL_PROVIDERS_COST_DAYS,
      cards,
      configuredModels: buildSelectableDefaultModels(data.models, defaults),
      defaultModels: defaults,
      defaultModelsDirty: this.defaultsDraft !== null,
      ...modelBehavior,
      configBusy: this.configBusy(),
      quickAddSupported: data.authStatus?.providerCapabilities !== undefined,
      unconfiguredProviders: buildUnconfiguredProviderOptions(
        data.authStatus?.providerCapabilities,
        configuredProviderIds,
      ),
      canMutate: this.canMutate(),
      mutationBlockedReason: this.mutationBlockedReason(),
      probeAvailable: !this.probeUnsupported && probeAdvertised !== false,
      ...readProviderProfileMutationAccess(gatewaySnapshot, this.selectedAgentId),
      busy: this.busy,
      messages: this.messages,
      probeResults: this.probeResults,
      keyEditorProvider: this.keyEditorProvider,
      keyDraft: this.keyDraft,
      addProviderOpen: this.addProviderOpen,
      addProviderId: this.addProviderId,
      addProviderKey: this.addProviderKey,
      onRefresh: () =>
        void (rosterError ? this.context.agents.refreshList() : this.refresh({ force: true })),
      onOpenKeyEditor: (provider) => this.openKeyEditor(provider),
      onCloseKeyEditor: () => this.closeKeyEditor(),
      onKeyDraftChange: (value) => (this.keyDraft = value),
      onSaveKey: (provider, configKey) => void this.saveKey(provider, configKey),
      onRemoveKey: (provider, configKey) => void this.removeKey(provider, configKey),
      onProbe: (cardId, providers) => void this.probe(cardId, providers),
      onLogoutProfile: (cardId, provider, owner, profileId, label) =>
        void this.profileOrder.requestLogout(
          cardId,
          provider,
          owner,
          profileId,
          label,
          t("modelProviders.logout.done"),
        ),
      onProfileOrderChange: (owner, profileIds) => this.profileOrder.queue(owner, profileIds ?? []),
      onClearProfileCooldown: (owner, provider, profileId) =>
        void this.profileOrder.mutate(
          `profiles:${owner}`,
          "models.authCooldownClear",
          { provider, profileId },
          `cooldown:${owner}`,
        ),
      onAddProviderToggle: () => {
        this.addProviderOpen = !this.addProviderOpen;
        this.addProviderKey = "";
        this.setMessage("add", null);
      },
      onAddProviderIdChange: (provider) => (this.addProviderId = provider),
      onAddProviderKeyChange: (value) => (this.addProviderKey = value),
      onAddProvider: () => void this.addProvider(),
      onPrimaryChange: (model) => {
        this.defaultsDraft = {
          ...defaults,
          primary: model,
          fallbacks: defaults.fallbacks.filter((fallback) => fallback !== model),
        };
        this.setMessage("defaults", null);
      },
      onFallbackAdd: (model) => {
        this.defaultsDraft = {
          ...defaults,
          fallbacks: [...defaults.fallbacks, model],
        };
        this.setMessage("defaults", null);
      },
      onFallbackRemove: (index) => {
        this.defaultsDraft = {
          ...defaults,
          fallbacks: defaults.fallbacks.filter((_, candidate) => candidate !== index),
        };
        this.setMessage("defaults", null);
      },
      onUtilityChange: (model) => {
        this.defaultsDraft = { ...defaults, utilityModel: model };
        this.setMessage("defaults", null);
      },
      onDefaultModelsSave: () => void this.saveDefaultModels(),
      onDefaultModelsReset: () => {
        this.defaultsDraft = null;
        this.setMessage("defaults", null);
      },
      onThinkingChange: (level) =>
        runtimeConfig.patchForm(["agents", "defaults", "thinkingDefault"], level),
      onThinkingReset: () =>
        runtimeConfig.removeFormValue(["agents", "defaults", "thinkingDefault"]),
      onFastModeChange: (mode: FastMode) =>
        runtimeConfig.patchForm(["agents", "defaults", "fastModeDefault"], mode),
      onFastModeReset: () =>
        runtimeConfig.removeFormValue(["agents", "defaults", "fastModeDefault"]),
      onOpenModelSetup: () => this.context.navigate("model-setup"),
    });
    return renderModelProvidersPageChrome({
      body,
      agents,
      selection: this.context.agentSelection,
      selectedId: this.selectedAgentId,
      onOpenModelSetup: () => this.context.navigate("model-setup"),
    });
  }
}

if (!customElements.get("openclaw-model-providers-page")) {
  customElements.define("openclaw-model-providers-page", ModelProvidersPage);
}

import type {
  ModelAuthCooldownClearResult,
  ModelAuthLogoutResult,
  ModelAuthOrderSetResult,
} from "../../../../src/gateway/server-methods/models-auth-status.types.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { modelProviderErrorMessage } from "./config-mutation.ts";
import {
  buildModelProviderCards,
  readModelProviderConfig,
  type ModelProviderCard,
} from "./data.ts";
import type { ModelProvidersData } from "./load.ts";
import type { ModelProviderRowMessage } from "./view.ts";

export type ProfileOrderDrafts = Record<string, string[]>;

export type ProfileMutationMethod =
  | "models.authOrderSet"
  | "models.authCooldownClear"
  | "models.authLogout";

type ProfileOrderHost = {
  snapshot: () => ApplicationGatewaySnapshot;
  current: () => { agentEpoch: number; agentId: string; clientEpoch: number };
  isBusy: (key: string) => boolean;
  isCurrentClient: (client: GatewayBrowserClient, clientEpoch: number) => boolean;
  prepareForMutation: (agentId: string) => void;
  refresh: () => Promise<void>;
  clearProbe: (cardId: string) => void;
  getData: () => ModelProvidersData | null;
  setData: (data: ModelProvidersData) => void;
  getDrafts: () => ProfileOrderDrafts;
  setDrafts: (drafts: ProfileOrderDrafts) => void;
  setBusy: (key: string, value: boolean) => void;
  setMessage: (key: string, message: ModelProviderRowMessage | null) => void;
};

type ProfileMutationContext = {
  client: GatewayBrowserClient;
  clientEpoch: number;
  agentEpoch: number;
  agentId: string;
};

function canMutateProviderProfiles(
  snapshot: ApplicationGatewaySnapshot,
  agentId: string,
  method: ProfileMutationMethod,
): boolean {
  return Boolean(agentId) && canCallGatewayMethod(snapshot, method, "operator.admin");
}

export function readProviderProfileMutationAccess(
  snapshot: ApplicationGatewaySnapshot,
  agentId: string,
) {
  const can = (method: ProfileMutationMethod) =>
    canMutateProviderProfiles(snapshot, agentId, method);
  return {
    profileCanReorder: can("models.authOrderSet"),
    profileCanLogout: can("models.authLogout"),
    profileCanClearCooldown: can("models.authCooldownClear"),
  };
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function buildCards(data: ModelProvidersData) {
  const config = readModelProviderConfig(data.config);
  return buildModelProviderCards({
    ...data,
    configProviderIds: config.providerIds,
    configApiKeyProviderIds: config.apiKeyProviderIds,
    configProviderAuthModes: config.providerAuthModes,
  });
}

export class ProfileOrderController {
  private saves = new Map<string, Promise<void>>();
  private providers = new Map<string, string>();
  private memberships = new Map<string, string[]>();
  private logoutConfirmation: AbortController | null = null;

  constructor(private readonly host: ProfileOrderHost) {}

  reset() {
    this.logoutConfirmation?.abort();
    this.logoutConfirmation = null;
    this.saves.clear();
    this.providers.clear();
    this.memberships.clear();
    this.host.setDrafts({});
  }

  applyData(data: ModelProvidersData) {
    this.host.setData(data);
  }

  buildCards(data: ModelProvidersData): ModelProviderCard[] {
    const drafts = this.host.getDrafts();
    return buildCards(data).map((card) => {
      const ownedDrafts = Object.entries(drafts).filter(
        ([owner]) => card.profileOwnerProfileIds[owner] !== undefined,
      );
      if (ownedDrafts.length === 0) {
        return card;
      }
      const profileOrder = [...card.profileOrder];
      for (const profile of card.profiles) {
        if (!profileOrder.includes(profile.profileId)) {
          profileOrder.push(profile.profileId);
        }
      }
      const profileOrders = { ...card.profileOrders };
      const profileOrderProviders = { ...card.profileOrderProviders };
      const profileOrderFallbacks = { ...card.profileOrderFallbacks };
      for (const [owner, draft] of ownedDrafts) {
        const membership = card.profileOwnerProfileIds[owner] ?? [];
        const fallbackOrder = card.profileOrderFallbackOrders[owner];
        const visibleOrder = draft.length > 0 ? draft : (fallbackOrder ?? membership);
        if (draft.length === 0) {
          if (fallbackOrder) {
            profileOrders[owner] = fallbackOrder;
          } else {
            delete profileOrders[owner];
            delete profileOrderProviders[owner];
          }
          delete profileOrderFallbacks[owner];
        }
        const displayOrder = [
          ...visibleOrder,
          ...membership.filter((profileId) => !visibleOrder.includes(profileId)),
        ];
        const ownerIds = new Set(membership);
        let draftIndex = 0;
        for (let index = 0; index < profileOrder.length; index += 1) {
          if (ownerIds.has(profileOrder[index]!)) {
            profileOrder[index] = displayOrder[draftIndex++] ?? profileOrder[index]!;
          }
        }
        if (draft.length > 0) {
          profileOrders[owner] = draft;
          profileOrderFallbacks[owner] ??=
            card.profileOrders[owner] === undefined ? "automatic" : "config";
        }
      }
      return Object.assign({}, card, {
        profileOrder,
        profileOrders,
        profileOrderProviders,
        profileOrderFallbacks,
      });
    });
  }

  queue(provider: string, profileIds: string[]) {
    const client = this.host.snapshot().client;
    const owner = this.canonicalOwner(provider);
    const membership = owner ? this.ownerMembership(owner) : null;
    const { agentEpoch, agentId, clientEpoch } = this.host.current();
    if (
      !client ||
      !canMutateProviderProfiles(this.host.snapshot(), agentId, "models.authOrderSet") ||
      !owner ||
      !membership
    ) {
      return;
    }
    this.providers.set(owner, provider);
    this.memberships.set(owner, membership);
    this.setDraft(owner, profileIds);
    this.host.setMessage(`profiles:${owner}`, null);
    if (this.saves.has(owner)) {
      return;
    }

    this.host.prepareForMutation(agentId);
    this.host.setBusy(`profiles:${owner}`, true);
    const save = this.flush({ owner, client, clientEpoch, agentEpoch, agentId }).finally(() => {
      if (this.saves.get(owner) !== save) {
        return;
      }
      this.saves.delete(owner);
      if (this.isCurrent(client, clientEpoch, agentEpoch)) {
        this.host.setBusy(`profiles:${owner}`, false);
      }
    });
    this.saves.set(owner, save);
  }

  waitFor(owner: string): Promise<void> | undefined {
    return this.saves.get(owner);
  }

  async requestLogout(
    cardId: string,
    provider: string,
    owner: string,
    profileId: string,
    label: string,
    success: string,
  ) {
    const client = this.host.snapshot().client;
    const { agentEpoch, agentId, clientEpoch } = this.host.current();
    if (!client || !canMutateProviderProfiles(this.host.snapshot(), agentId, "models.authLogout")) {
      return;
    }
    const context = { client, clientEpoch, agentEpoch, agentId };
    const controller = new AbortController();
    this.logoutConfirmation?.abort();
    this.logoutConfirmation = controller;
    try {
      const confirmed = await showConfirmDialog({
        title: t("modelProviders.logout.profileTitle"),
        message: t("modelProviders.logout.profileConfirm", { account: label }),
        confirmLabel: t("modelProviders.logout.action"),
        danger: true,
        signal: controller.signal,
      });
      if (confirmed && this.isCurrent(client, clientEpoch, agentEpoch)) {
        await this.logout(cardId, provider, owner, profileId, success, context);
      }
    } finally {
      if (this.logoutConfirmation === controller) {
        this.logoutConfirmation = null;
      }
    }
  }

  async mutate(
    messageKey: string,
    method: "models.authCooldownClear",
    params: Record<string, unknown>,
    busyKey = messageKey,
  ) {
    await this.runProfileMutation({
      method,
      messageKey,
      busyKey,
      request: (client, agentId) =>
        client.request<ModelAuthCooldownClearResult>(method, { ...params, agentId }),
    });
  }

  private async logout(
    cardId: string,
    provider: string,
    owner: string,
    profileId: string,
    success: string,
    context: ProfileMutationContext,
  ) {
    const key = `logout:${owner}`;
    await this.waitFor(owner);
    if (!this.isCurrent(context.client, context.clientEpoch, context.agentEpoch)) {
      return;
    }
    await this.runProfileMutation({
      method: "models.authLogout",
      messageKey: `profiles:${owner}`,
      busyKey: key,
      success,
      context,
      beforeRequest: () => this.host.clearProbe(cardId),
      request: (client, agentId) =>
        client.request<ModelAuthLogoutResult>("models.authLogout", {
          provider,
          profileIds: [profileId],
          agentId,
        }),
    });
  }

  private async runProfileMutation(params: {
    method: ProfileMutationMethod;
    messageKey: string;
    busyKey: string;
    success?: string;
    context?: ProfileMutationContext;
    beforeRequest?: () => void;
    request: (client: GatewayBrowserClient, agentId: string) => Promise<unknown>;
  }) {
    const client = params.context?.client ?? this.host.snapshot().client;
    const { agentEpoch, agentId, clientEpoch } = params.context ?? this.host.current();
    if (
      !client ||
      !canMutateProviderProfiles(this.host.snapshot(), agentId, params.method) ||
      this.host.isBusy(params.busyKey)
    ) {
      return;
    }
    if (!this.isCurrent(client, clientEpoch, agentEpoch)) {
      return;
    }
    params.beforeRequest?.();
    this.host.setBusy(params.busyKey, true);
    this.host.setMessage(params.messageKey, null);
    try {
      await params.request(client, agentId);
      if (this.isCurrent(client, clientEpoch, agentEpoch)) {
        await this.refreshAfterCommit({
          messageKey: params.messageKey,
          success: params.success,
          client,
          clientEpoch,
          agentEpoch,
        });
      }
    } catch (error) {
      if (this.isCurrent(client, clientEpoch, agentEpoch)) {
        this.host.setMessage(params.messageKey, {
          kind: "error",
          text: modelProviderErrorMessage(error),
        });
      }
    } finally {
      if (this.isCurrent(client, clientEpoch, agentEpoch)) {
        this.host.setBusy(params.busyKey, false);
      }
    }
  }

  private async flush(params: {
    owner: string;
    client: GatewayBrowserClient;
    clientEpoch: number;
    agentEpoch: number;
    agentId: string;
  }) {
    const { owner, client, clientEpoch, agentEpoch, agentId } = params;
    while (this.isCurrent(client, clientEpoch, agentEpoch)) {
      const profileIds = this.host.getDrafts()[owner];
      const provider = this.providers.get(owner);
      const expectedProfileMembership = this.memberships.get(owner);
      if (!profileIds || !provider || !expectedProfileMembership) {
        return;
      }
      try {
        await client.request<ModelAuthOrderSetResult>("models.authOrderSet", {
          provider,
          profileIds: profileIds.length > 0 ? profileIds : null,
          expectedProfileIds: this.authoritativeOrder(owner, provider),
          expectedProfileMembership,
          agentId,
        });
      } catch (error) {
        if (this.isCurrent(client, clientEpoch, agentEpoch)) {
          const latest = this.host.getDrafts()[owner];
          if (latest && sameOrder(latest, profileIds)) {
            this.clearDraft(owner);
          }
          await this.refreshQuietly();
          this.host.setMessage(`profiles:${owner}`, {
            kind: "error",
            text: modelProviderErrorMessage(error),
          });
          if (this.host.getDrafts()[owner]) {
            continue;
          }
        }
        return;
      }
      if (!this.isCurrent(client, clientEpoch, agentEpoch)) {
        return;
      }
      this.host.prepareForMutation(agentId);
      this.commit(owner, profileIds);
      const latest = this.host.getDrafts()[owner];
      if (latest && !sameOrder(latest, profileIds)) {
        continue;
      }
      this.clearDraft(owner);
      await this.refreshAfterCommit({
        messageKey: `profiles:${owner}`,
        client,
        clientEpoch,
        agentEpoch,
      });
      if (this.host.getDrafts()[owner]) {
        continue;
      }
      return;
    }
  }

  private canonicalOwner(provider: string): string | null {
    const row = this.host
      .getData()
      ?.authStatus?.providers.find(
        (candidate) =>
          candidate.provider === provider ||
          candidate.authProvider === provider ||
          candidate.profileOrderProvider === provider,
      );
    return row?.authProvider ?? null;
  }

  private ownerMembership(owner: string): string[] | null {
    const data = this.host.getData();
    const card = data
      ? buildCards(data).find((candidate) => candidate.profileOwnerProfileIds[owner])
      : null;
    const membership = card?.profileOwnerProfileIds[owner];
    return membership ? [...membership] : null;
  }

  private authoritativeOrder(owner: string, provider: string): string[] | null {
    const rows = this.host.getData()?.authStatus?.providers;
    const row =
      rows?.find(
        (candidate) => candidate.provider === provider && candidate.authProvider === owner,
      ) ?? rows?.find((candidate) => candidate.authProvider === owner);
    return row?.profileOrder ? [...row.profileOrder] : null;
  }

  private commit(owner: string, profileIds: string[]) {
    const data = this.host.getData();
    const authStatus = data?.authStatus;
    if (!data || !authStatus) {
      return;
    }
    const providers = authStatus.providers.map((row) => {
      if (row.authProvider !== owner) {
        return row;
      }
      const updated = { ...row };
      if (profileIds.length === 0) {
        if (updated.profileOrderFallbackOrder) {
          updated.profileOrder = [...updated.profileOrderFallbackOrder];
        } else {
          delete updated.profileOrder;
        }
        delete updated.profileOrderFallback;
        delete updated.profileOrderFallbackOrder;
      } else {
        updated.profileOrderFallback ??=
          updated.profileOrder === undefined ? "automatic" : "config";
        updated.profileOrder = [...profileIds];
      }
      return updated;
    });
    this.host.setData({ ...data, authStatus: { ...authStatus, providers } });
  }

  private setDraft(owner: string, profileIds: string[] | null) {
    const drafts = { ...this.host.getDrafts() };
    if (profileIds) {
      drafts[owner] = [...profileIds];
    } else {
      delete drafts[owner];
    }
    this.host.setDrafts(drafts);
  }

  private clearDraft(owner: string) {
    this.setDraft(owner, null);
    this.providers.delete(owner);
    this.memberships.delete(owner);
  }

  private isCurrent(client: GatewayBrowserClient, clientEpoch: number, agentEpoch: number) {
    return (
      this.host.isCurrentClient(client, clientEpoch) &&
      this.host.current().agentEpoch === agentEpoch
    );
  }

  private async refreshQuietly() {
    try {
      await this.host.refresh();
    } catch {
      // The original mutation error remains the useful action for the operator.
    }
  }

  private async refreshAfterCommit(params: {
    messageKey: string;
    success?: string;
    client: GatewayBrowserClient;
    clientEpoch: number;
    agentEpoch: number;
  }) {
    let warning: string | null = null;
    try {
      await this.host.refresh();
    } catch (error) {
      warning = modelProviderErrorMessage(error);
    }
    if (!this.isCurrent(params.client, params.clientEpoch, params.agentEpoch)) {
      return;
    }
    if (params.success !== undefined) {
      this.host.setMessage(params.messageKey, {
        kind: "success",
        text: params.success,
        ...(warning ? { warning } : {}),
      });
    } else if (warning) {
      this.host.setMessage(params.messageKey, { kind: "warning", text: warning });
    }
  }
}

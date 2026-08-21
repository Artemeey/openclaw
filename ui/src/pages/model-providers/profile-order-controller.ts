import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { modelProviderErrorMessage } from "./config-mutation.ts";
import {
  buildModelProviderCards,
  readModelProviderConfig,
  type ModelProviderCard,
} from "./data.ts";
import type { ModelProvidersData } from "./load.ts";
import type { ModelProviderRowMessage } from "./view.ts";

export type ProfileOrderDrafts = Record<string, string[]>;

type ProfileOrderHost = {
  snapshot: () => ApplicationGatewaySnapshot;
  current: () => { agentEpoch: number; agentId: string; clientEpoch: number };
  canMutate: () => boolean;
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

export function canMutateProviderProfiles(
  snapshot: ApplicationGatewaySnapshot,
  agentId: string,
): boolean {
  return (
    snapshot.phase === "connected" &&
    Boolean(snapshot.client) &&
    Boolean(agentId) &&
    hasOperatorAdminAccess(snapshot.hello?.auth ?? null)
  );
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function buildCards(data: ModelProvidersData) {
  const config = readModelProviderConfig(data.config);
  return buildModelProviderCards({
    ...data,
    providerUsage: data.providerUsage?.ok ? data.providerUsage.value : null,
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
      for (const [owner, draft] of ownedDrafts) {
        const ownerIds = new Set(draft);
        let draftIndex = 0;
        for (let index = 0; index < profileOrder.length; index += 1) {
          if (ownerIds.has(profileOrder[index]!)) {
            profileOrder[index] = draft[draftIndex++] ?? profileOrder[index]!;
          }
        }
        profileOrders[owner] = draft;
      }
      return Object.assign({}, card, { profileOrder, profileOrders });
    });
  }

  queue(provider: string, profileIds: string[]) {
    const client = this.host.snapshot().client;
    const owner = this.canonicalOwner(provider);
    const membership = owner ? this.ownerMembership(owner) : null;
    if (!client || !this.host.canMutate() || !owner || !membership || profileIds.length === 0) {
      return;
    }
    const { agentEpoch, agentId, clientEpoch } = this.host.current();
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
    if (!client) {
      return;
    }
    const { agentEpoch, clientEpoch } = this.host.current();
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
        await this.logout(cardId, provider, owner, profileId, success);
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
    success: string,
    busyKey = messageKey,
  ) {
    const client = this.host.snapshot().client;
    if (!client || !this.host.canMutate() || this.host.isBusy(busyKey)) {
      return;
    }
    const { agentEpoch, agentId, clientEpoch } = this.host.current();
    this.host.setBusy(busyKey, true);
    this.host.setMessage(messageKey, null);
    try {
      await client.request(method, { ...params, agentId });
      if (this.isCurrent(client, clientEpoch, agentEpoch)) {
        await this.refreshAfterCommit({ messageKey, success, client, clientEpoch, agentEpoch });
      }
    } catch (error) {
      if (this.isCurrent(client, clientEpoch, agentEpoch)) {
        this.host.setMessage(messageKey, {
          kind: "error",
          text: modelProviderErrorMessage(error),
        });
      }
    } finally {
      if (this.isCurrent(client, clientEpoch, agentEpoch)) {
        this.host.setBusy(busyKey, false);
      }
    }
  }

  private async logout(
    cardId: string,
    provider: string,
    owner: string,
    profileId: string,
    success: string,
  ) {
    const client = this.host.snapshot().client;
    const key = `logout:${owner}`;
    if (!client || !this.host.canMutate() || this.host.isBusy(key)) {
      return;
    }
    await this.waitFor(owner);
    const { agentEpoch, agentId, clientEpoch } = this.host.current();
    if (!this.isCurrent(client, clientEpoch, agentEpoch)) {
      return;
    }
    this.host.clearProbe(cardId);
    this.host.setBusy(key, true);
    this.host.setMessage(`profiles:${owner}`, null);
    try {
      await client.request("models.authLogout", { provider, profileIds: [profileId], agentId });
      if (this.isCurrent(client, clientEpoch, agentEpoch)) {
        await this.refreshAfterCommit({
          messageKey: `profiles:${owner}`,
          success,
          client,
          clientEpoch,
          agentEpoch,
        });
      }
    } catch (error) {
      if (this.isCurrent(client, clientEpoch, agentEpoch)) {
        this.host.setMessage(`profiles:${owner}`, {
          kind: "error",
          text: modelProviderErrorMessage(error),
        });
      }
    } finally {
      if (this.isCurrent(client, clientEpoch, agentEpoch)) {
        this.host.setBusy(key, false);
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
        await client.request("models.authOrderSet", {
          provider,
          profileIds,
          expectedProfileIds: this.authoritativeOrder(owner, provider),
          expectedProfileMembership,
          agentId,
        });
      } catch (error) {
        if (this.isCurrent(client, clientEpoch, agentEpoch)) {
          this.clearDraft(owner);
          await this.refreshQuietly();
          this.host.setMessage(`profiles:${owner}`, {
            kind: "error",
            text: modelProviderErrorMessage(error),
          });
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
      return;
    }
  }

  private canonicalOwner(provider: string): string | null {
    const row = this.host
      .getData()
      ?.authStatus?.providers.find(
        (candidate) =>
          candidate.provider === provider ||
          (candidate.authProvider ?? candidate.provider) === provider,
      );
    return row ? (row.authProvider ?? row.provider) : null;
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
        (candidate) =>
          candidate.provider === provider &&
          (candidate.authProvider ?? candidate.provider) === owner,
      ) ?? rows?.find((candidate) => (candidate.authProvider ?? candidate.provider) === owner);
    return row?.profileOrder ? [...row.profileOrder] : null;
  }

  private commit(owner: string, profileIds: string[]) {
    const data = this.host.getData();
    const authStatus = data?.authStatus;
    if (!data || !authStatus) {
      return;
    }
    const providers = authStatus.providers.map((row) =>
      (row.authProvider ?? row.provider) === owner
        ? { ...row, profileOrder: [...profileIds] }
        : row,
    );
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

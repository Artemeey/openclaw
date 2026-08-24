import { html, nothing, svg } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { strokeIcon } from "../../components/icons-tools.ts";
import { icons } from "../../components/icons.ts";
import { renderProviderUsageDetails } from "../../components/provider-usage.ts";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatDurationHuman } from "../../lib/format.ts";
import type { ModelProviderCard } from "./data.ts";
import type { ModelProvidersViewProps } from "./view.ts";

type ProviderProfile = ModelProviderCard["profiles"][number];
type ProfileViewProps = Pick<
  ModelProvidersViewProps,
  | "busy"
  | "canMutate"
  | "configBusy"
  | "messages"
  | "onClearProfileCooldown"
  | "onLogoutProfile"
  | "onOpenModelSetup"
  | "onProfileOrderChange"
  | "profileCanMutate"
>;

type ProfileMessage = {
  kind: "success" | "warning" | "error";
  text: string;
  warning?: string;
};

type ProfileDropPosition = "before" | "after";

const PROFILE_DRAGGING_CLASS = "model-providers__profile--dragging";
const PROFILE_DROP_BEFORE_CLASS = "model-providers__profile--drop-before";
const PROFILE_DROP_AFTER_CLASS = "model-providers__profile--drop-after";
const logoutIcon = strokeIcon(svg` <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
  <polyline points="16 17 21 12 16 7" />
  <line x1="21" x2="9" y1="12" y2="12" />`);

function profileIdentity(profile: ProviderProfile): string {
  return profile.email || profile.displayName || profile.profileId;
}

function profileMeta(profile: ProviderProfile): string {
  const parts: string[] = [];
  if (profile.email && profile.displayName) {
    parts.push(profile.displayName);
  } else if (profileIdentity(profile) !== profile.profileId) {
    parts.push(profile.profileId);
  }
  if (profile.lastUsedAt) {
    parts.push(
      t("modelProviders.profiles.lastUsed", {
        time: formatDurationHuman(Date.now() - profile.lastUsedAt),
      }),
    );
  }
  if (profile.usage?.plan) {
    parts.push(profile.usage.plan);
  }
  return parts.join(" · ");
}

function profileInitials(profile: ProviderProfile): string {
  const localPart = profileIdentity(profile).split("@")[0] ?? "";
  const words = localPart.split(/[^a-z0-9]+/iu).filter(Boolean);
  const initials =
    words.length > 1
      ? `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}`
      : (words[0]?.slice(0, 2) ?? "");
  return initials.toLocaleUpperCase() || "?";
}

function orderedProfiles(card: ModelProviderCard) {
  const explicit = new Map(card.profileOrder.map((profileId, index) => [profileId, index]));
  return card.profiles.toSorted((left, right) => {
    const leftIndex = explicit.get(left.profileId) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = explicit.get(right.profileId) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

function profileOwnerMembership(
  card: ModelProviderCard,
  profiles: ProviderProfile[],
  owner: string,
): string[] {
  const complete = card.profileOwnerProfileIds[owner];
  if (complete?.length) {
    return complete;
  }
  return profiles
    .filter((profile) => {
      const provider = card.profileProviderIds[profile.profileId] ?? card.id;
      return (card.profileAuthProviderIds[profile.profileId] ?? provider) === owner;
    })
    .map((profile) => profile.profileId);
}

function profileCooldown(profile: ProviderProfile) {
  return Math.max(
    profile.cooldownUntil ?? 0,
    profile.disabledUntil ?? 0,
    profile.blockedUntil ?? 0,
  );
}

function renderProfileStatus(profile: ProviderProfile) {
  const cooldown = profileCooldown(profile);
  if (cooldown > Date.now()) {
    return renderSettingsStatus({
      kind: "warn",
      label: t("modelProviders.profiles.cooldown", {
        time: formatDurationHuman(cooldown - Date.now()),
      }),
    });
  }
  const status =
    profile.status === "ok" || profile.status === "static"
      ? { kind: "ok" as const, label: t("modelProviders.status.ready") }
      : profile.status === "expiring"
        ? { kind: "warn" as const, label: t("modelProviders.status.expiring") }
        : profile.status === "expired"
          ? { kind: "danger" as const, label: t("modelProviders.status.expired") }
          : { kind: "muted" as const, label: t("modelProviders.status.missing") };
  return renderSettingsStatus(status);
}

function renderProfileUsage(profile: ProviderProfile) {
  const usage = profile.usage;
  if (!usage) {
    return html`<span class="model-providers__no-stats">${t("modelProviders.noStats")}</span>`;
  }
  return renderProviderUsageDetails({
    provider: usage.providerId,
    displayName: profileIdentity(profile),
    windows: usage.windows,
    ...(usage.summary ? { summary: usage.summary } : {}),
    ...(usage.billing?.length ? { billing: usage.billing } : {}),
    ...(usage.costHistory ? { costHistory: usage.costHistory } : {}),
    ...(usage.accountEmail ? { accountEmail: usage.accountEmail } : {}),
    ...(usage.error ? { error: usage.error } : {}),
  });
}

function renderProfileMessage(message: ProfileMessage | undefined) {
  if (!message) {
    return nothing;
  }
  return html`
    <div class="callout ${message.kind}" role=${message.kind === "error" ? "alert" : "status"}>
      ${message.text}
    </div>
    ${message.warning
      ? html`<div class="callout warning" role="status">${message.warning}</div>`
      : nothing}
  `;
}

function reorderedOwnerProfileIds(
  ownerProfileIds: readonly string[],
  draggedId: string,
  targetId: string,
  position: ProfileDropPosition,
): string[] | null {
  if (
    draggedId === targetId ||
    !ownerProfileIds.includes(draggedId) ||
    !ownerProfileIds.includes(targetId)
  ) {
    return null;
  }
  const next = ownerProfileIds.filter((profileId) => profileId !== draggedId);
  const targetIndex = next.indexOf(targetId);
  next.splice(targetIndex + (position === "after" ? 1 : 0), 0, draggedId);
  if (next.every((profileId, index) => profileId === ownerProfileIds[index])) {
    return null;
  }
  return next;
}

function clearProfileDragState(): void {
  document
    .querySelectorAll<HTMLElement>(".model-providers__profile")
    .forEach((row) =>
      row.classList.remove(
        PROFILE_DRAGGING_CLASS,
        PROFILE_DROP_BEFORE_CLASS,
        PROFILE_DROP_AFTER_CLASS,
      ),
    );
}

function clearProfileDropTargets(): void {
  document
    .querySelectorAll<HTMLElement>(`.${PROFILE_DROP_BEFORE_CLASS}, .${PROFILE_DROP_AFTER_CLASS}`)
    .forEach((row) => row.classList.remove(PROFILE_DROP_BEFORE_CLASS, PROFILE_DROP_AFTER_CLASS));
}

function profileDropPosition(clientY: number, row: HTMLElement): ProfileDropPosition {
  const rect = row.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function setProfileDropTarget(row: HTMLElement, position: ProfileDropPosition): void {
  document
    .querySelectorAll<HTMLElement>(`.${PROFILE_DROP_BEFORE_CLASS}, .${PROFILE_DROP_AFTER_CLASS}`)
    .forEach((candidate) => {
      if (candidate !== row) {
        candidate.classList.remove(PROFILE_DROP_BEFORE_CLASS, PROFILE_DROP_AFTER_CLASS);
      }
    });
  row.classList.toggle(PROFILE_DROP_BEFORE_CLASS, position === "before");
  row.classList.toggle(PROFILE_DROP_AFTER_CLASS, position === "after");
}

function profileRowAtPointer(event: PointerEvent): HTMLElement | null {
  return (
    document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>(".model-providers__profile") ?? null
  );
}

function startProfilePointerDrag(params: {
  event: PointerEvent;
  canMove: boolean;
  draggedId: string;
  owner: string;
  ownerProfileIds: readonly string[];
  move: (position: ProfileDropPosition, targetId: string) => void;
}): void {
  const { event, canMove, draggedId, owner, ownerProfileIds, move } = params;
  if (!canMove || event.button !== 0) {
    return;
  }
  const grip = event.currentTarget;
  if (!(grip instanceof HTMLElement)) {
    return;
  }
  const row = grip.closest<HTMLElement>(".model-providers__profile");
  if (!row) {
    return;
  }
  const ownerIds = new Set(ownerProfileIds);
  let targetRow: HTMLElement | null = null;
  event.preventDefault();
  row.classList.add(PROFILE_DRAGGING_CLASS);
  try {
    grip.setPointerCapture(event.pointerId);
  } catch {
    // Synthetic pointers and detached test targets cannot be captured.
  }

  const updateTarget = (pointerEvent: PointerEvent) => {
    if (pointerEvent.pointerId !== event.pointerId) {
      return;
    }
    const candidate = profileRowAtPointer(pointerEvent);
    const candidateId = candidate?.dataset.profileId;
    if (
      !candidate ||
      !candidateId ||
      candidateId === draggedId ||
      candidate.dataset.profileOwner !== owner ||
      !ownerIds.has(candidateId)
    ) {
      targetRow = null;
      clearProfileDropTargets();
      return;
    }
    targetRow = candidate;
    setProfileDropTarget(candidate, profileDropPosition(pointerEvent.clientY, candidate));
  };
  const finish = (pointerEvent: PointerEvent, apply: boolean) => {
    if (pointerEvent.pointerId !== event.pointerId) {
      return;
    }
    updateTarget(pointerEvent);
    const targetId = targetRow?.dataset.profileId;
    const position = targetRow
      ? targetRow.classList.contains(PROFILE_DROP_AFTER_CLASS)
        ? "after"
        : "before"
      : null;
    clearProfileDragState();
    grip.removeEventListener("pointermove", handleMove);
    grip.removeEventListener("pointerup", handleUp);
    grip.removeEventListener("pointercancel", handleCancel);
    try {
      grip.releasePointerCapture(event.pointerId);
    } catch {
      // Capture can already be gone when the pointer is cancelled.
    }
    if (apply && targetId && position) {
      move(position, targetId);
    }
  };
  const handleMove = (pointerEvent: PointerEvent) => updateTarget(pointerEvent);
  const handleUp = (pointerEvent: PointerEvent) => finish(pointerEvent, true);
  const handleCancel = (pointerEvent: PointerEvent) => finish(pointerEvent, false);
  grip.addEventListener("pointermove", handleMove);
  grip.addEventListener("pointerup", handleUp);
  grip.addEventListener("pointercancel", handleCancel);
}

export function renderProfiles(card: ModelProviderCard, props: ProfileViewProps) {
  const profiles = orderedProfiles(card);
  if (profiles.length === 0) {
    return nothing;
  }
  const owners = [
    ...new Set(
      profiles.map((profile) => {
        const provider = card.profileProviderIds[profile.profileId] ?? card.id;
        return card.profileAuthProviderIds[profile.profileId] ?? provider;
      }),
    ),
  ];
  const busy = owners.some(
    (owner) =>
      props.busy[`profiles:${owner}`] ||
      props.busy[`cooldown:${owner}`] ||
      props.busy[`logout:${owner}`],
  );
  const configMutationDisabled = !props.canMutate || props.configBusy;
  const profileMutationDisabled = !props.profileCanMutate;
  const hasExplicitOrder = profiles.some((profile) => {
    const provider = card.profileProviderIds[profile.profileId] ?? card.id;
    const orderProvider = card.profileAuthProviderIds[profile.profileId] ?? provider;
    return card.profileOrders[orderProvider] !== undefined;
  });
  const reorderOffered = profiles.some((profile) => {
    const provider = card.profileProviderIds[profile.profileId] ?? card.id;
    if (card.profileAuthProviderIds[profile.profileId] === undefined) {
      return false;
    }
    const orderProvider = card.profileAuthProviderIds[profile.profileId] ?? provider;
    const membership = profileOwnerMembership(card, profiles, orderProvider);
    const explicitOrder = card.profileOrders[orderProvider];
    return explicitOrder === undefined ? membership.length > 1 : explicitOrder.length > 1;
  });
  return html`
    <section
      class="model-providers__profiles${reorderOffered
        ? " model-providers__profiles--reorderable"
        : ""}"
      aria-label=${t("modelProviders.profiles.title")}
      aria-busy=${busy ? "true" : "false"}
    >
      <div class="model-providers__profiles-heading">
        <span class="model-providers__profiles-heading-copy">
          <strong>${t("modelProviders.profiles.title")}</strong>
          <span>
            ${t(
              profiles.length === 1
                ? "modelProviders.profiles.accountOne"
                : "modelProviders.profiles.accounts",
              { count: String(profiles.length) },
            )}
            ·
            ${t(
              reorderOffered
                ? "modelProviders.profiles.reorderHint"
                : hasExplicitOrder
                  ? "modelProviders.profiles.orderHint"
                  : "modelProviders.profiles.automaticHint",
            )}
          </span>
        </span>
        <span class="model-providers__profiles-heading-actions">
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${configMutationDisabled}
            @click=${props.onOpenModelSetup}
          >
            ${t("modelProviders.profiles.addAccount")}
          </button>
        </span>
      </div>
      <div class="model-providers__profile-list" role="list">
        ${repeat(
          profiles,
          (profile) => profile.profileId,
          (profile) => {
            const provider = card.profileProviderIds[profile.profileId] ?? card.id;
            const orderOwnerAvailable =
              card.profileAuthProviderIds[profile.profileId] !== undefined;
            const orderOwner = card.profileAuthProviderIds[profile.profileId] ?? provider;
            const orderProvider = card.profileOrderProviders[orderOwner] ?? orderOwner;
            const cooldown = profileCooldown(profile);
            const explicitOrder = card.profileOrders[orderOwner];
            const ownerMembershipIds = profileOwnerMembership(card, profiles, orderOwner);
            const moveContext = (draggedId: string) => {
              const ownerProfileIds = explicitOrder
                ? explicitOrder.includes(draggedId)
                  ? explicitOrder
                  : []
                : ownerMembershipIds;
              return ownerProfileIds;
            };
            const ownerProfileIds = moveContext(profile.profileId);
            const ownerIndex = ownerProfileIds.indexOf(profile.profileId);
            const logoutBusy = Boolean(props.busy[`logout:${orderOwner}`]);
            const ownerBusy = Boolean(
              props.busy[`profiles:${orderOwner}`] ||
              props.busy[`cooldown:${orderOwner}`] ||
              props.busy[`logout:${orderOwner}`],
            );
            const canMove =
              reorderOffered &&
              orderOwnerAvailable &&
              ownerIndex >= 0 &&
              ownerProfileIds.length > 1 &&
              !logoutBusy &&
              !profileMutationDisabled;
            const canClearCooldown = cooldown > Date.now();
            const canLogout = profile.logoutSupported === true;
            const identity = profileIdentity(profile);
            const logoutLabel = t("modelProviders.logout.actionFor", { account: identity });
            const excluded =
              explicitOrder !== undefined && !explicitOrder.includes(profile.profileId);
            const reorderLabel = canMove
              ? t("modelProviders.profiles.reorder", {
                  account: identity,
                  position: String(ownerIndex + 1),
                })
              : !explicitOrder
                ? t("modelProviders.profiles.automaticFor", { account: identity })
                : excluded
                  ? t("modelProviders.profiles.notInRotationFor", { account: identity })
                  : ownerIndex === 0
                    ? t("modelProviders.profiles.primaryFor", { account: identity })
                    : t("modelProviders.profiles.priorityFor", {
                        account: identity,
                        position: String(ownerIndex + 1),
                      });
            const move = (position: ProfileDropPosition, targetId: string) => {
              const next = reorderedOwnerProfileIds(
                moveContext(profile.profileId),
                profile.profileId,
                targetId,
                position,
              );
              if (next) {
                props.onProfileOrderChange(orderProvider, next);
              }
            };
            return html`
              <div
                class="model-providers__profile"
                role="listitem"
                data-profile-id=${profile.profileId}
                data-profile-owner=${orderOwner}
              >
                <button
                  type="button"
                  class="model-providers__profile-grip"
                  ?disabled=${!canMove}
                  aria-label=${reorderLabel}
                  aria-keyshortcuts=${canMove ? "ArrowUp ArrowDown" : nothing}
                  @pointerdown=${(event: PointerEvent) =>
                    startProfilePointerDrag({
                      event,
                      canMove,
                      draggedId: profile.profileId,
                      owner: orderOwner,
                      ownerProfileIds,
                      move,
                    })}
                  @keydown=${(event: KeyboardEvent) => {
                    if (!canMove) {
                      return;
                    }
                    const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
                    if (delta === 0) {
                      return;
                    }
                    const adjacentId = ownerProfileIds[ownerIndex + delta];
                    if (!adjacentId) {
                      return;
                    }
                    event.preventDefault();
                    move(delta < 0 ? "before" : "after", adjacentId);
                  }}
                >
                  ${icons.gripVertical}
                </button>
                <span class="model-providers__profile-avatar" aria-hidden="true"
                  >${profileInitials(profile)}</span
                >
                <span class="model-providers__profile-copy">
                  <strong title=${identity}>${identity}</strong>
                  <span>${profileMeta(profile)}</span>
                </span>
                <span class="model-providers__profile-usage">${renderProfileUsage(profile)}</span>
                <span class="model-providers__profile-status">
                  ${renderProfileStatus(profile)}
                  ${canClearCooldown
                    ? html`<button
                        type="button"
                        class="model-providers__profile-icon-action model-providers__profile-retry model-providers__profile-action"
                        aria-label=${t("modelProviders.profiles.clearCooldownFor", {
                          account: identity,
                        })}
                        title=${t("modelProviders.profiles.clearCooldownFor", {
                          account: identity,
                        })}
                        ?disabled=${ownerBusy || profileMutationDisabled}
                        @click=${() =>
                          props.onClearProfileCooldown(orderOwner, provider, profile.profileId)}
                      >
                        ${icons.refresh}
                      </button>`
                    : nothing}
                </span>
                <span class="model-providers__profile-actions">
                  ${excluded && orderOwnerAvailable
                    ? html`<button
                        type="button"
                        class="btn btn--sm btn--ghost model-providers__profile-action"
                        aria-label=${t("modelProviders.profiles.includeFor", {
                          account: identity,
                        })}
                        ?disabled=${ownerBusy || profileMutationDisabled}
                        @click=${() =>
                          props.onProfileOrderChange(orderProvider, [
                            ...(explicitOrder ?? []),
                            profile.profileId,
                          ])}
                      >
                        ${t("modelProviders.profiles.include")}
                      </button>`
                    : nothing}
                  ${canLogout
                    ? html`<button
                        type="button"
                        class="model-providers__profile-icon-action model-providers__profile-logout"
                        aria-label=${logoutLabel}
                        title=${logoutLabel}
                        ?disabled=${ownerBusy || profileMutationDisabled}
                        @click=${() =>
                          props.onLogoutProfile(
                            card.id,
                            provider,
                            orderOwner,
                            profile.profileId,
                            identity,
                          )}
                      >
                        ${logoutIcon}
                      </button>`
                    : nothing}
                </span>
              </div>
            `;
          },
        )}
      </div>
      ${owners.map((owner) => renderProfileMessage(props.messages[`profiles:${owner}`]))}
    </section>
  `;
}

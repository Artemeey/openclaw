import { html, nothing } from "lit";
import { icons } from "../components/icons.ts";
import { t } from "../i18n/index.ts";

export function renderConnectionActionBlock(props: {
  initialConnectPending: boolean;
  pageActionsBlocked: boolean;
  phase: string;
  settingsTakeover: boolean;
}) {
  if (
    (!props.initialConnectPending && !props.pageActionsBlocked) ||
    props.phase === "reload-required"
  ) {
    return nothing;
  }
  return html`<div class="connection-action-block" role="status" aria-live="polite">
    <span class="connection-action-block__icon" aria-hidden="true">${icons.globeOff}</span>
    <span class="connection-action-block__text">
      ${props.initialConnectPending
        ? html`${t(
            props.phase === "starting" ? "common.gatewayStarting" : "connection.reconnecting",
          )}
          ${t("common.staleData")}`
        : t(
            props.settingsTakeover
              ? "connection.settingsChangesUnavailable"
              : "connection.actionsUnavailable",
          )}
    </span>
  </div>`;
}

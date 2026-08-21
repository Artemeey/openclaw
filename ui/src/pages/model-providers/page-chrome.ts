import { html, type TemplateResult } from "lit";
import { titleForRoute } from "../../app-navigation.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { renderDocsLink } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";

const MODEL_PROVIDERS_DOCS_URL = "https://docs.openclaw.ai/concepts/model-providers";

export function renderModelProvidersPageChrome(props: {
  body: TemplateResult;
  agents: Parameters<typeof renderAgentScopeControl>[0]["agents"];
  selection: ApplicationContext["agentSelection"];
  selectedId: string;
  onOpenModelSetup: () => void;
}) {
  return html`
    <section class="content-header">
      <div>
        <div class="page-title">${titleForRoute("model-providers")}</div>
        <div class="page-subtitle">
          ${t("modelProviders.subtitle")}
          ${renderDocsLink(MODEL_PROVIDERS_DOCS_URL, t("common.learnMore"))}
        </div>
      </div>
      <div class="page-header-actions">
        ${renderAgentScopeControl({
          agents: props.agents,
          selection: props.selection,
          allowAll: false,
          selectedId: props.selectedId,
        })}
        <button class="btn" @click=${props.onOpenModelSetup}>${t("tabs.modelSetup")}</button>
      </div>
    </section>
    ${renderSettingsWorkspace(props.body)}
  `;
}

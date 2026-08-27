import { html } from "lit";
import { titleForRoute } from "../../app-navigation.ts";
import { renderDocsLink, renderSettingsPage } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "./cloud-provider-setup.ts";

class CloudWorkersPage extends OpenClawLightDomElement {
  override render() {
    const body = renderSettingsPage(
      html`<openclaw-cloud-provider-setup></openclaw-cloud-provider-setup>`,
      {
        intro: html`${t("cloudWorkersPage.intro")}
        ${renderDocsLink(
          "https://docs.openclaw.ai/gateway/cloud-workers",
          t("cloudWorkersPage.documentation"),
        )}`,
      },
    );
    return html`
      <section class="content-header">
        <div><div class="page-title">${titleForRoute("cloud-workers")}</div></div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-cloud-workers-page")) {
  customElements.define("openclaw-cloud-workers-page", CloudWorkersPage);
}

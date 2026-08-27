import { html, nothing } from "lit";
import type {
  ApplicationCloudSessionTest,
  CloudSessionTestState,
} from "../../app/cloud-session-test.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { renderWizardStepControls } from "../../components/wizard-step-controls.ts";
import { t } from "../../i18n/index.ts";
import { formatDateTimeMs } from "../../lib/format.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";

export function cloudSessionTestPassed(state: CloudSessionTestState) {
  return (
    state.phase === "finished" &&
    state.result?.status === "passed" &&
    state.result.cleanup === "verified"
  );
}

export function renderCloudSessionTest(
  context: ApplicationContext,
  owner: ApplicationCloudSessionTest,
) {
  const state = owner.state;
  if (!state) {
    return nothing;
  }
  const result = state.result;
  const historical = state.sourceRevision !== context.runtimeConfig.state.configSnapshot?.hash;
  const interrupted = state.phase === "interrupted" || state.phase === "reconnecting";
  const label = interrupted
    ? t("cloudSetup.testInterrupted")
    : cloudSessionTestPassed(state)
      ? t(historical ? "cloudSetup.testPreviousPassed" : "cloudSetup.testPassed")
      : state.cancelling && state.phase !== "finished"
        ? t("cloudSetup.testCancelling")
        : result?.status === "passed"
          ? t("cloudSetup.testCleanupPending")
          : result
            ? t(`cloudSetup.testStatus.${result.status}`)
            : t("cloudSetup.testStarting");
  const target = result?.sessionKey
    ? sessionNavigationTarget({
        context,
        face: "chat",
        sessionKey: result.sessionKey,
        exactKey: true,
      })
    : null;
  const step =
    !interrupted &&
    !state.cancelling &&
    state.step?.executor !== "gateway" &&
    state.step?.type !== "progress"
      ? state.step
      : undefined;
  return renderSettingsSection(
    {
      title: t("cloudSetup.testTitle", { name: state.label }),
      description: t("cloudSetup.testOwner"),
    },
    html`
      ${renderSettingsRow({
        title: html`<span role="status"
          >${renderSettingsStatus({
            kind: !historical && cloudSessionTestPassed(state) ? "ok" : "muted",
            label,
          })}</span
        >`,
        description: html`${historical
          ? html`${t("cloudSetup.testPreviousConfig")} `
          : nothing}${interrupted ? t("cloudSetup.testRecovery") : result?.message}`,
        control:
          state.sessionId && state.phase === "observing" && !state.cancelling
            ? html`<button class="btn btn--sm" @click=${() => owner.cancel()}>
                ${t("cloudSetup.cancelTest")}
              </button>`
            : nothing,
      })}
      ${state.error
        ? renderSettingsRow({ title: html`<span role="alert">${state.error}</span>` })
        : nothing}
      ${result
        ? renderSettingsRow({
            title: t(`cloudSetup.testStage.${result.stage}`),
            description:
              result.endedAt === undefined ? undefined : formatDateTimeMs(result.endedAt),
            control: renderSettingsStatus({
              kind: result.cleanup === "verified" ? "ok" : "muted",
              label: t(`cloudSetup.testCleanup.${result.cleanup}`),
            }),
          })
        : nothing}
      ${target
        ? renderSettingsRow({
            title: t("cloudSetup.testSession"),
            control: html`<a
              href=${target.href}
              @click=${(event: MouseEvent) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return;
                }
                event.preventDefault();
                context.navigate("chat", target.options);
              }}
              >${t("cloudSetup.openTestSession")}</a
            >`,
          })
        : nothing}
      ${step
        ? renderSettingsRow({
            title: step.title ?? t("cloudSetup.testConfirmation"),
            stacked: true,
            control: renderWizardStepControls({
              step,
              value: state.value,
              busy: state.answering,
              inputId: "cloud-test-answer",
              onValueChange: (value) => owner.setValue(value),
              onAnswer: (value) => owner.answer(value),
              confirmAffirmativeLabel: t("cloudSetup.confirmTest"),
            }),
          })
        : nothing}
    `,
  );
}

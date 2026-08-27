import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import type {
  WorkerSetupCheckResult,
  WorkerSetupDescribeResult,
  WorkerSetupDiagnostic,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { CloudSessionTestState } from "../../app/cloud-session-test.ts";
import { copyWithPathPatch } from "../../components/config-form-copy-on-write.ts";
import {
  analyzeConfigSchema,
  renderConfigTierGroups,
  renderNode,
} from "../../components/config-form.ts";
import { renderSensitiveInput } from "../../components/sensitive-input.ts";
import {
  renderDocsLink,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { CloudConnectionDraft } from "./cloud-connection-save.ts";
import type { CloudSetupOwner } from "./cloud-provider-setup.ts";
import { cloudSessionTestPassed } from "./cloud-session-test-view.ts";
import type { readCloudWorkerProfiles } from "./cloud-worker-config.ts";

type SetupProps = {
  admin: boolean;
  profiles: ReturnType<typeof readCloudWorkerProfiles>;
  canManageProfiles: boolean;
  onDelete: (profileId: string, label: string) => void;
  owners: CloudSetupOwner[];
  owner?: CloudSetupOwner;
  selected: string;
  description: WorkerSetupDescribeResult | null;
  draft: CloudConnectionDraft | null;
  draftProfileId: string;
  checks: Record<string, WorkerSetupCheckResult>;
  configRevision: string | null | undefined;
  adding: boolean;
  advanced: boolean;
  loaded: boolean;
  busy: boolean;
  awaitingApply: boolean;
  canSave: boolean;
  configUnavailable: string | null;
  mutationAllowed: boolean;
  error: string | null;
  notice: string | null;
  available: (method: string) => boolean;
  onAdd: () => void;
  onClose: () => void;
  onRefresh: () => void;
  onOwner: (value: string) => void;
  onEnable: () => void;
  onInstall: () => void;
  onProvider: (value: string) => void;
  onConnection: (value: string) => void;
  onDraft: (patch: Partial<CloudConnectionDraft>) => void;
  onAdvanced: (value: boolean) => void;
  onSave: () => void;
  onCheck: (profileId: string) => void;
  onStart: (profileId: string) => void;
  test: CloudSessionTestState | null;
  canTest: boolean;
  onTest: (profileId: string, label: string) => void;
  idleStop: (profileId: string) => string | undefined;
  onPlugins: () => void;
  onAdvancedConfig: () => void;
  onConnectionSettings: () => void;
  onSecrets: () => void;
  onEndpointSettings: () => void;
};

function action(label: string, onClick: () => void, disabled = false, primary = false) {
  return html`<button
    class=${primary ? "btn btn--sm primary" : "btn btn--sm"}
    type="button"
    ?disabled=${disabled}
    @click=${onClick}
  >
    ${label}
  </button>`;
}

function diagnostics(items: WorkerSetupDiagnostic[], props: SetupProps) {
  return items.map((item) =>
    renderSettingsRow({
      title: renderSettingsStatus({
        kind: item.severity === "error" ? "danger" : item.severity === "warning" ? "warn" : "muted",
        label: item.message,
      }),
      control:
        item.action === "configure_endpoint"
          ? action(t("cloudSetup.endpointSettings"), props.onEndpointSettings)
          : item.action === "save_credentials"
            ? action(t("tabs.secrets"), props.onSecrets)
            : item.action === "update_dependency" || item.action === "install"
              ? action(t("cloudSetup.plugins"), props.onPlugins)
              : item.action === "restart"
                ? html`<span class="settings-row__desc">${t("cloudSetup.applyRestart")}</span>`
                : nothing,
    }),
  );
}

function renderDraft(props: SetupProps) {
  const draft = props.draft;
  const provider = props.description?.providers.find((entry) => entry.id === draft?.provider);
  if (!draft || !provider) {
    return nothing;
  }
  if (provider.compatibility !== "guided") {
    return renderSettingsRow({
      title: provider.label,
      description: provider.reason ?? t("cloudSetup.providerUnavailable"),
      control: action(t("cloudSetup.advanced"), props.onAdvancedConfig),
    });
  }
  const connections =
    props.description?.connections.filter((entry) => entry.provider === provider.id) ?? [];
  return html`
    ${connections.length
      ? renderSettingsRow({
          title: t("cloudSetup.savedConnection"),
          description: t("cloudSetup.savedConnectionHelp"),
          control: html`<select
            class="settings-select"
            aria-label=${t("cloudSetup.savedConnection")}
            ?disabled=${props.busy || Boolean(draft.profileId)}
            .value=${connections.some((entry) => entry.connectionId === draft.connectionId)
              ? draft.connectionId
              : ""}
            @change=${(event: Event) => {
              if (!(event.currentTarget instanceof HTMLSelectElement)) {
                return;
              }
              const value = event.currentTarget.value;
              if (value) {
                props.onConnection(value);
              } else {
                props.onProvider(provider.id);
              }
            }}
          >
            <option value="">${t("cloudSetup.newConnection")}</option>
            ${connections.map(
              (entry) => html`<option value=${entry.connectionId}>${entry.label}</option>`,
            )}
          </select>`,
        })
      : nothing}
    ${renderSettingsRow({
      title: t("cloudSetup.connectionName"),
      description: draft.reusingConnection ? t("cloudSetup.sharedConnectionHelp") : undefined,
      control: html`<input
          class="settings-input"
          aria-label=${t("cloudSetup.connectionName")}
          maxlength="160"
          autocomplete="off"
          .value=${draft.label}
          ?readonly=${draft.reusingConnection || Boolean(draft.profileId)}
          ?disabled=${props.busy}
          @input=${(event: Event) => {
            if (event.currentTarget instanceof HTMLInputElement) {
              props.onDraft({ label: event.currentTarget.value });
            }
          }}
        />${draft.reusingConnection
          ? action(t("cloudSetup.advanced"), props.onAdvancedConfig)
          : nothing}`,
    })}
    ${draft.reusingConnection
      ? renderSettingsRow({
          title: t("cloudSetup.profileName"),
          description: t("cloudSetup.profileNameHelp"),
          control: html`<input
            class="settings-input"
            aria-label=${t("cloudSetup.profileName")}
            maxlength="160"
            autocomplete="off"
            .value=${draft.profileName}
            ?readonly=${Boolean(draft.profileId)}
            ?disabled=${props.busy}
            @input=${(event: Event) => {
              if (event.currentTarget instanceof HTMLInputElement) {
                props.onDraft({ profileName: event.currentTarget.value });
              }
            }}
          />`,
        })
      : nothing}
    ${renderSettingsRow({
      title: t("cloudSetup.profileId"),
      description: draft.profileId
        ? t("cloudSetup.identityReserved")
        : t("cloudSetup.profileIdHelp"),
      control: renderSettingsValue(props.draftProfileId, { mono: true }),
    })}
    ${provider.credentials.map((credential) => {
      const ref = draft.credentials[credential.key];
      const id = `cloud-credential-${credential.key}`;
      return renderSettingsRow({
        title: html`<label for=${id}>${credential.label}</label>`,
        description: ref
          ? t("cloudSetup.referenceRetained")
          : (credential.description ?? t("cloudSetup.secretHelp")),
        control: html`${ref
          ? renderSensitiveInput({
              id,
              value: "",
              placeholder: "••••••••",
              revealed: false,
              revealLabel: t("cloudSetup.showCredential"),
              hideLabel: t("cloudSetup.hideCredential"),
              inputClassName: "settings-input",
              disabled: true,
              onInput: () => {},
              onToggle: () => {},
            })
          : renderSensitiveInput({
              id,
              value: draft.values[credential.key] ?? "",
              revealed: draft.revealed[credential.key] === true,
              revealLabel: t("cloudSetup.showCredential"),
              hideLabel: t("cloudSetup.hideCredential"),
              inputClassName: "settings-input",
              disabled: props.busy || !props.available("secrets.store.set"),
              onInput: (value) =>
                props.onDraft({ values: { ...draft.values, [credential.key]: value } }),
              onToggle: () =>
                props.onDraft({
                  revealed: {
                    ...draft.revealed,
                    [credential.key]: !draft.revealed[credential.key],
                  },
                }),
            })}${credential.helpUrl
          ? renderDocsLink(
              credential.helpUrl,
              t("cloudSetup.getCredential", { name: credential.label }),
            )
          : nothing}`,
      });
    })}
    ${provider.credentials.length
      ? renderSettingsRow({
          title: t("cloudSetup.protectedStorage"),
          description: t("cloudSetup.secretHelp"),
          control: action(t("tabs.secrets"), props.onSecrets),
        })
      : nothing}
    ${!props.available("secrets.store.set") &&
    provider.credentials.some(({ key }) => !draft.credentials[key])
      ? renderSettingsRow({ title: t("cloudSetup.secretUnavailable") })
      : nothing}
  `;
}

function renderProviderSettings(props: SetupProps) {
  const draft = props.draft;
  const provider = props.description?.providers.find((entry) => entry.id === draft?.provider);
  if (!draft || !provider || provider.compatibility !== "guided") {
    return nothing;
  }
  const analysis = analyzeConfigSchema(provider.settingsSchema);
  // Guided descriptors already curate the form. Only explicitly advanced,
  // optional fields belong behind disclosure; required inputs must be visible.
  const hints = Object.fromEntries(
    [
      ...new Set([
        ...Object.keys(analysis.schema?.properties ?? {}),
        ...Object.keys(provider.uiHints),
      ]),
    ].map((path) => [
      path,
      {
        ...provider.uiHints[path],
        advanced: analysis.schema?.required?.includes(path)
          ? false
          : (provider.uiHints[path]?.advanced ?? false),
      },
    ]),
  );
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("cloudSetup.providerSettings")}</h2>
      </div>
      <p class="settings-section__desc">${t("cloudSetup.idleHelp")}</p>
      ${analysis.schema
        ? renderConfigTierGroups({
            schema: analysis.schema,
            path: [],
            hints,
            revealAdvanced: props.advanced,
            onShowAdvanced: () => props.onAdvanced(true),
            onHideAdvanced: () => props.onAdvanced(false),
            renderTier: (schema) =>
              renderNode({
                schema,
                value: draft.settings,
                path: [],
                hints,
                unsupported: new Set(analysis.unsupportedPaths),
                disabled: props.busy,
                showLabel: false,
                onPatch: (path, value) => {
                  const patched = copyWithPathPatch(draft.settings, path, value);
                  if (patched.ok && isRecord(patched.value)) {
                    props.onDraft({ settings: patched.value });
                  }
                },
              }),
          })
        : renderSettingsSection(
            {},
            renderSettingsRow({ title: t("cloudSetup.schemaUnavailable") }),
          )}
    </section>
    ${renderSettingsSection(
      {},
      renderSettingsRow({
        title: t("cloudSetup.saveConnection"),
        description:
          props.configUnavailable ??
          (!props.owner ||
          !props.available(props.owner.descriptor.methods.prepare) ||
          !props.available("config.patch")
            ? t("cloudSetup.reconnect")
            : t("cloudSetup.noAllocation")),
        control: action(
          props.busy ? t("common.saving") : t("common.save"),
          props.onSave,
          !props.canSave || !analysis.schema,
          !props.test?.step,
        ),
      }),
    )}
  `;
}

function renderChecks(result: WorkerSetupCheckResult | undefined, props: SetupProps) {
  if (!result) {
    return nothing;
  }
  return html`
    ${renderSettingsRow({
      title: t("cloudSetup.credentials"),
      control: renderSettingsStatus({
        kind: result.credentials === "verified" ? "ok" : "warn",
        label: t(`cloudSetup.credentialsState.${result.credentials}`),
      }),
    })}
    ${renderSettingsRow({
      title: t("cloudSetup.lifecycle"),
      control: renderSettingsStatus({
        kind: result.lifecycle === "supported" ? "ok" : "warn",
        label: t(`cloudSetup.lifecycleState.${result.lifecycle}`),
      }),
    })}
    ${renderSettingsRow({
      title: t("cloudSetup.endpoint"),
      control: renderSettingsStatus({
        kind: "warn",
        label: t(`cloudSetup.endpointState.${result.endpoint}`),
      }),
    })}
    ${diagnostics(result.diagnostics, props)}
  `;
}

export function renderCloudProviderSetup(props: SetupProps) {
  const owner = props.owner;
  const description = props.description;
  const dependency = description?.dependency;
  const providers =
    description?.providers.filter((provider) => provider.compatibility === "guided") ?? [];
  const onlyProvider = providers.length === 1 ? providers[0] : undefined;
  const setupReady =
    owner?.plugin.enabled &&
    props.available(owner.descriptor.methods.describe) &&
    !props.awaitingApply;
  return html`
    ${props.error ? html`<div class="callout warning" role="alert">${props.error}</div>` : nothing}
    ${props.notice
      ? html`<div class="callout warning" role="status">${props.notice}</div>`
      : nothing}
    ${!props.admin
      ? html`<div class="callout warning" role="note">${t("cloudWorkersPage.adminRequired")}</div>`
      : nothing}
    ${props.admin
      ? renderSettingsSection(
          {
            title: t("cloudSetup.connections"),
            description: t("cloudSetup.intro"),
            actions: !props.adding
              ? action(t("cloudSetup.add"), props.onAdd, props.busy, !props.test?.step)
              : action(t("common.cancel"), props.onClose, props.busy),
          },
          html`
            ${!props.available("plugins.list")
              ? renderSettingsRow({
                  title: t("cloudSetup.reconnect"),
                  control: action(t("cloudSetup.connectionSettings"), props.onConnectionSettings),
                })
              : nothing}
            ${props.busy ? renderSettingsRow({ title: t("common.loading") }) : nothing}
            ${props.loaded && !props.owners.length
              ? renderSettingsRow({
                  title: t("cloudSetup.noOwners"),
                  control: action(t("cloudSetup.plugins"), props.onPlugins),
                })
              : nothing}
            ${props.owners.length
              ? renderSettingsRow({
                  title: t("cloudSetup.plugin"),
                  control:
                    props.owners.length === 1
                      ? html`<span class="settings-row__desc">${owner?.plugin.name}</span>`
                      : html`<select
                          class="settings-select"
                          aria-label=${t("cloudSetup.plugin")}
                          .value=${props.selected}
                          ?disabled=${props.busy ||
                          props.awaitingApply ||
                          Boolean(props.draft?.profileId)}
                          @change=${(event: Event) => {
                            if (event.currentTarget instanceof HTMLSelectElement) {
                              props.onOwner(event.currentTarget.value);
                            }
                          }}
                        >
                          ${props.owners.map(
                            ({ plugin, descriptor }) =>
                              html`<option value=${`${plugin.id}/${descriptor.id}`}>
                                ${plugin.name}${plugin.workerSetup?.length === 1
                                  ? ""
                                  : ` · ${descriptor.id}`}
                              </option>`,
                          )}
                        </select>`,
                })
              : nothing}
            ${owner && !owner.plugin.installed
              ? renderSettingsRow({
                  title: t("cloudSetup.pluginMissing"),
                  control: action(t("cloudSetup.plugins"), props.onPlugins),
                })
              : owner && !owner.plugin.enabled
                ? renderSettingsRow({
                    title: owner.plugin.name,
                    description: owner.plugin.error ?? t("cloudSetup.enableHelp"),
                    control:
                      props.mutationAllowed && props.available("plugins.setEnabled")
                        ? action(t("pluginsPage.enableAction"), props.onEnable, props.busy)
                        : html`<span>${t("cloudSetup.enableUnavailable")}</span>`,
                  })
                : owner && !setupReady
                  ? renderSettingsRow({
                      title: t("cloudSetup.methodsUnavailable"),
                      description: props.awaitingApply
                        ? t("cloudSetup.applyRestart")
                        : (owner.plugin.error ?? t("cloudSetup.reconnect")),
                      control: action(t("common.refresh"), props.onRefresh, props.busy),
                    })
                  : nothing}
            ${setupReady && dependency
              ? renderSettingsRow({
                  title: t("cloudSetup.dependency"),
                  description: t("cloudSetup.dependencyVersion", {
                    version: dependency.version ?? t("cloudSetup.notInstalled"),
                    required: dependency.requiredVersion,
                  }),
                  control:
                    dependency.state === "available"
                      ? renderSettingsStatus({
                          kind: "ok",
                          label: t("cloudSetup.dependencyAvailable"),
                        })
                      : (dependency.state === "missing" || dependency.state === "incompatible") &&
                          props.available(owner.descriptor.methods.install)
                        ? action(t("cloudSetup.install"), props.onInstall, props.busy)
                        : html`<span>${t("cloudSetup.dependencyUnsupported")}</span>${action(
                              t("cloudSetup.advanced"),
                              props.onAdvancedConfig,
                            )}`,
                })
              : nothing}
            ${description ? diagnostics(description.diagnostics, props) : nothing}
            ${props.adding && setupReady && dependency?.state === "available"
              ? html`
                  ${renderSettingsRow({
                    title: t("cloudSetup.provider"),
                    description: t("cloudSetup.guidedChoices"),
                    control: onlyProvider
                      ? html`<span>${onlyProvider.label}</span>${action(
                            t("cloudSetup.advanced"),
                            props.onAdvancedConfig,
                          )}`
                      : html`<select
                          class="settings-select"
                          aria-label=${t("cloudSetup.provider")}
                          .value=${props.draft?.provider ?? ""}
                          ?disabled=${props.busy || Boolean(props.draft?.profileId)}
                          @change=${(event: Event) => {
                            if (event.currentTarget instanceof HTMLSelectElement) {
                              props.onProvider(event.currentTarget.value);
                            }
                          }}
                        >
                          <option value="">${t("cloudSetup.chooseProvider")}</option>
                          ${providers.map(
                            (provider) =>
                              html`<option value=${provider.id}>${provider.label}</option>`,
                          )}
                        </select>`,
                  })}
                  ${providers.length === 0
                    ? renderSettingsRow({
                        title: t("cloudSetup.providerUnavailable"),
                        control: action(t("cloudSetup.advanced"), props.onAdvancedConfig),
                      })
                    : renderDraft(props)}
                `
              : nothing}
            ${!props.adding && !props.profiles.length && !props.configUnavailable && setupReady
              ? renderSettingsRow({ title: t("cloudSetup.empty") })
              : nothing}
          `,
        )
      : nothing}
    ${props.admin && props.adding && setupReady && dependency?.state === "available"
      ? renderProviderSettings(props)
      : nothing}
    ${props.profiles.map((profile) => renderProfile(profile, props))}
    ${renderSettingsSection(
      { title: t("cloudSetup.advanced") },
      renderSettingsRow({
        title: t("cloudSetup.advancedProfiles"),
        description: props.configUnavailable ?? t("cloudSetup.advancedHelp"),
        control: action(t("cloudSetup.advanced"), props.onAdvancedConfig),
      }),
    )}
  `;
}

function renderProfile(profile: SetupProps["profiles"][number], props: SetupProps) {
  const setup =
    profile.providerId === props.owner?.descriptor.id
      ? props.description?.profiles.find((entry) => entry.profileId === profile.id)
      : undefined;
  const provider = props.description?.providers.find((entry) => entry.id === setup?.provider);
  const label = setup?.label ?? profile.id;
  const check = setup ? props.checks[profile.id] : undefined;
  const test =
    props.test?.profileId === profile.id && props.test.sourceRevision === props.configRevision
      ? props.test
      : null;
  const passed = test && cloudSessionTestPassed(test);
  return renderSettingsSection(
    {
      title: label,
      description:
        label !== profile.id ? t("cloudSetup.profileIdentity", { id: profile.id }) : undefined,
    },
    html`
      ${renderSettingsRow({
        title: t("cloudSetup.profile"),
        description:
          provider?.label ??
          t("cloudWorkersPage.providerFact", {
            provider: profile.providerId || t("common.unknown"),
          }),
        control: html`${renderSettingsStatus({ kind: "muted", label: t("cloudSetup.configured") })}
        ${action(t("cloudWorkersPage.editAction"), props.onAdvancedConfig)}
        ${action(
          t("cloudSetup.removeProfile"),
          () => props.onDelete(profile.id, label),
          !props.canManageProfiles,
        )}`,
      })}
      ${renderSettingsRow({
        title: t("cloudSetup.idleSuspension"),
        description: t("cloudSetup.idleSuspensionHelp"),
        control: html`<span
          >${props.idleStop(profile.id)
            ? t("cloudSetup.idleSuspensionSet", { duration: props.idleStop(profile.id) ?? "" })
            : t("cloudSetup.idleSuspensionUnset")}</span
        >`,
      })}
      ${!setup ? renderSettingsRow({ title: t("cloudSetup.manualProfile") }) : nothing}
      ${props.admin && setup
        ? html` ${renderChecks(check, props)}
          ${renderSettingsRow({
            title: t("cloudSetup.readOnlyCheck"),
            description:
              props.configUnavailable ??
              (!props.owner ||
              !props.available(props.owner.descriptor.methods.check) ||
              props.awaitingApply
                ? t("cloudSetup.checkUnavailable")
                : t("cloudSetup.noAllocation")),
            control: action(
              t("cloudSetup.check"),
              () => props.onCheck(profile.id),
              props.busy ||
                Boolean(props.configUnavailable) ||
                props.awaitingApply ||
                !props.owner ||
                !props.available(props.owner.descriptor.methods.check),
            ),
          })}`
        : nothing}
      ${renderSettingsRow({
        title: t("cloudSetup.realSession"),
        description:
          check?.lifecycle === "unsupported"
            ? t("cloudSetup.lifecycleBlocked")
            : t("cloudSetup.startHelp"),
        control: html`${renderSettingsStatus({
          kind: passed ? "ok" : "muted",
          label: passed
            ? t("cloudSetup.testPassed")
            : test
              ? t("cloudSetup.testObserved")
              : t("cloudSetup.notTested"),
        })}
        ${action(
          t("cloudSetup.startSession"),
          () => props.onStart(profile.id),
          props.busy || props.awaitingApply || check?.lifecycle === "unsupported",
        )}`,
      })}
      ${props.admin && provider?.compatibility === "guided"
        ? renderSettingsRow({
            title: t("cloudSetup.testAction"),
            description: !["wizard.start", "wizard.next", "wizard.status", "wizard.cancel"].every(
              props.available,
            )
              ? t("cloudSetup.testUnavailable")
              : props.test && !props.canTest && !props.adding
                ? t("cloudSetup.testRetained")
                : t("cloudSetup.testHelp"),
            control: action(
              t("cloudSetup.runTest"),
              () => props.onTest(profile.id, label),
              !props.canTest ||
                props.busy ||
                props.awaitingApply ||
                check?.lifecycle === "unsupported",
            ),
          })
        : nothing}
    `,
  );
}

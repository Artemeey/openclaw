// Fetches the gateway signals behind the Models settings page.
// Each source degrades independently so auxiliary failures do not blank the provider list.
import type { SessionModelUsage } from "../../../../src/infra/session-cost-usage.types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ConfigSnapshot,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  ModelCatalogProviderOutcome,
} from "../../api/types.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { loadModelAuthStatus } from "../../lib/model-auth.ts";
import { loadModels } from "../../lib/model-catalog-store.ts";
import { requestSessionUsage } from "../../lib/sessions/index.ts";

/** Local session-spend window shown on each card. */
export const MODEL_PROVIDERS_COST_DAYS = 30;

export type ModelProvidersData = {
  authStatus: ModelAuthStatusResult | null;
  models: ModelCatalogEntry[] | null;
  catalogModels: ModelCatalogEntry[] | null;
  providerOutcomes: ModelCatalogProviderOutcome[];
  catalogError: string | null;
  config: Record<string, unknown> | null;
  costByProvider: SessionModelUsage[] | null;
  updatedAt: number | null;
  error: string | null;
};

type ModelProvidersCatalogResult = {
  models?: ModelCatalogEntry[];
  providerOutcomes?: ModelCatalogProviderOutcome[];
};

export const EMPTY_MODEL_PROVIDERS_DATA: ModelProvidersData = {
  authStatus: null,
  models: null,
  catalogModels: null,
  providerOutcomes: [],
  catalogError: null,
  config: null,
  costByProvider: null,
  updatedAt: null,
  error: null,
};

export type ModelProvidersAuthStatusRefreshState = {
  agentId: string;
  client: GatewayBrowserClient | null;
  clientEpoch: number;
  connected: boolean;
  data: ModelProvidersData | null;
  dataClient: GatewayBrowserClient | null;
};

function localDate(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function errorMessage(error: unknown): string {
  if (isMissingOperatorReadScopeError(error)) {
    return formatMissingOperatorReadScopeMessage("model providers");
  }
  return formatUiError(error, "request failed");
}

export async function loadModelProvidersData(
  client: GatewayBrowserClient,
  opts: {
    agentId: string;
    refresh?: boolean;
    signal?: AbortSignal;
  },
): Promise<ModelProvidersData> {
  const request = <T>(method: string, params?: unknown): Promise<T> =>
    opts?.signal
      ? client.request<T>(method, params, { signal: opts.signal })
      : params === undefined
        ? client.request<T>(method)
        : client.request<T>(method, params);
  const catalogRefresh = opts?.refresh
    ? request<ModelProvidersCatalogResult>("models.list", {
        view: "all",
        agentId: opts.agentId,
        refresh: true,
      })
        .then((result) => ({ ok: true as const, result: result ?? null }))
        .catch((error: unknown) => ({ ok: false as const, error }))
    : Promise.resolve({ ok: true as const, result: null });
  const modelsLoad = catalogRefresh.then((catalogResult) =>
    loadModels(client, {
      agentId: opts.agentId,
      ...(opts.refresh && catalogResult.ok ? { refresh: true } : { preparedOnly: true }),
      rejectOnFailure: true,
    }).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  );
  const [authStatus, models, catalogResult, config, costByProvider] = await Promise.all([
    loadModelAuthStatus(client, opts).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    modelsLoad,
    catalogRefresh,
    request<ConfigSnapshot>("config.get", {})
      .then((snapshot) => resolveEditableSnapshotConfig(snapshot))
      .catch(() => null),
    requestSessionUsage(client, {
      startDate: localDate(MODEL_PROVIDERS_COST_DAYS - 1),
      endDate: localDate(0),
      scope: "family",
      timeZone: "local",
    })
      .then((result) => result?.aggregates?.byProvider ?? null)
      .catch(() => null),
  ]);
  return {
    authStatus:
      authStatus.ok && Array.isArray(authStatus.result?.providers) ? authStatus.result : null,
    models: models.ok ? models.result : null,
    catalogModels: catalogResult.ok ? (catalogResult.result?.models ?? null) : null,
    providerOutcomes: catalogResult.ok ? (catalogResult.result?.providerOutcomes ?? []) : [],
    catalogError: !catalogResult.ok
      ? errorMessage(catalogResult.error)
      : !models.ok
        ? errorMessage(models.error)
        : null,
    config,
    costByProvider,
    updatedAt: Date.now(),
    // Auth status is the primary provider list; its failure is the only one
    // worth surfacing as a page-level error.
    error: authStatus.ok ? null : errorMessage(authStatus.error),
  };
}

/** Refreshes quota/auth facts without reloading catalog, config, or session-cost data. */
export async function refreshModelProvidersAuthStatus(
  readState: () => ModelProvidersAuthStatusRefreshState,
  adopt: (client: GatewayBrowserClient, data: ModelProvidersData) => void,
): Promise<void> {
  const initial = readState();
  const { agentId, client, clientEpoch, data } = initial;
  if (!initial.connected || !client || !agentId || !data || initial.dataClient !== client) {
    return;
  }
  let refreshed: ModelProvidersData;
  try {
    const authStatus = await loadModelAuthStatus(client, { agentId });
    refreshed = { ...data, authStatus, updatedAt: Date.now(), error: null };
  } catch (error) {
    const authStatus = data.authStatus ? { ...data.authStatus, usageRefreshPending: false } : null;
    refreshed = { ...data, authStatus, error: errorMessage(error) };
  }
  const current = readState();
  if (
    !current.connected ||
    current.client !== client ||
    current.clientEpoch !== clientEpoch ||
    current.agentId !== agentId ||
    current.data !== data ||
    current.dataClient !== client
  ) {
    return;
  }
  adopt(client, refreshed);
}

import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
// Merges gateway provider signals (auth status, live usage/quota, local session
// cost) into one card list for the Models settings page.
import type { ProviderUsageSnapshot } from "../../../../src/infra/provider-usage.types.js";
import type { SessionModelUsage } from "../../../../src/infra/session-cost-usage.types.js";
import type {
  ModelAuthStatusProvider,
  ModelAuthStatusProfile,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  ModelCatalogProviderOutcome,
} from "../../api/types.ts";
import { providerDisplayLabel } from "../../components/provider-icon.ts";
import {
  canonicalModelAuthProviderId,
  listEffectiveModelAuthProviders,
} from "../../lib/model-auth.ts";

export type ModelProviderAuthKind = "ok" | "expiring" | "expired" | "missing" | "api-key";

type ModelProviderAuthSummary = {
  kind: ModelProviderAuthKind;
  profileCount: number;
  expiryLabel?: string;
};

type ModelProviderLocalCost = {
  totalCost: number;
  totalTokens: number;
  sessionCount: number;
};

export type ModelProviderCard = {
  /** Canonical provider id used for icon + label lookup. */
  id: string;
  /** Exact config map key; provider ids are otherwise normalized for display/runtime use. */
  configKey?: string;
  configAuthMode?: string;
  apiKeySupported?: boolean;
  /** Provider ids that own credentials merged into this card. */
  credentialProviderIds: string[];
  displayName: string;
  auth?: ModelProviderAuthSummary;
  profiles: ModelAuthStatusProfile[];
  /** Exact credential-provider owner for profile-scoped gateway mutations. */
  profileProviderIds: Record<string, string>;
  /** Canonical auth-order owner for each profile. */
  profileAuthProviderIds: Record<string, string>;
  /** Complete profile membership for each canonical auth-order owner. */
  profileOwnerProfileIds: Record<string, string[]>;
  /** Explicit per-agent priority override, in first-choice order. */
  profileOrder: string[];
  /** Exact explicit priority override for each credential-provider owner. */
  profileOrders: Record<string, string[]>;
  /** Provider route that supplied each owner's explicit priority override. */
  profileOrderProviders: Record<string, string>;
  /** Result of clearing each owner's stored priority override. */
  profileOrderFallbacks: Record<string, "automatic" | "config" | "inherited">;
  /** Configured priority revealed by clearing each owner's stored override. */
  profileOrderFallbackOrders: Record<string, string[]>;
  /** Owners whose runtime selection is pinned by provider configuration. */
  profileOrderLockedOwners: Record<string, boolean>;
  apiKey?: ModelAuthStatusProvider["apiKey"];
  hasConfigApiKey: boolean;
  modelCount: number;
  availableModelCount: number;
  catalogStatus?: ModelCatalogProviderOutcome["status"];
  /** Live provider-reported usage (quota windows, billing, cost history). */
  usage?: ProviderUsageSnapshot;
  /** Locally-computed session spend for the requested window. */
  localCost?: ModelProviderLocalCost;
};

type ModelProviderCardsInput = {
  authStatus: ModelAuthStatusResult | null;
  models: ModelCatalogEntry[] | null;
  catalogModels?: ModelCatalogEntry[] | null;
  providerOutcomes?: ModelCatalogProviderOutcome[];
  configProviderIds?: string[] | null;
  configApiKeyProviderIds?: string[] | null;
  configProviderAuthModes?: Record<string, string> | null;
  costByProvider: SessionModelUsage[] | null;
};

type CardDraft = {
  ids: Set<string>;
  card: ModelProviderCard;
  hasAuthRow: boolean;
};

// Canonicalize alias provider ids (claude-cli → anthropic, minimax-* →
// minimax) with the same table the gateway uses, so one subscription stays
// one card even when the optional auth-status usage embed is missing.
function canonicalProviderId(provider: string): string {
  return canonicalModelAuthProviderId(provider);
}

function authKindForProvider(provider: ModelAuthStatusProvider): ModelProviderAuthKind {
  switch (provider.status) {
    case "ok":
    case "expiring":
    case "expired":
    case "missing":
      return provider.status;
    default:
      return "api-key";
  }
}

function authProviderFor(provider: ModelAuthStatusProvider): string {
  return provider.authProvider || provider.provider;
}

function findDraft(drafts: CardDraft[], ids: string[]): CardDraft | undefined {
  return drafts.find((draft) => ids.some((id) => draft.ids.has(id)));
}

function ensureDraft(drafts: CardDraft[], id: string, displayName: string): CardDraft {
  const existing = findDraft(drafts, [id]);
  if (existing) {
    return existing;
  }
  const draft: CardDraft = {
    ids: new Set([id]),
    card: {
      id,
      displayName,
      profiles: [],
      profileProviderIds: {},
      profileAuthProviderIds: {},
      profileOwnerProfileIds: {},
      profileOrder: [],
      profileOrders: {},
      profileOrderProviders: {},
      profileOrderFallbacks: {},
      profileOrderFallbackOrders: {},
      profileOrderLockedOwners: {},
      credentialProviderIds: [],
      hasConfigApiKey: false,
      modelCount: 0,
      availableModelCount: 0,
    },
    hasAuthRow: false,
  };
  drafts.push(draft);
  return draft;
}

function addProviderId(ids: string[], provider: string): void {
  const normalized = normalizeProviderId(provider);
  if (normalized && !ids.some((candidate) => normalizeProviderId(candidate) === normalized)) {
    ids.push(provider);
  }
}

/**
 * Builds the provider card list. A provider qualifies as "configured" when it
 * has an auth row, catalog models (the default models.list view only contains
 * configured or auth-backed entries), a live usage snapshot, or recorded
 * local spend. Model presence alone is enough: a configured API-key provider
 * with a broken credential reports available=false and no auth row, and the
 * page must surface that state rather than hide the provider.
 */
export function buildModelProviderCards(input: ModelProviderCardsInput): ModelProviderCard[] {
  const drafts: CardDraft[] = [];
  const apiKeyCapabilities = new Map(
    (input.authStatus?.providerCapabilities ?? []).flatMap((capability) => {
      const id = canonicalProviderId(capability.provider);
      return id ? [[id, capability.apiKeySupported] as const] : [];
    }),
  );
  for (const model of input.catalogModels ?? []) {
    const id = canonicalProviderId(model.provider);
    if (!id) {
      continue;
    }
    apiKeyCapabilities.set(
      id,
      apiKeyCapabilities.get(id) === true || model.apiKeySupported === true,
    );
  }

  for (const provider of input.configProviderIds ?? []) {
    const id = canonicalProviderId(provider);
    if (id) {
      ensureDraft(drafts, id, providerDisplayLabel(id)).card.configKey ??= provider;
    }
  }
  for (const provider of input.configApiKeyProviderIds ?? []) {
    const id = canonicalProviderId(provider);
    if (id) {
      const card = ensureDraft(drafts, id, providerDisplayLabel(id)).card;
      card.configKey = provider;
      card.hasConfigApiKey = true;
      addProviderId(card.credentialProviderIds, provider);
    }
  }
  for (const [provider, authMode] of Object.entries(input.configProviderAuthModes ?? {})) {
    const id = canonicalProviderId(provider);
    if (id) {
      ensureDraft(drafts, id, providerDisplayLabel(id)).card.configAuthMode = authMode;
    }
  }

  const outcomeSeverity: ReadonlyArray<ModelCatalogProviderOutcome["status"]> = [
    "auth-rejected",
    "unavailable",
    "ready",
  ];
  for (const outcome of input.providerOutcomes ?? []) {
    const id = canonicalProviderId(outcome.provider);
    if (!id) {
      continue;
    }
    const card = ensureDraft(drafts, id, providerDisplayLabel(id)).card;
    if (
      !card.catalogStatus ||
      outcomeSeverity.indexOf(outcome.status) < outcomeSeverity.indexOf(card.catalogStatus)
    ) {
      card.catalogStatus = outcome.status;
    }
  }

  for (const entry of input.models ?? []) {
    const id = canonicalProviderId(entry.provider);
    if (!id) {
      continue;
    }
    const draft = ensureDraft(drafts, id, providerDisplayLabel(id));
    draft.card.modelCount += 1;
    if (entry.available === true) {
      draft.card.availableModelCount += 1;
    }
  }

  const ownerProfileIds = new Map<string, string[]>();
  const lockedOrderOwners = new Set<string>();
  const reorderableOwners = new Set<string>();
  const ownerOrderSources = new Map<
    string,
    {
      provider: string;
      order: string[] | undefined;
      fallback: "automatic" | "config" | "inherited" | undefined;
      fallbackOrder: string[] | undefined;
    }
  >();
  for (const provider of input.authStatus?.providers ?? []) {
    const authProvider = authProviderFor(provider);
    if (provider.profiles.length > 0) {
      (provider.profileOrderLocked ? lockedOrderOwners : reorderableOwners).add(authProvider);
    }
    const membership = ownerProfileIds.get(authProvider) ?? [];
    for (const profile of provider.profiles) {
      if (!membership.includes(profile.profileId)) {
        membership.push(profile.profileId);
      }
    }
    ownerProfileIds.set(authProvider, membership);
    const candidate = {
      provider: provider.profileOrderProvider ?? provider.provider,
      order: provider.profileOrder,
      fallback: provider.profileOrderFallback,
      fallbackOrder: provider.profileOrderFallbackOrder,
    };
    const sourceKey = `${authProvider}\0${canonicalProviderId(provider.provider)}`;
    const current = ownerOrderSources.get(sourceKey);
    const rank = (source: typeof candidate) =>
      normalizeProviderId(source.provider) === normalizeProviderId(authProvider) ? 0 : 1;
    const candidateHasOrder = candidate.order !== undefined;
    const currentHasOrder = current?.order !== undefined;
    if (
      !current ||
      (candidateHasOrder && !currentHasOrder) ||
      (candidateHasOrder === currentHasOrder && rank(candidate) < rank(current)) ||
      (candidateHasOrder === currentHasOrder &&
        rank(candidate) === rank(current) &&
        normalizeProviderId(candidate.provider).localeCompare(
          normalizeProviderId(current.provider),
        ) < 0)
    ) {
      ownerOrderSources.set(sourceKey, candidate);
    }
  }

  for (const provider of input.authStatus?.providers ?? []) {
    const id = canonicalProviderId(provider.provider);
    if (!id) {
      continue;
    }
    const draft = findDraft(drafts, [id]) ?? ensureDraft(drafts, id, providerDisplayLabel(id));
    draft.card.displayName = provider.displayName || draft.card.displayName;
    draft.card.profiles.push(...provider.profiles);
    const authProvider = authProviderFor(provider);
    draft.card.profileOwnerProfileIds[authProvider] = [
      ...(ownerProfileIds.get(authProvider) ?? []),
    ];
    for (const profile of provider.profiles) {
      draft.card.profileProviderIds[profile.profileId] = provider.provider;
      draft.card.profileAuthProviderIds[profile.profileId] = authProvider;
    }
    const profileOrderSource = ownerOrderSources.get(`${authProvider}\0${id}`);
    for (const profileId of profileOrderSource?.order ?? []) {
      if (!draft.card.profileOrder.includes(profileId)) {
        draft.card.profileOrder.push(profileId);
      }
    }
    if (profileOrderSource?.order !== undefined) {
      draft.card.profileOrders[authProvider] = [...profileOrderSource.order];
      draft.card.profileOrderProviders[authProvider] = profileOrderSource.provider;
      if (profileOrderSource.fallback) {
        draft.card.profileOrderFallbacks[authProvider] = profileOrderSource.fallback;
      }
      if (profileOrderSource.fallbackOrder) {
        draft.card.profileOrderFallbackOrders[authProvider] = [...profileOrderSource.fallbackOrder];
      }
    }
    if (lockedOrderOwners.has(authProvider) && !reorderableOwners.has(authProvider)) {
      draft.card.profileOrderLockedOwners[authProvider] = true;
    }
    if (provider.apiKey || provider.profiles.length > 0) {
      addProviderId(draft.card.credentialProviderIds, provider.provider);
    }
    draft.card.apiKey ??= provider.apiKey;
    draft.hasAuthRow = true;
  }

  for (const provider of listEffectiveModelAuthProviders(input.authStatus?.providers ?? [])) {
    const draft = findDraft(drafts, [canonicalProviderId(provider.provider)]);
    if (draft) {
      draft.card.auth = {
        kind: authKindForProvider(provider),
        profileCount: provider.profiles.length,
        ...(provider.expiry?.label ? { expiryLabel: provider.expiry.label } : {}),
      };
    }
  }

  for (const usage of input.authStatus?.providerUsage ?? []) {
    const id = canonicalProviderId(usage.providerId);
    if (!id) {
      continue;
    }
    const draft =
      findDraft(drafts, [id]) ??
      ensureDraft(drafts, id, usage.displayName || providerDisplayLabel(id));
    draft.card.usage = {
      provider: usage.providerId,
      displayName: usage.displayName,
      windows: usage.windows,
      ...(usage.summary ? { summary: usage.summary } : {}),
      ...(usage.plan ? { plan: usage.plan } : {}),
      ...(usage.billing?.length ? { billing: usage.billing } : {}),
      ...(usage.costHistory ? { costHistory: usage.costHistory } : {}),
      ...(usage.error ? { error: usage.error } : {}),
    };
  }

  for (const entry of input.costByProvider ?? []) {
    const id = canonicalProviderId(entry.provider ?? "");
    if (!id) {
      continue;
    }
    const draft = findDraft(drafts, [id]) ?? ensureDraft(drafts, id, providerDisplayLabel(id));
    const addition: ModelProviderLocalCost = {
      totalCost: entry.totals.totalCost,
      totalTokens: entry.totals.totalTokens,
      sessionCount: entry.count,
    };
    const current = draft.card.localCost;
    draft.card.localCost = current
      ? {
          totalCost: current.totalCost + addition.totalCost,
          totalTokens: current.totalTokens + addition.totalTokens,
          sessionCount: current.sessionCount + addition.sessionCount,
        }
      : addition;
  }

  return drafts
    .filter(
      (draft) =>
        draft.hasAuthRow ||
        (input.configProviderIds ?? []).some((id) => canonicalProviderId(id) === draft.card.id) ||
        Boolean(draft.card.usage) ||
        draft.card.modelCount > 0 ||
        Boolean(draft.card.catalogStatus) ||
        (draft.card.localCost?.totalTokens ?? 0) > 0,
    )
    .map((draft) => {
      const apiKeySupported = apiKeyCapabilities.get(draft.card.id);
      return Object.assign(
        {},
        draft.card,
        apiKeySupported === undefined ? {} : { apiKeySupported },
      );
    })
    .toSorted((a, b) => a.displayName.localeCompare(b.displayName));
}

export type DefaultModelSelection = {
  primary: string;
  fallbacks: string[];
  /** null = automatic/unset; empty string = explicitly disabled. */
  utilityModel: string | null;
};

export type ModelPickerEntry = ModelCatalogEntry & { selectionRef?: string };

export function modelCatalogRef(model: ModelPickerEntry): string {
  if (model.selectionRef !== undefined) {
    return model.selectionRef;
  }
  return model.id.startsWith(`${model.provider}/`) ? model.id : `${model.provider}/${model.id}`;
}

export function buildSelectableDefaultModels(
  models: ModelCatalogEntry[] | null,
  selection: DefaultModelSelection,
): ModelPickerEntry[] {
  const selected = new Set<string>(
    [selection.primary, ...selection.fallbacks, selection.utilityModel].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  const selectable: ModelPickerEntry[] = (models ?? []).filter(
    (model) => model.available !== false || selected.has(modelCatalogRef(model)),
  );
  const seen = new Set(selectable.map(modelCatalogRef));
  // An unavailable catalog cannot establish that a saved model is unavailable.
  const availability = models === null ? {} : { available: false as const };
  for (const ref of selected) {
    if (seen.has(ref)) {
      continue;
    }
    const slash = ref.indexOf("/");
    if (slash <= 0 || slash === ref.length - 1) {
      const normalized = ref.trim().toLowerCase();
      const match = (models ?? []).find(
        (model) =>
          model.alias?.trim().toLowerCase() === normalized || model.id.trim() === ref.trim(),
      );
      selectable.push({
        ...(match ?? { provider: "", id: ref, name: ref, ...availability }),
        selectionRef: ref,
      });
      continue;
    }
    selectable.push({
      provider: ref.slice(0, slash),
      id: ref.slice(slash + 1),
      name: ref,
      ...availability,
    });
  }
  return selectable;
}

export function readModelProviderConfig(config: Record<string, unknown> | null): {
  providerIds: string[];
  apiKeyProviderIds: string[];
  providerAuthModes: Record<string, string>;
  defaults: DefaultModelSelection;
} {
  const models = asRecord(config?.models);
  const providers = asRecord(models?.providers);
  const agents = asRecord(config?.agents);
  const defaults = asRecord(agents?.defaults);
  const model = defaults?.model;
  const modelObject = asRecord(model);
  const primary =
    typeof model === "string"
      ? model
      : typeof modelObject?.primary === "string"
        ? modelObject.primary
        : "";
  const fallbacks = Array.isArray(modelObject?.fallbacks)
    ? modelObject.fallbacks.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    providerIds: Object.keys(providers ?? {}),
    apiKeyProviderIds: Object.entries(providers ?? {})
      .filter(([, value]) => {
        const provider = asRecord(value);
        return provider ? Object.hasOwn(provider, "apiKey") && provider.apiKey != null : false;
      })
      .map(([id]) => id),
    providerAuthModes: Object.fromEntries(
      Object.entries(providers ?? {}).flatMap(([id, value]) => {
        const auth = asRecord(value)?.auth;
        return typeof auth === "string" ? [[id, auth]] : [];
      }),
    ),
    defaults: {
      primary,
      fallbacks,
      utilityModel: typeof defaults?.utilityModel === "string" ? defaults.utilityModel : null,
    },
  };
}

export type ProviderOption = { id: string; displayName: string };

export function buildUnconfiguredProviderOptions(
  capabilities: ModelAuthStatusResult["providerCapabilities"],
  configuredProviderIds: Iterable<string>,
): ProviderOption[] {
  const configured = new Set(Array.from(configuredProviderIds, canonicalProviderId));
  const options = new Map<string, ProviderOption>();
  for (const capability of capabilities ?? []) {
    const id = canonicalProviderId(capability.provider);
    if (capability.quickApiKeySetup && id && !configured.has(id) && !options.has(id)) {
      options.set(id, { id, displayName: providerDisplayLabel(id) });
    }
  }
  return [...options.values()].toSorted((a, b) => a.displayName.localeCompare(b.displayName));
}

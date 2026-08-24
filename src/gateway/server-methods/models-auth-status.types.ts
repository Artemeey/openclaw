import type {
  AuthProviderHealthStatus,
  AuthProfileHealthStatus,
} from "../../agents/auth-health.js";
import type { AuthCredentialReasonCode } from "../../agents/auth-profiles/credential-state.js";
import type {
  ProviderUsageBilling,
  ProviderUsageCostHistory,
  UsageProviderId,
  UsageWindow,
} from "../../infra/provider-usage.types.js";

/** Time-bounded credential expiry projected to gateway clients. */
export type ModelAuthExpiry = {
  at: number;
  remainingMs: number;
  label: string;
};

export type ModelAuthUsage = {
  providerId: UsageProviderId;
  windows: UsageWindow[];
  summary?: string;
  plan?: string;
  billing?: ProviderUsageBilling[];
  costHistory?: ProviderUsageCostHistory;
  accountEmail?: string;
  error?: string;
};

export type ModelAuthStatusProfile = {
  profileId: string;
  type: "oauth" | "token" | "api_key";
  status: AuthProfileHealthStatus;
  reasonCode?: AuthCredentialReasonCode;
  expiry?: ModelAuthExpiry;
  /** True only for saved OAuth/token profiles this gateway can remove. */
  logoutSupported?: boolean;
  /** Non-secret account metadata supplied by the provider login flow. */
  displayName?: string;
  email?: string;
  lastUsedAt?: number;
  cooldownUntil?: number;
  cooldownReason?: string;
  disabledUntil?: number;
  disabledReason?: string;
  blockedUntil?: number;
  blockedReason?: string;
  /** Account-scoped provider quota and billing facts for this exact credential. */
  usage?: ModelAuthUsage;
};

export type ModelAuthStatusProvider = {
  provider: string;
  /** Canonical credential-order owner; absent only on older gateways. */
  authProvider?: string;
  displayName: string;
  status: AuthProviderHealthStatus;
  expiry?: ModelAuthExpiry;
  profiles: ModelAuthStatusProfile[];
  /** Effective stored/config priority; omitted when selection is automatic. */
  profileOrder?: string[];
  apiKey?: {
    source: "config" | "env";
    envVar?: string;
  };
  usage?: ModelAuthUsage;
};

export type ModelProviderCapability = {
  provider: string;
  apiKeySupported: boolean;
  quickApiKeySetup: boolean;
};

export type ModelAuthStatusResult = {
  /** Snapshot build time, ms since epoch. 0 = never loaded (UI fallback sentinel). */
  ts: number;
  providers: ModelAuthStatusProvider[];
  /** Process-stable provider setup capabilities from the active plugin generation. */
  providerCapabilities?: ModelProviderCapability[];
};

export type ModelAuthLogoutResult = {
  provider: string;
  removedProfiles: string[];
  abortedRunIds: string[];
};

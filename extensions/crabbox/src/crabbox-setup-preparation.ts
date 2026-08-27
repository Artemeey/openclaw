import { isDeepStrictEqual } from "node:util";
import {
  validateWorkerSetupPrepareParams,
  type WorkerSetupPrepareParams,
  type WorkerSetupPrepareResult,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  crabboxConnectionRefs,
  crabboxConnections,
  readCrabboxConnection,
} from "./crabbox-connections.js";
import { parseCrabboxProfile } from "./crabbox-worker-profile.js";

export const CRABBOX_GUIDED_DEFAULTS = { ttl: "8h", idleTimeout: "45m" };
export const CRABBOX_GUIDED_SETTING_KEYS = new Set([
  "ttl",
  "idleTimeout",
  "organizationId",
  "snapshot",
  "target",
]);

/** Pure patch preparation. The config.patch caller owns CAS, persistence, and partial success. */
export function prepareCrabboxSetup(
  source: OpenClawConfig,
  params: WorkerSetupPrepareParams,
): WorkerSetupPrepareResult {
  if (
    !validateWorkerSetupPrepareParams(params) ||
    Buffer.byteLength(JSON.stringify(params), "utf8") > 16_384
  ) {
    throw new Error("Invalid cloud setup input");
  }
  if (
    params.provider !== "daytona" ||
    Object.keys(params.credentials).length !== 1 ||
    !params.credentials.apiKey
  ) {
    throw new Error("Select a guided provider and supply its API key SecretRef");
  }
  for (const [key, value] of Object.entries(params.settings)) {
    if (
      !CRABBOX_GUIDED_SETTING_KEYS.has(key) ||
      typeof value !== "string" ||
      value.length > 256 ||
      !value.trim()
    ) {
      throw new Error("Cloud settings must contain only the provider's nonsecret fields");
    }
  }
  const previousConnection = crabboxConnections(source)[params.connectionId];
  if (previousConnection !== undefined) {
    const connection = readCrabboxConnection(source, params.connectionId);
    if (connection.provider !== params.provider) {
      throw new Error("A saved connection cannot be retargeted; create a new connection");
    }
    if (
      connection.label !== params.label ||
      !isDeepStrictEqual(crabboxConnectionRefs(source, params.connectionId), params.credentials)
    ) {
      throw new Error(
        "The saved connection changed. Refresh cloud setup, or use Advanced configuration to edit its label or credential reference.",
      );
    }
  }
  const previousProfile = source.cloudWorkers?.profiles?.[params.profileId];
  if (
    previousProfile &&
    (previousProfile.provider !== "crabbox" ||
      previousProfile.settings?.provider !== params.provider ||
      previousProfile.settings?.connectionId !== params.connectionId)
  ) {
    throw new Error(
      "A saved profile cannot be moved to another provider or connection; create a new profile",
    );
  }
  const settings: Record<string, unknown> = {
    ...CRABBOX_GUIDED_DEFAULTS,
    ...previousProfile?.settings,
    ...params.settings,
    provider: params.provider,
    connectionId: params.connectionId,
  };
  if (!settings.snapshot) {
    throw new Error("Select a Daytona Linux snapshot before saving");
  }
  parseCrabboxProfile(settings);
  const settingsPatch = {
    ...Object.fromEntries(
      Object.entries(CRABBOX_GUIDED_DEFAULTS).filter(
        ([key]) => previousProfile?.settings?.[key] === undefined,
      ),
    ),
    ...params.settings,
    provider: params.provider,
    connectionId: params.connectionId,
  };
  return {
    status: "prepared",
    saved: false,
    connectionId: params.connectionId,
    profileId: params.profileId,
    restartRequired: true,
    patch: {
      ...(previousConnection === undefined
        ? {
            plugins: {
              entries: {
                crabbox: {
                  config: {
                    connections: {
                      [params.connectionId]: {
                        label: params.label,
                        provider: params.provider,
                        credentials: params.credentials,
                      },
                    },
                  },
                },
              },
            },
          }
        : {}),
      cloudWorkers: {
        profiles: {
          [params.profileId]: {
            provider: "crabbox",
            ...(!previousProfile ? { suspendAfter: "15m" } : {}),
            settings: settingsPatch,
          },
        },
      },
    },
  };
}

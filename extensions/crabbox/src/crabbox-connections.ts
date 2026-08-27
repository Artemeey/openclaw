import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkerSetupConnection } from "openclaw/plugin-sdk/gateway-runtime";
import { WorkerProviderError, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isSecretRef, resolveSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";

export const CRABBOX_CONNECTION_ID =
  /^(?!constructor$|prototype$)[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
export type CrabboxRuntimeConfig = ReturnType<OpenClawPluginApi["runtime"]["config"]["current"]>;

export function crabboxConnections(config: CrabboxRuntimeConfig): Record<string, unknown> {
  const plugin = config.plugins?.entries?.crabbox?.config;
  return isRecord(plugin?.connections) ? plugin.connections : {};
}

export function readCrabboxConnection(config: CrabboxRuntimeConfig, connectionId: string) {
  const value = crabboxConnections(config)[connectionId];
  if (
    !CRABBOX_CONNECTION_ID.test(connectionId) ||
    !isRecord(value) ||
    value.provider !== "daytona" ||
    typeof value.label !== "string" ||
    !isRecord(value.credentials)
  ) {
    throw new WorkerProviderError(
      "Crabbox connection is unavailable; restore its configuration before retrying or cleaning up leases",
    );
  }
  return { provider: value.provider, label: value.label, credentials: value.credentials };
}

export function inspectCrabboxConnection(
  config: CrabboxRuntimeConfig,
  connectionId: string,
  provider: string,
) {
  const connection = readCrabboxConnection(config, connectionId);
  if (connection.provider !== provider) {
    throw new WorkerProviderError(
      "Crabbox connection provider changed; restore the original provider to avoid redirecting lease operations",
    );
  }
  return resolveSecretInputString({
    value: connection.credentials.apiKey,
    path: `plugins.entries.crabbox.config.connections.${connectionId}.credentials.apiKey`,
    mode: "inspect",
  });
}

/** Reference-only source projection. Resolved config is never a substitute for this input. */
export function crabboxConnectionRefs(
  config: CrabboxRuntimeConfig,
  connectionId: string,
): WorkerSetupConnection["credentials"] {
  const connection = readCrabboxConnection(config, connectionId);
  const apiKey = connection.credentials.apiKey;
  return isSecretRef(apiKey) ? { apiKey } : {};
}

// CLI config is an external-tool artifact, not an OpenClaw workflow/state store.
// CRABBOX_CONFIG is exclusive in Crabbox configPaths; the child starts with an empty
// environment so project policy, provider credentials, and broker auth cannot bleed in.
export function createCrabboxControlRunner(params: {
  runCommand: CrabboxCommandRunner;
  getConfig: () => CrabboxRuntimeConfig;
  profile?: Readonly<Record<string, unknown>>;
}): CrabboxCommandRunner {
  const profile = params.profile ? { ...params.profile } : undefined;
  return async (argv, options) => {
    const connectionId = profile?.connectionId;
    const provider = profile?.provider;
    if (profile && connectionId === undefined) {
      // Existing settings.provider profiles deliberately retain their operator-managed CLI context.
      return await params.runCommand(argv, options);
    }
    return await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-crabbox-control-" },
      async ({ dir }) => {
        const configPath = path.join(dir, "config.yaml");
        const nativeConfig = {
          // With an exclusive config and no coordinator env, baseConfig leaves the
          // coordinator empty; shouldUseCoordinator then selects the native backend.
          ...(provider ? { provider } : {}),
          ...(provider === "daytona"
            ? {
                daytona: {
                  ...(profile?.snapshot ? { snapshot: profile.snapshot } : {}),
                  ...(profile?.target ? { target: profile.target } : {}),
                },
              }
            : {}),
        };
        await writeFile(configPath, JSON.stringify(nativeConfig), { mode: 0o600, flag: "wx" });
        const env: NodeJS.ProcessEnv = {};
        for (const key of [
          "PATH",
          "HOME",
          "USERPROFILE",
          "SystemRoot",
          "TMPDIR",
          "TMP",
          "TEMP",
          "LANG",
        ]) {
          if (process.env[key] !== undefined) {
            env[key] = process.env[key];
          }
        }
        // The worker forwarding helper may delete names and set its explicit allowlist.
        // Control credentials cannot be supplied through that remote environment surface.
        env.CRABBOX_ENV_ALLOW = ",";
        env.CRABBOX_CONFIG = configPath;
        if (connectionId !== undefined) {
          if (typeof connectionId !== "string" || typeof provider !== "string") {
            throw new WorkerProviderError(
              "Crabbox profile requires a valid connection and provider",
            );
          }
          const credential = inspectCrabboxConnection(params.getConfig(), connectionId, provider);
          if (credential.status !== "available") {
            throw new WorkerProviderError(
              "Crabbox connection credential is unavailable; repair its SecretRef and reload secrets before retrying",
            );
          }
          env.CRABBOX_DAYTONA_API_KEY = credential.value;
          // The native YAML schema omits organizationId. Keep the durable
          // allocation scope in the local child only, outside worker forwarded env.
          if (typeof profile?.organizationId === "string") {
            env.CRABBOX_DAYTONA_ORGANIZATION_ID = profile.organizationId;
          }
        }
        try {
          return await params.runCommand(argv, { ...options, baseEnv: {}, env });
        } catch {
          throw new WorkerProviderError(
            "Crabbox command could not start in the selected connection context; check the installed binary and Gateway permissions",
          );
        }
      },
    );
  };
}

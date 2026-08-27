import { resolveGatewayPublicOrigin } from "openclaw/plugin-sdk/config-contracts";
import {
  validateWorkerSetupDescribeParams,
  validateWorkerSetupInstallParams,
  validateWorkerSetupPrepareParams,
  validateWorkerSetupCheckParams,
  resolveConfiguredPairingPublicUrl,
  type WorkerSetupDescribeResult,
  type WorkerSetupCheckResult,
  type WorkerSetupCheckParams,
  type WorkerSetupPrepareResult,
  type WorkerSetupInstallResult,
  type WorkerSetupProvider,
  type WorkerSetupProfile,
  type WorkerSetupDiagnostic,
} from "openclaw/plugin-sdk/gateway-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  getRuntimeConfigSourceSnapshot,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  crabboxConnectionRefs,
  crabboxConnections,
  createCrabboxControlRunner,
  inspectCrabboxConnection,
  readCrabboxConnection,
} from "./crabbox-connections.js";
import type { createCrabboxInstallation } from "./crabbox-install.js";
import {
  CRABBOX_GUIDED_DEFAULTS,
  CRABBOX_GUIDED_SETTING_KEYS,
  prepareCrabboxSetup,
} from "./crabbox-setup-preparation.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { parseCrabboxProfile } from "./crabbox-worker-profile.js";

type CrabboxSetupResult =
  | WorkerSetupDescribeResult
  | WorkerSetupInstallResult
  | WorkerSetupPrepareResult
  | WorkerSetupCheckResult;
const DAYTONA_DESCRIPTOR: WorkerSetupProvider = {
  id: "daytona",
  label: "Daytona",
  compatibility: "guided",
  reason:
    "Guided credentials and profile configuration. The selected Linux snapshot supplies the base machine; the exact Gateway runtime is prepared before enrollment.",
  settingsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      organizationId: { type: "string", minLength: 1, maxLength: 256 },
      snapshot: { type: "string", minLength: 1, maxLength: 256 },
      target: { type: "string", minLength: 1, maxLength: 256 },
      ttl: { type: "string", minLength: 1, maxLength: 64 },
      idleTimeout: { type: "string", minLength: 1, maxLength: 64 },
    },
    required: ["organizationId", "snapshot"],
  },
  uiHints: {
    organizationId: {
      label: "Organization ID",
      help: "Enter the organization ID for this API key. The API-key metadata endpoint does not return it; copy it from the Daytona dashboard.",
    },
    snapshot: {
      label: "Linux snapshot",
      help: "Daytona snapshot for the worker. Released OpenClaw runtimes are prepared automatically; unpublished source builds require an exact candidate installed by advanced profile setup.",
    },
    target: { label: "Target", advanced: true },
    ttl: {
      label: "Requested lifetime",
      help: "For example 8h. The Daytona deployment must support wall-clock TTL. Read-only checks do not verify deadline enforcement; idle stop is not a hard lifetime limit.",
    },
    idleTimeout: { label: "Idle timeout", advanced: true },
  },
  defaults: CRABBOX_GUIDED_DEFAULTS,
  // Crabbox native metadata has no auth-field schema. This matches DaytonaConfig's
  // APIKey contract; JWT and custom endpoints are deliberately not guided.
  credentials: [
    {
      key: "apiKey",
      label: "Daytona API key",
      required: true,
      helpUrl: "https://app.daytona.io/dashboard/keys",
    },
  ],
};

function sourceConfig(): OpenClawConfig {
  const source = getRuntimeConfigSourceSnapshot();
  if (!source) {
    throw new Error(
      "Source configuration is unavailable; reload the Gateway before editing cloud connections",
    );
  }
  return source;
}

export function registerCrabboxSetup(params: {
  api: OpenClawPluginApi;
  installation: ReturnType<typeof createCrabboxInstallation>;
  runCommand: CrabboxCommandRunner;
}) {
  const { api, installation } = params;
  const getConfig = () => api.runtime.config.current();
  const metadataRunner = createCrabboxControlRunner({ runCommand: params.runCommand, getConfig });
  let catalog: Promise<WorkerSetupProvider[]> | undefined;
  const readCatalog = async (): Promise<WorkerSetupProvider[]> => {
    const { binary } = await installation.inspect();
    if (!binary) {
      return [DAYTONA_DESCRIPTOR];
    }
    const result = await metadataRunner([binary, "providers", "--json"], {
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
      killProcessTree: true,
    });
    if (result.code !== 0 || result.termination !== "exit" || result.outputLimitExceeded) {
      throw new Error("Crabbox provider catalog is unavailable");
    }
    const entries: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(entries) || entries.length > 128) {
      throw new Error("Crabbox provider catalog is invalid or exceeds its supported bound");
    }
    const providers: WorkerSetupProvider[] = [];
    for (const entry of entries) {
      if (
        !isRecord(entry) ||
        typeof entry.provider !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(entry.provider)
      ) {
        continue;
      }
      if (entry.provider === "daytona") {
        const description = await metadataRunner(
          [binary, "providers", "describe", entry.provider, "--json"],
          { timeoutMs: 10_000, maxOutputBytes: 256 * 1024, killProcessTree: true },
        );
        if (
          description.code !== 0 ||
          description.termination !== "exit" ||
          description.outputLimitExceeded
        ) {
          throw new Error("Crabbox provider description is unavailable");
        }
        const native: unknown = JSON.parse(description.stdout);
        if (
          !isRecord(native) ||
          native.schemaVersion !== 2 ||
          !isRecord(native.provider) ||
          native.provider.canonical !== entry.provider ||
          !isRecord(native.classCatalog)
        ) {
          throw new Error(
            "Crabbox provider description does not match the supported native contract",
          );
        }
        providers.push({
          ...DAYTONA_DESCRIPTOR,
          ...(native.kind !== "ssh-lease" ||
          !Array.isArray(native.targets) ||
          !native.targets.includes("linux")
            ? ({
                compatibility: "unsupported",
                reason: "This native backend cannot host an OpenClaw Linux worker lease.",
              } as const)
            : {}),
        });
      } else {
        providers.push({
          id: entry.provider,
          label: entry.provider,
          compatibility: "unsupported",
          reason:
            "Native Crabbox provider; guided authentication and OpenClaw worker lifecycle have not been verified. Existing advanced profiles remain available.",
          settingsSchema: {},
          uiHints: {},
          defaults: {},
          credentials: [],
        });
      }
    }
    return providers.toSorted((left, right) => left.id.localeCompare(right.id));
  };
  const describe = async (): Promise<WorkerSetupDescribeResult> => {
    const source = sourceConfig();
    const current = getConfig();
    const diagnostics: WorkerSetupDiagnostic[] = [];
    let providers: WorkerSetupProvider[];
    try {
      providers = await (catalog ??= readCatalog());
    } catch {
      catalog = undefined;
      providers = [DAYTONA_DESCRIPTOR];
      diagnostics.push({
        code: "catalog_unavailable",
        severity: "warning",
        message:
          "Native provider metadata could not be read; install or repair Crabbox before checking this connection.",
        action: "install",
      });
    }
    const profiles = Object.entries(source.cloudWorkers?.profiles ?? {})
      .filter(([, profile]) => profile.provider === "crabbox")
      .slice(0, 128)
      .map(([profileId, profile]): WorkerSetupProfile => {
        const described: WorkerSetupProfile = {
          profileId,
          label: profileId,
          provider:
            typeof profile.settings?.provider === "string" ? profile.settings.provider : "unknown",
          // Commands and forwarded environment names remain in advanced editing;
          // arbitrary setup text can carry secrets and cannot enter this catalog.
          settings: Object.fromEntries(
            Object.entries(profile.settings ?? {}).filter(
              ([key]) => CRABBOX_GUIDED_SETTING_KEYS.has(key) || key === "class",
            ),
          ),
        };
        if (profile.suspendAfter !== undefined) {
          described.suspendAfter = profile.suspendAfter;
        }
        const connectionId = profile.settings?.connectionId;
        if (typeof connectionId === "string") {
          described.connectionId = connectionId;
          if (crabboxConnections(source)[connectionId]) {
            described.label = readCrabboxConnection(source, connectionId).label;
          }
        }
        return described;
      });
    const connections = Object.keys(crabboxConnections(source))
      .toSorted()
      .slice(0, 128)
      .map((connectionId) => {
        const connection = readCrabboxConnection(source, connectionId);
        let available = false;
        try {
          available =
            inspectCrabboxConnection(current, connectionId, connection.provider).status ===
            "available";
        } catch {
          /* Source may be saved while runtime still awaits restart. */
        }
        return {
          connectionId,
          label: connection.label,
          provider: connection.provider,
          credentials: crabboxConnectionRefs(source, connectionId),
          state: available ? ("configured" as const) : ("configured_unavailable" as const),
          profileIds: profiles
            .filter((profile) => profile.connectionId === connectionId)
            .map((profile) => profile.profileId),
        };
      });
    return {
      dependency: (await installation.inspect()).dependency,
      providers,
      profiles,
      connections,
      diagnostics,
    };
  };

  const check = async (input: WorkerSetupCheckParams): Promise<WorkerSetupCheckResult> => {
    const config = getConfig();
    const profileId = "profileId" in input ? input.profileId : undefined;
    const profile = profileId ? config.cloudWorkers?.profiles?.[profileId] : undefined;
    if (profileId && (!profile || profile.provider !== "crabbox")) {
      throw new Error("Cloud profile is unavailable; apply saved configuration first");
    }
    if (profile) {
      parseCrabboxProfile(profile.settings ?? {});
    }
    const connectionId =
      "connectionId" in input ? input.connectionId : profile?.settings?.connectionId;
    if (typeof connectionId !== "string") {
      throw new Error("Use advanced provider diagnostics for profiles without a named connection");
    }
    const connection = readCrabboxConnection(config, connectionId);
    const provider = profile?.settings?.provider ?? connection.provider;
    if (typeof provider !== "string") {
      throw new Error("Cloud profile provider is invalid");
    }
    const source = sourceConfig();
    const configuredEndpoint =
      resolveConfiguredPairingPublicUrl(source) ?? resolveGatewayPublicOrigin(source);
    const result: WorkerSetupCheckResult = {
      connectionId,
      ...(profileId ? { profileId } : {}),
      status: "verified",
      allocation: "none",
      credentials: "unverified",
      lifecycle: "unverified",
      endpoint: configuredEndpoint ? "configured_unproven" : "not_configured",
      realSession: "not_tested",
      diagnostics: [],
    };
    result.diagnostics.push({
      code: "endpoint_unproven",
      severity: "info",
      action: "configure_endpoint",
      message:
        "Configure a public TLS Gateway origin and trusted proxy sources where applicable. Configuration does not prove outbound worker reachability; only a real session can do that.",
    });
    if (inspectCrabboxConnection(config, connectionId, provider).status !== "available") {
      return {
        ...result,
        status: "configured_unavailable",
        credentials: "unavailable",
        diagnostics: [
          ...result.diagnostics,
          {
            code: "credential_unavailable",
            severity: "error",
            message:
              "The saved credential reference is unavailable. Repair it and reload secrets; ambient credentials will not be used.",
            action: "save_credentials",
          },
        ],
      };
    }
    let binary: string;
    try {
      binary = await installation.requireBinary(
        typeof profile?.settings?.binary === "string" ? profile.settings.binary : undefined,
      );
    } catch {
      return {
        ...result,
        status: "failed",
        diagnostics: [
          ...result.diagnostics,
          {
            code: "dependency_unavailable",
            severity: "error",
            message: "Install a compatible Crabbox CLI before checking the connection.",
            action: "install",
          },
        ],
      };
    }
    const run = createCrabboxControlRunner({
      runCommand: params.runCommand,
      getConfig,
      profile: profile?.settings ?? { connectionId, provider },
    });
    const native = await run([binary, "providers", "describe", provider, "--json"], {
      timeoutMs: 10_000,
      maxOutputBytes: 256 * 1024,
      killProcessTree: true,
    });
    let description: unknown;
    try {
      description = JSON.parse(native.stdout);
    } catch {
      description = undefined;
    }
    if (
      native.code !== 0 ||
      native.termination !== "exit" ||
      native.outputLimitExceeded ||
      !isRecord(description) ||
      description.schemaVersion !== 2 ||
      !isRecord(description.provider) ||
      description.provider.canonical !== provider ||
      description.kind !== "ssh-lease" ||
      !Array.isArray(description.targets) ||
      !description.targets.includes("linux")
    ) {
      result.status = "unsupported";
      result.lifecycle = "unsupported";
      result.diagnostics.push({
        code: "native_lifecycle_unsupported",
        severity: "error",
        message:
          "The selected native provider does not advertise a supported Linux worker lease contract.",
        action: "update_dependency",
      });
    }
    // POSIX script transport is a prerequisite, not fixed-ID or lifecycle proof.
    // The controller identity bit is unrelated; native warmup enforces --lease-id itself.
    if (
      !isRecord(description) ||
      !isRecord(description.capabilities) ||
      !Array.isArray(description.capabilities.features) ||
      !description.capabilities.features.includes("posix-script-run")
    ) {
      result.status = "unsupported";
      result.lifecycle = "unsupported";
      result.diagnostics.push({
        code: "posix_script_unsupported",
        severity: "error",
        action: "update_dependency",
        message:
          "This Crabbox provider does not advertise POSIX script execution required for worker setup. Use a compatible CLI and backend before starting a session.",
      });
    } else if (result.lifecycle !== "unsupported") {
      result.diagnostics.push({
        code: "lifecycle_unverified",
        severity: "warning",
        action: "use_session",
        message:
          "POSIX script transport is advertised. Fixed-ID allocation, worker execution, workspace transfer, and reclaim remain unverified; an explicitly confirmed real test session is required and may incur provider charges.",
      });
    }
    const doctor = await run([binary, "doctor", "--provider", provider, "--json"], {
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      killProcessTree: true,
    });
    let report: unknown;
    try {
      report = JSON.parse(doctor.stdout);
    } catch {
      report = undefined;
    }
    // Do not echo native message/details: provider failures may include URLs or credentials.
    if (
      doctor.termination === "exit" &&
      !doctor.outputLimitExceeded &&
      isRecord(report) &&
      report.provider === provider &&
      Array.isArray(report.checks) &&
      report.checks.some(
        (item) => isRecord(item) && item.check === "provider" && item.status === "ok",
      )
    ) {
      result.credentials = "verified";
      result.diagnostics.push({
        code: "credentials_verified",
        severity: "info",
        message:
          "Provider read-only access succeeded. Allocation, worker execution, workspace transfer, and reclaim have not been tested.",
        action: "use_session",
      });
    } else {
      result.status = "failed";
      result.diagnostics.push({
        code: "doctor_failed",
        severity: "error",
        message:
          "The provider read-only check failed. Check the API key, provider access, and Gateway network connectivity.",
        action: "save_credentials",
      });
    }
    return result;
  };

  function register<Input>(
    verb: string,
    validate: (input: unknown) => input is Input,
    handler: (input: Input) => CrabboxSetupResult | Promise<CrabboxSetupResult>,
  ) {
    api.registerGatewayMethod(
      `crabbox.setup.${verb}`,
      async ({ params: input, respond }) => {
        if (!validate(input) || Buffer.byteLength(JSON.stringify(input), "utf8") > 16_384) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: "Invalid cloud setup parameters",
          });
          return;
        }
        try {
          respond(true, await handler(input));
        } catch (error) {
          // Only our bounded validation errors are actionable; subprocess output never escapes.
          const message =
            error instanceof Error
              ? redactSensitiveText(error.message).slice(0, 1024)
              : "Cloud setup failed";
          respond(false, undefined, { code: "UNAVAILABLE", message });
        }
      },
      { scope: "operator.admin", profileAccess: "independent" },
    );
  }
  register("describe", validateWorkerSetupDescribeParams, describe);
  register("install", validateWorkerSetupInstallParams, async () => {
    const result = await installation.install();
    catalog = undefined;
    return result;
  });
  register("prepare", validateWorkerSetupPrepareParams, (input) =>
    prepareCrabboxSetup(sourceConfig(), input),
  );
  register("check", validateWorkerSetupCheckParams, check);
}

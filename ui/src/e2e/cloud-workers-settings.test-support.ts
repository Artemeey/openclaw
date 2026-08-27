import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";

export function configResponse(config: Record<string, unknown>, hash: string) {
  return {
    appliedConfigHash: hash,
    config,
    sourceConfig: config,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

export function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  if (!isRecord(request.params) || typeof request.params.raw !== "string") {
    throw new Error("Expected config mutation params");
  }
  const parsed: unknown = JSON.parse(request.params.raw);
  if (!isRecord(parsed)) {
    throw new Error("Expected config mutation raw object");
  }
  return parsed;
}

export const cloudSetupMethods = {
  describe: "fixture-cloud.setup.describe",
  install: "fixture-cloud.setup.install",
  prepare: "fixture-cloud.setup.prepare",
  check: "fixture-cloud.setup.check",
};
export const cloudSetupWorkerId = "fixture-worker";
export const cloudSetupPlugin = {
  id: "fixture-cloud",
  name: "Fixture Cloud",
  installed: true,
  enabled: true,
  state: "enabled",
  workerSetup: [{ id: cloudSetupWorkerId, methods: cloudSetupMethods }],
} satisfies import("../../../packages/gateway-protocol/src/index.js").PluginCatalogEntry;

export const cloudSetupFeatureMethods = [
  "plugins.list",
  "plugins.setEnabled",
  "config.patch",
  "secrets.store.set",
  "environments.list",
  ...Object.values(cloudSetupMethods),
];

export const cloudSetupDescription = {
  dependency: { state: "available", version: "1.0.0", requiredVersion: "1.0.0", managed: true },
  providers: [
    {
      id: "native-provider",
      label: "Native provider",
      compatibility: "guided",
      credentials: [
        {
          key: "apiToken",
          label: "Provider API token",
          required: true,
          helpUrl: "https://provider.example.test/settings/keys",
        },
      ],
      settingsSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          image: { type: "string" },
          cpu: { type: "number", minimum: 1 },
          organizationId: { type: "string", minLength: 1 },
        },
        required: ["image", "organizationId"],
      },
      uiHints: {
        image: { label: "Prepared image" },
        cpu: { label: "CPU count", advanced: true },
        organizationId: { label: "Organization" },
      },
      defaults: { image: "small-image", cpu: 2 },
    },
  ],
  connections: [],
  profiles: [],
  diagnostics: [],
} satisfies import("../../../packages/gateway-protocol/src/index.js").WorkerSetupDescribeResult;

export const cloudSetupCheck = {
  status: "verified",
  allocation: "none",
  credentials: "verified",
  lifecycle: "supported",
  endpoint: "configured_unproven",
  realSession: "not_tested",
  diagnostics: [],
} satisfies import("../../../packages/gateway-protocol/src/index.js").WorkerSetupCheckResult;

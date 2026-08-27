import type {
  WorkerSetupPrepareParams,
  WorkerSetupCheckResult,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createCrabboxInstallation } from "./crabbox-install.js";
import { prepareCrabboxSetup } from "./crabbox-setup-preparation.js";
import { registerCrabboxSetup } from "./crabbox-setup.js";

const input: WorkerSetupPrepareParams = {
  connectionId: "team",
  profileId: "sandbox",
  label: "Team",
  provider: "daytona",
  settings: {
    organizationId: "organization-one",
    snapshot: "prepared-example",
    target: "region-one",
  },
  credentials: { apiKey: { source: "store", provider: "default", id: "TEAM_DAYTONA_KEY" } },
};

afterEach(clearRuntimeConfigSnapshot);

describe("Crabbox setup patch preparation", () => {
  it("bounds UTF-8 input bytes before processing provider settings", () => {
    expect(() =>
      prepareCrabboxSetup(
        {},
        {
          ...input,
          settings: { snapshot: "é".repeat(9_000) },
        },
      ),
    ).toThrow("Invalid cloud setup input");
  });
  it.each(
    [true, false, undefined].flatMap((controllerFixedLeaseId) =>
      [undefined, [], ["module-run"], ["posix-script-run"]].map((features) => ({
        controllerFixedLeaseId,
        features,
      })),
    ),
  )(
    "checks script transport $features without inferring warmup from controller capability $controllerFixedLeaseId",
    async ({ controllerFixedLeaseId, features }) => {
      const source: OpenClawConfig = {
        cloudWorkers: {
          profiles: {
            "cloud-uuid": {
              provider: "crabbox",
              suspendAfter: "15m",
              settings: {
                provider: "daytona",
                connectionId: "team",
                organizationId: "organization-one",
                snapshot: "linux",
                ttl: "8h",
                idleTimeout: "45m",
              },
            },
          },
        },
        plugins: {
          entries: {
            crabbox: {
              config: {
                connections: {
                  team: {
                    label: "Team",
                    provider: "daytona",
                    credentials: input.credentials,
                  },
                },
              },
            },
          },
        },
        gateway: { publicOrigin: "https://gateway.example.test" },
      };
      let current: OpenClawConfig = structuredClone(source);
      current.plugins!.entries!.crabbox!.config!.connections = {
        team: {
          label: "Team",
          provider: "daytona",
          credentials: { apiKey: "fixture-do-not-echo" },
        },
      };
      setRuntimeConfigSnapshot(current, source);
      type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      const handlers = new Map<string, Handler>();
      const api = createTestPluginApi();
      api.runtime = { ...api.runtime, config: { ...api.runtime.config, current: () => current } };
      api.registerGatewayMethod = (name, handler) => {
        handlers.set(name, handler);
      };
      const dependency = {
        state: "available",
        version: "dev",
        requiredVersion: "0.46.0",
        managed: false,
      } as const;
      const installation = {
        inspect: async () => ({ binary: "/mock/crabbox", dependency }),
        install: async () => ({ status: "unmanaged" as const, dependency, diagnostics: [] }),
        requireBinary: async () => "/mock/crabbox",
      } satisfies ReturnType<typeof createCrabboxInstallation>;
      const runCommand = vi.fn(
        async (argv: string[]): Promise<SpawnResult> => ({
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
          stderr: "fixture-do-not-echo",
          stdout: JSON.stringify(
            argv[1] === "providers" && argv[2] === "--json"
              ? [{ provider: "daytona" }]
              : argv[1] === "providers"
                ? {
                    schemaVersion: 2,
                    provider: { canonical: "daytona" },
                    kind: "ssh-lease",
                    targets: ["linux"],
                    classCatalog: { disposition: "unmapped" },
                    capabilities: { features },
                  }
                : argv[1] === "config"
                  ? { provider: "daytona", idempotentLeaseId: controllerFixedLeaseId }
                  : {
                      ok: true,
                      provider: "daytona",
                      checks: [{ check: "provider", status: "ok", message: "fixture-do-not-echo" }],
                    },
          ),
        }),
      );
      registerCrabboxSetup({ api, installation, runCommand });
      const handler = handlers.get("crabbox.setup.check")!;
      const respond = vi.fn();
      const request: Parameters<Handler>[0] = {
        req: { type: "req", id: "setup-check", method: "crabbox.setup.check" },
        params: { connectionId: "team" },
        respond,
        client: null,
        isWebchatConnect: () => false,
        get context(): never {
          throw new Error("Setup check must not enter the session or enrollment lifecycle");
        },
      };
      await handler(request);
      const result = respond.mock.calls[0]?.[1] as WorkerSetupCheckResult;
      expect(result).toMatchObject({
        credentials: "verified",
        status: features?.includes("posix-script-run") ? "verified" : "unsupported",
        lifecycle: features?.includes("posix-script-run") ? "unverified" : "unsupported",
        allocation: "none",
        realSession: "not_tested",
        endpoint: "configured_unproven",
      });
      expect(JSON.stringify(result)).not.toContain("fixture-do-not-echo");
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: features?.includes("posix-script-run")
            ? "lifecycle_unverified"
            : "posix_script_unsupported",
        }),
      );
      expect(runCommand.mock.calls.map(([argv]) => argv[1])).toEqual(["providers", "doctor"]);
      expect(runCommand.mock.calls[1]?.[0]).toEqual([
        "/mock/crabbox",
        "doctor",
        "--provider",
        "daytona",
        "--json",
      ]);
      respond.mockClear();
      request.params = {};
      await handlers.get("crabbox.setup.describe")!(request);
      expect(respond.mock.calls[0]?.[1]).toMatchObject({
        profiles: [
          {
            profileId: "cloud-uuid",
            label: "Team",
            suspendAfter: "15m",
            connectionId: "team",
            settings: { organizationId: "organization-one" },
          },
        ],
        providers: [
          expect.objectContaining({
            credentials: [
              expect.objectContaining({ helpUrl: "https://app.daytona.io/dashboard/keys" }),
            ],
          }),
        ],
      });
      current = source;
      request.params = { connectionId: "team" };
      respond.mockClear();
      runCommand.mockClear();
      await handler(request);
      expect(respond.mock.calls[0]?.[1]).toMatchObject({
        status: "configured_unavailable",
        credentials: "unavailable",
      });
      expect(runCommand).not.toHaveBeenCalled();
    },
  );

  it("sets Gateway idle suspension only for a new guided profile", () => {
    expect(prepareCrabboxSetup({}, input).patch).toHaveProperty(
      "cloudWorkers.profiles.sandbox",
      expect.objectContaining({
        suspendAfter: "15m",
        settings: expect.objectContaining({ ttl: "8h", idleTimeout: "45m" }),
      }),
    );
    const existing: OpenClawConfig = {
      cloudWorkers: {
        profiles: {
          sandbox: {
            provider: "crabbox",
            settings: { provider: "daytona", connectionId: "team", snapshot: "old" },
          },
        },
      },
    };
    expect(prepareCrabboxSetup(existing, input).patch).not.toHaveProperty(
      "cloudWorkers.profiles.sandbox.suspendAfter",
    );
  });

  it("builds a reference-only patch without writing or changing unrelated source settings", () => {
    const source: OpenClawConfig = {
      cloudWorkers: {
        profiles: {
          advanced: {
            provider: "crabbox",
            settings: { provider: "aws", class: "large", ttl: "24h", idleTimeout: "60m" },
          },
          sandbox: {
            provider: "crabbox",
            suspendAfter: "5m",
            settings: {
              connectionId: "team",
              provider: "daytona",
              ttl: "20m",
              idleTimeout: "5m",
              snapshot: "old",
              setup: "echo prepared",
            },
          },
        },
      },
    };
    const before = structuredClone(source);
    const result = prepareCrabboxSetup(source, input);
    expect(source).toEqual(before);
    expect(result).toMatchObject({
      status: "prepared",
      saved: false,
      restartRequired: true,
      patch: {
        plugins: {
          entries: {
            crabbox: { config: { connections: { team: { credentials: input.credentials } } } },
          },
        },
        cloudWorkers: {
          profiles: {
            sandbox: {
              provider: "crabbox",
              settings: {
                provider: "daytona",
                connectionId: "team",
                organizationId: "organization-one",
                snapshot: "prepared-example",
                target: "region-one",
              },
            },
          },
        },
      },
    });
    expect(result.patch).not.toHaveProperty("cloudWorkers.profiles.advanced");
    expect(result.patch).not.toHaveProperty("cloudWorkers.profiles.sandbox.suspendAfter");
    expect(result.patch).not.toHaveProperty("cloudWorkers.profiles.sandbox.settings.setup");
    expect(result.patch).not.toHaveProperty("cloudWorkers.profiles.sandbox.settings.ttl");
  });

  it("reuses the authoritative connection without writing its label or secret reference", () => {
    const source: OpenClawConfig = {
      plugins: {
        entries: {
          crabbox: {
            config: {
              connections: {
                team: {
                  label: input.label,
                  provider: input.provider,
                  credentials: input.credentials,
                },
              },
            },
          },
        },
      },
    };
    const before = structuredClone(source);
    const result = prepareCrabboxSetup(source, input);
    expect(result.patch).not.toHaveProperty("plugins");
    expect(result.patch).toHaveProperty(
      "cloudWorkers.profiles.sandbox.settings.organizationId",
      "organization-one",
    );
    expect(source).toEqual(before);
    for (const staleInput of [
      { ...input, label: "Old label" },
      {
        ...input,
        credentials: {
          apiKey: { source: "store" as const, provider: "default", id: "REPLACED_KEY" },
        },
      },
    ]) {
      expect(() => prepareCrabboxSetup(source, staleInput)).toThrow(
        /Refresh cloud setup.*Advanced/,
      );
    }
    expect(source).toEqual(before);
  });

  it("does not redirect an existing profile to another connection", () => {
    const source: OpenClawConfig = {
      cloudWorkers: {
        profiles: {
          sandbox: {
            provider: "crabbox",
            settings: { provider: "daytona", connectionId: "other" },
          },
        },
      },
    };
    expect(() => prepareCrabboxSetup(source, input)).toThrow(/cannot be moved/);
  });

  it.each([
    { ...input, credentials: { apiKey: "plaintext-fixture" } },
    { ...input, settings: { ...input.settings, apiKey: "plaintext-fixture" } },
    { ...input, settings: { snapshot: "prepared-example", ttl: "forever" } },
    { ...input, settings: {} },
    { ...input, settings: { organizationId: "organization-one" } },
    { ...input, settings: { snapshot: "prepared-example" } },
    ...[null, 42, "", "  ", "x".repeat(257)].map((organizationId) =>
      Object.assign({}, input, { settings: Object.assign({}, input.settings, { organizationId }) }),
    ),
  ])("rejects invalid credentials or allocation settings without producing a patch", (invalid) => {
    expect(() => prepareCrabboxSetup({}, invalid as WorkerSetupPrepareParams)).toThrow();
  });
});

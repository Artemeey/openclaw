import { readFile, stat } from "node:fs/promises";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCrabboxControlRunner } from "./crabbox-connections.js";
import { withCrabboxWorkerEnvProfile } from "./crabbox-worker-env-profile.js";

const result: SpawnResult = {
  code: 0,
  stdout: "",
  stderr: "",
  signal: null,
  killed: false,
  termination: "exit",
};
const options = { timeoutMs: 1000, maxOutputBytes: 4096, killProcessTree: true };
const profile = {
  connectionId: "one",
  provider: "daytona",
  organizationId: "organization-one",
  snapshot: "snapshot-one",
  target: "region-one",
};
function config(apiKey: unknown): OpenClawConfig {
  return {
    plugins: {
      entries: {
        crabbox: {
          config: {
            connections: { one: { label: "One", provider: "daytona", credentials: { apiKey } } },
          },
        },
      },
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("Crabbox connection control context", () => {
  it("forwards setup values only through the private worker profile, never the control key", async () => {
    let forwardedPath = "";
    const runner = createCrabboxControlRunner({
      getConfig: () => config("control-key-fixture"),
      profile,
      runCommand: async (argv, child) => {
        expect(child.env?.CRABBOX_DAYTONA_API_KEY).toBe("control-key-fixture");
        expect(child.env?.CRABBOX_DAYTONA_ORGANIZATION_ID).toBe("organization-one");
        expect(child.env?.CRABBOX_ENV_ALLOW).toBe(",");
        expect(child.env).not.toHaveProperty("CRABBOX_WORKER_SETUP_CODE");
        forwardedPath = argv[argv.indexOf("--env-from-profile") + 1]!;
        const contents = await readFile(forwardedPath, "utf8");
        expect(contents).toContain('CRABBOX_WORKER_SETUP_CODE="setup-code-fixture"');
        expect(contents).toContain('WORKER_NOTE="operator-selected"');
        expect(contents).not.toContain("control-key-fixture");
        expect(contents).not.toContain("organization-one");
        expect((await stat(forwardedPath)).mode & 0o777).toBe(0o600);
        expect(argv.filter((_value, index) => argv[index - 1] === "--allow-env")).toEqual([
          "CRABBOX_WORKER_SETUP_CODE",
          "WORKER_NOTE",
        ]);
        expect(JSON.stringify(argv)).not.toContain("setup-code-fixture");
        expect(JSON.stringify(argv)).not.toContain("control-key-fixture");
        expect(JSON.stringify(argv)).not.toContain("organization-one");
        return result;
      },
    });
    await withCrabboxWorkerEnvProfile(
      { CRABBOX_WORKER_SETUP_CODE: "setup-code-fixture", WORKER_NOTE: "operator-selected" },
      (names, file, childEnv) =>
        runner(
          [
            "/mock/crabbox",
            "run",
            "--env-from-profile",
            file!,
            ...names.flatMap((name) => ["--allow-env", name]),
          ],
          { ...options, env: childEnv },
        ),
    );
    await expect(stat(forwardedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("isolates every child, preserves the allocation snapshot, and observes secret rotation", async () => {
    vi.stubEnv("CRABBOX_CONFIG", "/unrelated/project.yaml");
    vi.stubEnv("DAYTONA_API_KEY", "ambient-fixture-key");
    vi.stubEnv("CRABBOX_DAYTONA_ORGANIZATION_ID", "ambient-organization");
    vi.stubEnv("DAYTONA_ORGANIZATION_ID", "other-organization");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "unrelated-fixture-key");
    let current = config("first-fixture-key");
    const configPaths: string[] = [];
    const keys: string[] = [];
    const allocationProfile = { ...profile };
    const runner = createCrabboxControlRunner({
      getConfig: () => current,
      profile: allocationProfile,
      runCommand: async (argv, child) => {
        expect(child.baseEnv).toEqual({});
        expect(child.env).not.toHaveProperty("DAYTONA_API_KEY");
        expect(child.env).not.toHaveProperty("DAYTONA_ORGANIZATION_ID");
        expect(child.env?.CRABBOX_DAYTONA_ORGANIZATION_ID).toBe("organization-one");
        expect(child.env).not.toHaveProperty("AWS_ACCESS_KEY_ID");
        expect(child.env?.CRABBOX_ENV_ALLOW).toBe(",");
        expect(JSON.stringify(argv)).not.toContain("fixture-key");
        keys.push(child.env!.CRABBOX_DAYTONA_API_KEY!);
        const file = child.env!.CRABBOX_CONFIG!;
        configPaths.push(file);
        expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
          provider: "daytona",
          daytona: { snapshot: "snapshot-one", target: "region-one" },
        });
        return result;
      },
    });
    allocationProfile.organizationId = "changed-after-allocation";
    for (const command of ["doctor", "warmup", "inspect", "run", "heartbeat", "stop"]) {
      await runner(["/mock/crabbox", command], options);
      current = config("rotated-fixture-key");
    }
    expect(keys).toEqual(["first-fixture-key", ...Array(5).fill("rotated-fixture-key")]);
    expect(process.env.CRABBOX_DAYTONA_ORGANIZATION_ID).toBe("ambient-organization");
    for (const file of configPaths) {
      await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each([
    {
      name: "unavailable reference",
      current: config({ source: "store", provider: "default", id: "MISSING_KEY" }),
    },
    { name: "removed connection", current: {} },
    {
      name: "changed provider",
      current: {
        plugins: {
          entries: {
            crabbox: {
              config: {
                connections: {
                  one: {
                    label: "One",
                    provider: "other",
                    credentials: { apiKey: "other-fixture-key" },
                  },
                },
              },
            },
          },
        },
      },
    },
  ])("fails before spawning for $name, without ambient fallback", async ({ current }) => {
    const runCommand = vi.fn(async () => result);
    const run = createCrabboxControlRunner({ getConfig: () => current, profile, runCommand });
    await expect(run(["/mock/crabbox", "stop"], options)).rejects.toThrow(/connection/i);
    expect(runCommand).not.toHaveBeenCalled();
  });
});

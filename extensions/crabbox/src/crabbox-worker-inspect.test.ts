import { describe, expect, it } from "vitest";
import { inspectCrabboxLease } from "./crabbox-worker-inspect.js";

function inspectJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: "cbx_012345abcdef", state: "RUNNING", ...overrides });
}

describe("Crabbox worker inspect", () => {
  it("projects lifecycle facts without retaining provider transport details", async () => {
    expect(
      await inspectCrabboxLease({
        context: { binary: "/mock/crabbox", provider: "daytona" },
        id: "cbx_012345abcdef",
        expectedLeaseId: "cbx_012345abcdef",
        runCommand: async () => ({
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
          stderr: "",
          stdout: inspectJson({
            providerMetadata: { instanceProfileAttached: false },
            ready: true,
            sshHost: "worker.example.test",
            sshPort: 2222,
            sshKey: "/tmp/provider-owned-key",
          }),
        }),
      }),
    ).toStrictEqual({
      status: "found",
      inspect: {
        id: "cbx_012345abcdef",
        state: "running",
        tailscaleEnabled: false,
        awsInstanceProfileAttached: false,
        ready: true,
      },
    });
  });
});

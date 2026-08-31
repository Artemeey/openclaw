// Update-channel switch Docker assertions accept the candidate's advertised dry-run route.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/update-channel-switch/assertions.mjs";

function resolveStoredDevRoute(preview: Record<string, unknown>) {
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "resolve-stored-dev-route"], {
    encoding: "utf8",
    env: { ...process.env, UPDATE_JSON: JSON.stringify(preview) },
  });
}

describe("update-channel switch Docker assertions", () => {
  it.each([
    ["git", { mode: "git", switchToGit: true, updateInstallKind: "git" }],
    ["package", { mode: "npm", switchToGit: false, updateInstallKind: "package" }],
  ])("uses the advertised stored dev %s route", (expectedRoute, route) => {
    const result = resolveStoredDevRoute({
      dryRun: true,
      installKind: "package",
      storedChannel: "dev",
      effectiveChannel: "dev",
      switchToPackage: false,
      ...route,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(expectedRoute);
  });

  it("rejects an inconsistent advertised route", () => {
    const result = resolveStoredDevRoute({
      dryRun: true,
      installKind: "package",
      storedChannel: "dev",
      effectiveChannel: "dev",
      mode: "npm",
      switchToGit: false,
      switchToPackage: false,
      updateInstallKind: "git",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Expected values to be strictly equal");
  });
});

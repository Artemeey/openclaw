import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PARKING_SCRIPT = "scripts/e2e/lib/upgrade-survivor/config-parking.mjs";

describe("upgrade survivor config parking", () => {
  it("parks a minimal auth-only gateway config and restores authored bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-config-parking-"));
    try {
      const configPath = join(root, "openclaw.json");
      const snapshotPath = join(root, "authored-config");
      const authored =
        '{\n  "plugins": { "entries": { "whatsapp": { "enabled": true } } },\n  "sentinel": true\n}\n';
      writeFileSync(configPath, authored);

      execFileSync(process.execPath, [
        PARKING_SCRIPT,
        "park-restart-probe",
        configPath,
        snapshotPath,
        "18789",
      ]);
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
        plugins: { enabled: false },
        gateway: {
          port: 18789,
          mode: "local",
          bind: "loopback",
          controlUi: { enabled: false },
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "GATEWAY_AUTH_TOKEN_REF" },
          },
          reload: { mode: "off" },
        },
      });
      expect(readFileSync(snapshotPath, "utf8")).toBe(authored);

      execFileSync(process.execPath, [PARKING_SCRIPT, "restore", configPath, snapshotPath]);
      expect(readFileSync(configPath, "utf8")).toBe(authored);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

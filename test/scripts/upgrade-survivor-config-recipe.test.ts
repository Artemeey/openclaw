// Upgrade Survivor Config Recipe tests cover upgrade survivor config recipe script behavior.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_COMMAND_MAX_BUFFER_BYTES,
  CONFIG_COMMAND_TIMEOUT_MS,
  adaptStepForBaseline,
  isReleaseBefore,
  resolveUpgradeSurvivorOpenClawCommand,
  runUpgradeSurvivorOpenClawStep,
} from "../../scripts/e2e/lib/upgrade-survivor/config-recipe.mjs";

const RECIPE_PATH = "scripts/e2e/lib/upgrade-survivor/config-recipe.mjs";

describe("upgrade survivor config recipe command resolution", () => {
  it("compares baseline versions with the shared release parser", () => {
    expect(isReleaseBefore("2026.3.31", "2026.4.0")).toBe(true);
    expect(isReleaseBefore("2026.3.31-beta.1", "2026.4.0")).toBe(true);
    expect(isReleaseBefore("2026.4.1", "2026.4.0")).toBe(false);
    expect(isReleaseBefore(null, "2026.4.0")).toBe(false);
    expect(isReleaseBefore("2026.3.31junk", "2026.4.0")).toBe(false);
    expect(isReleaseBefore("2026.3.9007199254740993", "2026.4.0")).toBe(false);
  });

  it.each([
    ["2026.8.1-beta.1", true],
    ["2026.8.1-beta.2", false],
    ["2026.8.1", false],
  ])("adapts the legacy default marker for baseline %s", (version, keepsDefault) => {
    const summary = { skippedIntents: [] };
    const step = adaptStepForBaseline(
      {
        id: "agents",
        intent: "agents",
        argv: [
          "config",
          "set",
          "agents",
          JSON.stringify({ list: [{ id: "main", default: true }, { id: "ops" }] }),
          "--strict-json",
        ],
      },
      version,
      summary,
    );
    const agents = JSON.parse(step?.argv[3] ?? "{}");

    expect(agents.list[0].default).toBe(keepsDefault ? true : undefined);
    expect(summary.skippedIntents).toEqual([]);
  });

  it("adapts Discord DM fields for explicit-ownership baselines", () => {
    const summary = { skippedIntents: [] };
    const step = adaptStepForBaseline(
      {
        id: "channels-discord",
        intent: "discord-channel",
        argv: [
          "config",
          "set",
          "channels.discord",
          JSON.stringify({
            enabled: true,
            dm: { policy: "allowlist", allowFrom: ["111111111111111111"] },
          }),
          "--strict-json",
        ],
      },
      "2026.8.1",
      summary,
    );
    const discord = JSON.parse(step?.argv[3] ?? "{}");

    expect(discord).toMatchObject({
      enabled: true,
      dmPolicy: "allowlist",
      allowFrom: ["111111111111111111"],
    });
    expect(discord.dm).toBeUndefined();
  });

  it("wraps Windows openclaw npm shims through cmd.exe", () => {
    expect(
      resolveUpgradeSurvivorOpenClawCommand(
        ["config", "set", "models.providers.openai", '{"apiKey":"sk test"}', "--strict-json"],
        {
          comSpec: String.raw`C:\Windows\System32\cmd.exe`,
          platform: "win32",
        },
      ),
    ).toEqual({
      args: [
        "/d",
        "/s",
        "/c",
        'openclaw.cmd config set models.providers.openai "{""apiKey"":""sk test""}" --strict-json',
      ],
      command: String.raw`C:\Windows\System32\cmd.exe`,
      commandLabel:
        'openclaw config set models.providers.openai {"apiKey":"sk test"} --strict-json',
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("keeps POSIX openclaw invocations direct", () => {
    expect(
      resolveUpgradeSurvivorOpenClawCommand(["config", "validate"], {
        platform: "linux",
      }),
    ).toEqual({
      args: ["config", "validate"],
      command: "openclaw",
      commandLabel: "openclaw config validate",
      shell: false,
    });
  });

  it("bounds baseline config commands and reports spawn errors", () => {
    const calls: unknown[] = [];
    const timeoutError = Object.assign(new Error("spawnSync openclaw ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });

    const outcome = runUpgradeSurvivorOpenClawStep(
      {
        argv: ["config", "validate"],
        id: "validate",
        intent: "validate",
      },
      {
        spawnSyncCommand(command: string, args: string[], options: unknown) {
          calls.push({ args, command, options });
          return {
            error: timeoutError,
            signal: "SIGTERM",
            status: null,
            stderr: "still validating",
            stdout: "partial output",
          };
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      args: ["config", "validate"],
      command: "openclaw",
      options: {
        killSignal: "SIGTERM",
        maxBuffer: CONFIG_COMMAND_MAX_BUFFER_BYTES,
        timeout: CONFIG_COMMAND_TIMEOUT_MS,
      },
    });
    expect(outcome).toMatchObject({
      command: "openclaw config validate",
      errorCode: "ETIMEDOUT",
      errorMessage: "spawnSync openclaw ETIMEDOUT",
      ok: false,
      signal: "SIGTERM",
      status: null,
      stderr: "still validating",
      stdout: "partial output",
    });
  });

  it("skips ACPX bridge config on baselines before the bridge field existed", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-recipe-acpx-"));
    try {
      const binDir = join(root, "bin");
      const logPath = join(root, "openclaw-argv.jsonl");
      const summaryPath = join(root, "summary.json");
      mkdirSync(binDir, { recursive: true });
      const openclawLogPath = join(binDir, "openclaw-log.js");
      const openclawPath = join(binDir, "openclaw");
      const openclawCmdPath = join(binDir, "openclaw.cmd");
      writeFileSync(
        openclawLogPath,
        `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(0);
`,
      );
      writeFileSync(openclawPath, `#!/usr/bin/env node\nrequire("./openclaw-log.js");\n`);
      chmodSync(openclawPath, 0o755);
      writeFileSync(
        openclawCmdPath,
        `@echo off\r\n"${process.execPath}" "%~dp0openclaw-log.js" %*\r\n`,
      );

      execFileSync(
        process.execPath,
        [RECIPE_PATH, "apply", "--summary", summaryPath, "--baseline-version", "2026.4.21"],
        {
          env: {
            ...process.env,
            OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "acpx-openclaw-tools-bridge",
            PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
          },
          stdio: "pipe",
        },
      );

      const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
      const loggedArgs = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(summary.skippedIntents).toContain("acpx-openclaw-tools-bridge");
      expect(loggedArgs).not.toContainEqual(
        expect.arrayContaining([
          "set",
          "plugins",
          expect.stringContaining("openClawToolsMcpBridge"),
        ]),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

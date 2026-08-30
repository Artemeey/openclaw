// Test script helpers provide shared filesystem and process utilities for script tests.
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { runVitestShutdownCommand } from "../helpers/vitest-shutdown-command.js";

/** Keep script children secretless and all of their writable namespaces fixture-owned. */
export function createScriptTestEnv(root: string): NodeJS.ProcessEnv {
  const ownedRoot = fs.realpathSync(root);
  const home = path.join(ownedRoot, "home");
  const tmp = path.join(ownedRoot, "tmp");
  const directories = {
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: path.join(ownedRoot, "state"),
    OPENCLAW_WORKSPACE_DIR: path.join(ownedRoot, "workspace"),
    XDG_CONFIG_HOME: path.join(ownedRoot, "config"),
    XDG_CACHE_HOME: path.join(ownedRoot, "cache"),
    XDG_DATA_HOME: path.join(ownedRoot, "data"),
    XDG_STATE_HOME: path.join(ownedRoot, "xdg-state"),
    XDG_RUNTIME_DIR: path.join(ownedRoot, "runtime"),
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
  };
  for (const directory of new Set(Object.values(directories))) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const configPath = path.join(directories.XDG_CONFIG_HOME, "openclaw.json");
  fs.writeFileSync(configPath, "{}\n");
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    ...directories,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_TEST_PROJECTS_TIMINGS: "0",
    TSX_DISABLE_CACHE: "1",
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
}

export function linkPnpmBootstrapShellTools(binDir: string): void {
  // Omit package managers: absence must not depend on the host's installed tools.
  for (const name of [
    "bash",
    "cp",
    "date",
    "dirname",
    "env",
    "grep",
    "head",
    "mkdir",
    "mktemp",
    "rm",
  ]) {
    const binary = ["/usr/bin", "/bin"].map((dir) => path.join(dir, name)).find(fs.existsSync);
    if (!binary) {
      throw new Error(`Missing system shell fixture tool: ${name}`);
    }
    fs.symlinkSync(binary, path.join(binDir, name));
  }
}

export function writeNodeBackedJq(binDir: string): void {
  const jqPath = path.join(binDir, "jq");
  fs.writeFileSync(
    jqPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const query = args.at(-1) ?? "";
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const print = (value) => process.stdout.write(String(value ?? "") + "\\n");

if (query === ".login") print(input.login);
else if (query === ".name // empty") print(input.name ?? "");
else if (query === ".created_at") print(input.created_at);
else if (query === ".type") print(input.type);
else if (query === ".totalCommitContributions") print(input.totalCommitContributions);
else if (query === ".totalIssueContributions") print(input.totalIssueContributions);
else if (query === ".totalPullRequestContributions") print(input.totalPullRequestContributions);
else if (query === ".totalPullRequestReviewContributions") print(input.totalPullRequestReviewContributions);
else if (query.includes("{id: .profileId")) {
  const profiles = input.auth?.oauth?.profiles ?? [];
  const profile = profiles.filter((item) => item.provider === "anthropic" && item.type === "oauth").sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0];
  print(profile?.profileId ?? "none");
} else if (query.includes(".auth.providers[]")) {
  const counts = (input.auth?.providers ?? []).filter((item) => item.provider === "anthropic").map((item) => item.profiles?.apiKey ?? 0);
  print(Math.max(0, ...counts));
} else if (query.includes(".auth.oauth.profiles[]")) {
  const profiles = (input.auth?.oauth?.profiles ?? []).filter((item) => item.provider === "anthropic" && item.type === "oauth");
  print(Math.max(0, ...profiles.map((item) => item.expiresAt ?? 0)));
} else {
  process.stderr.write("unsupported jq query: " + query + "\\n");
  process.exit(2);
}
`,
  );
  fs.chmodSync(jqPath, 0o755);
}

export function createScriptTestHarness() {
  const tempDirs: string[] = [];
  const commands: { controller: AbortController; completion: Promise<unknown> }[] = [];

  afterEach(async () => {
    // Vitest timeouts abandon the test promise. Join its writers before removing
    // their roots; failed process-tree verification must retain the fixtures.
    const pending = commands.slice();
    for (const { controller } of pending) {
      controller.abort();
    }
    const failures: unknown[] = [];
    for (const result of await Promise.allSettled(pending.map(({ completion }) => completion))) {
      if (result.status === "rejected") {
        const error: unknown = result.reason;
        if (!(error instanceof Error && "code" in error && error.code === "ABORT_ERR")) {
          failures.push(error);
        }
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Script child cleanup failed; retained fixture roots.");
    }
    commands.splice(0, pending.length);
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function createTempDirAsync(prefix: string): Promise<string> {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function trackTempDir(dir: string): string {
    tempDirs.push(dir);
    return dir;
  }

  function runNodeScript(args: string[], root: string) {
    const controller = new AbortController();
    const completion = runVitestShutdownCommand({
      args,
      cwd: root,
      env: createScriptTestEnv(root),
      signal: controller.signal,
    });
    commands.push({ controller, completion });
    return completion.then(({ code, stdout, stderr }) => ({ code, output: stdout + stderr }));
  }

  return {
    createTempDir,
    createTempDirAsync,
    trackTempDir,
    runNodeScript,
  };
}

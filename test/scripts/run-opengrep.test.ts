// Run Opengrep tests cover run opengrep script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function copyRunOpengrepFiles(repo: string): void {
  const scriptSource = path.resolve("scripts/run-opengrep.sh");
  const helperSource = path.resolve("scripts/lib/merge-head-diff-base.mjs");
  const argUtilsSource = path.resolve("scripts/lib/arg-utils.runtime.mjs");
  writeFile(path.join(repo, "scripts/run-opengrep.sh"), fs.readFileSync(scriptSource, "utf8"));
  writeFile(
    path.join(repo, "scripts/lib/merge-head-diff-base.mjs"),
    fs.readFileSync(helperSource, "utf8"),
  );
  writeFile(
    path.join(repo, "scripts/lib/arg-utils.runtime.mjs"),
    fs.readFileSync(argUtilsSource, "utf8"),
  );
  fs.chmodSync(path.join(repo, "scripts/run-opengrep.sh"), 0o755);
}

function installOpengrepStub(repo: string): { argsPath: string; binDir: string } {
  const argsPath = path.join(repo, "opengrep-args.txt");
  const binDir = path.join(repo, "bin");
  fs.mkdirSync(binDir);
  writeFile(
    path.join(binDir, "opengrep"),
    ["#!/usr/bin/env bash", `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`, "exit 0", ""].join(
      "\n",
    ),
  );
  fs.chmodSync(path.join(binDir, "opengrep"), 0o755);
  return { argsPath, binDir };
}

describe("run-opengrep.sh", () => {
  it("fails before scanning with official installation advice when opengrep is missing", () => {
    const repo = createTempDir("openclaw-run-opengrep-missing-");
    copyRunOpengrepFiles(repo);
    writeFile(path.join(repo, "security/opengrep/precise.yml"), "rules: []\n");

    const binDir = path.join(repo, "bin");
    fs.mkdirSync(binDir);
    for (const command of ["bash", "dirname", "cat"]) {
      const executable = execFileSync("bash", ["-c", 'command -v "$1"', "_", command], {
        encoding: "utf8",
      }).trim();
      fs.symlinkSync(executable, path.join(binDir, command));
    }

    const result = spawnSync(
      "bash",
      ["scripts/run-opengrep.sh", "--changed", "--sarif", "--error"],
      { cwd: repo, env: { ...process.env, PATH: binDir }, encoding: "utf8" },
    );

    expect(result.status).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("'opengrep' not found on PATH");
    expect(result.stderr).toMatch(
      /curl -fsSL https:\/\/raw\.githubusercontent\.com\/opengrep\/opengrep\/\S+\/install\.sh \| bash -s -- -v \S+/,
    );
    expect(fs.existsSync(path.join(repo, ".opengrep-out"))).toBe(false);
    expect(result.stderr).not.toContain("pipx");
    expect(result.stderr).not.toContain("opengrep/tap/opengrep");
  });

  it("validates the rulepack when only OpenGrep rulepack files changed", () => {
    const repo = createTempDir("openclaw-run-opengrep-");
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");

    copyRunOpengrepFiles(repo);
    writeFile(path.join(repo, "security/opengrep/precise.yml"), "rules: []\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "initial");

    fs.appendFileSync(path.join(repo, "security/opengrep/precise.yml"), "# changed\n");
    const { argsPath, binDir } = installOpengrepStub(repo);

    execFileSync("bash", ["scripts/run-opengrep.sh", "--changed"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_OPENGREP_BASE_REF: "HEAD",
      },
      encoding: "utf8",
    });

    const args = fs.readFileSync(argsPath, "utf8");
    expect(args).toContain("security/opengrep/precise.yml");
  });

  it("writes empty SARIF when a changed scan has no first-party paths", () => {
    const repo = createTempDir("openclaw-run-opengrep-empty-sarif-");
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");

    copyRunOpengrepFiles(repo);
    writeFile(path.join(repo, "security/opengrep/precise.yml"), "rules: []\n");
    writeFile(path.join(repo, ".github/actions/ensure-base-commit/action.yml"), "name: ensure\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "initial");

    fs.appendFileSync(
      path.join(repo, ".github/actions/ensure-base-commit/action.yml"),
      "# changed\n",
    );
    const { argsPath, binDir } = installOpengrepStub(repo);

    execFileSync("bash", ["scripts/run-opengrep.sh", "--changed", "--sarif", "--error"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_OPENGREP_BASE_REF: "HEAD",
      },
      encoding: "utf8",
    });

    const sarif = JSON.parse(
      fs.readFileSync(path.join(repo, ".opengrep-out/precise.sarif"), "utf8"),
    );
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].tool.driver.name).toBe("Opengrep OSS");
    expect(sarif.runs[0].tool.driver.semanticVersion).toBe("1.27.1");
    expect(sarif.runs[0].results).toEqual([]);
    expect(fs.existsSync(argsPath)).toBe(false);
  });

  it.each([
    {
      failure: "invalid base range",
      baseRef: "missing-base...HEAD",
      failedGitCommand: null,
      errorText: "missing-base...HEAD",
    },
    {
      failure: "git ls-files",
      baseRef: "HEAD",
      failedGitCommand: "ls-files",
      errorText: "forced git ls-files failure",
    },
  ])(
    "fails when changed-path discovery hits $failure",
    ({ baseRef, failedGitCommand, errorText }) => {
      const repo = createTempDir("openclaw-run-opengrep-discovery-failure-");
      git(repo, "init", "-q");
      git(repo, "config", "user.email", "test@example.com");
      git(repo, "config", "user.name", "Test User");

      copyRunOpengrepFiles(repo);
      writeFile(path.join(repo, "security/opengrep/precise.yml"), "rules: []\n");
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "initial");

      const { argsPath, binDir } = installOpengrepStub(repo);
      if (failedGitCommand) {
        const realGit = execFileSync("bash", ["-lc", "command -v git"], {
          encoding: "utf8",
        }).trim();
        writeFile(
          path.join(binDir, "git"),
          [
            "#!/usr/bin/env bash",
            `if [[ "\${1:-}" == ${JSON.stringify(failedGitCommand)} ]]; then`,
            '  echo "forced git ls-files failure" >&2',
            "  exit 71",
            "fi",
            `exec ${JSON.stringify(realGit)} "$@"`,
            "",
          ].join("\n"),
        );
        fs.chmodSync(path.join(binDir, "git"), 0o755);
      }

      const result = spawnSync(
        "bash",
        ["scripts/run-opengrep.sh", "--changed", "--sarif", "--error"],
        {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            OPENCLAW_OPENGREP_BASE_REF: baseRef,
          },
          encoding: "utf8",
        },
      );

      expect.soft(result.status).not.toBe(0);
      expect.soft(result.stderr).toContain(errorText);
      expect.soft(fs.existsSync(argsPath)).toBe(false);
      expect.soft(fs.existsSync(path.join(repo, ".opengrep-out/precise.sarif"))).toBe(false);
    },
  );

  it("prepares and scans a shallow PR merge without fetching a stale payload base", () => {
    let repo = createTempDir("openclaw-run-opengrep-merge-");
    git(repo, "init", "-q", "--initial-branch=main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");

    copyRunOpengrepFiles(repo);
    writeFile(path.join(repo, "security/opengrep/precise.yml"), "rules: []\n");
    writeFile(path.join(repo, "README.md"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "base");
    const staleBase = git(repo, "rev-parse", "HEAD");

    git(repo, "switch", "-q", "-c", "feature");
    writeFile(path.join(repo, "src/pr.ts"), "export const pr = true;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "feature");

    git(repo, "switch", "-q", "main");
    writeFile(path.join(repo, "src/main-only.ts"), "export const mainOnly = true;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "main only");
    const mergeBase = git(repo, "rev-parse", "HEAD");
    git(repo, "merge", "--no-ff", "feature", "-m", "synthetic merge");

    const checkout = createTempDir("openclaw-run-opengrep-shallow-");
    git(checkout, "clone", "--quiet", "--depth=2", pathToFileURL(repo).href, ".");
    repo = checkout;
    git(repo, "remote", "remove", "origin");
    expect(spawnSync("git", ["cat-file", "-e", staleBase], { cwd: repo }).status).not.toBe(0);

    const workflow = parse(fs.readFileSync(".github/workflows/opengrep-precise.yml", "utf8"));
    const outputPath = path.join(repo, "github-output");
    const expressions: Record<string, string> = {
      "github.event.pull_request.base.sha": staleBase,
      "github.event.pull_request.base.ref": "main",
    };
    const expand = (value: string) =>
      value.replace(/\$\{\{ ([\w.-]+) \}\}/gu, (_match, key: string) => {
        const expanded = expressions[key];
        if (expanded === undefined) {
          throw new Error(`Unexpected workflow expression: ${key}`);
        }
        return expanded;
      });
    for (const step of workflow.jobs.scan.steps) {
      if (step.name === "Checkout") {
        continue;
      }
      if (step.name === "Install opengrep") {
        break;
      }
      let runnable = step;
      if (step.uses) {
        const actionPath = path.resolve(step.uses);
        expressions["github.action_path"] = actionPath;
        for (const [key, value] of Object.entries(step.with)) {
          expressions[`inputs.${key}`] = expand(String(value));
        }
        runnable = parse(fs.readFileSync(path.join(actionPath, "action.yml"), "utf8")).runs
          .steps[0];
      }
      const prepared = spawnSync("bash", ["-euo", "pipefail", "-c", runnable.run], {
        cwd: repo,
        env: {
          ...process.env,
          RUNNER_OS: process.platform === "win32" ? "Windows" : process.platform,
          GITHUB_OUTPUT: outputPath,
          ...Object.fromEntries(
            Object.entries(runnable.env ?? {}).map(([key, value]) => [key, expand(String(value))]),
          ),
        },
        encoding: "utf8",
      });
      expect(prepared.status, `${prepared.stdout}${prepared.stderr}`).toBe(0);
      if (step.id) {
        for (const line of fs.readFileSync(outputPath, "utf8").trim().split("\n")) {
          const separator = line.indexOf("=");
          expressions[`steps.${step.id}.outputs.${line.slice(0, separator)}`] = line.slice(
            separator + 1,
          );
        }
      }
    }
    const scan = workflow.jobs.scan.steps.find(
      (step: { name: string }) => step.name === "Run opengrep on PR diff",
    );
    expect(expand(scan.env.OPENCLAW_OPENGREP_BASE_REF)).toBe(`${mergeBase}...HEAD`);
    const { argsPath, binDir } = installOpengrepStub(repo);

    execFileSync("bash", ["scripts/run-opengrep.sh", "--changed"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        ...Object.fromEntries(
          Object.entries(scan.env).map(([key, value]) => [key, expand(String(value))]),
        ),
      },
      encoding: "utf8",
    });

    const args = fs.readFileSync(argsPath, "utf8");
    expect(args).toContain("src/pr.ts");
    expect(args).not.toContain("src/main-only.ts");
  });
});

describe("OpenGrep GitHub SARIF uploads", () => {
  it.each(["opengrep-precise.yml", "opengrep-precise-full.yml"])(
    "%s preserves raw evidence and uploads only findings without accepted source suppression",
    (workflowName) => {
      const repo = createTempDir("openclaw-opengrep-sarif-");
      const ignored = [
        { ruleId: "in-source", suppressions: [{ kind: "inSource" }] },
        { ruleId: "accepted", suppressions: [{ kind: "inSource", status: "accepted" }] },
      ];
      const retained = [
        { ruleId: "active" },
        { ruleId: "empty", suppressions: [] },
        { ruleId: "unknown", suppressions: null },
        { ruleId: "external", suppressions: [{ kind: "external", status: "accepted" }] },
        { ruleId: "under-review", suppressions: [{ kind: "inSource", status: "underReview" }] },
        { ruleId: "rejected", suppressions: [{ kind: "inSource", status: "rejected" }] },
        { ruleId: "future-status", suppressions: [{ kind: "inSource", status: "unknown" }] },
        { ruleId: "null-status", suppressions: [{ kind: "inSource", status: null }] },
        { ruleId: "malformed", suppressions: [null] },
        {
          ruleId: "mixed",
          suppressions: [{ kind: "inSource" }, { kind: "inSource", status: "rejected" }],
        },
      ];
      const tool = { driver: { name: "Opengrep OSS", rules: [{ id: "unchanged-rule" }] } };
      const report = {
        version: "2.1.0",
        runs: [
          {
            tool,
            invocations: [{ executionSuccessful: false }],
            results: [...ignored, ...retained],
          },
          { tool, results: [] },
          { tool },
        ],
      };
      const raw = `${JSON.stringify(report, null, 2)}\n`;
      const reportPath = ".opengrep-out/precise.sarif";
      writeFile(path.join(repo, reportPath), raw);
      const workflow = parse(fs.readFileSync(`.github/workflows/${workflowName}`, "utf8"));
      const steps: Array<{
        name: string;
        id?: string;
        run?: string;
        if?: string;
        with?: Record<string, string>;
      }> = workflow.jobs.scan.steps;
      const prepare = steps.find((step) => step.id === "github-sarif");
      if (prepare) {
        writeFile(
          path.join(repo, "scripts/opengrep-github-sarif.mjs"),
          fs.readFileSync("scripts/opengrep-github-sarif.mjs", "utf8"),
        );
        expect(prepare.if).toBe("always() && hashFiles('.opengrep-out/precise.sarif') != ''");
        const prepared = spawnSync("bash", ["-euo", "pipefail", "-c", prepare.run!], {
          cwd: repo,
          encoding: "utf8",
        });
        expect(prepared.status).toBe(0);
        expect(prepared.stderr).toContain(
          "Omitted 2 accepted in-source suppression(s); raw audit: .opengrep-out/precise.sarif",
        );
      }
      const upload = steps.find((step) => step.name === "Upload SARIF to GitHub Code Scanning")!;
      const artifact = steps.find((step) => step.name === "Upload SARIF as workflow artifact")!;
      const uploadPath = upload.with?.sarif_file;
      if (!uploadPath) {
        throw new Error("Workflow must name its SARIF upload payload");
      }
      const uploaded = JSON.parse(fs.readFileSync(path.join(repo, uploadPath), "utf8"));
      expect(uploaded).toEqual({
        ...report,
        runs: [{ ...report.runs[0], results: retained }, ...report.runs.slice(1)],
      });
      expect(upload.if).toBe("always() && steps.github-sarif.outcome == 'success'");
      expect(artifact.with?.path).toBe(reportPath);
      expect(artifact.with?.["if-no-files-found"]).toBe("error");
      expect(fs.readFileSync(path.join(repo, reportPath), "utf8")).toBe(raw);
    },
  );

  it.each(["{", JSON.stringify({ version: "2.1.0", runs: [{ results: "invalid" }] })])(
    "fails malformed reports without emitting an upload payload: %s",
    (raw) => {
      const repo = createTempDir("openclaw-opengrep-sarif-invalid-");
      const inputPath = path.join(repo, "raw.sarif");
      writeFile(inputPath, raw);
      const result = spawnSync(process.execPath, ["scripts/opengrep-github-sarif.mjs", inputPath], {
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trimEnd()).toMatch(/\[opengrep-github-sarif\] FAILED \(exit 1\)$/);
      expect(fs.readFileSync(inputPath, "utf8")).toBe(raw);
    },
  );
});

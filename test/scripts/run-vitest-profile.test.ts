// Run Vitest Profile tests cover run vitest profile script behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildVitestProfileCommandWithArgs,
  parseArgs,
  resolveVitestProfileDir,
} from "../../scripts/run-vitest-profile.mts";
import { createScriptTestHarness } from "./test-helpers.js";

describe("scripts/run-vitest-profile", () => {
  const {
    createTempDir,
    trackTempDir,
    runNodeScript: runProfileProcess,
  } = createScriptTestHarness();
  const repoRoot = path.resolve(import.meta.dirname, "../..");

  it("joins timed-out script children before removing their fixture roots", async () => {
    const root = createTempDir("oc-profile-timeout-");
    fs.symlinkSync(
      path.join(repoRoot, "node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    const config = path.join(root, "vitest.config.mjs");
    fs.writeFileSync(
      config,
      `export default ${JSON.stringify({
        root,
        cacheDir: path.join(root, "cache"),
        test: { include: ["lifetime.test.ts"], pool: "forks", maxWorkers: 1 },
      })};`,
    );
    fs.writeFileSync(
      path.join(root, "child.mjs"),
      `import fs from "node:fs";
const [root, receipt, stopped] = process.argv.slice(2);
process.on("SIGTERM", () => {
  fs.writeFileSync(stopped, JSON.stringify({ rootExists: fs.existsSync(root) }));
  process.exit(0);
});
// Bound this fault fixture even if harness cancellation regresses.
setTimeout(() => process.exit(1), 10_000);
fs.writeFileSync(receipt + ".tmp", JSON.stringify({ pid: process.pid, root }));
fs.renameSync(receipt + ".tmp", receipt);`,
    );
    fs.writeFileSync(
      path.join(root, "lifetime.test.ts"),
      `import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createScriptTestHarness } from ${JSON.stringify(path.join(repoRoot, "test/scripts/test-helpers.ts"))};
import { isProcessAlive, waitForFile } from ${JSON.stringify(path.join(repoRoot, "test/helpers/process-wait.ts"))};
const harness = createScriptTestHarness();
const receipt = ${JSON.stringify(path.join(root, "child.json"))};
const stopped = ${JSON.stringify(path.join(root, "stopped.json"))};
let running;
describe("ready child", () => {
  beforeEach(async () => {
    const fixture = harness.createTempDir("oc-profile-writer-");
    running = harness.runNodeScript([${JSON.stringify(path.join(root, "child.mjs"))}, fixture, receipt, stopped], fixture);
    // Observe early startup rejection until the test awaits the command itself.
    void running.catch(() => {});
    await waitForFile(receipt, 5000);
  });
  it("times out with an owned child", { timeout: 500 }, async () => {
    await running;
  });
});
it("observes joined writers before fixture removal", () => {
  const { pid, root } = JSON.parse(fs.readFileSync(receipt, "utf8"));
  expect(isProcessAlive(pid)).toBe(false);
  expect(fs.existsSync(root)).toBe(false);
  // Windows terminates the process without delivering a SIGTERM callback.
  if (process.platform !== "win32") {
    expect(JSON.parse(fs.readFileSync(stopped, "utf8")).rootExists).toBe(true);
  }
});`,
    );
    const report = path.join(root, "native.json");
    const result = await runProfileProcess(
      [
        path.join(repoRoot, "scripts/run-vitest.mjs"),
        "run",
        "--config",
        config,
        path.join(root, "lifetime.test.ts"),
        "--reporter=verbose",
        "--reporter=json",
        `--outputFile=${report}`,
      ],
      root,
    );
    expect(result.code, result.output).toBe(1);
    // JSON retains the collection stack; the verbose reporter prints the timeout message.
    expect(result.output).toContain("Error: Test timed out in 500ms.");
    const native = JSON.parse(fs.readFileSync(report, "utf8"));
    expect(native).toMatchObject({
      success: false,
      numTotalTests: 2,
      numPassedTests: 1,
      numFailedTests: 1,
      numPendingTests: 0,
    });
    expect(native.testResults).toHaveLength(1);
    expect(native.testResults[0].assertionResults).toEqual([
      expect.objectContaining({
        title: "times out with an owned child",
        status: "failed",
        failureMessages: [expect.any(String)],
      }),
      expect.objectContaining({
        title: "observes joined writers before fixture removal",
        status: "passed",
        failureMessages: [],
      }),
    ]);
  });

  it("confines native child namespaces to the script fixture", async () => {
    const root = fs.realpathSync(createTempDir("oc-profile-env-"));
    const result = await runProfileProcess(
      [
        "--input-type=module",
        "-e",
        `
import os from "node:os";
console.log(JSON.stringify({ tmp: os.tmpdir(), home: os.homedir(), ...Object.fromEntries(
  ["TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_WORKSPACE_DIR"].map(key => [key, process.env[key] ?? null])
)}));
`,
      ],
      root,
    );
    expect(result.code, result.output).toBe(0);
    const namespaces = JSON.parse(result.output) as Record<string, string | null>;
    for (const [key, value] of Object.entries(namespaces)) {
      expect(value, key).toEqual(expect.any(String));
      expect(value?.startsWith(root + path.sep), key).toBe(true);
    }
  });

  it("defaults profile output outside the repo", () => {
    const outputDir = trackTempDir(resolveVitestProfileDir({ mode: "main", outputDir: "" }));

    expect(outputDir.startsWith(os.tmpdir())).toBe(true);
    expect(outputDir.startsWith(process.cwd())).toBe(false);
  });

  it("keeps explicit output directories", () => {
    expect(
      resolveVitestProfileDir({ mode: "runner", outputDir: ".artifacts/custom-profile" }),
    ).toBe(path.resolve(".artifacts/custom-profile"));
  });

  it.each(["main", "runner"])(
    "launches %s without shell parsing and preserves Vitest arguments",
    (mode) => {
      const outputDir = path.join(os.tmpdir(), "profile with spaces");
      const forwarded = [
        "--config",
        "custom config.ts",
        "--pool",
        "threads",
        "--isolate",
        "--reporter",
        "json",
      ];
      const plan = buildVitestProfileCommandWithArgs({ mode, outputDir, vitestArgs: forwarded });
      expect(plan.command).toBe(process.execPath);
      expect(plan.args.slice(1, 3)).toEqual([mode, outputDir]);
      expect(plan.args.slice(-forwarded.length)).toEqual(forwarded);
    },
  );

  it.each(
    [
      { pool: "forks", isolate: true, custom: false, failRun: false },
      { pool: "threads", isolate: true, custom: false, failRun: true },
      { pool: "forks", isolate: false, custom: false, failRun: true },
      { pool: "threads", isolate: false, custom: false, failRun: false },
      { pool: "forks", isolate: true, custom: true, failRun: true },
      { pool: "threads", isolate: true, custom: true, failRun: false },
      { pool: "forks", isolate: true, custom: true, failRun: false, projects: true },
      { pool: "forks", isolate: false, custom: false, failRun: false, failProfile: true },
      { pool: "threads", isolate: false, custom: false, failRun: true, failProfile: true },
      ...["ignore", "filter"].flatMap((errorPolicy) =>
        [false, true].map((failProfile) => ({
          pool: errorPolicy === "ignore" ? "forks" : "threads",
          isolate: false,
          custom: false,
          failRun: false,
          failProfile,
          unhandled: true,
          errorPolicy,
        })),
      ),
      { pool: "forks", isolate: false, custom: false, failRun: false, unhandled: true },
    ].map((testCase) =>
      Object.assign(
        { projects: false, failProfile: false, unhandled: false, errorPolicy: "default" },
        testCase,
      ),
    ),
  )(
    "profiles selected $pool runner (isolated: $isolate, custom: $custom, failed: $failRun, projects: $projects, write failure: $failProfile, unhandled: $unhandled, policy: $errorPolicy)",
    async ({ pool, isolate, custom, failRun, projects, failProfile, unhandled, errorPolicy }) => {
      const root = createTempDir("oc-profile-sibling-");
      fs.writeFileSync(path.join(root, "package.json"), '{"private":true,"type":"module"}');
      fs.symlinkSync(
        path.join(repoRoot, "node_modules"),
        path.join(root, "node_modules"),
        "junction",
      );
      const environment = custom && pool === "threads" ? "jsdom" : "node";
      const outputDir = path.join(root, "profiles with spaces");
      const configPath = path.join(root, "custom.config.ts");
      const configLoads = path.join(root, "config-loads");
      fs.writeFileSync(
        configPath,
        `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(configLoads)}, "loaded\\n");
export default { cacheDir: ${JSON.stringify(path.join(root, "vite-cache"))}, test: {
  include: ["*.test.ts"], exclude: ["config-excluded.test.ts"], reporters: ["default", "json"], outputFile: "report.json",
  globalSetup: "./custom-setup.ts",
  ${custom && !projects ? 'runner: "./custom-runner.ts",' : ""}
  dangerouslyIgnoreUnhandledErrors: ${errorPolicy === "ignore"},
  ${errorPolicy === "filter" ? 'onUnhandledError(error) { console.error("filtered workload error:", error.message); return false; },' : ""}
  ${projects ? `projects: ["first", "second"].map(name => ({ test: { name, include: [name + ".test.ts"], runner: ${JSON.stringify(path.join(root, "custom-runner.ts"))} } })),` : ""}
} };`,
      );
      for (const name of ["config-excluded", "cli-excluded"]) {
        fs.writeFileSync(
          path.join(root, name + ".test.ts"),
          'throw new Error("excluded files must not run");',
        );
      }
      fs.writeFileSync(
        path.join(root, "custom-setup.ts"),
        `export function setup(project) {
  project.provide("customSetupCount", (project.getProvidedContext().customSetupCount ?? 0) + 1);
}`,
      );
      const customRunner = path.join(root, "custom-runner.ts");
      fs.writeFileSync(
        customRunner,
        `import { TestRunner } from "vitest";
export default class extends TestRunner {
  onCollectStart(file) { super.onCollectStart(file); globalThis.profileCustomRunner = true; }
}`,
      );
      for (const name of ["first", "second"]) {
        fs.writeFileSync(
          path.join(root, `${name}.test.ts`),
          `import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainThread, threadId } from "node:worker_threads";
import { expect, inject, it, vi } from "vitest";
it("retains the selected execution context", async () => {
  vi.resetModules();
  expect(inject("customSetupCount")).toBe(1);
  for (const namespace of [os.tmpdir(), os.homedir(), process.env.XDG_CACHE_HOME]) {
    expect(namespace.startsWith(${JSON.stringify(fs.realpathSync(root))} + path.sep)).toBe(true);
  }
  expect(isMainThread).toBe(${pool === "forks"});
  expect(globalThis.profileCustomRunner === true).toBe(${custom});
  expect(typeof document).toBe(${JSON.stringify(environment === "jsdom" ? "object" : "undefined")});
  ${
    environment === "jsdom" && name === "first"
      ? `const unrelatedModule = ${JSON.stringify(path.join(repoRoot, "scripts/lib/error-format.mts"))};
  await expect(import(unrelatedModule)).rejects.toMatchObject({ code: "ERR_MODULE_NOT_FOUND" });`
      : ""
  }
  fs.writeFileSync(${JSON.stringify(path.join(root, name + ".json"))}, JSON.stringify({ pid: process.pid, threadId }));
  ${failProfile && name === "second" ? `fs.rmdirSync(${JSON.stringify(outputDir)});` : ""}
  ${unhandled && name === "second" ? 'process.emit("unhandledRejection", new Error("intentional unhandled profiling workload"), Promise.resolve());' : ""}
  ${failRun && name === "second" ? 'expect.fail("intentional profiling sibling failure");' : ""}
});`,
        );
      }
      const args = [
        path.join(repoRoot, "scripts/run-vitest-profile.mts"),
        "runner",
        "--output-dir",
        outputDir,
        "--",
        "--config",
        configPath,
        "--configLoader",
        "native",
        "--pool",
        pool,
        `--isolate=${isolate}`,
        "--maxWorkers",
        "1",
        "--environment",
        environment,
        "--exclude",
        "cli-excluded.test.ts",
      ];
      if (projects) {
        args.push("--reporter", "dot", "--reporter", "json");
      }
      const result = await runProfileProcess(args, root);
      const reportPath = path.join(root, "report.json");
      const reportText = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : "";
      const shouldFail = failRun || failProfile || (unhandled && errorPolicy === "default");
      expect(result.code, `${result.output}\n${reportText}`).toBe(shouldFail ? 1 : 0);
      expect(fs.readFileSync(configLoads, "utf8")).toBe("loaded\n");
      if (shouldFail) {
        expect(result.output.trimEnd()).toMatch(/\[run-vitest-profile\] FAILED \(exit 1\)$/u);
      }
      if (failRun) {
        expect(result.output).toContain("intentional profiling sibling failure");
      }
      if (unhandled) {
        expect(result.output).toContain("intentional unhandled profiling workload");
      }
      const report = JSON.parse(reportText);
      expect(report.numTotalTests).toBe(2);
      expect(report.numFailedTests).toBe(failRun ? 1 : 0);
      if (failProfile) {
        expect(result.output).toContain("Failed to write Vitest profiles.");
        expect(result.output).toContain("ENOENT");
        expect(fs.existsSync(outputDir)).toBe(false);
        return;
      }
      const profiles = fs.readdirSync(outputDir);
      for (const name of ["first", "second"]) {
        const { pid, threadId } = JSON.parse(
          fs.readFileSync(path.join(root, name + ".json"), "utf8"),
        );
        const cpuFiles = profiles.filter((file) => file.startsWith(`CPU.${pid}.${threadId}.`));
        const heapFiles = profiles.filter((file) => file.startsWith(`Heap.${pid}.${threadId}.`));
        // Repeated files share one sampler unless Vitest actually creates another worker.
        expect(cpuFiles, result.output).toHaveLength(1);
        expect(heapFiles, result.output).toHaveLength(1);
        const cpu = JSON.parse(fs.readFileSync(path.join(outputDir, cpuFiles[0]!), "utf8"));
        const heap = JSON.parse(fs.readFileSync(path.join(outputDir, heapFiles[0]!), "utf8"));
        expect(cpu.nodes.length).toBeGreaterThan(0);
        expect(cpu.samples.length).toBeGreaterThan(0);
        expect(cpu.endTime).toBeGreaterThan(cpu.startTime);
        expect(heap.head.children.length).toBeGreaterThan(0);
        expect(heap.samples.length).toBeGreaterThan(0);
      }
    },
  );

  it.each([
    { mode: "main", flags: ["--help", "--unknown-profile-test-option"] },
    { mode: "runner", flags: ["-h", "--pool"] },
  ])("prints $mode help without starting a test server", async ({ mode, flags }) => {
    const root = createTempDir("oc-profile-help-");
    const args = [
      path.join(repoRoot, "scripts/run-vitest-profile.mts"),
      mode,
      "--output-dir",
      path.join(root, "profiles"),
      "--",
      ...flags,
    ];
    const result = await runProfileProcess(args, root);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Usage:");
  });

  it.each(
    ["main", "runner"].flatMap((mode) => [
      { mode, flag: "--unknown-profile-test-option", error: "Unknown option" },
      { mode, flag: "--runner=custom-runner.ts", error: "Unknown option" },
      { mode, flag: "--pool", error: "value is missing" },
    ]),
  )("rejects $mode $flag before evaluating config", async ({ mode, flag, error }) => {
    const root = createTempDir("oc-profile-validation-");
    const config = path.join(root, "probe.config.mjs");
    const marker = path.join(root, "config-loaded");
    fs.writeFileSync(
      config,
      `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker)}, "loaded");
throw new Error("Invalid CLI options reached config loading");`,
    );
    const args = [
      path.join(repoRoot, "scripts/run-vitest-profile.mts"),
      mode,
      "--output-dir",
      path.join(root, "profiles"),
      "--",
      "--config",
      config,
      "--configLoader",
      "native",
      flag,
    ];
    const result = await runProfileProcess(args, root);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain(error);
    expect(fs.existsSync(marker)).toBe(false);
    expect(result.output.trimEnd()).toMatch(/\[run-vitest-profile\] FAILED \(exit 1\)$/u);
  });

  it("keeps the public parser's unknown-option opt-in separate from value validation", async () => {
    const { parseCLI } = await import("vitest/node");
    const args = ["vitest", "run", "--unknown-profile-test-option"];
    expect(() => parseCLI([...args], { allowUnknownOptions: false })).toThrow("Unknown option");
    expect(parseCLI([...args], { allowUnknownOptions: true }).options).toMatchObject({
      unknownProfileTestOption: true,
    });
    expect(() => parseCLI(["vitest", "run", "--pool"], { allowUnknownOptions: true })).toThrow(
      "value is missing",
    );
    expect(() => parseCLI(["vitest", "init"])).toThrow("missing required args");
  });

  it("retains the CLI startup error when profile output cannot be written", async () => {
    const root = createTempDir("oc-profile-errors-");
    const plan = buildVitestProfileCommandWithArgs({
      mode: "main",
      outputDir: path.join(root, "missing"),
      vitestArgs: ["--config", "first.config.ts", "--config", "second.config.ts"],
    });
    const result = await runProfileProcess(plan.args, root);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("Expected a single value");
    expect(result.output).toContain("ENOENT");
  });

  it("parses mode and explicit output dir", () => {
    expect(parseArgs(["runner", "--output-dir", "/tmp/out"])).toEqual({
      mode: "runner",
      outputDir: "/tmp/out",
      vitestArgs: [],
    });
  });

  it("rejects missing profile output directories", () => {
    expect(() => parseArgs(["runner", "--output-dir"])).toThrow("Expected --output-dir <dir>.");
    expect(() => parseArgs(["runner", "--output-dir", "-h"])).toThrow(
      "Expected --output-dir <dir>.",
    );
    expect(() => parseArgs(["runner", "--output-dir", "--", "--config", "custom.ts"])).toThrow(
      "Expected --output-dir <dir>.",
    );
  });

  it("passes vitest args after a separator", () => {
    expect(parseArgs(["main", "--output-dir", "/tmp/out", "--", "--config", "custom.ts"])).toEqual({
      mode: "main",
      outputDir: "/tmp/out",
      vitestArgs: ["--config", "custom.ts"],
    });
    expect(
      buildVitestProfileCommandWithArgs({
        mode: "runner",
        outputDir: "/tmp/profile-runner",
        vitestArgs: ["src/example.test.ts"],
      }).args,
    ).toContain("src/example.test.ts");
  });

  it("allows a package-script separator before script flags", () => {
    expect(parseArgs(["main", "--", "--output-dir", "/tmp/out"])).toEqual({
      mode: "main",
      outputDir: "/tmp/out",
      vitestArgs: [],
    });
  });
});

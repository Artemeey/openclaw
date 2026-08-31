import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runPluginsInitCommand } from "../src/cli/plugins-authoring-command.js";

type InspectorReport = {
  status?: unknown;
  summary?: {
    breakageCount?: unknown;
    warningCount?: unknown;
    issueCount?: unknown;
  };
};

const artifactRoot = path.resolve(
  process.env.OPENCLAW_PLUGIN_INIT_VALIDATE_ROOT ?? ".artifacts/plugin-init-provider-scaffold",
);
const projectDir = path.join(artifactRoot, "plugin-init-test");
const reportPath = path.join(projectDir, ".clawhub-validation", "plugin-inspector-report.json");

function run(command: string, args: string[], cwd: string): void {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

function readInspectorReport(): InspectorReport {
  if (!fs.existsSync(reportPath)) {
    throw new Error(`ClawHub validation report not found: ${reportPath}`);
  }
  return JSON.parse(fs.readFileSync(reportPath, "utf8")) as InspectorReport;
}

function assertCleanInspectorReport(report: InspectorReport): void {
  const breakageCount = Number(report.summary?.breakageCount ?? Number.NaN);
  const warningCount = Number(report.summary?.warningCount ?? Number.NaN);
  const issueCount = Number(report.summary?.issueCount ?? Number.NaN);
  if (report.status !== "pass" || breakageCount !== 0 || warningCount !== 0 || issueCount !== 0) {
    throw new Error(
      `Plugin Inspector was not clean: status=${String(
        report.status,
      )}, breakages=${breakageCount}, warnings=${warningCount}, issues=${issueCount}`,
    );
  }
}

fs.rmSync(projectDir, { force: true, recursive: true });
fs.mkdirSync(artifactRoot, { recursive: true });
for (const entry of fs.readdirSync(artifactRoot)) {
  if (entry.endsWith(".tgz")) {
    fs.rmSync(path.join(artifactRoot, entry));
  }
}

run("pnpm", ["build"], process.cwd());
const hostPackageTarball = "openclaw-provider-scaffold.tgz";
run(
  "node",
  [
    "scripts/package-openclaw-for-docker.mjs",
    "--allow-unreleased-changelog",
    "--skip-build",
    "--pnpm-pack",
    "--output-dir",
    artifactRoot,
    "--output-name",
    hostPackageTarball,
  ],
  process.cwd(),
);

await runPluginsInitCommand("plugin-init-test", {
  directory: projectDir,
  name: "Plugin Init Test",
  type: "provider",
});

const generatedPackagePath = path.join(projectDir, "package.json");
const generatedPackage = JSON.parse(fs.readFileSync(generatedPackagePath, "utf8")) as {
  devDependencies: Record<string, string>;
};
generatedPackage.devDependencies.openclaw = `file:../${hostPackageTarball}`;
fs.writeFileSync(generatedPackagePath, `${JSON.stringify(generatedPackage, null, 2)}\n`);

run("npm", ["install", "--no-audit", "--fund=false"], projectDir);
run("npm", ["run", "build"], projectDir);
run("npm", ["test"], projectDir);
run("npm", ["run", "validate"], projectDir);
assertCleanInspectorReport(readInspectorReport());

console.log(`Generated provider scaffold passed ClawHub validation: ${projectDir}`);

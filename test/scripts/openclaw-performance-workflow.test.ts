// Openclaw Performance Workflow tests cover openclaw performance workflow script behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/openclaw-performance.yml";

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

type WorkflowJob = {
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

function readWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
}

function findStep(name: string): WorkflowStep {
  const steps = readWorkflow().jobs?.kova?.steps ?? [];
  const step = steps.find((candidate) => candidate.name === name);
  expect(step).toBeDefined();
  return step as WorkflowStep;
}

describe("OpenClaw performance workflow", () => {
  it("uses an optional dispatch identifier to name parent-owned runs", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");

    expect(workflow).toContain(
      "run-name: ${{ inputs.dispatch_id != '' && format('OpenClaw Performance {0}', inputs.dispatch_id) || 'OpenClaw Performance' }}",
    );
    expect(workflow).toContain("dispatch_id:");
    expect(workflow).toContain("Optional parent workflow dispatch identifier");
  });

  it("pins the Kova evaluator with release validation contracts", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const kovaRef = "24c26969e57d4d49f9d1a5071af85dd3d79daa2d";

    expect(workflow).toContain(`default: ${kovaRef}`);
    expect(workflow).toContain(`inputs.kova_ref || '${kovaRef}'`);
  });

  it("rewrites only Kova files that own the performance model pin", () => {
    const pinModel = findStep("Pin Kova OpenAI model to GPT 5.5").run ?? "";

    expect(pinModel).toContain('"support/configure-openclaw-mock-auth.mjs"');
    expect(pinModel).toContain('"support/configure-openclaw-live-auth.mjs"');
    expect(pinModel).toContain('"states/mock-openai-provider.json"');
    expect(pinModel).not.toContain('"support/mock-openai-server.mjs"');
  });

  it("resolves dispatch target refs before checkout", () => {
    const resolveTarget = findStep("Resolve OpenClaw target ref");
    const checkout = findStep("Checkout OpenClaw");

    expect(resolveTarget.id).toBe("target");
    expect(resolveTarget.if).toBe("steps.lane.outputs.run == 'true'");
    expect(resolveTarget.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(resolveTarget.env?.TARGET_REF_INPUT).toBe("${{ inputs.target_ref }}");
    expect(resolveTarget.run).toContain("encodeURIComponent");
    expect(resolveTarget.run).toContain(
      'gh api "repos/${GITHUB_REPOSITORY}/commits/${encoded_ref}"',
    );
    expect(resolveTarget.run).toContain("checkout_ref=${resolved_sha}");
    expect(checkout.with?.ref).toBe("${{ steps.target.outputs.checkout_ref }}");
  });

  it("uses the clawgrit reports token for every report repo push path", () => {
    const prepare = findStep("Prepare clawgrit reports checkout");
    const publish = findStep("Publish to clawgrit reports");

    expect(prepare.env?.CLAWGRIT_REPORTS_TOKEN).toBe("${{ secrets.CLAWGRIT_REPORTS_TOKEN }}");
    expect(publish.env?.CLAWGRIT_REPORTS_TOKEN).toBe("${{ secrets.CLAWGRIT_REPORTS_TOKEN }}");
    expect(prepare.run).toContain(
      'remote add origin "https://x-access-token:${CLAWGRIT_REPORTS_TOKEN}@github.com/openclaw/clawgrit-reports.git"',
    );
    expect(publish.run).toContain(
      'remote set-url origin "https://x-access-token:${CLAWGRIT_REPORTS_TOKEN}@github.com/openclaw/clawgrit-reports.git"',
    );
    expect(publish.run).toContain('git -C "$reports_root" push origin HEAD:main');
  });

  it("keeps optional clawgrit report publishing bounded", () => {
    const prepare = findStep("Prepare clawgrit reports checkout");
    const publish = findStep("Publish to clawgrit reports");

    expect(prepare.run).toContain('echo "ready=false" >> "$GITHUB_OUTPUT"');
    expect(prepare.run).toContain("timeout 60s git");
    expect(prepare.run).toContain("timeout 120s git");
    expect(prepare.run).toContain('echo "ready=true" >> "$GITHUB_OUTPUT"');
    expect(publish.if).toContain("steps.clawgrit_reports.outputs.ready == 'true'");
    expect(publish.run).toContain("timeout 120s git");
  });

  it("requires the shared Kova report gate before tolerating partial verdicts", () => {
    const runKova = findStep("Run Kova");

    expect(runKova.run).toContain(
      'node "$PERFORMANCE_HELPER_DIR/scripts/lib/kova-report-gate.mjs" "$report_json"',
    );
    expect(runKova.run).not.toContain("report.summary?.statuses ?? {}");
  });

  it("selects the full Kova report instead of its summary", () => {
    const runKova = findStep("Run Kova");
    const validate = findStep("Validate Kova evidence");

    expect(runKova.run).toContain('kova-report-selector.mjs" --report-dir "$REPORT_DIR"');
    expect(validate.run).toContain('kova-report-selector.mjs" --report-dir "$REPORT_DIR"');
    expect(runKova.run).not.toContain("tail -n 1");
  });

  it("installs local workspace packages beside the OCM root tarball", () => {
    const configure = findStep("Configure OCM local workspace dependencies");

    expect(configure.run).toContain(
      'npm_wrapper="$PERFORMANCE_HELPER_DIR/scripts/ocm-npm-workspace-deps.mjs"',
    );
    expect(configure.run).toContain("OCM_INTERNAL_NPM_BIN=$npm_wrapper");
    expect(configure.run).toContain(
      'if [[ -f "${GITHUB_WORKSPACE}/packages/ai/package.json" ]]; then',
    );
    expect(configure.run).toContain(
      "OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS=$workspace_dependency_dirs",
    );
  });

  it("installs Kova runtime dependencies before invoking its CLI", () => {
    const install = findStep("Install OCM and Kova");

    expect(install.run).toContain(
      'npm --prefix "$KOVA_SRC" ci --ignore-scripts --no-audit --no-fund',
    );
    expect(install.run).toContain('require.resolve("mock-ai-provider/package.json", {');
    expect(install.run).toContain('packageJson.bin?.["mock-ai-provider"]');
    expect(install.run).toContain('path.join(root, "node_modules", ".bin", "mock-ai-provider")');
    expect(install.run).toContain("fs.constants.X_OK");
    expect(install.run).toContain('require.resolve("zod", { paths: [root] })');
    expect(install.run).not.toContain('require.resolve("mock-ai-provider",');
  });

  it("fails selected live Kova lanes when live auth is missing", () => {
    const configureAuth = findStep("Configure live OpenAI auth");
    const runKova = findStep("Run Kova");

    expect(configureAuth.if).toContain("matrix.live == 'true'");
    expect(configureAuth.env?.OPENAI_API_KEY).toBe("${{ secrets.OPENAI_API_KEY }}");
    expect(configureAuth.run).toContain('if [[ -z "${OPENAI_API_KEY:-}" ]]; then');
    expect(configureAuth.run).toContain("cannot run without live evidence");
    expect(configureAuth.run).toContain("exit 1");
    expect(configureAuth.run).not.toContain("will be skipped");
    expect(runKova.run).not.toContain('echo "skipped=true" >> "$GITHUB_OUTPUT"');
  });

  it("requires Kova evidence before uploading selected lane artifacts", () => {
    const validateEvidence = findStep("Validate Kova evidence");
    const upload = findStep("Upload Kova artifacts");

    expect(validateEvidence.if).toContain("always()");
    expect(validateEvidence.if).toContain("steps.lane.outputs.run == 'true'");
    expect(validateEvidence.run).toContain('kova-report-selector.mjs" --report-dir "$REPORT_DIR"');
    expect(validateEvidence.run).toContain('"$BUNDLE_DIR/bundle.json"');
    expect(validateEvidence.run).toContain('"$SUMMARY_DIR/${LANE_ID}.md"');
    expect(validateEvidence.run).toContain("exit 1");
    expect(upload.with?.["if-no-files-found"]).toBe("error");
  });
});

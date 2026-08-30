// Dependency-free launch policy shared by preflight planning and Vitest execution.
import path from "node:path";
import { embeddedAgentVitestProjectOwners } from "../../test/vitest/vitest.agents-paths.mjs";
import { parsePermissiveBooleanToken } from "./arg-utils.mts";
import { resolveLocalVitestEnv } from "./vitest-local-scheduling.mts";

function parseExplicitVitestWorkerBudget(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text || !/^\d+$/u.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveExplicitVitestWorkerBudget(env: NodeJS.ProcessEnv): number | null {
  return parseExplicitVitestWorkerBudget(
    env.OPENCLAW_VITEST_MAX_WORKERS ?? env.OPENCLAW_TEST_WORKERS,
  );
}

function shouldApplyNativeWorkerBudget(env: NodeJS.ProcessEnv): boolean {
  if (env.RAYON_NUM_THREADS?.trim() && env.TOKIO_WORKER_THREADS?.trim()) {
    return false;
  }
  return (
    env.OPENCLAW_TEST_PROJECTS_SERIAL === "1" || resolveExplicitVitestWorkerBudget(env) !== null
  );
}

function resolveNativeWorkerCount(env: NodeJS.ProcessEnv): number {
  return Math.min(resolveExplicitVitestWorkerBudget(env) ?? 1, 4);
}

/** Applies local Vitest scheduling and native worker budget env. */
export function resolveVitestProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const baseEnv = resolveLocalVitestEnv(env);
  if (!shouldApplyNativeWorkerBudget(baseEnv)) {
    return baseEnv;
  }

  const nativeWorkerCount = String(resolveNativeWorkerCount(baseEnv));
  return {
    ...baseEnv,
    RAYON_NUM_THREADS: baseEnv.RAYON_NUM_THREADS?.trim() || nativeWorkerCount,
    TOKIO_WORKER_THREADS: baseEnv.TOKIO_WORKER_THREADS?.trim() || nativeWorkerCount,
  };
}

/** Default watchdog timeout for Vitest runs that stop producing output. */
const DEFAULT_VITEST_NO_OUTPUT_TIMEOUT_MS = 120_000;
/** Default heartbeat interval while waiting on silent Vitest output. */
export const DEFAULT_VITEST_NO_OUTPUT_HEARTBEAT_MS = 30_000;
/** Longer watchdog timeout for known long-running Vitest configs. */
export const DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS = 300_000;
/** Extra-long watchdog timeout for broad configs that can stay silent on macOS. */
export const DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS = 2_400_000;
export const VITEST_CONFIG_NO_OUTPUT_TIMEOUT_MS = new Map([
  ["test/vitest/vitest.e2e.config.ts", DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  ["test/vitest/vitest.tui-pty.config.ts", DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  ["test/vitest/vitest.gateway.config.ts", DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  ["test/vitest/vitest.ui-e2e.config.ts", DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  ["test/vitest/vitest.full-agentic.config.ts", DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  [
    "test/vitest/vitest.full-core-contracts.config.ts",
    DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  ],
  [
    "test/vitest/vitest.contracts-plugin.config.ts",
    DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  ],
  ["test/vitest/vitest.infra.config.ts", DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS],
  // Largest extension shard: silent transform/import startup was measured at
  // ~210s on a loaded macOS host, so the 120s default kills healthy runs (#123025).
  [
    "test/vitest/vitest.extension-discord.config.ts",
    DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  ],
  // Codex extension shard: 168 serial files run ~6min total with silent
  // stretches beyond 300s under the default reporter (measured 61s import +
  // 293s testing while the worker burned ~95% CPU); the 300s CI window kills
  // healthy runs and flips with incidental flake output (#125825).
  [
    "test/vitest/vitest.extension-codex.config.ts",
    DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  ],
  [
    "test/vitest/vitest.gateway-core.config.ts",
    DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  ],
  [
    "test/vitest/vitest.gateway-server.config.ts",
    DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  ],
]);
for (const owner of embeddedAgentVitestProjectOwners) {
  VITEST_CONFIG_NO_OUTPUT_TIMEOUT_MS.set(
    owner.config,
    DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  );
}

/**
 * Resolves default Node flags for Vitest, including the local Maglev opt-in.
 */
export function resolveVitestNodeArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  if (parsePermissiveBooleanToken(env.OPENCLAW_VITEST_ENABLE_MAGLEV) === true) {
    return [];
  }

  return ["--no-maglev"];
}

/**
 * Chooses the default watchdog timeout from the selected Vitest config.
 */
export function resolveDefaultVitestNoOutputTimeoutMs(argv: string[] = []): number {
  const config = resolveVitestConfigArg(argv);
  return config === null
    ? DEFAULT_VITEST_NO_OUTPUT_TIMEOUT_MS
    : (resolveVitestConfigNoOutputTimeoutMs(config) ?? DEFAULT_VITEST_NO_OUTPUT_TIMEOUT_MS);
}

export function resolveVitestConfigArg(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--") {
      return null;
    }
    if (arg === "--config" || arg === "-c") {
      return argv[index + 1] ?? null;
    }
    if (arg.startsWith("--config=")) {
      return arg.slice("--config=".length);
    }
  }
  return null;
}

export function resolveVitestConfigNoOutputTimeoutMs(config: string): number | null {
  const normalized = normalizeVitestConfigPath(config);
  for (const [candidate, timeoutMs] of VITEST_CONFIG_NO_OUTPUT_TIMEOUT_MS) {
    if (matchesVitestConfigPath(normalized, candidate)) {
      return timeoutMs;
    }
  }
  return null;
}

export function normalizeVitestConfigPath(config: string): string {
  return path.normalize(config).replaceAll(path.sep, "/").replace(/^\.\//u, "");
}

export function matchesVitestConfigPath(normalized: string, candidate: string): boolean {
  return normalized === candidate || normalized.endsWith("/" + candidate);
}

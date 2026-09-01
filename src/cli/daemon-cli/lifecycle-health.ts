import { theme } from "../../../packages/terminal-core/src/theme.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "../../infra/restart.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import {
  DEFAULT_RESTART_HEALTH_ATTEMPTS,
  DEFAULT_RESTART_HEALTH_DELAY_MS,
  type GatewayPortHealthSnapshot,
  type GatewayRestartSnapshot,
  renderGatewayPortHealthDiagnostics,
} from "./restart-health.js";

export const LIFECYCLE_HEALTH_DELAY_MS = DEFAULT_RESTART_HEALTH_DELAY_MS;

const WINDOWS_LIFECYCLE_HEALTH_TIMEOUT_MS = 180_000;

export function lifecycleHealthAttempts(): number {
  return process.platform === "win32"
    ? Math.ceil(WINDOWS_LIFECYCLE_HEALTH_TIMEOUT_MS / LIFECYCLE_HEALTH_DELAY_MS)
    : DEFAULT_RESTART_HEALTH_ATTEMPTS;
}

export function formatGatewayRestartFailure(params: {
  health: GatewayRestartSnapshot;
  port: number;
  defaultTimeoutSeconds: number;
}): { statusLine: string; failMessage: string } {
  if (params.health.waitOutcome === "stopped-free") {
    const elapsedSeconds = Math.max(1, Math.round((params.health.elapsedMs ?? 0) / 1000));
    return {
      statusLine: `Gateway restart failed after ${elapsedSeconds}s: service stayed stopped and port ${params.port} stayed free.`,
      failMessage: `Gateway restart failed after ${elapsedSeconds}s: service stayed stopped and health checks never came up.`,
    };
  }

  const elapsed = params.health.elapsedMs;
  const timeoutSeconds = Math.max(
    1,
    Math.round(elapsed === undefined ? params.defaultTimeoutSeconds : elapsed / 1000),
  );
  return {
    statusLine: `Timed out after ${timeoutSeconds}s waiting for gateway port ${params.port} to become healthy.`,
    failMessage: `Gateway restart timed out after ${timeoutSeconds}s waiting for health checks.`,
  };
}

export function hasGatewayPluginReadinessFailure(
  health: Pick<GatewayPortHealthSnapshot, "activatedPluginErrors" | "unavailablePlugins">,
): boolean {
  return Boolean(health.activatedPluginErrors?.length || health.unavailablePlugins?.length);
}

export function failGatewayPluginReadiness(params: {
  action: "start" | "restart";
  health: GatewayPortHealthSnapshot;
  json: boolean;
  warnings: string[];
  fail: (message: string, hints?: string[]) => void;
}): never {
  const pluginIds = [
    ...(params.health.activatedPluginErrors ?? []).map((plugin) => plugin.id),
    ...(params.health.unavailablePlugins ?? []).map((plugin) => plugin.id),
  ].filter((id, index, ids) => ids.indexOf(id) === index);
  const message = `Gateway ${params.action} completed, but configured plugin health failed for ${pluginIds.join(", ")}. The Gateway remains running in degraded mode.`;
  const diagnostics = renderGatewayPortHealthDiagnostics(params.health);
  if (params.json) {
    params.warnings.push(...diagnostics);
  } else {
    defaultRuntime.log(theme.warn(message));
    for (const line of diagnostics) {
      defaultRuntime.log(theme.muted(line));
    }
  }
  params.fail(message, [
    formatCliCommand("openclaw plugins doctor"),
    formatCliCommand("openclaw gateway status --deep"),
  ]);
  throw new Error("unreachable after gateway plugin readiness failure");
}

export async function resolveRestartListenerHealthWait(
  restartIntent: GatewayRestartIntent | undefined,
) {
  let drainTimeoutMs: number | undefined;
  if (restartIntent?.force) {
    drainTimeoutMs = 0;
  } else if (typeof restartIntent?.waitMs === "number" && Number.isFinite(restartIntent.waitMs)) {
    drainTimeoutMs = restartIntent.waitMs > 0 ? Math.floor(restartIntent.waitMs) : undefined;
  } else {
    drainTimeoutMs = resolveGatewayRestartDeferralTimeoutMs();
  }

  const replacementHealthAttempts = lifecycleHealthAttempts();
  if (drainTimeoutMs === undefined) {
    return {
      attempts: replacementHealthAttempts,
      waitIndefinitelyForPreviousOwner: true,
      timeoutSeconds: Math.round((replacementHealthAttempts * LIFECYCLE_HEALTH_DELAY_MS) / 1000),
    };
  }
  const attempts =
    replacementHealthAttempts + Math.ceil(drainTimeoutMs / LIFECYCLE_HEALTH_DELAY_MS);
  return {
    attempts,
    waitIndefinitelyForPreviousOwner: false,
    timeoutSeconds: Math.round((attempts * LIFECYCLE_HEALTH_DELAY_MS) / 1000),
  };
}

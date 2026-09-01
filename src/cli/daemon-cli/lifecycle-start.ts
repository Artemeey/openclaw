import { resolveGatewayService } from "../../daemon/service.js";
import { assertGatewayServiceMutationAllowed } from "../../infra/gateway-supervision.js";
import { formatCliCommand } from "../command-format.js";
import { recoverInstalledLaunchAgent } from "./launchd-recovery.js";
import { appendGatewayLifecycleAudit } from "./lifecycle-audit.js";
import { resolveGatewayConfigPorts, resolveGatewayLifecycleContext } from "./lifecycle-context.js";
import { runServiceStart } from "./lifecycle-core.js";
import {
  failGatewayPluginReadiness,
  hasGatewayPluginReadinessFailure,
  LIFECYCLE_HEALTH_DELAY_MS,
  lifecycleHealthAttempts,
} from "./lifecycle-health.js";
import { renderRestartDiagnostics, waitForGatewayHealthyRestart } from "./restart-health.js";
import { renderGatewayServiceStartHints } from "./shared.js";
import { repairLoadedGatewayServiceForStart } from "./start-repair.js";
import type { DaemonLifecycleOptions } from "./types.js";

/** Start the managed Gateway service, repairing stale service definitions when possible. */
export async function runDaemonStart(opts: DaemonLifecycleOptions = {}) {
  assertGatewayServiceMutationAllowed("start the gateway");
  const service = resolveGatewayService();
  const { explicit: configuredPort, fallback: fallbackPort } = await resolveGatewayConfigPorts();
  return await runServiceStart({
    serviceNoun: "Gateway",
    service,
    renderStartHints: renderGatewayServiceStartHints,
    onNotLoaded:
      process.platform === "darwin"
        ? async () => {
            const recovered = await recoverInstalledLaunchAgent({ result: "started" });
            if (recovered) {
              appendGatewayLifecycleAudit({
                action: "start",
                source: "cli",
                mode: "launchd-bootstrap",
              });
            }
            return recovered;
          }
        : undefined,
    repairLoadedService: async ({ json, stdout, warn, state, issues }) =>
      await repairLoadedGatewayServiceForStart({
        service,
        json,
        stdout,
        warn,
        state,
        issues,
      }),
    expectedPort: configuredPort,
    postStartCheck: async ({ warnings, fail }) => {
      const context = await resolveGatewayLifecycleContext(service).catch(() => ({
        port: fallbackPort,
        env: process.env,
      }));
      const port = configuredPort ?? context.port;
      const health = await waitForGatewayHealthyRestart({
        service,
        port,
        attempts: lifecycleHealthAttempts(),
        delayMs: LIFECYCLE_HEALTH_DELAY_MS,
        env: context.env,
        includeUnknownListenersAsStale: process.platform === "win32",
        supervisorKeepsAlive: process.platform === "darwin",
      });
      if (hasGatewayPluginReadinessFailure(health)) {
        failGatewayPluginReadiness({
          action: "start",
          health,
          json: Boolean(opts.json),
          warnings,
          fail,
        });
      }
      if (!health.healthy) {
        const diagnostics = renderRestartDiagnostics(health);
        fail(`Gateway start completed, but health verification failed on port ${port}.`, [
          ...diagnostics,
          formatCliCommand("openclaw gateway status --deep"),
        ]);
      }
    },
    opts,
  });
}

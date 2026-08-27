import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import {
  crabboxPreparedCodexCheck,
  crabboxRuntimePaths,
  crabboxRuntimeVersionCheck,
  shellQuote,
} from "./crabbox-worker-runtime-preparation.js";

const CLOUD_SETUP_CODE_ENV = "CRABBOX_WORKER_SETUP_CODE";

export type CrabboxWorkerNodeEnrollment = Awaited<
  ReturnType<
    NonNullable<NonNullable<Parameters<WorkerProvider["provision"]>[2]>["beginNodeEnrollment"]>
  >
>;

export function createCrabboxNodeEnrollmentSetup(params: {
  enrollment: CrabboxWorkerNodeEnrollment;
  executionMode?: NonNullable<WorkerProvider["supportedExecutionModes"]>[number];
  leaseId: string;
}): { command: string; forwardedEnv?: Record<string, string> } {
  const { enrollment, executionMode, leaseId } = params;
  const launch =
    enrollment.mode === "connect"
      ? `connect --target-file "$setup_code_file" --ephemeral --display-name ${shellQuote(enrollment.displayName)}`
      : `node run --ephemeral --display-name ${shellQuote(enrollment.displayName)}`;
  return {
    command: [
      "set -eu",
      ...crabboxRuntimePaths(leaseId),
      'pid_file="$state_dir/node.pid"',
      'if [ -s "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then exit 0; fi',
      ...(enrollment.mode === "connect"
        ? [
            'setup_code_file="$state_dir/setup-code"',
            "umask 077",
            `printf "%s\\n" "$${CLOUD_SETUP_CODE_ENV}" >"$setup_code_file"`,
            `unset ${CLOUD_SETUP_CODE_ENV}`,
          ]
        : []),
      'openclaw_bin="$(cat "$runtime_dir/openclaw-bin")"',
      crabboxRuntimeVersionCheck(enrollment.openclawVersion),
      ...(executionMode === "remote-exec"
        ? [crabboxPreparedCodexCheck(enrollment.openclawVersion)]
        : []),
      `setsid -f sh -c 'printf "%s\\n" "$$" >"$1"; shift; exec "$@"' sh "$pid_file" env OPENCLAW_STATE_DIR="$state_dir" "$openclaw_bin" ${launch} >"$state_dir/node.log" 2>&1 </dev/null`,
      'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$pid_file" ] && break; sleep 0.1; done',
      'test -s "$pid_file"',
    ].join("\n"),
    ...(enrollment.mode === "connect"
      ? { forwardedEnv: { [CLOUD_SETUP_CODE_ENV]: enrollment.setupCode } }
      : {}),
  };
}

import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import { crabboxCommandError } from "./crabbox-worker-command-error.js";
import {
  isAuthoritativeLeaseAbsence,
  runCrabboxCommand,
  type CrabboxCommandRunner,
} from "./crabbox-worker-command.js";
import { nonEmptyString } from "./crabbox-worker-profile.js";
import {
  CRABBOX_MACHINE0_READY_WAIT_TIMEOUT,
  resolveCrabboxLifecycleTimeoutMs,
} from "./crabbox-worker-timeouts.js";

// Stopped/archived machines can retain billed resources; only deletion evidence
// can release ownership and skip provider teardown.
const DESTROYED_STATES = new Set([
  "deleted",
  "destroyed",
  "expired",
  "missing",
  "released",
  "terminated",
]);
const UNUSABLE_PROVISION_STATES = new Set([
  ...DESTROYED_STATES,
  "stopped",
  "stopped_with_code",
  "archived",
  "error",
  "deleting",
  "failed",
]);

export const isCrabboxLeaseDestroyed = (state: string) => DESTROYED_STATES.has(state.toLowerCase());
export const isCrabboxLeaseUnusable = (state: string) =>
  UNUSABLE_PROVISION_STATES.has(state.toLowerCase());

type CrabboxInspect = {
  id?: unknown;
  providerMetadata?: unknown;
  ready?: unknown;
  state?: unknown;
  tailscale?: unknown;
};

export type ParsedInspect = {
  awsInstanceProfileAttached?: boolean;
  id: string;
  ready?: boolean;
  state: string;
  tailscaleEnabled: boolean;
};

function parseInspectJson(stdout: string): ParsedInspect {
  let value: CrabboxInspect;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("inspect output is not an object");
    }
    value = parsed as CrabboxInspect;
  } catch {
    throw new Error("Crabbox inspect returned invalid JSON");
  }

  const id = nonEmptyString(value.id);
  const state = nonEmptyString(value.state)?.toLowerCase();
  if (!id || !/^\S{1,128}$/u.test(id) || !state) {
    throw new Error("Crabbox inspect returned an invalid lease identity or state");
  }
  if (value.ready !== undefined && typeof value.ready !== "boolean") {
    throw new Error("Crabbox inspect returned an invalid ready state");
  }
  if (
    value.tailscale !== undefined &&
    (value.tailscale === null ||
      typeof value.tailscale !== "object" ||
      Array.isArray(value.tailscale))
  ) {
    throw new Error("Crabbox inspect returned invalid Tailscale state");
  }
  const tailscaleEnabled = value.tailscale !== undefined;
  let awsInstanceProfileAttached: boolean | undefined;
  if (value.providerMetadata !== undefined) {
    if (
      value.providerMetadata === null ||
      typeof value.providerMetadata !== "object" ||
      Array.isArray(value.providerMetadata)
    ) {
      throw new Error("Crabbox inspect returned invalid provider metadata");
    }
    const attached = (value.providerMetadata as Record<string, unknown>)["instanceProfileAttached"];
    if (attached !== undefined && typeof attached !== "boolean") {
      throw new Error("Crabbox inspect returned invalid AWS instance profile metadata");
    }
    awsInstanceProfileAttached = attached as boolean | undefined;
  }

  return {
    id,
    state,
    tailscaleEnabled,
    ...(awsInstanceProfileAttached !== undefined ? { awsInstanceProfileAttached } : {}),
    ...(typeof value.ready === "boolean" ? { ready: value.ready } : {}),
  };
}

export type CrabboxInspectResult =
  | { status: "found"; inspect: ParsedInspect }
  | { status: "unknown" };

export async function inspectCrabboxLease(params: {
  context: { binary: string; provider: string };
  expectedLeaseId?: string;
  id: string;
  runCommand: CrabboxCommandRunner;
  timeoutMs?: number;
  waitForReady?: boolean;
}): Promise<CrabboxInspectResult> {
  const action = params.waitForReady ? "status" : "inspect";
  const result = await runCrabboxCommand({
    action,
    args: [
      action,
      "--provider",
      params.context.provider,
      "--network",
      "public",
      "--id",
      params.id,
      ...(params.waitForReady
        ? ["--wait", "--wait-timeout", CRABBOX_MACHINE0_READY_WAIT_TIMEOUT]
        : []),
      "--json",
    ],
    binary: params.context.binary,
    runCommand: params.runCommand,
    timeoutMs: params.timeoutMs ?? resolveCrabboxLifecycleTimeoutMs(params.context.provider),
  });
  if (result.termination === "exit" && result.code === 0) {
    // A successful but malformed response cannot attest the fixed lease. Command failures and
    // authoritative absence remain transient so Gateway replay can inspect the live lease later.
    let inspect: ParsedInspect;
    try {
      inspect = parseInspectJson(result.stdout);
    } catch (error) {
      throw new WorkerProviderError(
        error instanceof Error ? error.message : "Crabbox inspect returned invalid output",
      );
    }
    if (params.expectedLeaseId && inspect.id !== params.expectedLeaseId) {
      throw new WorkerProviderError("Crabbox inspect returned a different lease id");
    }
    return { status: "found", inspect };
  }
  if (result.termination === "exit" && isAuthoritativeLeaseAbsence(result, params.id)) {
    return { status: "unknown" };
  }
  throw crabboxCommandError(action, result);
}

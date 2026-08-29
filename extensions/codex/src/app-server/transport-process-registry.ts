import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  inspectCodexTransportProcess,
  inspectCodexTransportProcessCommand,
  inspectCodexTransportProcessSnapshot,
  type PosixProcess,
} from "./transport-process-containment.js";

export type StoredCodexAppServerProcess = {
  pid: number;
  startedAt: string;
  command: string;
  ownerPid: number;
  ownerStartedAt: string;
  spawnedAtMs: number;
};

export const CODEX_APP_SERVER_PROCESS_NAMESPACE = "app-server-processes";
export const CODEX_APP_SERVER_PROCESS_MAX_ENTRIES = 64;
const PROCESS_REGISTRY_INSPECTION_MS = 5_000;

type RegistryStore = PluginStateSyncKeyedStore<StoredCodexAppServerProcess>;
type SpawnedProcess = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: string | null;
  once: (event: "exit", listener: () => void) => unknown;
};
type ProcessRegistryRuntime = {
  platform: NodeJS.Platform;
  inspectProcess: typeof inspectCodexTransportProcess;
  inspectCommand: typeof inspectCodexTransportProcessCommand;
  inspectSnapshot: typeof inspectCodexTransportProcessSnapshot;
  kill: (pid: number, signal: NodeJS.Signals) => boolean;
  now: () => number;
};
const PROCESS_REGISTRY_RUNTIME: ProcessRegistryRuntime = {
  platform: process.platform,
  inspectProcess: inspectCodexTransportProcess,
  inspectCommand: inspectCodexTransportProcessCommand,
  inspectSnapshot: inspectCodexTransportProcessSnapshot,
  kill: (pid, signal) => process.kill(pid, signal),
  now: Date.now,
};

let openStore: (() => RegistryStore) | undefined;
let ownerIdentity: Promise<PosixProcess | undefined> | undefined;
let reapPromise: Promise<void> | undefined;

export function setCodexAppServerProcessRegistryStore(open: () => RegistryStore): void {
  openStore = open;
}

export async function registerCodexAppServerProcessSpawn(
  child: SpawnedProcess,
  runtime: ProcessRegistryRuntime = PROCESS_REGISTRY_RUNTIME,
): Promise<void> {
  const pid = child.pid;
  if (runtime.platform === "win32" || !pid || !openStore) {
    return;
  }
  // Attach before inspection yields so every exit path removes its registration.
  child.once("exit", () => withRegistryStore((store) => store.delete(String(pid))));
  const spawnedAtMs = runtime.now();
  const deadline = spawnedAtMs + PROCESS_REGISTRY_INSPECTION_MS;
  try {
    // SIGKILL in this small spawn-to-identity window leaves cleanup to Codex's stdin-EOF drain.
    const [identity, command, owner] = await Promise.all([
      runtime.inspectProcess(pid, deadline),
      runtime.inspectCommand(pid, deadline),
      (ownerIdentity ??= runtime.inspectProcess(process.pid, deadline)),
    ]);
    if (!owner) {
      // Memoizing a failed owner read would silently disable registration for the
      // whole process lifetime; drop it so the next spawn retries.
      ownerIdentity = undefined;
    }
    if (!identity || !command || !owner) {
      // Without exact identities, a later reap could kill an innocent reused PID.
      warnRegistry("codex app-server process identity unavailable; skipping registration", { pid });
      return;
    }
    if (child.exitCode != null || child.signalCode != null) {
      return;
    }
    withRegistryStore((store) =>
      store.register(String(pid), {
        pid,
        startedAt: identity.startedAt,
        command,
        ownerPid: process.pid,
        ownerStartedAt: owner.startedAt,
        spawnedAtMs,
      }),
    );
  } catch (error) {
    warnRegistry("codex app-server process registration failed", { pid, error });
  }
}

export function reapOrphanedCodexAppServerProcesses(
  runtime: ProcessRegistryRuntime = PROCESS_REGISTRY_RUNTIME,
): Promise<void> {
  return (reapPromise ??= reapProcesses(runtime).catch((error: unknown) => {
    warnRegistry("codex app-server orphan reap failed", { error });
  }));
}

async function reapProcesses(runtime: ProcessRegistryRuntime): Promise<void> {
  if (runtime.platform === "win32" || !openStore) {
    return;
  }
  // This deadline bounds inspection/signaling; synchronous store calls have their own lock timeout.
  const deadline = runtime.now() + PROCESS_REGISTRY_INSPECTION_MS;
  const entries = withRegistryStore((store) => store.entries());
  if (!entries?.length || runtime.now() >= deadline) {
    return;
  }
  const snapshot = await runtime.inspectSnapshot(deadline);
  if (!snapshot) {
    // Unknown ownership cannot authorize a kill or row deletion; cleanup must fail open.
    warnRegistry("codex app-server process snapshot unavailable; skipping orphan reap");
    return;
  }
  const byPid = new Map(snapshot.map((row) => [row.pid, row]));
  const self = byPid.get(process.pid);
  if (!self) {
    // A snapshot that cannot see the observer is not authoritative; without our
    // own lstart, a pid-reused row could be misjudged in either direction.
    warnRegistry("codex app-server process snapshot missing this process; skipping orphan reap");
    return;
  }
  for (const { key, value } of entries) {
    if (runtime.now() >= deadline) {
      return;
    }
    if (!isStoredProcess(value)) {
      withRegistryStore((store) => store.delete(key));
      continue;
    }
    // "Our row" is an identity claim, not a numeric pid match: a restarted
    // gateway can reuse its predecessor's pid and must still reap those rows.
    if (value.ownerPid === process.pid && value.ownerStartedAt === self.startedAt) {
      continue;
    }
    const owner = byPid.get(value.ownerPid);
    // A zombie owner is dead: an unreaped SIGKILLed gateway (wedged supervisor,
    // init-less container) keeps its pid+lstart in the snapshot but no longer
    // owns cleanup, and the memoized pass would otherwise skip its orphan forever.
    if (owner?.startedAt === value.ownerStartedAt && !owner.state.startsWith("Z")) {
      continue;
    }
    if (byPid.get(value.pid)?.startedAt !== value.startedAt) {
      withRegistryStore((store) => deleteRegistryRowIfCurrent(store, key, value));
      continue;
    }
    // lstart is second-granular, so pid + lstart alone could match a same-second
    // replacement process. Command equality is the extra kill-authority gate;
    // absent-or-failed reads keep the row for a later pass instead of killing.
    // lstart is second-granular, so pid + lstart alone could match a same-second
    // replacement process. Command equality is the extra kill-authority gate;
    // absent-or-failed reads keep the row for a later pass instead of killing.
    const command = await runtime.inspectCommand(value.pid, deadline);
    if (runtime.now() >= deadline || command === undefined) {
      continue;
    }
    if (command !== value.command) {
      withRegistryStore((store) => deleteRegistryRowIfCurrent(store, key, value));
      continue;
    }
    // Never carry numeric signal authority across an await after this final identity check.
    const current = await runtime.inspectProcess(value.pid, deadline);
    if (
      runtime.now() >= deadline ||
      !current ||
      current.pid !== value.pid ||
      current.startedAt !== value.startedAt
    ) {
      continue;
    }
    try {
      // QA children can share their owner's group; only detached leaders own a killable group.
      runtime.kill(current.pgid === current.pid ? -current.pid : current.pid, "SIGKILL");
    } catch {
      // The identity-confirmed process can disappear before the signal reaches it.
    }
    withRegistryStore((store) => deleteRegistryRowIfCurrent(store, key, value));
    warnRegistry("reaped orphaned codex app-server", {
      pid: value.pid,
      spawnedAtMs: value.spawnedAtMs,
      ownerPid: value.ownerPid,
    });
  }
}

// Rows judged against a snapshot may be seconds stale: a reaped/dead pid can be
// re-registered by a live owner meanwhile, so delete only the exact row we judged.
function deleteRegistryRowIfCurrent(
  store: RegistryStore,
  key: string,
  expected: StoredCodexAppServerProcess,
): boolean {
  if (!store.deleteIf) {
    return store.delete(key);
  }
  return store.deleteIf(
    key,
    (row) =>
      row.startedAt === expected.startedAt &&
      row.command === expected.command &&
      row.ownerStartedAt === expected.ownerStartedAt,
  );
}

function isStoredProcess(value: unknown): value is StoredCodexAppServerProcess {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.pid) &&
    typeof value.pid === "number" &&
    value.pid > 0 &&
    typeof value.startedAt === "string" &&
    value.startedAt.length > 0 &&
    typeof value.command === "string" &&
    value.command.length > 0 &&
    Number.isSafeInteger(value.ownerPid) &&
    typeof value.ownerPid === "number" &&
    value.ownerPid > 0 &&
    typeof value.ownerStartedAt === "string" &&
    value.ownerStartedAt.length > 0 &&
    typeof value.spawnedAtMs === "number" &&
    Number.isFinite(value.spawnedAtMs)
  );
}

function withRegistryStore<T>(operation: (store: RegistryStore) => T): T | undefined {
  try {
    return openStore ? operation(openStore()) : undefined;
  } catch (error) {
    warnRegistry("codex app-server process registry access failed", { error });
    return undefined;
  }
}

function warnRegistry(message: string, details?: Record<string, unknown>): void {
  try {
    embeddedAgentLog.warn(message, details);
  } catch {
    // Diagnostics must not turn best-effort cleanup into a failed spawn or boot.
  }
}

export function createCodexAppServerProcessReaperService(): OpenClawPluginService {
  return {
    id: "codex-app-server-process-reaper",
    start: () => {
      void reapOrphanedCodexAppServerProcesses();
    },
  };
}

export function resetCodexAppServerProcessRegistryForTests(): void {
  openStore = undefined;
  ownerIdentity = undefined;
  reapPromise = undefined;
}

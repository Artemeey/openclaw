import { execFile } from "node:child_process";
import { getProcessIdentity } from "openclaw/plugin-sdk/process-runtime";

type ContainableTransport = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: string | null;
  kill?: (signal?: NodeJS.Signals) => unknown;
};

type PosixProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
};

type CapturedProcess = PosixProcess & { instance: string };

export type CodexAppServerProcessIdentity = Pick<PosixProcess, "pid" | "pgid"> & {
  instance: string;
};

const PROCESS_COLUMNS = "pid=,ppid=,pgid=,stat=";
const MAX_CONTAINED_PROCESSES = 512;
const MAX_PROCESS_CONTAINMENT_MS = 2_000;
const MAX_PROCESS_QUIESCE_PASSES = 16;
const PROCESS_INSPECTION_MAX_BYTES = 8 * 1024 * 1024;

export async function terminateCodexAppServerDescendants(
  child: ContainableTransport,
): Promise<(() => void) | undefined> {
  const rootPid = child.pid;
  if (process.platform === "win32" || !rootPid || !child.kill || hasExited(child)) {
    return undefined;
  }
  const deadline = Date.now() + MAX_PROCESS_CONTAINMENT_MS;
  const snapshot = await readProcessSnapshot(deadline);
  if (!snapshot || Date.now() >= deadline) {
    return undefined;
  }
  const rootRow = snapshot.find((row) => row.pid === rootPid);
  const root = rootRow && captureProcess(rootRow);
  if (!root || root.ppid !== process.pid || !isSameLiveRoot(root, root)) {
    return undefined;
  }

  return await terminateProcessDescendants(root, snapshot, deadline, () =>
    signalCapturedProcess(root, "SIGCONT"),
  );
}

/** Captured before the transport can admit its first request. */
export async function captureCodexAppServerProcessIdentity(
  pid: number,
): Promise<CodexAppServerProcessIdentity> {
  const rows = await readProcessSnapshot(Date.now() + MAX_PROCESS_CONTAINMENT_MS);
  const row = rows?.find((candidate) => candidate.pid === pid);
  const captured = row && captureProcess(row);
  if (!captured || captured.state.startsWith("Z")) {
    throw new Error("Cannot register Codex app-server process identity; retry the connection.");
  }
  return {
    pid: captured.pid,
    pgid: captured.pgid,
    instance: captured.instance,
  };
}

/** Only a recorded child of a proven-dead owner can enter orphan containment. */
export async function reapCodexAppServerOrphan(
  owner: CodexAppServerProcessIdentity,
  child: CodexAppServerProcessIdentity,
  recoveryDeadline: number,
): Promise<"owned" | "gone"> {
  const deadline = Math.min(recoveryDeadline, Date.now() + MAX_PROCESS_CONTAINMENT_MS);
  const snapshot = await readProcessSnapshot(deadline);
  const failure = () =>
    new Error(
      "Cannot reap an orphaned Codex app-server safely; retry the connection after checking local process permissions.",
    );
  if (!snapshot) {
    throw failure();
  }
  const parent = snapshot.find((row) => row.pid === owner.pid);
  const matchesRegistration = (row: PosixProcess, expected: CodexAppServerProcessIdentity) => {
    const identity = getProcessIdentity(row.pid);
    if (!identity.ok) {
      throw failure();
    }
    if (identity.value.start !== expected.instance) {
      return false;
    }
    if (identity.value.parentPid !== row.ppid || identity.value.processGroupId !== row.pgid) {
      throw failure();
    }
    return true;
  };
  if (parent && !parent.state.startsWith("Z") && matchesRegistration(parent, owner)) {
    return "owned";
  }
  const rootRow = snapshot.find((row) => row.pid === child.pid);
  if (!rootRow || rootRow.state.startsWith("Z") || !matchesRegistration(rootRow, child)) {
    return "gone";
  }
  if (rootRow.pgid !== child.pgid) {
    throw failure();
  }
  const root: CapturedProcess = { ...rootRow, instance: child.instance };
  // Orphan custody is terminal. Never resume on failure: another recovering
  // process may be killing this same stopped tree. Retain its registration.
  const contained = await terminateProcessDescendants(root, snapshot, deadline);
  if (contained) {
    await signalSameRoot(root, "SIGKILL", deadline);
  }
  // A concurrent reaper or natural exit may win any inspection/signal race.
  // Only observed absence retires custody, regardless of who delivered the kill.
  while (Date.now() < deadline) {
    const rows = await readProcessSnapshot(deadline);
    if (!rows) {
      throw failure();
    }
    const current = rows.find((row) => row.pid === child.pid);
    const identity = current && getProcessIdentity(child.pid);
    // A killed process can disappear between ps and the kernel query. Unknown
    // evidence stays pending until the next observation; it never authorizes a signal.
    if (
      !current ||
      current.state.startsWith("Z") ||
      (identity?.ok && identity.value.start !== child.instance)
    ) {
      return "gone";
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw failure();
}

async function terminateProcessDescendants(
  root: CapturedProcess,
  snapshot: PosixProcess[],
  deadline: number,
  resumeRoot?: () => void,
): Promise<(() => void) | undefined> {
  const initialDescendants = collectDescendants(snapshot, [root.pid]);
  if (initialDescendants.length > MAX_CONTAINED_PROCESSES) {
    return undefined;
  }
  const capturedDescendants: CapturedProcess[] = [];
  for (const descendant of initialDescendants) {
    const captured = captureProcess(descendant);
    if (!captured) {
      return undefined;
    }
    capturedDescendants.push(captured);
  }
  const stoppedDescendants = new Map<string, CapturedProcess>();
  if (!(await signalSameRoot(root, "SIGSTOP", deadline))) {
    return undefined;
  }
  let resumeRootOnUnwind = true;
  try {
    const descendants = await quiesceDescendants(
      root,
      capturedDescendants,
      stoppedDescendants,
      deadline,
    );
    if (!descendants) {
      return undefined;
    }

    // Parents are last: every destructive signal revalidates the exact live PID
    // while the stopped ancestry still prevents new descendants.
    for (const descendant of descendants.toReversed()) {
      if (Date.now() >= deadline) {
        return undefined;
      }
      if (!descendant.state.startsWith("Z")) {
        if (!(await signalSameProcess(descendant, "SIGKILL", deadline)) || Date.now() >= deadline) {
          return undefined;
        }
      }
    }
    resumeRootOnUnwind = false;
    let resumed = false;
    return () => {
      if (resumed) {
        return;
      }
      resumed = true;
      resumeRoot?.();
    };
  } finally {
    if (resumeRootOnUnwind && resumeRoot) {
      // Unwind only processes whose captured kernel identity still owns the PID.
      for (const descendant of stoppedDescendants.values()) {
        signalCapturedProcess(descendant, "SIGCONT");
      }
      resumeRoot();
    }
  }
}

async function quiesceDescendants(
  root: CapturedProcess,
  initialDescendants: CapturedProcess[],
  stopped: Map<string, CapturedProcess>,
  deadline: number,
): Promise<CapturedProcess[] | undefined> {
  const provenByPid = new Map(initialDescendants.map((descendant) => [descendant.pid, descendant]));
  const stopFailures = new Map<string, number>();
  for (let pass = 0; pass < MAX_PROCESS_QUIESCE_PASSES; pass += 1) {
    if (Date.now() >= deadline) {
      return undefined;
    }
    const snapshot = await readProcessSnapshot(deadline);
    if (!snapshot || Date.now() >= deadline) {
      return undefined;
    }
    const currentRoot = snapshot.find((row) => row.pid === root.pid);
    if (!currentRoot || !isSameLiveRoot(currentRoot, root)) {
      return undefined;
    }
    if (!isSameLiveRoot(currentRoot, root, true)) {
      if (!(await signalSameRoot(root, "SIGSTOP", deadline)) || Date.now() >= deadline) {
        return undefined;
      }
      continue;
    }
    const snapshotByPid = new Map(snapshot.map((process) => [process.pid, process]));
    for (const proven of provenByPid.values()) {
      const current = snapshotByPid.get(proven.pid);
      if (!current) {
        provenByPid.delete(proven.pid);
        stopped.delete(identityKey(proven));
        continue;
      }
      if (!isSameProcess(current, proven)) {
        return undefined;
      }
      const refreshed = { ...current, instance: proven.instance };
      provenByPid.set(current.pid, refreshed);
      const key = identityKey(refreshed);
      if (stopped.has(key)) {
        stopped.set(key, refreshed);
      }
    }
    const descendants = collectDescendants(snapshot, [root.pid, ...provenByPid.keys()]);
    for (const descendant of descendants) {
      const captured = captureProcess(descendant);
      if (!captured) {
        return undefined;
      }
      provenByPid.set(descendant.pid, captured);
    }
    if (provenByPid.size > MAX_CONTAINED_PROCESSES) {
      return undefined;
    }
    let allStopped = true;
    for (const descendant of provenByPid.values()) {
      if (Date.now() >= deadline) {
        return undefined;
      }
      if (isStoppedState(descendant.state)) {
        continue;
      }
      const stopQueued = await signalSameProcess(descendant, "SIGSTOP", deadline);
      if (Date.now() >= deadline) {
        return undefined;
      }
      if (stopQueued) {
        stopFailures.delete(identityKey(descendant));
        stopped.set(identityKey(descendant), descendant);
      } else {
        const key = identityKey(descendant);
        const failures = (stopFailures.get(key) ?? 0) + 1;
        if (failures >= 2) {
          return undefined;
        }
        stopFailures.set(key, failures);
      }
      if (!isUninterruptibleState(descendant.state) || !stopQueued) {
        allStopped = false;
      }
    }
    if (allStopped) {
      return [...provenByPid.values()];
    }
  }
  return undefined;
}

async function readProcessSnapshot(deadline: number): Promise<PosixProcess[] | undefined> {
  return await readProcesses(["-axo", PROCESS_COLUMNS], deadline);
}

async function readProcess(pid: number, deadline: number): Promise<PosixProcess | undefined> {
  return (await readProcesses(["-o", PROCESS_COLUMNS, "-p", String(pid)], deadline))?.find(
    (row) => row.pid === pid,
  );
}

async function readProcesses(
  args: string[],
  deadline: number,
): Promise<PosixProcess[] | undefined> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return undefined;
  }
  return await new Promise<PosixProcess[] | undefined>((resolve) => {
    let settled = false;
    const settle = (processes: PosixProcess[] | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(processes);
    };
    const inspector = execFile(
      "ps",
      args,
      {
        encoding: "utf8",
        maxBuffer: PROCESS_INSPECTION_MAX_BYTES,
      },
      (error, stdout) => {
        settle(error ? undefined : parseProcesses(stdout));
      },
    );
    const timer = setTimeout(
      () => {
        settle(undefined);
        inspector.stdout?.destroy();
        inspector.stderr?.destroy();
        inspector.kill("SIGKILL");
        inspector.unref();
      },
      Math.max(1, remainingMs),
    );
    timer.unref?.();
  });
}

function parseProcesses(output: string): PosixProcess[] {
  const rows: PosixProcess[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const pid = Number(match[1] ?? "");
    const ppid = Number(match[2] ?? "");
    const pgid = Number(match[3] ?? "");
    if (![pid, ppid, pgid].every(Number.isSafeInteger) || pid <= 0 || ppid < 0 || pgid <= 0) {
      continue;
    }
    rows.push({ pid, ppid, pgid, state: match[4] ?? "" });
  }
  return rows;
}

function collectDescendants(snapshot: PosixProcess[], rootPids: number[]): PosixProcess[] {
  const childrenByParent = new Map<number, PosixProcess[]>();
  for (const row of snapshot) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row);
    childrenByParent.set(row.ppid, children);
  }
  const descendants: PosixProcess[] = [];
  const pending = [...new Set(rootPids)];
  const seen = new Set(pending);
  for (const parentPid of pending) {
    for (const child of childrenByParent.get(parentPid) ?? []) {
      if (seen.has(child.pid)) {
        continue;
      }
      seen.add(child.pid);
      descendants.push(child);
      pending.push(child.pid);
    }
  }
  return descendants;
}

function isStoppedState(state: string): boolean {
  return state.startsWith("T") || state.startsWith("t") || state.startsWith("Z");
}

function isQuiescedState(state: string): boolean {
  return isStoppedState(state) || isUninterruptibleState(state);
}

function isUninterruptibleState(state: string): boolean {
  return state.startsWith("D") || state.startsWith("U");
}

function captureProcess(row: PosixProcess): CapturedProcess | undefined {
  const identity = getProcessIdentity(row.pid);
  if (
    !identity.ok ||
    identity.value.parentPid !== row.ppid ||
    identity.value.processGroupId !== row.pgid
  ) {
    return undefined;
  }
  return { ...row, instance: identity.value.start };
}

function isSameProcess(current: PosixProcess, expected: CapturedProcess): boolean {
  const captured = captureProcess(current);
  return (
    current.pid === expected.pid &&
    current.pgid === expected.pgid &&
    captured?.instance === expected.instance
  );
}

function isSameLiveProcess(current: PosixProcess, expected: CapturedProcess): boolean {
  return !current.state.startsWith("Z") && isSameProcess(current, expected);
}

function isSameLiveRoot(
  current: PosixProcess,
  expected: CapturedProcess,
  requireStopped = false,
): boolean {
  return (
    current.ppid === expected.ppid &&
    (!requireStopped || isQuiescedState(current.state)) &&
    isSameLiveProcess(current, expected)
  );
}

async function signalSameRoot(
  root: CapturedProcess,
  signal: NodeJS.Signals,
  deadline: number,
): Promise<boolean> {
  const current = await readProcess(root.pid, deadline);
  return Boolean(current && isSameLiveRoot(current, root) && signalProcess(current.pid, signal));
}

function signalCapturedProcess(expected: CapturedProcess, signal: NodeJS.Signals): boolean {
  const identity = getProcessIdentity(expected.pid);
  return (
    identity.ok &&
    identity.value.start === expected.instance &&
    identity.value.processGroupId === expected.pgid &&
    signalProcess(expected.pid, signal)
  );
}

async function signalSameProcess(
  expected: CapturedProcess,
  signal: NodeJS.Signals,
  deadline: number,
): Promise<boolean> {
  // Portable Node POSIX signals are PID-based, so never retain numeric authority:
  // take this final identity snapshot synchronously immediately before every signal.
  const current = await readProcess(expected.pid, deadline);
  return Boolean(
    current && isSameLiveProcess(current, expected) && signalProcess(current.pid, signal),
  );
}

function identityKey(row: CapturedProcess): string {
  return `${row.pid}\0${row.instance}`;
}

function hasExited(child: ContainableTransport): boolean {
  return child.exitCode != null || child.signalCode != null;
}

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

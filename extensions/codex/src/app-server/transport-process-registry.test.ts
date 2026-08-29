import { EventEmitter } from "node:events";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PosixProcess } from "./transport-process-containment.js";
import {
  createCodexAppServerProcessReaperService,
  reapOrphanedCodexAppServerProcesses,
  registerCodexAppServerProcessSpawn,
  resetCodexAppServerProcessRegistryForTests,
  setCodexAppServerProcessRegistryStore,
  type StoredCodexAppServerProcess,
} from "./transport-process-registry.js";
import { createCodexProcessRegistryTestStore } from "./transport-process-registry.test-support.js";

const STARTED_AT = "Sat Aug 29 10:00:00 2026";
const OWNER_STARTED_AT = "Sat Aug 29 09:00:00 2026";

class SpawnedChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;

  constructor(readonly pid = 101) {
    super();
  }
}

function processRow(pid: number, startedAt = STARTED_AT, pgid = pid): PosixProcess {
  return { pid, ppid: 1, pgid, state: "S", startedAt };
}

function createHarness() {
  const store = createCodexProcessRegistryTestStore();
  const owner = processRow(process.pid, OWNER_STARTED_AT);
  // The reaper refuses snapshots that cannot see the observer, so every
  // snapshot mock includes this process's own row.
  const self = owner;
  const child = processRow(101);
  const inspectProcess = vi.fn(
    async (pid: number): Promise<PosixProcess | undefined> => (pid === process.pid ? owner : child),
  );
  const runtime = {
    platform: "linux" as NodeJS.Platform,
    inspectProcess,
    inspectSnapshot: vi.fn(async (): Promise<PosixProcess[] | undefined> => [self, child]),
    kill: vi.fn(() => true),
    now: vi.fn(() => 1_000),
  };
  const row: StoredCodexAppServerProcess = {
    pid: child.pid,
    startedAt: child.startedAt,
    ownerPid: process.pid + 1,
    ownerStartedAt: OWNER_STARTED_AT,
    spawnedAtMs: 100,
  };
  const seed = (overrides: Partial<StoredCodexAppServerProcess> = {}) => {
    const value = { ...row, ...overrides };
    store.register(String(value.pid), value);
    return value;
  };
  setCodexAppServerProcessRegistryStore(() => store);
  return { store, runtime, row, seed, child, self };
}

describe("Codex app-server process registry", () => {
  beforeEach(() => {
    resetCodexAppServerProcessRegistryForTests();
    vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetCodexAppServerProcessRegistryForTests();
    vi.restoreAllMocks();
  });

  it("records exact spawn identities and removes the row on exit", async () => {
    const { store, runtime } = createHarness();
    const child = new SpawnedChild();
    const registering = registerCodexAppServerProcessSpawn(child, runtime);
    expect(child.listenerCount("exit")).toBe(1);
    await registering;
    expect(store.lookup("101")).toEqual({
      pid: 101,
      startedAt: STARTED_AT,
      ownerPid: process.pid,
      ownerStartedAt: OWNER_STARTED_AT,
      spawnedAtMs: 1_000,
    });
    child.exitCode = 0;
    child.emit("exit");
    expect(store.entries()).toEqual([]);
  });

  it("shares one owner identity read across concurrent registrations", async () => {
    const { runtime } = createHarness();
    const children = [new SpawnedChild(101), new SpawnedChild(102)];
    runtime.inspectProcess.mockImplementation(async (pid) => processRow(pid));
    await Promise.all(children.map((child) => registerCodexAppServerProcessSpawn(child, runtime)));
    expect(runtime.inspectProcess.mock.calls.filter(([pid]) => pid === process.pid)).toHaveLength(
      1,
    );
    for (const child of children) {
      child.emit("exit");
    }
  });

  it.each(["child", "owner"] as const)(
    "skips registration when the %s identity is unavailable",
    async (missing) => {
      const { store, runtime } = createHarness();
      const child = new SpawnedChild();
      runtime.inspectProcess.mockImplementation(async (pid) =>
        (missing === "owner") === (pid === process.pid) ? undefined : processRow(pid),
      );
      await registerCodexAppServerProcessSpawn(child, runtime);
      expect(store.entries()).toEqual([]);
      expect(embeddedAgentLog.warn).toHaveBeenCalledWith(
        expect.stringContaining("identity unavailable"),
        { pid: child.pid },
      );
      child.emit("exit");
    },
  );

  it("retries the owner identity read after a failed read", async () => {
    const { store, runtime } = createHarness();
    runtime.inspectProcess.mockImplementation(async (pid) =>
      pid === process.pid ? undefined : processRow(pid),
    );
    await registerCodexAppServerProcessSpawn(new SpawnedChild(101), runtime);
    expect(store.entries()).toEqual([]);
    runtime.inspectProcess.mockImplementation(async (pid) => processRow(pid));
    const child = new SpawnedChild(102);
    await registerCodexAppServerProcessSpawn(child, runtime);
    expect(store.lookup("102")).toBeDefined();
    child.emit("exit");
  });

  it.each(["exitCode", "signalCode"] as const)(
    "does not resurrect a row after early %s",
    async (field) => {
      const { store, runtime } = createHarness();
      const pending = createDeferred<PosixProcess>();
      runtime.inspectProcess.mockReturnValue(pending.promise);
      const child = new SpawnedChild();
      const registering = registerCodexAppServerProcessSpawn(child, runtime);
      if (field === "exitCode") {
        child.exitCode = 0;
      } else {
        child.signalCode = "SIGKILL";
      }
      child.emit("exit");
      pending.resolve(processRow(child.pid));
      await registering;
      expect(store.entries()).toEqual([]);
    },
  );

  it.each(["own", "foreign"] as const)("preserves children with a live %s owner", async (kind) => {
    const { store, runtime, seed, child, self } = createHarness();
    const row = seed(kind === "own" ? { ownerPid: process.pid } : {});
    runtime.inspectSnapshot.mockResolvedValue(
      kind === "own" ? [self] : [self, child, processRow(row.ownerPid, row.ownerStartedAt)],
    );
    await reapOrphanedCodexAppServerProcesses(runtime);
    expect(store.lookup("101")).toEqual(row);
    expect(runtime.inspectProcess).not.toHaveBeenCalled();
    expect(runtime.kill).not.toHaveBeenCalled();
  });

  it.each([
    { name: "dead owner, group leader", pgid: 101, ownerRow: "absent", target: -101 },
    { name: "reused owner PID", pgid: 101, ownerRow: "reused", target: -101 },
    { name: "zombie owner", pgid: 101, ownerRow: "zombie", target: -101 },
    { name: "non-leader child", pgid: 99, ownerRow: "absent", target: 101 },
  ] as const)("reaps an identity-confirmed orphan: $name", async ({ pgid, ownerRow, target }) => {
    const { store, runtime, seed, child, self } = createHarness();
    const row = seed();
    runtime.inspectSnapshot.mockResolvedValue([
      self,
      child,
      // A zombie keeps its exact pid + lstart in the snapshot; only the state marks it dead.
      ...(ownerRow === "reused" ? [processRow(row.ownerPid, "new owner")] : []),
      ...(ownerRow === "zombie"
        ? [{ ...processRow(row.ownerPid, row.ownerStartedAt), state: "Z+" }]
        : []),
    ]);
    runtime.inspectProcess.mockResolvedValue({ ...child, pgid });
    await reapOrphanedCodexAppServerProcesses(runtime);
    expect(runtime.kill).toHaveBeenCalledExactlyOnceWith(target, "SIGKILL");
    expect(store.entries()).toEqual([]);
    expect(embeddedAgentLog.warn).toHaveBeenCalledWith("reaped orphaned codex app-server", {
      pid: row.pid,
      ownerPid: row.ownerPid,
      spawnedAtMs: row.spawnedAtMs,
    });
  });

  it("reaps rows inherited from a pid-reusing predecessor gateway", async () => {
    const { store, runtime, seed, child, self } = createHarness();
    // Same numeric owner pid as this process, but the dead predecessor's lstart.
    const row = seed({ ownerPid: process.pid, ownerStartedAt: "previous gateway" });
    runtime.inspectSnapshot.mockResolvedValue([self, child]);
    await reapOrphanedCodexAppServerProcesses(runtime);
    expect(runtime.kill).toHaveBeenCalledExactlyOnceWith(-row.pid, "SIGKILL");
    expect(store.entries()).toEqual([]);
  });

  it("keeps all rows when the snapshot omits this process", async () => {
    const { store, runtime, seed, child } = createHarness();
    seed();
    const before = store.entries();
    runtime.inspectSnapshot.mockResolvedValue([child]);
    await reapOrphanedCodexAppServerProcesses(runtime);
    expect(store.entries()).toEqual(before);
    expect(runtime.inspectProcess).not.toHaveBeenCalled();
    expect(runtime.kill).not.toHaveBeenCalled();
    expect(embeddedAgentLog.warn).toHaveBeenCalledOnce();
  });

  it.each(["gone", "reused"] as const)(
    "deletes a child proven %s by the snapshot without signaling",
    async (kind) => {
      const { store, runtime, seed, child, self } = createHarness();
      seed();
      runtime.inspectSnapshot.mockResolvedValue(
        kind === "gone" ? [self] : [self, { ...child, startedAt: "new child" }],
      );
      await reapOrphanedCodexAppServerProcesses(runtime);
      expect(store.entries()).toEqual([]);
      expect(runtime.inspectProcess).not.toHaveBeenCalled();
      expect(runtime.kill).not.toHaveBeenCalled();
    },
  );

  it("keeps a row re-registered with a new identity after the snapshot was judged", async () => {
    const { store, runtime, seed, self } = createHarness();
    const stale = seed();
    const replacement = { ...stale, startedAt: "new child", ownerPid: process.pid + 2 };
    // The reaper judged the stale row against its snapshot; a live owner re-registered
    // the same pid meanwhile. Only the judged row may be deleted.
    vi.spyOn(store, "entries").mockReturnValue([{ key: "101", value: stale, createdAt: 0 }]);
    store.register("101", replacement);
    runtime.inspectSnapshot.mockResolvedValue([self]);
    await reapOrphanedCodexAppServerProcesses(runtime);
    expect(store.lookup("101")).toEqual(replacement);
    expect(runtime.kill).not.toHaveBeenCalled();
  });

  it("keeps all rows and logs once when the snapshot fails", async () => {
    const { store, runtime, seed } = createHarness();
    seed();
    seed({ pid: 102 });
    const before = store.entries();
    runtime.inspectSnapshot.mockResolvedValue(undefined);
    await reapOrphanedCodexAppServerProcesses(runtime);
    expect(store.entries()).toEqual(before);
    expect(runtime.kill).not.toHaveBeenCalled();
    expect(runtime.inspectProcess).not.toHaveBeenCalled();
    expect(embeddedAgentLog.warn).toHaveBeenCalledOnce();
  });

  it.each(["unavailable", "pid", "startedAt"] as const)(
    "retains the row when final confirmation differs: %s",
    async (kind) => {
      const { store, runtime, seed, child } = createHarness();
      const row = seed();
      runtime.inspectProcess.mockResolvedValue(
        kind === "unavailable"
          ? undefined
          : { ...child, [kind]: kind === "pid" ? 102 : "new child" },
      );
      await reapOrphanedCodexAppServerProcesses(runtime);
      expect(store.lookup("101")).toEqual(row);
      expect(runtime.kill).not.toHaveBeenCalled();
    },
  );

  it("returns the same promise without rescanning, including after settlement", async () => {
    const { runtime, seed } = createHarness();
    seed();
    const pending = createDeferred<PosixProcess[]>();
    runtime.inspectSnapshot.mockReturnValue(pending.promise);
    const first = reapOrphanedCodexAppServerProcesses(runtime);
    expect(reapOrphanedCodexAppServerProcesses(runtime)).toBe(first);
    pending.resolve([]);
    await first;
    expect(reapOrphanedCodexAppServerProcesses(runtime)).toBe(first);
    expect(runtime.inspectSnapshot).toHaveBeenCalledOnce();
  });

  it("starts the service without waiting for an in-flight reap", async () => {
    const { runtime, seed } = createHarness();
    seed();
    const pending = createDeferred<PosixProcess[]>();
    runtime.inspectSnapshot.mockReturnValue(pending.promise);
    const reaping = reapOrphanedCodexAppServerProcesses(runtime);
    const service = createCodexAppServerProcessReaperService();
    expect(service.start({} as never)).toBeUndefined();
    expect(reapOrphanedCodexAppServerProcesses(runtime)).toBe(reaping);
    pending.resolve([]);
    await reaping;
  });

  it.each(["snapshot", "confirmation", "next row"] as const)(
    "stops at the deadline after %s",
    async (boundary) => {
      const { store, runtime, seed, child, self } = createHarness();
      seed();
      seed({ pid: 102 });
      if (boundary === "snapshot") {
        runtime.inspectSnapshot.mockImplementation(async () => {
          runtime.now.mockReturnValue(6_000);
          return [self, child];
        });
      } else if (boundary === "confirmation") {
        runtime.inspectProcess.mockImplementation(async () => {
          runtime.now.mockReturnValue(6_000);
          return child;
        });
      } else {
        runtime.kill.mockImplementation(() => {
          runtime.now.mockReturnValue(6_000);
          return true;
        });
      }
      await reapOrphanedCodexAppServerProcesses(runtime);
      expect(store.lookup("102")).toBeDefined();
      expect(runtime.kill).toHaveBeenCalledTimes(boundary === "next row" ? 1 : 0);
    },
  );

  it("removes malformed persisted rows without signaling", async () => {
    const { store, runtime } = createHarness();
    vi.spyOn(store, "entries").mockReturnValue([
      { key: "bad", value: { pid: 101 } as StoredCodexAppServerProcess, createdAt: 0 },
    ]);
    const remove = vi.spyOn(store, "delete");
    await reapOrphanedCodexAppServerProcesses(runtime);
    expect(remove).toHaveBeenCalledExactlyOnceWith("bad");
    expect(runtime.kill).not.toHaveBeenCalled();
  });

  it("deletes an identity-confirmed row even when signaling returns false", async () => {
    const { store, runtime, seed } = createHarness();
    seed();
    runtime.kill.mockReturnValue(false);
    await reapOrphanedCodexAppServerProcesses(runtime);
    expect(runtime.kill).toHaveBeenCalledExactlyOnceWith(-101, "SIGKILL");
    expect(store.entries()).toEqual([]);
  });

  it.each(["open", "register", "entries", "delete", "deleteIf"] as const)(
    "contains %s store failures",
    async (operation) => {
      const { store, runtime, seed } = createHarness();
      seed();
      const fail = () => {
        throw new Error("store unavailable");
      };
      if (operation === "open") {
        setCodexAppServerProcessRegistryStore(fail);
      } else {
        vi.spyOn(store, operation).mockImplementation(fail);
      }
      // A distinct pid keeps the seeded foreign row alive so the reap reaches deleteIf.
      const child = new SpawnedChild(operation === "deleteIf" ? 102 : 101);
      await expect(registerCodexAppServerProcessSpawn(child, runtime)).resolves.toBeUndefined();
      expect(() => child.emit("exit")).not.toThrow();
      await expect(reapOrphanedCodexAppServerProcesses(runtime)).resolves.toBeUndefined();
      expect(embeddedAgentLog.warn).toHaveBeenCalled();
    },
  );

  it.each(["win32", "no store"] as const)("does nothing with %s", async (mode) => {
    const { store, runtime, seed } = createHarness();
    seed();
    const before = store.entries();
    if (mode === "win32") {
      runtime.platform = "win32";
    } else {
      resetCodexAppServerProcessRegistryForTests();
    }
    const child = new SpawnedChild();
    await registerCodexAppServerProcessSpawn(child, runtime);
    await reapOrphanedCodexAppServerProcesses(runtime);
    expect(child.listenerCount("exit")).toBe(0);
    expect(store.entries()).toEqual(before);
    expect(runtime.inspectProcess).not.toHaveBeenCalled();
    expect(runtime.inspectSnapshot).not.toHaveBeenCalled();
    expect(runtime.kill).not.toHaveBeenCalled();
  });
});

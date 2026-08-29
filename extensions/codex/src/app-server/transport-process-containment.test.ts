import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reapCodexAppServerOrphan,
  terminateCodexAppServerDescendants,
} from "./transport-process-containment.js";

const execFile = vi.hoisted(() => vi.fn());
const getProcessIdentity = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile }));
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ getProcessIdentity }));
afterEach(() => vi.restoreAllMocks());

type ProcessFixture = {
  pid: number;
  parentPid: number;
  processGroupId: number;
  start: string;
  state: string;
};

function mockKernelProcesses(processes: ProcessFixture[]) {
  getProcessIdentity.mockImplementation((pid: number) => {
    const row = processes.find((process) => process.pid === pid);
    return row
      ? {
          ok: true,
          value: {
            start: row.start,
            parentPid: row.parentPid,
            processGroupId: row.processGroupId,
          },
        }
      : { ok: false, error: "unavailable" };
  });
  return (args: string[]) => {
    const pidArgument = args.indexOf("-p");
    const pid = pidArgument === -1 ? undefined : Number(args[pidArgument + 1]);
    return processes
      .filter((row) => pid === undefined || row.pid === pid)
      .map((row) => `${row.pid} ${row.parentPid} ${row.processGroupId} ${row.state}`)
      .join("\n");
  };
}

describe.skipIf(process.platform === "win32")("owned Codex process-tree custody", () => {
  const rootProcess = (): ProcessFixture => ({
    pid: 200,
    parentPid: process.pid,
    processGroupId: 200,
    start: "kernel-root",
    state: "S",
  });
  const descendantProcess = (): ProcessFixture => ({
    pid: 300,
    parentPid: 200,
    processGroupId: 300,
    start: "kernel-descendant",
    state: "S",
  });

  it.each([
    "late discovery",
    "reparented descendant",
    "resumed root",
    "traced descendant",
    "uninterruptible U",
    "uninterruptible D",
    "extended stop settlement",
  ])("retains custody through %s before permitting graceful root shutdown", async (mode) => {
    const root = rootProcess();
    const descendant = descendantProcess();
    if (mode.startsWith("uninterruptible")) {
      descendant.state = mode.endsWith("U") ? "U" : "D";
    }
    const processes = mode === "late discovery" ? [root] : [root, descendant];
    const rows = mockKernelProcesses(processes);
    let rootStops = 0;
    let descendantStops = 0;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === root.pid && signal === "SIGSTOP") {
        rootStops += 1;
        root.state = mode === "resumed root" && rootStops === 1 ? "S" : "T";
        if (mode === "late discovery" && !processes.includes(descendant)) {
          // This child was forked after the first census but before the root stopped.
          processes.push(descendant);
        }
      }
      if (pid === descendant.pid && signal === "SIGSTOP") {
        descendantStops += 1;
        if (mode === "reparented descendant") {
          descendant.parentPid = 1;
        }
        if (mode === "traced descendant") {
          descendant.state = "t";
        } else if (!mode.startsWith("uninterruptible")) {
          descendant.state = mode === "extended stop settlement" && descendantStops < 9 ? "S" : "T";
        }
      }
      return true;
    });
    execFile.mockImplementation((_file, args: string[], _options, callback) => {
      queueMicrotask(() => callback(null, rows(args)));
      return {};
    });

    const resume = await terminateCodexAppServerDescendants({ pid: root.pid, kill: vi.fn() });
    expect(resume).toBeTypeOf("function");
    expect(kill.mock.calls.filter(([, signal]) => signal === "SIGKILL")).toEqual([
      [descendant.pid, "SIGKILL"],
    ]);
    expect(kill).not.toHaveBeenCalledWith(root.pid, "SIGCONT");
    expect(rootStops).toBe(mode === "resumed root" ? 2 : 1);
    expect(descendantStops).toBe(mode === "extended stop settlement" ? 9 : 1);
    resume?.();
    expect(kill).toHaveBeenLastCalledWith(root.pid, "SIGCONT");
  });

  it.each([false, true])(
    "resumes only original process instances after failed inspection (descendant reused: %s)",
    async (reused) => {
      const root = rootProcess();
      const descendant = descendantProcess();
      const rows = mockKernelProcesses([root, descendant]);
      let descendantStopped = false;
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === root.pid && signal === "SIGSTOP") {
          root.state = "T";
        }
        if (pid === descendant.pid && signal === "SIGSTOP") {
          descendant.state = "T";
          descendantStopped = true;
        }
        return true;
      });
      execFile.mockImplementation((_file, args: string[], _options, callback) => {
        if (descendantStopped && !args.includes("-p")) {
          if (reused) {
            descendant.start = "kernel-replacement";
            descendant.parentPid = 999;
          }
          queueMicrotask(() => callback(new Error("ps failed"), ""));
        } else {
          queueMicrotask(() => callback(null, rows(args)));
        }
        return {};
      });

      await expect(
        terminateCodexAppServerDescendants({ pid: root.pid, kill: vi.fn() }),
      ).resolves.toBeUndefined();
      expect(kill).toHaveBeenCalledWith(descendant.pid, "SIGSTOP");
      expect(kill.mock.calls.filter(([, signal]) => signal === "SIGKILL")).toEqual([]);
      expect(kill.mock.calls.filter(([, signal]) => signal === "SIGCONT")).toEqual(
        reused
          ? [[root.pid, "SIGCONT"]]
          : [
              [descendant.pid, "SIGCONT"],
              [root.pid, "SIGCONT"],
            ],
      );
    },
  );

  it("bounds a hung inspector and resumes its original root", async () => {
    const root = rootProcess();
    const rows = mockKernelProcesses([root]);
    const inspector = {
      kill: vi.fn(),
      unref: vi.fn(),
      stdout: { destroy: vi.fn() },
      stderr: { destroy: vi.fn() },
    };
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGSTOP") {
        root.state = "T";
      }
      return true;
    });
    execFile.mockImplementation((_file, args: string[], _options, callback) => {
      if (root.state !== "T" || args.includes("-p")) {
        queueMicrotask(() => callback(null, rows(args)));
      }
      return inspector;
    });

    await expect(
      terminateCodexAppServerDescendants({ pid: root.pid, kill: vi.fn() }),
    ).resolves.toBeUndefined();
    expect(inspector.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(inspector.stdout.destroy).toHaveBeenCalledOnce();
    expect(inspector.stderr.destroy).toHaveBeenCalledOnce();
    expect(inspector.unref).toHaveBeenCalledOnce();
    expect(kill.mock.calls).toEqual([
      [root.pid, "SIGSTOP"],
      [root.pid, "SIGCONT"],
    ]);
  });
});

describe.skipIf(process.platform === "win32")("registered Codex orphan custody", () => {
  const owner = {
    pid: 100,
    pgid: 100,
    instance: "kernel-owner",
  };
  const child = {
    pid: 200,
    pgid: 200,
    instance: "darwin:1000:1",
  };
  const rootRow = "200 1 200 S";
  const kernelIdentity = (pid: number, start: string, parentPid = 1) => ({
    ok: true,
    value: { start, parentPid, processGroupId: pid },
  });

  it.each(["initial inspection", "final signal check"])(
    "rejects same-second PID reuse at %s",
    async (phase) => {
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      getProcessIdentity.mockReturnValue(kernelIdentity(child.pid, "darwin:1000:2"));
      if (phase === "final signal check") {
        getProcessIdentity.mockReturnValueOnce(kernelIdentity(child.pid, child.instance));
      }
      execFile.mockImplementation((_file, _args, _options, callback) => {
        queueMicrotask(() => callback(null, rootRow));
        return {};
      });
      await expect(reapCodexAppServerOrphan(owner, child, Date.now() + 2_000)).resolves.toBe(
        "gone",
      );
      expect(kill).not.toHaveBeenCalled();
    },
  );

  it.each([
    { signal: "SIGSTOP", state: "S" },
    { signal: "SIGKILL", state: "T" },
  ])("rejects same-second descendant PID reuse before $signal", async ({ state }) => {
    let rootStopped = false;
    let descendantReused = false;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === child.pid && signal === "SIGSTOP") {
        rootStopped = true;
      }
      return true;
    });
    getProcessIdentity.mockImplementation((pid: number) =>
      kernelIdentity(
        pid,
        pid === 300 ? (descendantReused ? "darwin:1001:2" : "darwin:1001:1") : child.instance,
        pid === 300 ? (descendantReused ? 999 : child.pid) : 1,
      ),
    );
    execFile.mockImplementation((_file, args: string[], _options, callback) => {
      const pidArgument = args.indexOf("-p");
      const inspectedPid = pidArgument === -1 ? undefined : args[pidArgument + 1];
      let rows: string;
      if (inspectedPid === "300") {
        // A detached descendant exits; an unrelated process reuses its PID/PGID
        // within the same ps timestamp second, before the pending signal.
        descendantReused = true;
        rows = `300 999 300 ${state}`;
      } else if (descendantReused) {
        // Another reaper completes so this recovery can observe terminal custody.
        rows = "";
      } else {
        const root = `200 1 200 ${rootStopped ? "T" : "S"}`;
        rows = inspectedPid ? root : `${root}\n300 200 300 ${state}`;
      }
      queueMicrotask(() => callback(null, rows));
      return {};
    });

    await expect(reapCodexAppServerOrphan(owner, child, Date.now() + 2_000)).resolves.toBe("gone");
    expect(descendantReused).toBe(true);
    expect(kill).toHaveBeenCalledWith(child.pid, "SIGSTOP");
    expect(kill).not.toHaveBeenCalledWith(300, expect.anything());
  });

  it.each([
    { parentPid: 999, processGroupId: 300 },
    { parentPid: child.pid, processGroupId: 999 },
  ])("rejects stale descendant ancestry when the kernel reports %j", async (identity) => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    getProcessIdentity.mockImplementation((pid: number) =>
      pid === 300
        ? { ok: true, value: { start: "darwin:1001:1", ...identity } }
        : kernelIdentity(pid, child.instance),
    );
    const snapshots = [`${rootRow}\n300 200 300 S`, ""];
    execFile.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(null, snapshots.shift() ?? ""));
      return {};
    });

    await expect(reapCodexAppServerOrphan(owner, child, Date.now() + 2_000)).resolves.toBe("gone");
    expect(kill).not.toHaveBeenCalled();
  });

  it("waits for observed exit when the kernel retires identity before ps drops the killed root", async () => {
    let stopped = false;
    let killed = false;
    let finalSnapshots = 0;
    let unavailableObserved = false;
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      stopped ||= signal === "SIGSTOP";
      killed ||= signal === "SIGKILL";
      return true;
    });
    getProcessIdentity.mockImplementation(() => {
      if (killed) {
        unavailableObserved = true;
        return { ok: false, error: "unavailable" };
      }
      return kernelIdentity(child.pid, child.instance);
    });
    execFile.mockImplementation((_file, _args, _options, callback) => {
      const rows = killed && finalSnapshots++ > 0 ? "" : `200 1 200 ${stopped ? "T" : "S"}`;
      queueMicrotask(() => callback(null, rows));
      return {};
    });

    await expect(reapCodexAppServerOrphan(owner, child, Date.now() + 2_000)).resolves.toBe("gone");
    expect(unavailableObserved).toBe(true);
    expect(kill.mock.calls).toEqual([
      [child.pid, "SIGSTOP"],
      [child.pid, "SIGKILL"],
    ]);
  });

  it.each([
    { name: "live owner", rows: [`100 1 100 S\n${rootRow}`], result: "owned" },
    { name: "reused child PID", rows: [rootRow], result: "gone" },
    { name: "another reaper finishes during inspection", rows: [rootRow, "", ""], result: "gone" },
    { name: "unavailable process evidence", rows: [null], result: "error" },
    { name: "unavailable kernel identity", rows: [rootRow], result: "error" },
  ])("does not signal with $name", async ({ name, rows, result }) => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const snapshots = [...rows];
    getProcessIdentity.mockImplementation((pid: number) =>
      name === "unavailable kernel identity"
        ? { ok: false, error: "unavailable" }
        : kernelIdentity(
            pid,
            pid === owner.pid
              ? owner.instance
              : name === "reused child PID"
                ? "darwin:1000:2"
                : child.instance,
          ),
    );
    execFile.mockImplementation((_file, _args, _options, callback) => {
      const snapshot = snapshots.shift() ?? (result === "error" ? null : "");
      queueMicrotask(() =>
        callback(snapshot === null ? new Error("ps unavailable") : null, snapshot ?? ""),
      );
      return {};
    });
    const recovery = reapCodexAppServerOrphan(owner, child, Date.now() + 2_000);
    if (result === "error") {
      await expect(recovery).rejects.toThrow("Cannot reap an orphaned Codex app-server safely");
    } else {
      await expect(recovery).resolves.toBe(result);
    }
    expect(kill).not.toHaveBeenCalled();
  });
});

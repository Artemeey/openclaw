import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  inspectCodexTransportProcess,
  inspectCodexTransportProcessCommand,
  inspectCodexTransportProcessSnapshot,
  type PosixProcess,
} from "./transport-process-containment.js";
import {
  reapOrphanedCodexAppServerProcesses,
  resetCodexAppServerProcessRegistryForTests,
  setCodexAppServerProcessRegistryStore,
} from "./transport-process-registry.js";
import { createCodexProcessRegistryTestStore } from "./transport-process-registry.test-support.js";

function spawnSleepFixture(detached: boolean) {
  const child = spawn("sleep", ["60"], { detached, stdio: "ignore" });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  return { child, exited };
}

describe.skipIf(process.platform === "win32")("Codex app-server orphan process reaper", () => {
  it("preserves a live owner's child and kills its detached group after the owner exits", async () => {
    const store = createCodexProcessRegistryTestStore();
    const orphan = spawnSleepFixture(true);
    const owner = spawnSleepFixture(false);
    resetCodexAppServerProcessRegistryForTests();
    setCodexAppServerProcessRegistryStore(() => store);

    try {
      await Promise.all([once(orphan.child, "spawn"), once(owner.child, "spawn")]);
      const orphanPid = orphan.child.pid;
      const ownerPid = owner.child.pid;
      if (!orphanPid || !ownerPid) {
        throw new Error("process fixtures did not acquire PIDs");
      }
      const deadline = Date.now() + 5_000;
      const [orphanIdentity, orphanCommand, ownerIdentity] = await Promise.all([
        inspectCodexTransportProcess(orphanPid, deadline),
        inspectCodexTransportProcessCommand(orphanPid, deadline),
        inspectCodexTransportProcess(ownerPid, deadline),
      ]);
      if (!orphanIdentity || !orphanCommand || !ownerIdentity) {
        throw new Error("could not inspect process fixture identities");
      }
      expect(orphanIdentity.pgid).toBe(orphanPid);
      const key = String(orphanPid);
      store.register(key, {
        pid: orphanPid,
        startedAt: orphanIdentity.startedAt,
        command: orphanCommand,
        ownerPid,
        ownerStartedAt: ownerIdentity.startedAt,
        spawnedAtMs: Date.now(),
      });

      await reapOrphanedCodexAppServerProcesses();

      expect(process.kill(orphanPid, 0)).toBe(true);
      expect(store.lookup(key)).toBeDefined();

      owner.child.kill("SIGKILL");
      await owner.exited;
      expect(process.kill(orphanPid, 0)).toBe(true);
      resetCodexAppServerProcessRegistryForTests();
      setCodexAppServerProcessRegistryStore(() => store);

      await reapOrphanedCodexAppServerProcesses();
      await expect.poll(() => orphan.child.signalCode, { timeout: 5_000 }).toBe("SIGKILL");
      await orphan.exited;

      const snapshot = await inspectCodexTransportProcessSnapshot(Date.now() + 5_000);
      expect(snapshot).toBeDefined();
      expect(snapshot?.some((row) => row.pid === orphanPid)).toBe(false);
      expect(() => process.kill(orphanPid, 0)).toThrowError(
        expect.objectContaining({ code: "ESRCH" }),
      );
      expect(store.entries()).toEqual([]);
    } finally {
      for (const fixture of [owner, orphan]) {
        if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
          fixture.child.kill("SIGKILL");
        }
      }
      await Promise.all([owner.exited, orphan.exited]);
      store.clear();
      resetCodexAppServerProcessRegistryForTests();
    }
  }, 20_000);

  it("treats an unreaped zombie owner as dead and reaps its orphan", async () => {
    const store = createCodexProcessRegistryTestStore();
    const orphan = spawnSleepFixture(true);
    // The inner sleep exits after 1s; its parent becomes the exec'd sleep binary,
    // which never calls wait, so the inner pid stays a real Z-state process.
    const holder = spawn("sh", ["-c", 'sh -c "exec sleep 1" & echo $!; exec sleep 60'], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const holderExited = new Promise<void>((resolve) => {
      holder.once("exit", () => resolve());
      holder.once("error", () => resolve());
    });
    resetCodexAppServerProcessRegistryForTests();
    setCodexAppServerProcessRegistryStore(() => store);

    try {
      const zombiePid = await new Promise<number>((resolve, reject) => {
        let buffered = "";
        holder.stdout.on("data", (chunk: Buffer) => {
          buffered += chunk.toString("utf8");
          const line = buffered.split("\n")[0]?.trim();
          if (line) {
            resolve(Number(line));
          }
        });
        holder.once("error", reject);
        holder.once("exit", () => reject(new Error("holder exited before printing the pid")));
      });
      expect(Number.isSafeInteger(zombiePid)).toBe(true);
      // The orphan's "spawn" event has usually fired while reading holder stdout;
      // pid is assigned synchronously on success, so only wait when it is absent.
      if (!orphan.child.pid) {
        await once(orphan.child, "spawn");
      }
      const orphanPid = orphan.child.pid;
      if (!orphanPid) {
        throw new Error("orphan fixture did not acquire a PID");
      }
      let zombieRow: PosixProcess | undefined;
      const zombieDeadline = Date.now() + 10_000;
      while (Date.now() < zombieDeadline && !zombieRow) {
        const snapshot = await inspectCodexTransportProcessSnapshot(Date.now() + 5_000);
        const row = snapshot?.find((candidate) => candidate.pid === zombiePid);
        if (row?.state.startsWith("Z")) {
          zombieRow = row;
          break;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
      }
      const [orphanIdentity, orphanCommand] = await Promise.all([
        inspectCodexTransportProcess(orphanPid, Date.now() + 5_000),
        inspectCodexTransportProcessCommand(orphanPid, Date.now() + 5_000),
      ]);
      if (!zombieRow || !orphanIdentity || !orphanCommand) {
        throw new Error("could not inspect zombie or orphan fixture identities");
      }
      store.register(String(orphanPid), {
        pid: orphanPid,
        startedAt: orphanIdentity.startedAt,
        command: orphanCommand,
        ownerPid: zombiePid,
        ownerStartedAt: zombieRow.startedAt,
        spawnedAtMs: Date.now(),
      });

      await reapOrphanedCodexAppServerProcesses();
      await expect.poll(() => orphan.child.signalCode, { timeout: 5_000 }).toBe("SIGKILL");
      await orphan.exited;
      expect(store.entries()).toEqual([]);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        holder.kill("SIGKILL");
      }
      if (orphan.child.exitCode === null && orphan.child.signalCode === null) {
        orphan.child.kill("SIGKILL");
      }
      await Promise.all([holderExited, orphan.exited]);
      store.clear();
      resetCodexAppServerProcessRegistryForTests();
    }
  }, 20_000);
});

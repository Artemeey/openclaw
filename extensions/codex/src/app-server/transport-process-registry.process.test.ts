import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  inspectCodexTransportProcess,
  inspectCodexTransportProcessSnapshot,
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
      const [orphanIdentity, ownerIdentity] = await Promise.all([
        inspectCodexTransportProcess(orphanPid, deadline),
        inspectCodexTransportProcess(ownerPid, deadline),
      ]);
      if (!orphanIdentity || !ownerIdentity) {
        throw new Error("could not inspect process fixture identities");
      }
      expect(orphanIdentity.pgid).toBe(orphanPid);
      const key = String(orphanPid);
      store.register(key, {
        pid: orphanPid,
        startedAt: orphanIdentity.startedAt,
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
});

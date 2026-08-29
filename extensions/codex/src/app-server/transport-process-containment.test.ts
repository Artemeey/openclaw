import { afterEach, describe, expect, it, vi } from "vitest";
import { reapCodexAppServerOrphan } from "./transport-process-containment.js";

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile }));
afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.platform === "win32")("registered Codex orphan custody", () => {
  const owner = { pid: 100, pgid: 100, startedAt: "Mon Jan 1 00:00:00 2001" };
  const child = { pid: 200, pgid: 200, startedAt: "Mon Jan 1 00:00:01 2001" };
  const rootRow = `200 1 200 S ${child.startedAt}`;

  it.each([
    { name: "live owner", rows: [`100 1 100 S ${owner.startedAt}\n${rootRow}`], result: "owned" },
    { name: "reused child PID", rows: ["200 1 200 S Tue Jan 2 00:00:00 2001"], result: "gone" },
    { name: "another reaper finishes during inspection", rows: [rootRow, "", ""], result: "gone" },
    { name: "unavailable process evidence", rows: [null], result: "error" },
  ])("does not signal with $name", async ({ rows, result }) => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const snapshots = [...rows];
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

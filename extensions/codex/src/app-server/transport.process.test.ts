import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeCodexAppServerTransportAndWait } from "./transport.js";

type FixtureEvent = {
  role: "root" | "separate-leader" | "separate-descendant" | "shared-leader" | "shared-descendant";
  pid: number;
  pgid: number;
};

type ProcessRow = {
  pid: number;
  command: string;
};

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function listProcesses(): ProcessRow[] {
  return execFileSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(.*)$/.exec(line);
      if (!match) {
        throw new Error(`unexpected ps row: ${line}`);
      }
      return {
        pid: Number(match[1]),
        command: match[2] ?? "",
      };
    });
}

async function waitForFixtureEvents(logPath: string, count: number): Promise<FixtureEvent[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = await readFixtureEvents(logPath);
    if (events.length >= count) {
      return events;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for ${count} process fixture events`);
}

async function readFixtureEvents(logPath: string): Promise<FixtureEvent[]> {
  const contents = await fs.readFile(logPath, "utf8").catch(() => "");
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureEvent);
}

async function removeTaskOwnedFixtureProcesses(tempDir: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const allRows = listProcesses();
    const ownedRows = allRows.filter((row) => row.command.includes(tempDir));
    if (ownedRows.length === 0) {
      return;
    }
    for (const row of ownedRows) {
      try {
        process.kill(row.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    }
    await delay(20);
  }
  const survivors = listProcesses().filter((row) => row.command.includes(tempDir));
  if (survivors.length > 0) {
    throw new Error(`task-owned process fixture survived cleanup: ${JSON.stringify(survivors)}`);
  }
}

describe.skipIf(process.platform === "win32")("Codex app-server process containment", () => {
  it("reaps descendants in independent and root process groups before close returns", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-transport-process-"));
    const logPath = path.join(tempDir, "processes.jsonl");
    const rootPath = path.join(tempDir, "root.mjs");
    const leaderPath = path.join(tempDir, "leader.mjs");
    const descendantPath = path.join(tempDir, "descendant.mjs");
    await fs.writeFile(logPath, "");
    await fs.writeFile(
      descendantPath,
      `
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [logPath, role] = process.argv.slice(2);
const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
appendFileSync(logPath, JSON.stringify({ role, pid: process.pid, pgid }) + "\\n");
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => {});
setInterval(() => {}, 1_000);
`,
    );
    await fs.writeFile(
      leaderPath,
      `
import { appendFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
const [logPath, role, descendantPath] = process.argv.slice(2);
const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
appendFileSync(logPath, JSON.stringify({ role, pid: process.pid, pgid }) + "\\n");
const descendant = spawn(process.execPath, [descendantPath, logPath, role.replace("leader", "descendant")], { stdio: "ignore" });
descendant.unref();
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => {});
setInterval(() => {}, 1_000);
`,
    );
    await fs.writeFile(
      rootPath,
      `
import { appendFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
const [logPath, leaderPath, descendantPath] = process.argv.slice(2);
const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
appendFileSync(logPath, JSON.stringify({ role: "root", pid: process.pid, pgid }) + "\\n");
for (const [role, detached] of [["separate-leader", true], ["shared-leader", false]]) {
  const child = spawn(process.execPath, [leaderPath, logPath, role, descendantPath], { detached, stdio: "ignore" });
  child.unref();
}
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`,
    );

    const root = spawn(process.execPath, [rootPath, logPath, leaderPath, descendantPath], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      const events = await waitForFixtureEvents(logPath, 5);
      const eventByRole = new Map(events.map((event) => [event.role, event]));
      const rootEvent = eventByRole.get("root");
      const separateLeader = eventByRole.get("separate-leader");
      const separateDescendant = eventByRole.get("separate-descendant");
      const sharedLeader = eventByRole.get("shared-leader");
      const sharedDescendant = eventByRole.get("shared-descendant");
      expect(rootEvent).toBeDefined();
      expect(separateLeader?.pgid).toBe(separateLeader?.pid);
      expect(separateDescendant?.pgid).toBe(separateLeader?.pgid);
      expect(sharedLeader?.pgid).toBe(rootEvent?.pgid);
      expect(sharedDescendant?.pgid).toBe(rootEvent?.pgid);
      await expect(
        closeCodexAppServerTransportAndWait(root, {
          forceKillDelayMs: 500,
          exitTimeoutMs: 2_000,
        }),
      ).resolves.toBe(true);
      expect(root.exitCode).toBe(0);
      expect(root.signalCode).toBeNull();

      const survivors = listProcesses().filter((row) => row.command.includes(tempDir));
      expect(survivors).toEqual([]);
    } finally {
      await removeTaskOwnedFixtureProcesses(tempDir);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

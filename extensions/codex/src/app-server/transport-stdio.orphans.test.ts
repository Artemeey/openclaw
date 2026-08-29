import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

function isRunning(pid: number): boolean {
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .startsWith("Z");
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("Codex stdio orphan recovery", () => {
  it("reaps a hard-killed owner's child before reconnect, preserving live and foreign owners", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-orphans-")));
    const server = path.join(root, "server.mjs");
    const driver = path.join(root, "driver.mts");
    const parents: ChildProcess[] = [];
    const children: number[] = [];
    await fs.writeFile(
      server,
      `
import { spawn } from "node:child_process";
if (!process.argv.includes("--descendant")) {
  const children = [false, true].map((detached) => spawn(process.execPath, [process.argv[1], "--descendant"], { detached, stdio: "ignore" }));
  process.stdout.write(JSON.stringify([process.pid, ...children.map((child) => child.pid)]) + "\\n");
}
process.stdin.resume();
process.stdin.on("end", () => {});
setInterval(() => {}, 1000);
`,
    );
    const transportUrl = pathToFileURL(
      path.resolve("extensions/codex/src/app-server/transport-stdio.ts"),
    ).href;
    await fs.writeFile(
      driver,
      `
import { createInterface } from "node:readline";
import { createStdioTransport } from ${JSON.stringify(transportUrl)};
const child = await createStdioTransport({ transport: "stdio", command: process.execPath, args: [process.argv[2]], headers: {} });
child.on("error", (error) => { throw error; });
createInterface({ input: child.stdout }).once("line", (line) => process.send({ pids: JSON.parse(line) }));
setInterval(() => {}, 1000);
`,
    );
    const start = async (stateDir: string) => {
      const env: NodeJS.ProcessEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      delete env.OPENCLAW_QA_PARENT_PID;
      const parent = spawn(process.execPath, ["--import", "tsx", driver, server], {
        env,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      parents.push(parent);
      let stderr = "";
      parent.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const pids = await new Promise<number[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`spawn timed out: ${stderr}`)), 15_000);
        parent.once("error", reject);
        parent.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(`driver exited: ${stderr}`));
        });
        parent.once("message", (message: { pids: number[] }) => {
          clearTimeout(timer);
          resolve(message.pids);
        });
      });
      children.push(...pids);
      return { parent, pids };
    };
    const killParent = async (parent: ChildProcess) => {
      const exited = new Promise<void>((resolve) => parent.once("exit", () => resolve()));
      parent.kill("SIGKILL");
      await exited;
    };
    try {
      const state = path.join(root, "state");
      const orphan = await start(state);
      const live = await start(state);
      const foreign = await start(path.join(root, "foreign"));
      await killParent(orphan.parent);
      await killParent(foreign.parent);
      expect(orphan.pids.every(isRunning)).toBe(true);
      const fresh = await start(state);
      expect(
        orphan.pids.filter(isRunning),
        "old process tree must be gone before fresh spawn",
      ).toEqual([]);
      expect(live.pids.every(isRunning)).toBe(true);
      expect(foreign.pids.every(isRunning)).toBe(true);
      expect(fresh.pids.every(isRunning)).toBe(true);
    } finally {
      for (const parent of parents) {
        if (parent.exitCode === null && parent.signalCode === null) await killParent(parent);
      }
      for (const pid of children) {
        if (isRunning(pid)) process.kill(pid, "SIGKILL");
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

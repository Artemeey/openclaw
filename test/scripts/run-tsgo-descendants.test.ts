import { spawn } from "node:child_process";
import fs from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { waitForDead } from "../helpers/process-wait.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const repo = process.cwd();
type FixtureProcess = { role: string; pid: number; ppid: number; socket: Socket; closed: boolean };

async function until(predicate: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await delay(10);
  }
  return true;
}

describe.skipIf(process.platform === "win32")("compiler descendant cleanup", () => {
  it.each(["timeout", "abort", "signal"])(
    "closes lint and its nested compiler after %s",
    async (mode) => {
      const dir = fs.realpathSync(createTempDir("openclaw-compiler-descendants-"));
      const records: FixtureProcess[] = [];
      const server = net.createServer((socket) => {
        let buffer = "";
        let record: FixtureProcess | undefined;
        socket.on("data", (data) => {
          buffer += data;
          while (buffer.includes("\n")) {
            const index = buffer.indexOf("\n");
            const message = JSON.parse(buffer.slice(0, index)) as Omit<
              FixtureProcess,
              "socket" | "closed"
            >;
            buffer = buffer.slice(index + 1);
            record = { ...message, socket, closed: false };
            records.push(record);
          }
        });
        socket.on("error", () => {});
        socket.on("close", () => {
          if (record) record.closed = true;
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture address");
      const port = address.port;
      const preload = path.join(dir, "preload.mjs");
      const prep = path.join(dir, "prepare.mjs");
      const compiler = path.join(dir, "compiler.cjs");
      const grandchild = path.join(dir, "grandchild.cjs");
      const sentinel = path.join(dir, "sentinel.cjs");
      const sibling = path.join(dir, "sibling.cjs");
      const originalPrep = path.join(
        repo,
        "scripts/prepare-extension-package-boundary-artifacts.mts",
      );
      const roles = {
        [path.join(repo, "scripts/run-oxlint.mjs")]: "lint-shim",
        [path.join(repo, "scripts/run-oxlint.mts")]: "lint-implementation",
        [path.join(repo, "scripts/run-tsgo.mjs")]: "compiler-shim",
        [path.join(repo, "scripts/run-tsgo.mts")]: "compiler-implementation",
        [prep]: "prepare",
        [compiler]: "compiler",
        [grandchild]: "grandchild",
        [sentinel]: "sentinel",
        [sibling]: "sibling",
      };
      fs.writeFileSync(
        preload,
        `
import cp from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
const role = ${JSON.stringify(roles)}[process.argv[1]];
if (role) {
  const socket = net.connect(${port}, '127.0.0.1');
  const send = message => socket.write(JSON.stringify(message) + '\\n');
  socket.on('connect', () => { send({kind:'hello',role,pid:process.pid,ppid:process.ppid}); socket.unref(); });
  socket.on('error', () => {});
  let data = '';
  let deadlineCallback;
  if (role === 'prepare') {
    const schedule = globalThis.setTimeout;
    globalThis.setTimeout = (callback, ms, ...args) => {
      if (ms === 300000) deadlineCallback = () => callback(...args);
      return schedule(callback, ms, ...args);
    };
  }
  socket.on('data', chunk => {
    data += chunk;
    while (data.includes('\\n')) {
      const index = data.indexOf('\\n');
      const command = data.slice(0,index); data = data.slice(index+1);
      if (command === 'cleanup') process.exit(137);
      if (command === 'fail') process.exit(2);
      if (command === 'signal') process.kill(process.pid, 'SIGTERM');
      if (command === 'timeout') deadlineCallback();
    }
  });
  const originalSpawn = cp.spawn;
  cp.spawn = (command, args, options) => {
    if (role === 'compiler-implementation') {
      command = process.execPath; args = [${JSON.stringify(compiler)}];
    } else if (args?.includes(${JSON.stringify(originalPrep)})) {
      args = args.map(arg => arg === ${JSON.stringify(originalPrep)} ? ${JSON.stringify(prep)} : arg);
    } else if (role === 'lint-implementation' && !args?.includes(${JSON.stringify(prep)})) {
      command = process.execPath; args = ['-e', 'console.log("FALSE_SUCCESS")'];
    }
    const child = originalSpawn(command, args, options);
    return child;
  };
  syncBuiltinESMExports();
}
`,
      );
      const hang = `for (const signal of ['SIGTERM','SIGHUP','SIGINT']) process.on(signal,()=>{});\nsetInterval(()=>{},1000);\nsetTimeout(()=>process.exit(99),45000).unref();\n`;
      fs.writeFileSync(grandchild, hang + 'console.log("grandchild holds stdout");\n');
      fs.writeFileSync(
        compiler,
        hang +
          `require('node:child_process').spawn(process.execPath,[${JSON.stringify(grandchild)}],{stdio:'inherit'});\n`,
      );
      fs.writeFileSync(sentinel, hang);
      fs.writeFileSync(sibling, hang);
      fs.writeFileSync(
        prep,
        `
import {runNodeStep,runNodeStepsInParallel} from ${JSON.stringify(pathToFileURL(originalPrep).href)};
try {
  ${
    mode === "abort"
      ? `await runNodeStepsInParallel([
    {label:'failing sibling',args:[${JSON.stringify(sibling)}],timeoutMs:60000},
    {label:'plugin-sdk boundary dts',args:[${JSON.stringify(path.join(repo, "scripts/run-tsgo.mjs"))},'-p','tsconfig.plugin-sdk.dts.json'],timeoutMs:60000}
  ]);`
      : `await runNodeStep('plugin-sdk boundary dts',[${JSON.stringify(path.join(repo, "scripts/run-tsgo.mjs"))},'-p','tsconfig.plugin-sdk.dts.json'],300000);`
  }
  console.log('FALSE_SUCCESS');
} catch(error) { console.error(error.message); process.exitCode=1; }
`,
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      };
      delete env.OPENCLAW_TSGO_TIMEOUT_MS;
      delete env.OPENCLAW_OXLINT_SKIP_PREPARE;
      const sentinelChild = spawn(process.execPath, [sentinel], {
        env,
        stdio: "ignore",
        detached: true,
      });
      const root = spawn(
        process.execPath,
        [
          path.join(repo, "scripts/run-oxlint.mjs"),
          "--tsconfig",
          "config/tsconfig/oxlint.extensions.json",
          "extensions",
        ],
        { env, stdio: ["ignore", "pipe", "pipe"], detached: true },
      );
      let output = "";
      let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      root.stdout.on("data", (data) => (output += data));
      root.stderr.on("data", (data) => (output += data));
      root.on("close", (code, signal) => {
        result = { code, signal };
      });
      try {
        const ready = await until(
          () =>
            [
              "grandchild",
              "compiler",
              "compiler-implementation",
              "compiler-shim",
              "prepare",
              "sentinel",
            ].every((role) => records.some((record) => record.role === role)),
          15000,
        );
        expect(ready, records.map((r) => r.role).join(",")).toBe(true);
        const target = records.find(
          (record) => record.role === (mode === "abort" ? "sibling" : "prepare"),
        );
        if (!target) throw new Error("Missing control target");
        target.socket.write(
          (mode === "abort" ? "fail" : mode === "signal" ? "signal" : "timeout") + "\n",
        );
        const completed = await until(
          () =>
            Boolean(result) && records.filter((r) => r.role !== "sentinel").every((r) => r.closed),
          4000,
        );
        expect(completed, output).toBe(true);
        expect(result).toEqual({ code: 1, signal: null });
        expect(output).toContain("[plugin-sdk boundary dts] grandchild holds stdout");
        expect(output.trim().split("\n").at(-1)).toBe("[oxlint] FAILED (exit 1)");
        expect(output).not.toContain("FALSE_SUCCESS");
        for (const record of records.filter((r) => r.role !== "sentinel"))
          await waitForDead(record.pid, 2000);
        expect(records.find((r) => r.role === "sentinel")?.closed).toBe(false);
        expect(sentinelChild.kill(0)).toBe(true);
      } finally {
        // Live private sockets identify these exact fixture instances; never signal saved PIDs.
        for (const record of records.filter(
          (r) => r.role === "grandchild" || r.role === "compiler",
        )) {
          if (!record.closed) record.socket.write("cleanup\n");
        }
        await until(
          () =>
            records
              .filter((r) => r.role === "grandchild" || r.role === "compiler")
              .every((r) => r.closed),
          2000,
        );
        for (const record of records) if (!record.closed) record.socket.write("cleanup\n");
        await until(() => records.every((r) => r.closed), 2000);
        if (root.exitCode === null && root.signalCode === null) root.kill("SIGKILL");
        if (sentinelChild.exitCode === null && sentinelChild.signalCode === null)
          sentinelChild.kill("SIGKILL");
        await until(() => result !== undefined, 2000);
        const cleanup = records.map(({ role, pid, closed }) => ({ role, pid, closed }));
        for (const record of records) record.socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        expect(
          cleanup.every((record) => record.closed),
          "fixture cleanup",
        ).toBe(true);
        for (const record of records) await waitForDead(record.pid, 2000);
      }
    },
    30000,
  );
});

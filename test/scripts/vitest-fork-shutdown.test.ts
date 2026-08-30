import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { isProcessAlive, waitForFile } from "../helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixture = fileURLToPath(new URL("../fixtures/vitest-fork-shutdown.mjs", import.meta.url));

it.each([
  { scenario: "slow-exit", setup: "shared", fail: false },
  { scenario: "slow-exit", setup: "env", fail: true },
  { scenario: "natural-exit", setup: "raw", fail: false },
  { scenario: "plain", setup: "shared", fail: false },
  { scenario: "threads", setup: "env", fail: false },
  { scenario: "vmForks", setup: "raw", fail: false },
  { scenario: "custom", setup: "raw", fail: false },
  { scenario: "custom-opt-in", setup: "raw", fail: false },
  { scenario: "hung-cleanup", setup: "shared", fail: false },
  { scenario: "hung-exit", setup: "shared", fail: false },
  { scenario: "bad-exit", setup: "shared", fail: false },
  { scenario: "forced", setup: "raw", fail: false },
])("joins $scenario shutdown with $setup setup (test failure: $fail)", async (options) => {
  const root = tempDirs.make("vitest-fork-shutdown-");
  const { stdout } = await execFileAsync(
    process.execPath,
    [fixture, root, JSON.stringify(options)],
    {
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout);
  const { scenario, setup, fail } = options;
  if (scenario === "forced") {
    // Node uses TerminateProcess for TERM on Windows; POSIX exercises escalation.
    expect(result.signal).toBe(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
    expect(result.stopped).toBe(true);
    return;
  }
  const brokenShutdown = scenario.startsWith("hung-") || scenario === "bad-exit";
  expect(result.code, result.output).toBe(fail || brokenShutdown ? 1 : 0);
  if (fail) {
    expect(result.output).toContain("intentional fixture failure");
  }
  expect(result.workerStopped).toBe(true);
  if (scenario === "threads") {
    expect(result.worker.threadId).toBeGreaterThan(0);
  } else {
    expect(result.worker.threadId).toBe(0);
  }
  if (setup !== "raw") {
    // Windows has no wrapper-owned group cleanup after a forced termination.
    // Its unfinished home remains inside this test's auto-cleaned fixture root.
    expect(result.homeRemoved).toBe(!(process.platform === "win32" && scenario === "hung-cleanup"));
  }
  expect(result.callerPreserved).toBe(true);
  if (scenario.startsWith("hung-")) {
    // Advance the real stop deadline only after the worker reaches the hung boundary.
    expect(result.events).toContainEqual({ event: "deadline", delay: 60_000 });
    expect(result.output).toContain("Timeout waiting for worker to respond");
    expect(result.events.some((event: { event: string }) => event.event === "terminate")).toBe(
      true,
    );
  } else if (scenario === "bad-exit") {
    expect(result.output).toContain("Worker exited during graceful shutdown");
  } else if (scenario === "custom") {
    expect(result.output).toContain("1 passed");
    expect(result.events).toContainEqual({ event: "stopped-consumed" });
    expect(result.events).toContainEqual({ event: "parent-stop" });
    expect(result.events.some((event: { event: string }) => event.event === "deadline")).toBe(
      false,
    );
    expect(result.events).toContainEqual({ event: "terminate", signal: "SIGTERM" });
  } else if (scenario !== "plain") {
    expect(result.profiles.cpu, result.output).toBeGreaterThan(0);
    expect(result.profiles.heap, result.output).toBeGreaterThan(0);
    expect(result.events.some((event: { event: string }) => event.event === "terminate")).toBe(
      false,
    );
    if (scenario === "slow-exit") {
      expect(result.events).toContainEqual({ event: "home-removed" });
    }
  }
});

// Windows termination cannot invoke the fixture's POSIX signal handlers.
it.skipIf(process.platform === "win32").each([
  { signal: "SIGINT", code: 130 },
  { signal: "SIGTERM", code: 143 },
] as const)("rejects forwarded $signal after joining fixture cleanup", async ({ signal, code }) => {
  const root = tempDirs.make("vitest-fork-shutdown-");
  const invocation = execFileAsync(
    process.execPath,
    [fixture, root, JSON.stringify({ scenario: "interrupted", setup: "shared", fail: false })],
    { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
  );
  // Handle early rejection while waiting for readiness; join before afterEach removes the root.
  const settled = invocation.then(
    () => undefined,
    () => undefined,
  );
  try {
    await waitForFile(path.join(root, "ready"), 10_000);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, "receipt.json"), "utf8"));
    expect(isProcessAlive(receipt.pid)).toBe(true);
    expect(fs.existsSync(receipt.home)).toBe(true);
    expect(fs.readdirSync(path.join(root, "tmp"))).not.toEqual([]);

    expect(invocation.child.kill(signal)).toBe(true);
    await expect(invocation).rejects.toMatchObject({ code, killed: true, signal: null });
    const { stdout } = await invocation.catch((error: { stdout: string }) => error);
    expect(stdout).not.toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      worker: { pid: receipt.pid },
      workerStopped: true,
      homeRemoved: true,
      callerPreserved: true,
    });

    expect(isProcessAlive(receipt.pid)).toBe(false);
    expect(fs.existsSync(receipt.home)).toBe(false);
    expect(fs.readdirSync(path.join(root, "tmp"))).toEqual([]);
    expect(fs.readFileSync(path.join(root, "home", "caller"), "utf8")).toBe("keep");
  } finally {
    if (invocation.child.exitCode === null && invocation.child.signalCode === null) {
      invocation.child.kill("SIGTERM");
    }
    await settled;
  }
});

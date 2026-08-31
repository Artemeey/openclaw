import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  statSync,
  type ReadStream,
  type WriteStream,
} from "node:fs";
import { createServer, type Server } from "node:http";
import {
  createConnection as createNetConnection,
  createServer as createNetServer,
  type Socket,
} from "node:net";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "../../windows-cmd-helpers.mjs";
import { toStringifiedError } from "../error-format.mts";
import { terminateManagedChild } from "../managed-child-process.mts";
import { resolveWindowsTaskkillPath } from "../windows-taskkill.mjs";
import type {
  Cleanup,
  CommandInvocation,
  CommandOptions,
  CommandResult,
  GatewayHandle,
  LaneState,
} from "./config.ts";
import {
  CROSS_OS_COMMAND_CAPTURE_TAIL_BYTES,
  CROSS_OS_COMMAND_HEARTBEAT_SECONDS,
  CROSS_OS_DASHBOARD_SMOKE_TIMEOUT_MS,
  CROSS_OS_PROCESS_TREE_KILL_AFTER_MS,
} from "./config.ts";
import { readLogTextSince } from "./logs.ts";
import { formatError, sleep, toLintErrorObject, trimForSummary } from "./shared.ts";

const CROSS_OS_SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};
const CROSS_OS_ACTIVE_CHILD_TREE_KILLERS = new Set<(signal: NodeJS.Signals) => void>();
const STARTUP_MIGRATION_RESTART_PREFIX =
  "OpenClaw plugin migration inputs changed during startup convergence;";
let forwardedSignalExitCode: number | undefined;
let forwardedSignalForceKillTimer: NodeJS.Timeout | undefined;

for (const signal of Object.keys(CROSS_OS_SIGNAL_EXIT_CODES) as NodeJS.Signals[]) {
  process.on(signal, () => {
    forwardedSignalExitCode ??= CROSS_OS_SIGNAL_EXIT_CODES[signal];
    if (forwardedSignalExitCode === undefined) {
      return;
    }
    if (CROSS_OS_ACTIVE_CHILD_TREE_KILLERS.size === 0) {
      process.exit(forwardedSignalExitCode);
    }
    const activeKillers = Array.from(CROSS_OS_ACTIVE_CHILD_TREE_KILLERS);
    for (const killChildTree of activeKillers) {
      killChildTree(signal);
    }
    forwardedSignalForceKillTimer ??= setTimeout(() => {
      for (const killChildTree of activeKillers) {
        killChildTree("SIGKILL");
      }
      process.exit(forwardedSignalExitCode);
    }, CROSS_OS_PROCESS_TREE_KILL_AFTER_MS);
  });
}

function exitForwardedSignalWhenChildTreesDone() {
  if (forwardedSignalExitCode === undefined || CROSS_OS_ACTIVE_CHILD_TREE_KILLERS.size > 0) {
    return;
  }
  if (forwardedSignalForceKillTimer) {
    clearTimeout(forwardedSignalForceKillTimer);
    forwardedSignalForceKillTimer = undefined;
  }
  process.exit(forwardedSignalExitCode);
}

export function resolveCommandSpawnInvocation(
  command: string,
  args: string[],
  options: { platform?: NodeJS.Platform; comSpec?: string; env?: NodeJS.ProcessEnv } = {
    platform: process.platform,
  },
) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && /\.(cmd|bat)$/iu.test(command)) {
    return {
      command: options.comSpec ?? resolveWindowsCmdExePath(options.env ?? process.env),
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(command, args)],
      shell: false,
      windowsVerbatimArguments: true,
    };
  }
  return { command, args, shell: false };
}

export async function canConnectToLoopbackPort(port: number, timeoutMs = 1_000) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return false;
  }
  return await new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const socket = createNetConnection({
      host: "127.0.0.1",
      port,
    });
    const settle = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

export function hasChildExited(child: ChildProcess) {
  return child.exitCode !== null || (child.signalCode ?? null) !== null;
}

export async function waitForGatewayWithStartupMigrationRestart(params: {
  gatewayHolder: { current: GatewayHandle | null };
  restartGateway: () => Promise<GatewayHandle>;
  waitUntilReady: (gateway: GatewayHandle) => Promise<void>;
}) {
  let gateway = params.gatewayHolder.current;
  if (!gateway) {
    throw new Error("Gateway restart coordination requires an active gateway handle.");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await params.waitUntilReady(gateway);
      return;
    } catch (error) {
      if (!hasChildExited(gateway.child)) {
        throw error;
      }
      await gateway.waitForClose();
      await gateway.closeLog();
      const startupLog = readLogTextSince(gateway.logPath, gateway.launchLogOffset);
      if (attempt > 0 || !startupLog.includes(STARTUP_MIGRATION_RESTART_PREFIX)) {
        throw error;
      }
      gateway = await params.restartGateway();
      params.gatewayHolder.current = gateway;
    }
  }
}

export async function stopGateway(gateway: GatewayHandle | null) {
  try {
    if (!gateway?.child?.pid) {
      return;
    }
    if (process.platform === "win32") {
      await runCommand(
        resolveWindowsTaskkillPath(),
        ["/PID", String(gateway.child.pid), "/T", "/F"],
        {
          logPath: gateway.logPath,
          check: false,
          timeoutMs: 30_000,
        },
      );
      const exited = await waitForChildExit(gateway.child, 10_000);
      if (!exited) {
        gateway.child.stdout?.destroy();
        gateway.child.stderr?.destroy();
      }
      return;
    }
    if (hasChildExited(gateway.child)) {
      signalChildProcessTree(gateway.child, "SIGTERM");
      await sleep(2_000);
      signalChildProcessTree(gateway.child, "SIGKILL");
      return;
    }
    signalChildProcessTree(gateway.child, "SIGTERM");
    const exitedAfterTerm = await waitForChildExit(gateway.child, 2_000);
    if (!exitedAfterTerm && !hasChildExited(gateway.child)) {
      signalChildProcessTree(gateway.child, "SIGKILL");
      await waitForChildExit(gateway.child, 5_000);
    }
  } finally {
    await gateway?.closeLog?.();
  }
}

function signalChildProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  terminateManagedChild(child, signal, {
    onChildSignalError(error) {
      throw error;
    },
    useWindowsTaskkill: false,
  });
}

export function registerActiveChildProcessTree(child: ChildProcess) {
  const killChildTree = (signal: NodeJS.Signals) => signalChildProcessTree(child, signal);
  CROSS_OS_ACTIVE_CHILD_TREE_KILLERS.add(killChildTree);
  return {
    killChildTree,
    unregister: () => {
      CROSS_OS_ACTIVE_CHILD_TREE_KILLERS.delete(killChildTree);
    },
  };
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number) {
  if (hasChildExited(child)) {
    return true;
  }
  return new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (didExit: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      child.off("exit", onExit);
      child.off("close", onClose);
      child.off("error", onError);
      resolvePromise(didExit);
    };
    const onExit = () => finish(true);
    const onClose = () => finish(true);
    const onError = () => finish(true);
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            finish(false);
          }, timeoutMs)
        : null;

    child.once("exit", onExit);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

export async function runCleanup(cleanupFns: Cleanup[]) {
  for (const cleanupFn of cleanupFns.toReversed()) {
    try {
      await cleanupFn();
    } catch {
      // Ignore cleanup failures so the main failure surface stays visible.
    }
  }
}

function resolveCommandCaptureLimit(options: CommandOptions) {
  const value = options.maxOutputBytes;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return CROSS_OS_COMMAND_CAPTURE_TAIL_BYTES;
  }
  return Math.max(1, Math.floor(value));
}

function decodeBoundedUtf8Tail(buffer: Buffer, maxBytes: number): string {
  const tail = buffer.subarray(Math.max(0, buffer.byteLength - maxBytes));
  let start = 0;
  while (start < tail.byteLength) {
    const byte = tail[start];
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    start += 1;
  }
  return tail.subarray(start).toString("utf8");
}

function appendBoundedCommandOutput(current: string, chunk: Uint8Array | string, maxBytes: number) {
  const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (chunkBuffer.byteLength >= maxBytes) {
    return decodeBoundedUtf8Tail(chunkBuffer, maxBytes);
  }

  const currentBuffer = Buffer.from(current);
  const nextBytes = currentBuffer.byteLength + chunkBuffer.byteLength;
  if (nextBytes <= maxBytes) {
    return `${current}${chunkBuffer.toString("utf8")}`;
  }

  const currentTailBytes = maxBytes - chunkBuffer.byteLength;
  const currentTail = currentBuffer.subarray(currentBuffer.byteLength - currentTailBytes);
  return decodeBoundedUtf8Tail(Buffer.concat([currentTail, chunkBuffer]), maxBytes);
}

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const invocation = resolveCommandSpawnInvocation(command, args, {
    env: options.env,
    platform: process.platform,
  });
  return runCommandInvocation(invocation, options);
}

export async function runCommandInvocation(
  invocation: CommandInvocation,
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolvePromise, rejectPromise) => {
    const commandLabel = `${invocation.command} ${invocation.args.join(" ")}`;
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      shell: invocation.shell,
      stdio: ["ignore", "pipe", "pipe"],
      detached: useProcessGroup,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      windowsHide: true,
    });
    const activeChildTree = registerActiveChildProcessTree(child);
    const logStream = createWriteStream(options.logPath, { flags: "a" });
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const startedAt = Date.now();
    let killWaitTimer: NodeJS.Timeout | null = null;
    let timer: NodeJS.Timeout | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    const maxCapturedOutputBytes = resolveCommandCaptureLimit(options);

    const clearTimers = () => {
      if (timer) {
        clearTimeout(timer);
      }
      if (killWaitTimer) {
        clearTimeout(killWaitTimer);
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
    };

    const finishLogStream = (callback: (error?: Error | null) => void) => {
      let completed = false;
      const finish = (error?: Error | null) => {
        if (completed) {
          return;
        }
        completed = true;
        callback(error);
      };
      logStream.once("finish", finish);
      logStream.once("error", finish);
      logStream.end();
    };

    const finalize = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      finishLogStream((logError) => {
        if (logError) {
          rejectPromise(new Error(`Command log write failed: ${formatError(logError)}`));
          return;
        }
        callback();
      });
    };

    const requestKill = () => {
      if (process.platform === "win32" && child.pid) {
        try {
          const killer = spawn(
            resolveWindowsTaskkillPath(),
            ["/PID", String(child.pid), "/T", "/F"],
            {
              stdio: "ignore",
              windowsHide: true,
            },
          );
          killer.on("error", () => {
            child.kill();
          });
          return;
        } catch {
          child.kill();
          return;
        }
      }
      activeChildTree.killChildTree("SIGKILL");
    };

    timer =
      options.timeoutMs && Number.isFinite(options.timeoutMs)
        ? setTimeout(() => {
            timedOut = true;
            logStream.write(`${new Date().toISOString()} timeout command=${commandLabel}\n`);
            requestKill();
            killWaitTimer = setTimeout(() => {
              finalize(() => {
                rejectPromise(
                  new Error(
                    `Command timed out and could not be terminated cleanly: ${commandLabel}`,
                  ),
                );
              });
            }, 15_000);
          }, options.timeoutMs)
        : null;
    heartbeatTimer =
      CROSS_OS_COMMAND_HEARTBEAT_SECONDS > 0
        ? setInterval(() => {
            const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
            const message = `${new Date().toISOString()} still running after ${elapsedSeconds}s: ${commandLabel}\n`;
            logStream.write(message);
            process.stdout.write(`[release-checks] ${message}`);
          }, CROSS_OS_COMMAND_HEARTBEAT_SECONDS * 1000)
        : null;
    heartbeatTimer?.unref?.();

    logStream.write(`${new Date().toISOString()} start command=${commandLabel}\n`);

    child.stdout?.on("data", (chunk) => {
      stdout = appendBoundedCommandOutput(
        stdout,
        stdoutDecoder.write(chunk),
        maxCapturedOutputBytes,
      );
      logStream.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBoundedCommandOutput(
        stderr,
        stderrDecoder.write(chunk),
        maxCapturedOutputBytes,
      );
      logStream.write(chunk);
    });

    child.on("error", (error) => {
      if (forwardedSignalExitCode !== undefined) {
        activeChildTree.killChildTree("SIGKILL");
      }
      activeChildTree.unregister();
      finalize(() => rejectPromise(error));
    });

    child.on("close", (exitCode) => {
      if (forwardedSignalExitCode !== undefined) {
        // The leader can exit on SIGTERM while descendants remain in its group.
        // Kill the group before unregistering so signal forwarding cannot leave them running.
        activeChildTree.killChildTree("SIGKILL");
        activeChildTree.unregister();
        finalize(exitForwardedSignalWhenChildTreesDone);
        return;
      }
      activeChildTree.unregister();
      stdout = appendBoundedCommandOutput(stdout, stdoutDecoder.end(), maxCapturedOutputBytes);
      stderr = appendBoundedCommandOutput(stderr, stderrDecoder.end(), maxCapturedOutputBytes);
      finalize(() => {
        const result = {
          exitCode: exitCode ?? 1,
          stdout,
          stderr,
        };
        if (timedOut) {
          rejectPromise(new Error(`Command timed out: ${commandLabel}`));
          return;
        }
        if ((options.check ?? true) && result.exitCode !== 0) {
          rejectPromise(
            new Error(
              `Command failed (${result.exitCode}): ${commandLabel}\n${trimForSummary(
                `${stdout}\n${stderr}`,
              )}`,
            ),
          );
          return;
        }
        resolvePromise(result);
      });
    });
  });
}

export async function startStaticFileServer(params: {
  filePath: string;
  logPath: string;
}): Promise<{ url: string; close: () => Promise<void> }> {
  mkdirSync(dirname(params.logPath), { recursive: true });
  const logStream = createWriteStream(params.logPath, { flags: "a" });
  let logStreamError: Error | null = null;
  logStream.on("error", (error) => {
    logStreamError ??= error;
  });
  const fileName = params.filePath.split(/[/\\]/u).at(-1) ?? "artifact";
  const fileStat = statSync(params.filePath);
  const sockets = new Set<Socket>();
  let nextRequestId = 0;
  const server = createServer((request, response) => {
    const requestId = ++nextRequestId;
    const startedAt = Date.now();
    let fileStream: ReadStream | undefined;
    // Diagnostic-only: retain closed counters, never caller-controlled request data.
    const recordTransfer = (
      event: "request-start" | "response-finish" | "response-close" | "read-error",
    ) => {
      if (requestId > 32 || logStream.writableEnded) {
        return;
      }
      const record = {
        requestId,
        event,
        elapsedMs: Date.now() - startedAt,
        statusCode: response.statusCode,
        expectedBytes: fileStream ? fileStat.size : 0,
        bytesRead: fileStream?.bytesRead ?? 0,
        finished: response.writableFinished,
      };
      const line = `${new Date().toISOString()} transfer ${JSON.stringify(record)}\n`;
      logStream.write(line);
      process.stdout.write(`[release-checks] ${line}`);
    };
    response.once("finish", () => recordTransfer("response-finish"));
    response.once("close", () => recordTransfer("response-close"));
    response.setHeader("connection", "close");
    if (request.url !== `/${fileName}`) {
      response.statusCode = 404;
      recordTransfer("request-start");
      response.end("not found");
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", resolveStaticFileContentType(params.filePath));
    response.setHeader("content-length", String(fileStat.size));
    fileStream = createReadStream(params.filePath);
    recordTransfer("request-start");
    fileStream.once("error", (error) => {
      recordTransfer("read-error");
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      response.removeHeader("content-length");
      response.statusCode = 500;
      response.end("failed to read file");
    });
    fileStream.pipe(response);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind static file server.");
  }
  const port = address.port;
  let closePromise: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}/${fileName}`,
    close: () => {
      closePromise ??= new Promise<void>((resolvePromise, rejectPromise) => {
        closeStaticFileServerConnections(server, sockets);
        server.close((error) => {
          void (async () => {
            const closeLogError = await finishStaticFileServerLog(logStream, logStreamError).catch(
              (logError: unknown): Error => toStringifiedError(logError),
            );
            if (error) {
              rejectPromise(error);
              return;
            }
            if (closeLogError) {
              rejectPromise(
                closeLogError instanceof Error
                  ? closeLogError
                  : new Error(formatError(closeLogError)),
              );
              return;
            }
            resolvePromise();
          })();
        });
        closeStaticFileServerConnections(server, sockets);
      });
      return closePromise;
    },
  };
}

export async function verifyStaticFileTransfer(params: {
  filePath: string;
  url: string;
  logPath: string;
}): Promise<{ bytes: number; sha256: string }> {
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(CROSS_OS_DASHBOARD_SMOKE_TIMEOUT_MS);
  let expectedBytes = 0;
  let bytes = 0;
  let reason = "transfer-error";
  const record = (status: "pass" | "fail") => {
    const entry = {
      status,
      reason: status === "pass" ? "verified" : reason,
      expectedBytes,
      bytes,
      elapsedMs: Date.now() - startedAt,
    };
    const line = `${JSON.stringify(entry)}\n`;
    try {
      appendFileSync(params.logPath, line);
    } catch {
      process.stdout.write(
        `[release-checks] candidate-transfer-probe ${JSON.stringify({
          ...entry,
          status: "fail",
          reason: "log-write-error",
          transferReason: entry.reason,
        })}\n`,
      );
      throw new Error("candidate transfer diagnostic log write failed");
    }
    process.stdout.write(`[release-checks] candidate-transfer-probe ${line}`);
  };
  let sha256 = "";
  try {
    const expectedHash = createHash("sha256");
    for await (const chunk of createReadStream(params.filePath, { signal })) {
      expectedBytes += chunk.length;
      expectedHash.update(chunk);
    }
    const expectedSha256 = expectedHash.digest("hex");
    const response = await fetch(params.url, { signal });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      reason = "http-status";
      throw new Error("candidate transfer HTTP status mismatch");
    }
    const hash = createHash("sha256");
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > expectedBytes) {
        reason = "size-mismatch";
        await reader.cancel();
        throw new Error("candidate transfer size mismatch");
      }
      hash.update(value);
    }
    sha256 = hash.digest("hex");
    if (bytes !== expectedBytes || sha256 !== expectedSha256) {
      reason = bytes !== expectedBytes ? "size-mismatch" : "digest-mismatch";
      throw new Error("candidate transfer digest mismatch");
    }
  } catch {
    reason = signal.aborted ? "timeout" : reason;
    record("fail");
    throw new Error(`candidate transfer ${reason.replaceAll("-", " ")}`);
  }
  record("pass");
  return { bytes, sha256 };
}

function closeStaticFileServerConnections(server: Server, sockets: Set<Socket>) {
  for (const socket of sockets) {
    socket.destroy();
  }
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
}

function finishStaticFileServerLog(logStream: WriteStream, pendingError: Error | null) {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    if (pendingError) {
      logStream.destroy();
      rejectPromise(new Error(`Static file server log write failed: ${formatError(pendingError)}`));
      return;
    }
    let completed = false;
    const finish = () => {
      if (completed) {
        return;
      }
      completed = true;
      resolvePromise();
    };
    const fail = (error: unknown) => {
      if (completed) {
        return;
      }
      completed = true;
      rejectPromise(new Error(`Static file server log write failed: ${formatError(error)}`));
    };
    logStream.once("finish", finish);
    logStream.once("error", fail);
    logStream.end();
  });
}

export function resolveStaticFileContentType(filePath: string) {
  if (filePath.endsWith(".sh") || filePath.endsWith(".ps1")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

export async function withAllocatedGatewayPort<T>(lane: LaneState, callback: () => Promise<T>) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const reservation = await reservePort();
    lane.gatewayPort = reservation.port;
    await reservation.release();
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      if (!isAddressInUseError(error) || attempt === 3) {
        throw error;
      }
      await sleep(250 * attempt);
    }
  }
  throw toLintErrorObject(
    lastError ?? new Error("Failed to allocate a gateway port."),
    "Non-Error thrown",
  );
}

export async function reserveGatewayPortForLane(lane: LaneState) {
  const reservation = await reservePort();
  lane.gatewayPort = reservation.port;
  let released = false;
  return {
    port: reservation.port,
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      await reservation.release();
    },
  };
}

function reservePort(): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPromise(new Error("Failed to allocate a TCP port."));
        return;
      }
      resolvePromise({
        port: address.port,
        release: () =>
          new Promise<void>((releaseResolve, releaseReject) => {
            server.close((error) => {
              if (error) {
                releaseReject(error);
                return;
              }
              releaseResolve();
            });
          }),
      });
    });
    server.once("error", rejectPromise);
  });
}

function isAddressInUseError(error: unknown) {
  const message = formatError(error);
  return message.includes("EADDRINUSE") || /address.+in use/iu.test(message);
}

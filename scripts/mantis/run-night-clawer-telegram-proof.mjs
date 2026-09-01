import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTelegramTestApiProxy } from "../../.agents/skills/telegram-e2e-userbot/scripts/telegram-test-api-proxy.mjs";
import { acquireTelegramTestCredential } from "../../.agents/skills/telegram-e2e-userbot/scripts/telegram-test-credential.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const CAPABILITY_SCHEMA = "openclaw.mantis.telegram-capability.v1";

/**
 * @typedef {{
 *   controllerGid: number,
 *   controllerRoot: string,
 *   controllerSha: string,
 *   controllerUid: number,
 *   openclawSha: string,
 *   output: string,
 * }} TelegramProofParams
 * @typedef {{
 *   controller: string,
 *   controllerLauncher: string,
 *   controllerRoot: string,
 *   openclawBin: string,
 *   userDriver: string,
 * }} TrustedSources
 * @typedef {{
 *   groupId: string,
 *   stateRoot: string,
 *   sutBotId: string,
 *   sutToken: string,
 *   sutUsername: string,
 *   testerUserId: string,
 *   userDriverDir: string,
 *   assertLeaseHealthy: () => void,
 *   whenLeaseUnhealthy: Promise<unknown>,
 *   release: () => Promise<void>,
 * }} TelegramProofCredential
 * @typedef {{
 *   apiRoot: string,
 *   close: () => Promise<void>,
 *   drainUpdates: (token: string) => Promise<void>,
 * }} TelegramProofProxy
 * @typedef {{ code: number | null, signal: string | null }} ControllerResult
 * @typedef {{
 *   acquireCredential: () => Promise<TelegramProofCredential>,
 *   runController: (input: {
 *     abortPromise: Promise<string>,
 *     capabilityPath: string,
 *     params: TelegramProofParams,
 *     runtimeRoot: string,
 *     sources: TrustedSources,
 *   }) => Promise<ControllerResult>,
 *   startProxy: (input: {
 *     leaseHealth: {
 *       assertHealthy: () => void,
 *       whenUnhealthy: Promise<unknown>,
 *     },
 *   }) => Promise<TelegramProofProxy>,
 *   verifySources: (params: TelegramProofParams) => TrustedSources,
 * }} TelegramProofDependencies
 */

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: sanitizedChildEnvironment(),
    maxBuffer: 1024 * 1024,
  });
  requireCondition(result.status === 0, "trusted source verification failed");
  return result.stdout.trim();
}

export function sanitizedChildEnvironment(env = process.env) {
  const allowed = new Set([
    "HOME",
    "LANG",
    "LC_ALL",
    "NODE_EXTRA_CA_CERTS",
    "PATH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "TMPDIR",
  ]);
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => allowed.has(key) && value !== undefined),
  );
}

function verifyRegularFile(root, relativePath) {
  const candidate = fs.realpathSync(path.join(root, relativePath));
  requireCondition(candidate.startsWith(`${root}${path.sep}`), "trusted source path escaped root");
  const info = fs.lstatSync(candidate);
  requireCondition(info.isFile() && !info.isSymbolicLink(), "trusted source file is invalid");
  return candidate;
}

export function verifyTrustedSources({ controllerRoot, controllerSha, openclawSha }) {
  requireCondition(/^[a-f0-9]{40}$/u.test(controllerSha), "controller SHA is invalid");
  requireCondition(/^[a-f0-9]{40}$/u.test(openclawSha), "OpenClaw SHA is invalid");
  const resolvedControllerRoot = fs.realpathSync(controllerRoot);
  requireCondition(
    git(resolvedControllerRoot, ["rev-parse", "HEAD"]) === controllerSha,
    "controller SHA differs",
  );
  requireCondition(
    git(resolvedControllerRoot, ["status", "--porcelain", "--untracked-files=no"]) === "",
    "controller checkout is dirty",
  );
  requireCondition(git(REPO_ROOT, ["rev-parse", "HEAD"]) === openclawSha, "OpenClaw SHA differs");
  requireCondition(
    git(REPO_ROOT, ["status", "--porcelain", "--untracked-files=no"]) === "",
    "OpenClaw checkout is dirty",
  );
  return {
    controller: verifyRegularFile(
      resolvedControllerRoot,
      "suite/proposed-h3/mantis-controller.mjs",
    ),
    controllerLauncher: verifyRegularFile(
      REPO_ROOT,
      "scripts/mantis/run-isolated-night-clawer-controller.sh",
    ),
    controllerRoot: resolvedControllerRoot,
    openclawBin: verifyRegularFile(REPO_ROOT, "openclaw.mjs"),
    userDriver: verifyRegularFile(
      REPO_ROOT,
      ".agents/skills/telegram-e2e-userbot/scripts/user-driver.py",
    ),
  };
}

/** @param {TelegramProofCredential} credential @param {string} apiRoot */
export function buildScopedCapability(credential, apiRoot) {
  return {
    schema: CAPABILITY_SCHEMA,
    apiRoot,
    groupId: credential.groupId,
    stateRoot: credential.stateRoot,
    sutBotId: credential.sutBotId,
    sutToken: credential.sutToken,
    sutUsername: credential.sutUsername,
    testerUserId: credential.testerUserId,
    userDriverDir: credential.userDriverDir,
  };
}

function writePrivate(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, value, { mode: 0o640 });
  fs.chmodSync(filePath, 0o640);
}

async function stopProcess(child) {
  if (!child?.pid) {
    return;
  }
  const groupAlive = () => {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!groupAlive()) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  const deadline = Date.now() + 20_000;
  while (groupAlive() && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  if (groupAlive()) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

async function runController({ abortPromise, capabilityPath, params, runtimeRoot, sources }) {
  const controllerOutput = path.join(runtimeRoot, "controller-result.json");
  const child = spawn(
    "sudo",
    [
      "--non-interactive",
      sources.controllerLauncher,
      "--launch",
      String(params.controllerUid),
      String(params.controllerGid),
      String(process.pid),
      runtimeRoot,
      sources.controllerRoot,
      "--",
      process.execPath,
      sources.controller,
      "--capability",
      capabilityPath,
      "--night-clawer-sha",
      params.controllerSha,
      "--openclaw-bin",
      sources.openclawBin,
      "--openclaw-sha",
      params.openclawSha,
      "--output",
      controllerOutput,
      "--user-driver",
      sources.userDriver,
    ],
    {
      cwd: sources.controllerRoot,
      detached: true,
      env: sanitizedChildEnvironment(),
      stdio: "ignore",
    },
  );
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    const result = await Promise.race([
      exited,
      abortPromise.then((reason) => {
        throw new Error(reason);
      }),
    ]);
    if (result.code === 0 && result.signal === null) {
      const outputInfo = fs.lstatSync(controllerOutput);
      requireCondition(
        outputInfo.isFile() && !outputInfo.isSymbolicLink() && outputInfo.size <= 2 * 1024 * 1024,
        "Night Clawer controller output is invalid",
      );
      const outputValue = fs.readFileSync(controllerOutput);
      fs.mkdirSync(path.dirname(params.output), { recursive: true, mode: 0o700 });
      fs.writeFileSync(params.output, outputValue, { mode: 0o600 });
      fs.chmodSync(params.output, 0o600);
    }
    return result;
  } finally {
    await stopProcess(child);
    await exited.catch(() => undefined);
  }
}

/**
 * @param {TelegramProofParams} params
 * @param {TelegramProofDependencies} dependencies
 */
export async function runNightClawerTelegramProof(
  params,
  dependencies = {
    acquireCredential: acquireTelegramTestCredential,
    runController,
    startProxy: startTelegramTestApiProxy,
    verifySources: verifyTrustedSources,
  },
) {
  requireCondition(Number.isSafeInteger(params.controllerUid), "controller UID is invalid");
  requireCondition(Number.isSafeInteger(params.controllerGid), "controller GID is invalid");
  requireCondition(params.controllerUid > 0, "controller UID is invalid");
  requireCondition(params.controllerGid >= 0, "controller GID is invalid");
  requireCondition(params.controllerUid !== process.getuid?.(), "controller UID is not isolated");
  requireCondition(params.controllerGid === process.getgid?.(), "controller GID is invalid");
  // Source and ownership checks must finish before the first broker call.
  const sources = dependencies.verifySources(params);
  let credential;
  let credentialPromise;
  let proxy;
  let cleanupError;
  let operationError;
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-mantis-night-clawer-"));
  fs.chmodSync(runtimeRoot, 0o770);
  for (const directory of ["home", "tmp"]) {
    const directoryPath = path.join(runtimeRoot, directory);
    fs.mkdirSync(directoryPath, { mode: 0o770 });
    fs.chmodSync(directoryPath, 0o770);
  }
  const capabilityPath = path.join(runtimeRoot, "telegram-capability.json");
  let resolveShutdown;
  const shutdown = new Promise((resolve) => {
    resolveShutdown = resolve;
  });
  const requestShutdown = () => resolveShutdown("workflow interrupted");
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  try {
    credentialPromise = dependencies.acquireCredential();
    credential = await Promise.race([
      credentialPromise,
      shutdown.then((reason) => {
        throw new Error(reason);
      }),
    ]);
    credential.assertLeaseHealthy();
    proxy = await dependencies.startProxy({
      leaseHealth: {
        assertHealthy: credential.assertLeaseHealthy,
        whenUnhealthy: credential.whenLeaseUnhealthy,
      },
    });
    await proxy.drainUpdates(credential.sutToken);
    writePrivate(
      capabilityPath,
      `${JSON.stringify(buildScopedCapability(credential, proxy.apiRoot))}\n`,
    );
    const abortPromise = Promise.race([
      credential.whenLeaseUnhealthy.then(() => "credential lease lost"),
      shutdown,
    ]);
    const result = await dependencies.runController({
      abortPromise,
      capabilityPath,
      params,
      runtimeRoot,
      sources,
    });
    requireCondition(result.code === 0 && result.signal === null, "Night Clawer controller failed");
  } catch (error) {
    operationError = error instanceof Error ? error : new Error("Telegram proof failed");
  } finally {
    process.off("SIGINT", requestShutdown);
    process.off("SIGTERM", requestShutdown);
    if (!credential && credentialPromise) {
      credential = await credentialPromise.catch(() => undefined);
    }
    try {
      await proxy?.close();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await credential?.release();
    } catch (error) {
      cleanupError = cleanupError ? new AggregateError([cleanupError, error]) : error;
    }
    try {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupError = cleanupError ? new AggregateError([cleanupError, error]) : error;
    }
  }
  if (operationError && cleanupError) {
    throw new AggregateError([operationError, cleanupError], "Telegram proof and cleanup failed");
  }
  if (cleanupError) {
    throw cleanupError instanceof Error ? cleanupError : new Error("Telegram cleanup failed");
  }
  if (operationError) {
    throw operationError;
  }
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    requireCondition(key?.startsWith("--") && value && !values.has(key), "invalid arguments");
    values.set(key, value);
  }
  const required = [
    "--controller-gid",
    "--controller-root",
    "--controller-sha",
    "--controller-uid",
    "--openclaw-sha",
    "--output",
  ];
  requireCondition(
    values.size === required.length && required.every((key) => values.has(key)),
    "invalid arguments",
  );
  return {
    controllerGid: Number(values.get("--controller-gid")),
    controllerRoot: values.get("--controller-root"),
    controllerSha: values.get("--controller-sha"),
    controllerUid: Number(values.get("--controller-uid")),
    openclawSha: values.get("--openclaw-sha"),
    output: values.get("--output"),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await runNightClawerTelegramProof(parseArgs(process.argv.slice(2)));
}

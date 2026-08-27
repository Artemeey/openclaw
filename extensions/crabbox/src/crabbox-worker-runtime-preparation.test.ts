import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCrabboxRuntimePreparation,
  shellQuote,
} from "./crabbox-worker-runtime-preparation.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtime = { openclawVersion: "2026.8.1", packageSpecs: ["openclaw@2026.8.1"] };
const leaseId = "cbx_test";
const preparation = createCrabboxRuntimePreparation({ runtime, leaseId });

// Exercise the real POSIX script and npm config loader; downloads/package materialization
// are fixtures. No registry request, cloud provider, enrollment credential, or daemon is used.
describe.skipIf(process.platform === "win32")("worker runtime preparation", () => {
  async function fixture(materializePackage = true) {
    const dir = tempDirs.make("crabbox-runtime-");
    const bin = path.join(dir, "bin");
    const npmCommand = await execFileAsync("/bin/sh", ["-c", "command -v npm"], {
      env: { PATH: process.env.PATH },
    });
    const npmCli = await realpath(npmCommand.stdout.trim());
    const globalConfig = path.join(dir, "ambient-global.npmrc");
    await writeFile(path.join(dir, ".npmrc"), "registry=https://user.example.invalid/\n");
    await writeFile(globalConfig, "registry=https://global.example.invalid/\n");
    await mkdir(bin);
    const executable = async (name: string, body: string) => {
      const file = path.join(bin, name);
      await writeFile(file, `#!/bin/sh\nset -eu\n${body}\n`);
      await chmod(file, 0o700);
    };
    await executable("node", "exit 0");
    await executable(
      "npm",
      [
        'printf "%s\\n" "$*" >>"$HOME/npm-calls"',
        '[ "$1" = install ] && [ "$2" = --prefix ]',
        'printf "%s\\n" "$NPM_CONFIG_GLOBALCONFIG" >"$HOME/npm-global-config-path"',
        `${shellQuote(process.execPath)} ${shellQuote(npmCli)} config get registry >"$HOME/npm-config-output" 2>"$HOME/npm-config-error"`,
        '[ ! -s "$NPM_CONFIG_GLOBALCONFIG" ]',
        `${shellQuote(process.execPath)} -e 'const fs=require("node:fs");if((fs.statSync(process.env.NPM_CONFIG_GLOBALCONFIG).mode&0o777)!==0o600)process.exit(1)'`,
        ...(materializePackage ? [] : ["exit 0"]),
        'mkdir -p "$3/node_modules/.bin"',
        'printf \'#!/bin/sh\\nprintf "OpenClaw 2026.8.1\\\\n"\\n\' >"$3/node_modules/.bin/openclaw"',
        'chmod 700 "$3/node_modules/.bin/openclaw"',
      ].join("\n"),
    );
    return {
      dir,
      executable,
      run: () =>
        execFileAsync("/bin/sh", ["-c", preparation], {
          cwd: dir,
          env: { HOME: dir, PATH: `${bin}:/usr/bin:/bin`, NPM_CONFIG_GLOBALCONFIG: globalConfig },
          timeout: 10_000,
        }),
      preparedPath: path.join(
        dir,
        ".openclaw",
        "cloud-workers",
        leaseId,
        "runtime",
        "openclaw-bin",
      ),
    };
  }

  it("reuses an exact image runtime without invoking npm", async () => {
    const f = await fixture();
    await f.executable("openclaw", 'printf "OpenClaw 2026.8.1 (candidate)\\n"');
    await f.run();
    expect((await readFile(f.preparedPath, "utf8")).trim()).toBe(
      path.join(f.dir, "bin", "openclaw"),
    );
    await expect(readFile(path.join(f.dir, "npm-calls"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs only the owner-selected exact package into the lease prefix and reuses it on replay", async () => {
    const f = await fixture();
    await f.executable("openclaw", 'printf "OpenClaw 2025.1.1\\n"');
    let failure: unknown;
    try {
      await f.run();
    } catch (error) {
      failure = error;
    }
    expect(failure, await readFile(path.join(f.dir, "npm-config-error"), "utf8")).toBeUndefined();
    expect((await readFile(path.join(f.dir, "npm-config-output"), "utf8")).trim()).toBe(
      "https://registry.npmjs.org/",
    );
    const globalConfig = (
      await readFile(path.join(f.dir, "npm-global-config-path"), "utf8")
    ).trim();
    await expect(stat(globalConfig)).rejects.toMatchObject({ code: "ENOENT" });
    await f.run();
    const calls = (await readFile(path.join(f.dir, "npm-calls"), "utf8")).trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--registry https://registry.npmjs.org");
    expect(calls[0]).toMatch(/openclaw@2026\.8\.1$/);
    expect((await readFile(f.preparedPath, "utf8")).trim()).toContain(
      ".openclaw/cloud-workers/cbx_test/runtime/openclaw/node_modules/.bin/openclaw",
    );
  });

  it("rejects a package source whose executable does not match the Gateway", async () => {
    const f = await fixture(false);
    await expect(f.run()).rejects.toThrow(
      /unpublished source build requires the exact locally packed candidate/,
    );
    await expect(readFile(f.preparedPath)).rejects.toMatchObject({ code: "ENOENT" });
    const globalConfig = (
      await readFile(path.join(f.dir, "npm-global-config-path"), "utf8")
    ).trim();
    await expect(stat(globalConfig)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([true, false])(
    "prepares private Node only after checksum verification succeeds: %s",
    async (verified) => {
      const f = await fixture();
      await f.executable("node", "exit 1");
      await f.executable("uname", 'if [ "$1" = -s ]; then echo Linux; else echo x86_64; fi');
      await f.executable(
        "curl",
        [
          'printf "%s\\n" "$*" >"$HOME/download-call"',
          'while [ "$1" != -o ]; do shift; done',
          'printf tampered >"$2"',
        ].join("\n"),
      );
      await f.executable("sha256sum", `cat >"$HOME/checksum-call"; exit ${verified ? 0 : 1}`);
      await f.executable(
        "tar",
        [
          'touch "$HOME/extracted"',
          'while [ "$1" != -C ]; do shift; done',
          'mkdir -p "$2/node-v24.19.0-linux-x64/bin"',
          "printf '#!/bin/sh\\necho v24.19.0\\n' >\"$2/node-v24.19.0-linux-x64/bin/node\"",
          'chmod 700 "$2/node-v24.19.0-linux-x64/bin/node"',
        ].join("\n"),
      );
      if (verified) {
        await f.run();
      } else {
        await expect(f.run()).rejects.toThrow();
      }
      expect(await readFile(path.join(f.dir, "download-call"), "utf8")).toContain(
        "https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.gz",
      );
      expect(await readFile(path.join(f.dir, "checksum-call"), "utf8")).toMatch(
        /^f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4 {2}/,
      );
      if (verified) {
        expect(await readFile(path.join(f.dir, "extracted"), "utf8")).toBe("");
        expect(await readFile(f.preparedPath, "utf8")).toContain(
          "runtime/openclaw/node_modules/.bin/openclaw",
        );
      } else {
        await expect(readFile(path.join(f.dir, "extracted"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(readFile(f.preparedPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );
});

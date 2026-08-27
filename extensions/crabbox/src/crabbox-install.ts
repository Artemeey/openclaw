import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractArchive } from "openclaw/plugin-sdk/archive";
import type {
  WorkerSetupDependency,
  WorkerSetupInstallResult,
} from "openclaw/plugin-sdk/gateway-runtime";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import {
  OccupiedInstallationError,
  publishVerifiedCrabboxInstallation,
} from "./crabbox-install-publication.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { findCrabboxBinary } from "./crabbox-worker-profile.js";

// Official v0.46.0 downloadable payload hashes, not unsigned macOS producer inputs.
const CRABBOX_INSTALL_VERSION = "0.46.0";
const ASSETS: Record<string, string> = {
  darwin_amd64: "18035770b5b654114fa95d2e468268b13c69862137cc1f083bd674bbb2bf83bb",
  darwin_arm64: "2216da0acbcc6e822ee341ec313aaab58875db951fa1daf0d13dd710ebfba9b8",
  linux_amd64: "6a9341e810307356361dbed4c4b84be28a036b5cc291af1566d2ccd376570d90",
  linux_arm64: "d95730856cd3909dab0703ec024e3017a094fff2a065516782b47019fec9533d",
  windows_amd64: "0bb0bbe08f4ad3b2204f13bb1e57372f7fa69758208eef46644dc85b5372ebfd",
  windows_arm64: "835f8ed04a419cfe0e9cf4cf8e58ae90676313d209f1561bda029e0c551e6052",
};
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
type InstalledCli = {
  binary: string;
  files: Record<string, string>;
  version: string;
  assetHash: string;
};
type DependencyInspection = { dependency: WorkerSetupDependency; binary?: string };

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function createCrabboxInstallation(runCommand: CrabboxCommandRunner) {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const target = `${platform}_${arch}`;
  const assetHash = ASSETS[target];
  const root = path.join(resolveStateDir(), "tools", "crabbox");
  const destination = path.join(root, `${CRABBOX_INSTALL_VERSION}-${target}`);
  const executable = platform === "windows" ? "crabbox.exe" : "crabbox";
  let store: ReturnType<typeof createPluginStateSyncKeyedStore<InstalledCli>> | undefined;
  const metadata = () =>
    (store ??= createPluginStateSyncKeyedStore<InstalledCli>("crabbox", {
      namespace: "managed-cli",
      maxEntries: 1,
    }));
  let inspection: Promise<DependencyInspection> | undefined;
  let installing: Promise<WorkerSetupInstallResult> | undefined;
  const missing = (): DependencyInspection => ({
    dependency: {
      state: assetHash ? "missing" : "unsupported",
      requiredVersion: CRABBOX_INSTALL_VERSION,
      managed: false,
    },
  });
  const probe = async (binary: string, managed: boolean): Promise<DependencyInspection> => {
    try {
      const result = await runCommand([binary, "--version"], {
        timeoutMs: 5_000,
        maxOutputBytes: 4096,
        killProcessTree: true,
      });
      const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(result.stdout);
      if (
        result.code !== 0 ||
        result.termination !== "exit" ||
        result.outputLimitExceeded ||
        !match
      ) {
        return missing();
      }
      const version = `${match[1]}.${match[2]}.${match[3]}`;
      const compatible = Number(match[1]) > 0 || Number(match[2]) >= 46;
      return {
        binary,
        dependency: {
          state: compatible ? "available" : "incompatible",
          version,
          managed,
          requiredVersion: CRABBOX_INSTALL_VERSION,
        },
      };
    } catch {
      return missing();
    }
  };
  const load = async (): Promise<DependencyInspection> => {
    const record = metadata().lookup("current");
    if (
      record &&
      record.assetHash === assetHash &&
      record.version === CRABBOX_INSTALL_VERSION &&
      record.binary === path.join(destination, executable)
    ) {
      try {
        if (!(await lstat(destination)).isDirectory()) {
          return missing();
        }
        const files = Object.entries(record.files);
        const expected =
          platform === "darwin" && arch === "arm64"
            ? [executable, "crabbox-apple-vm-helper"]
            : [executable];
        if (files.length !== expected.length || expected.some((name) => !record.files[name])) {
          return missing();
        }
        for (const [name, hash] of files) {
          if (!expected.includes(name)) {
            return missing();
          }
          const file = path.join(destination, name);
          if (!(await lstat(file)).isFile() || digest(await readFile(file)) !== hash) {
            return missing();
          }
        }
        return await probe(record.binary, true);
      } catch {
        return missing();
      }
    }
    const binary = findCrabboxBinary({
      openclawRoot: process.cwd(),
      pathEnv: process.env.PATH,
      includeSibling: false,
    });
    return binary ? await probe(binary, false) : missing();
  };
  const inspect = () => (inspection ??= load());
  const install = async (): Promise<WorkerSetupInstallResult> => {
    const current = await inspect();
    if (current.dependency.state === "available") {
      return {
        status: current.dependency.managed ? "installed" : "unmanaged",
        dependency: current.dependency,
        diagnostics: [],
      };
    }
    try {
      if (!assetHash) {
        throw new Error("Unsupported platform");
      }
      await mkdir(root, { recursive: true, mode: 0o700 });
      await withTempWorkspace({ rootDir: root, prefix: ".install-" }, async ({ dir }) => {
        const extension = platform === "windows" ? "zip" : "tar.gz";
        const asset = `crabbox_${CRABBOX_INSTALL_VERSION}_${target}.${extension}`;
        const archivePath = path.join(dir, asset);
        const fetched = await fetchWithSsrFGuard({
          url: `https://github.com/openclaw/crabbox/releases/download/v${CRABBOX_INSTALL_VERSION}/${asset}`,
          requireHttps: true,
          timeoutMs: 120_000,
          maxRedirects: 3,
          policy: { hostnameAllowlist: ["github.com", "release-assets.githubusercontent.com"] },
        });
        try {
          if (!fetched.response.ok) {
            throw new Error("Release download failed");
          }
          const bytes = await readResponseWithLimit(fetched.response, MAX_ARCHIVE_BYTES, {
            timeoutMs: 120_000,
          });
          if (digest(bytes) !== assetHash) {
            throw new Error("Release checksum mismatch");
          }
          await writeFile(archivePath, bytes, { mode: 0o600, flag: "wx" });
        } finally {
          await fetched.release();
        }
        const extracted = path.join(dir, "extracted");
        await mkdir(extracted, { mode: 0o700 });
        await extractArchive({
          archivePath,
          destDir: extracted,
          timeoutMs: 60_000,
          limits: {
            maxEntries: 32,
            maxExtractedBytes: 256 * 1024 * 1024,
            maxEntryBytes: 128 * 1024 * 1024,
          },
        });
        const files: Record<string, string> = {};
        const names =
          platform === "darwin" && arch === "arm64"
            ? [executable, "crabbox-apple-vm-helper"]
            : [executable];
        for (const name of names) {
          const file = path.join(extracted, name);
          if (!(await lstat(file)).isFile()) {
            throw new Error("Release executable missing");
          }
          await chmod(file, 0o700);
          files[name] = digest(await readFile(file));
        }
        const verified = await probe(path.join(extracted, executable), true);
        if (verified.dependency.version !== CRABBOX_INSTALL_VERSION) {
          throw new Error("Release version mismatch");
        }
        await publishVerifiedCrabboxInstallation({
          extracted,
          destination,
          register: () =>
            metadata().register("current", {
              binary: path.join(destination, executable),
              files,
              version: CRABBOX_INSTALL_VERSION,
              assetHash,
            }),
        });
      });
      inspection = load();
      const installed = await inspection;
      return { status: "installed", dependency: installed.dependency, diagnostics: [] };
    } catch (error) {
      return {
        status: "failed",
        dependency: current.dependency,
        diagnostics: [
          {
            code:
              error instanceof OccupiedInstallationError
                ? "install_directory_occupied"
                : "install_failed",
            severity: "error",
            message:
              error instanceof OccupiedInstallationError
                ? `The managed Crabbox version directory contains unexpected or modified files: ${destination}. Move that directory aside after stopping users of its binary, then retry installation. No files were overwritten.`
                : "Crabbox installation failed verification or could not be published. Check network access and the Gateway's managed tools directory, then retry; a complete verified installation can be recovered. No cloud machine was allocated.",
            action: "install",
          },
        ],
      };
    }
  };
  return {
    inspect,
    install: () =>
      (installing ??= install().finally(() => {
        installing = undefined;
      })),
    requireBinary: async (explicit?: string) => {
      if (explicit) {
        return explicit;
      }
      const current = await inspect();
      if (!current.binary || current.dependency.state !== "available") {
        throw new Error(
          "Install a compatible Crabbox CLI in cloud setup before starting a session",
        );
      }
      return current.binary;
    },
  };
}

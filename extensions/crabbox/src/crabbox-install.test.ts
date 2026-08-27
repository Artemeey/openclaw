import { createHash, Hash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { ArchiveFormatError } from "@openclaw/fs-safe/archive";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishVerifiedCrabboxInstallation } from "./crabbox-install-publication.js";
import { createCrabboxInstallation } from "./crabbox-install.js";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  register: vi.fn(),
  fetch: vi.fn(),
  extract: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/plugin-state-store-runtime", () => ({
  createPluginStateSyncKeyedStore: () => ({ lookup: mocks.lookup, register: mocks.register }),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: mocks.fetch }));
vi.mock("openclaw/plugin-sdk/archive", () => ({ extractArchive: mocks.extract }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const version: SpawnResult = {
  code: 0,
  stdout: "crabbox 0.46.0\n",
  stderr: "",
  signal: null,
  killed: false,
  termination: "exit",
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("explicit Crabbox installation", () => {
  async function verifiedArchive(root: string, name: string) {
    const dir = path.join(root, name);
    await mkdir(dir);
    await writeFile(path.join(dir, "crabbox"), "verified-binary", { mode: 0o700 });
    await writeFile(path.join(dir, "crabbox-apple-vm-helper"), "verified-helper", { mode: 0o700 });
    await writeFile(path.join(dir, "LICENSE"), "official-license");
    return dir;
  }

  it("recovers publication interrupted before KV registration using the complete verified tree", async () => {
    const root = tempDirs.make("crabbox-publish-");
    const extracted = await verifiedArchive(root, "first");
    const destination = path.join(root, "version");
    await expect(
      publishVerifiedCrabboxInstallation({
        extracted,
        destination,
        register: () => {
          throw new Error("interrupted KV commit");
        },
      }),
    ).rejects.toThrow("interrupted KV commit");
    expect(await readFile(path.join(destination, "crabbox"), "utf8")).toBe("verified-binary");
    const register = vi.fn();
    await publishVerifiedCrabboxInstallation({
      extracted: await verifiedArchive(root, "retry"),
      destination,
      register,
    });
    expect(register).toHaveBeenCalledOnce();
  });

  it.each(["binary", "helper", "extra", "symlink"])(
    "preserves an occupied %s mismatch without registering it",
    async (damage) => {
      const root = tempDirs.make("crabbox-occupied-");
      const extracted = await verifiedArchive(root, "verified");
      const destination = path.join(root, "version");
      if (damage === "symlink") {
        await symlink(extracted, destination, process.platform === "win32" ? "junction" : "dir");
      } else {
        await verifiedArchive(root, "version");
        const name =
          damage === "binary"
            ? "crabbox"
            : damage === "helper"
              ? "crabbox-apple-vm-helper"
              : "operator-file";
        await writeFile(path.join(destination, name), "do-not-overwrite");
      }
      const before = await stat(path.join(extracted, "crabbox"));
      const register = vi.fn();
      await expect(
        publishVerifiedCrabboxInstallation({ extracted, destination, register }),
      ).rejects.toThrow(/unexpected or modified/);
      expect(register).not.toHaveBeenCalled();
      expect((await stat(path.join(extracted, "crabbox"))).ino).toBe(before.ino);
      if (damage !== "symlink") {
        const name =
          damage === "binary"
            ? "crabbox"
            : damage === "helper"
              ? "crabbox-apple-vm-helper"
              : "operator-file";
        expect(await readFile(path.join(destination, name), "utf8")).toBe("do-not-overwrite");
      }
    },
  );

  it("refreshes cached missing inspection on explicit install to reuse an operator PATH executable", async () => {
    const dir = tempDirs.make("crabbox-unmanaged-");
    const binary = path.join(dir, process.platform === "win32" ? "crabbox.exe" : "crabbox");
    vi.stubEnv("PATH", dir);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(dir, "state"));
    const runCommand = vi.fn(async () => version);
    const installation = createCrabboxInstallation(runCommand);
    expect((await installation.inspect()).dependency.state).toBe("missing");
    await writeFile(binary, "fixture");
    await chmod(binary, 0o700);
    // Ordinary inspection remains cached until the operator explicitly requests installation.
    expect((await installation.inspect()).dependency.state).toBe("missing");
    expect(runCommand).not.toHaveBeenCalled();
    for (const result of await Promise.all([installation.install(), installation.install()])) {
      expect(result).toMatchObject({
        status: "unmanaged",
        dependency: { state: "available", version: "0.46.0", managed: false },
      });
    }
    expect(await installation.inspect()).toMatchObject({
      binary,
      dependency: { state: "available", managed: false },
    });
    expect(await installation.requireBinary()).toBe(binary);
    expect(runCommand).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it.each(["removed", "tampered-managed"])(
    "invalidates cached availability on explicit install after the executable is %s",
    async (change) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(process, "arch", "get").mockReturnValue("x64");
      const dir = tempDirs.make("crabbox-refresh-");
      const stateDir = path.join(dir, "state");
      vi.stubEnv("PATH", dir);
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      let binary = path.join(dir, "crabbox");
      await writeFile(binary, "path-fixture", { mode: 0o700 });
      if (change === "tampered-managed") {
        const destination = path.join(stateDir, "tools", "crabbox", "0.46.0-linux_amd64");
        await mkdir(destination, { recursive: true });
        binary = path.join(destination, "crabbox");
        await writeFile(binary, "managed-fixture", { mode: 0o700 });
        mocks.lookup.mockReturnValue({
          binary,
          files: { crabbox: createHash("sha256").update("managed-fixture").digest("hex") },
          version: "0.46.0",
          assetHash: "6a9341e810307356361dbed4c4b84be28a036b5cc291af1566d2ccd376570d90",
        });
      }
      const runCommand = vi.fn(async () => version);
      const installation = createCrabboxInstallation(runCommand);
      expect(await installation.inspect()).toMatchObject({
        binary,
        dependency: { state: "available", managed: change === "tampered-managed" },
      });
      if (change === "removed") {
        await unlink(binary);
      } else {
        await writeFile(binary, "do-not-overwrite");
      }
      mocks.fetch.mockRejectedValue(new Error("fixture download unavailable"));
      expect(await installation.install()).toMatchObject({
        status: "failed",
        dependency: { state: "missing" },
      });
      expect((await installation.inspect()).dependency.state).toBe("missing");
      await expect(installation.requireBinary()).rejects.toThrow(
        "Install a compatible Crabbox CLI",
      );
      expect(runCommand).toHaveBeenCalledOnce();
      expect(mocks.fetch).toHaveBeenCalledOnce();
      expect(mocks.extract).not.toHaveBeenCalled();
      expect(mocks.register).not.toHaveBeenCalled();
      if (change === "tampered-managed") {
        expect(await readFile(binary, "utf8")).toBe("do-not-overwrite");
      }
    },
  );

  it("rejects a bad official payload checksum before extraction or execution", async () => {
    const dir = tempDirs.make("crabbox-checksum-");
    await mkdir(path.join(dir, "empty-path"));
    vi.stubEnv("PATH", path.join(dir, "empty-path"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(dir, "state"));
    const release = vi.fn(async () => {});
    mocks.fetch.mockResolvedValue({ response: new Response("tampered-release"), release });
    const runCommand = vi.fn(async () => version);
    const installation = createCrabboxInstallation(runCommand);
    expect((await installation.install()).status).toBe("failed");
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringMatching(
          /^https:\/\/github\.com\/openclaw\/crabbox\/releases\/download\/v0\.46\.0\//,
        ),
      }),
    );
    expect(release).toHaveBeenCalledOnce();
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "reports extraction failure safely (format rejection: %s)",
    async (format) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
      const dir = tempDirs.make("crabbox-extraction-");
      const stateDir = path.join(dir, "state");
      vi.stubEnv("PATH", dir);
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const release = vi.fn(async () => {});
      mocks.fetch.mockResolvedValue({
        response: new Response("synthetic-verified-archive"),
        release,
      });
      // Only the checksum oracle is mocked: exercise the installer through extraction failure.
      // The independent tampered-payload case above keeps the real checksum rejection boundary.
      vi.spyOn(Hash.prototype, "digest").mockReturnValue(
        "2216da0acbcc6e822ee341ec313aaab58875db951fa1daf0d13dd710ebfba9b8",
      );
      mocks.extract.mockRejectedValue(
        format
          ? new ArchiveFormatError("private archive detail")
          : new Error("private archive detail"),
      );
      const runCommand = vi.fn(async () => version);
      const result = await createCrabboxInstallation(runCommand).install();
      expect(mocks.extract).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        status: "failed",
        dependency: { state: "missing", managed: false },
      });
      expect(result.diagnostics[0]?.message).not.toContain("private archive detail");
      if (format) {
        expect(result.diagnostics[0]).toMatchObject({
          code: "install_archive_rejected",
          action: "install",
        });
        expect(result.diagnostics[0]?.message).toContain("archive format");
        expect(result.diagnostics[0]?.message).toContain("OpenClaw update");
        expect(result.diagnostics[0]?.message).toContain("PATH");
      } else {
        expect(result.diagnostics[0]).toMatchObject({ code: "install_failed", action: "install" });
        expect(result.diagnostics[0]?.message).toContain("Check network access");
      }
      expect(release).toHaveBeenCalledOnce();
      expect(runCommand).not.toHaveBeenCalled();
      expect(mocks.register).not.toHaveBeenCalled();
      expect(await readdir(path.join(stateDir, "tools", "crabbox"))).toEqual([]);
    },
  );
});

import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
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
afterEach(() => vi.unstubAllEnvs());

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

  it("reuses a compatible PATH executable as unmanaged without downloading or publishing metadata", async () => {
    const dir = tempDirs.make("crabbox-unmanaged-");
    const binary = path.join(dir, process.platform === "win32" ? "crabbox.exe" : "crabbox");
    await writeFile(binary, "fixture");
    await chmod(binary, 0o700);
    vi.stubEnv("PATH", dir);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(dir, "state"));
    const installation = createCrabboxInstallation(vi.fn(async () => version));
    expect(await installation.install()).toMatchObject({
      status: "unmanaged",
      dependency: { version: "0.46.0", managed: false },
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

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
});

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { transferSkillResources } from "./skill-resource-transfer.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const tunnel: Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand"> = {
  runWorkspaceCommand: async (command) => {
    command.assertCurrent?.();
    return new Promise((resolve, reject) => {
      const child = spawn(command.argv[0]!, command.argv.slice(1), { stdio: "pipe" });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (bytes) => {
        stdout += bytes;
      });
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
      });
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({ stdout, stderr, code, termination: "exit", signal: null, killed: false }),
      );
      child.stdin.end(command.input);
    });
  },
};

describe("remote-exec skill resources", () => {
  it("executes the actual receiver and preserves complete binary and executable files outside the project", async () => {
    const workspace = await fs.realpath(temps.make("remote-skill-source-"));
    const baseDir = path.join(workspace, "skills", "source");
    await fs.mkdir(path.join(baseDir, "scripts"), { recursive: true });
    const filePath = path.join(baseDir, "SKILL.md");
    await fs.writeFile(
      filePath,
      "---\ndescription: Resource transfer test\n---\n# Resource\nRead data.bin and run scripts/check.sh.\n",
    );
    const binary = Buffer.alloc(150000, 129);
    await fs.writeFile(path.join(baseDir, "data.bin"), binary);
    await fs.writeFile(path.join(baseDir, "scripts/check.sh"), "#!/bin/sh\nprintf ready\n", {
      mode: 0o700,
    });
    const resources = await transferSkillResources({
      tunnel,
      assertCurrent: () => {},
      snapshot: buildSkillSnapshot(workspace, {
        entries: loadWorkspaceSkills(workspace, { workspaceOnly: true }),
      }),
    });
    expect(resources).toBeDefined();
    const remote = resources!.mounts[0]!.containerPath;
    try {
      expect(remote.startsWith(workspace)).toBe(false);
      expect(await fs.readFile(path.join(remote, "SKILL.md"))).toEqual(await fs.readFile(filePath));
      expect(resources!.snapshot.resolvedSkills![0]!.name).toBe("source");
      expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
      expect((await fs.stat(path.join(remote, "scripts/check.sh"))).mode & 0o777).toBe(0o500);
      expect((await fs.stat(path.join(remote, "data.bin"))).mode & 0o777).toBe(0o400);
      expect(resources!.snapshot.prompt).toContain(remote);
      expect(resources!.snapshot.resolvedSkills![0]!.filePath).toBe(filePath);
    } finally {
      await resources!.cleanup();
    }
    await expect(fs.stat(remote)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

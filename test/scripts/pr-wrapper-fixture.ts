import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function readPrAnchorRuntimePaths(sourceRoot = process.cwd()): string[] {
  return readFileSync(join(sourceRoot, "scripts/pr-lib/anchor-runtime-paths.txt"), "utf8")
    .trimEnd()
    .split("\n");
}

export function readPrRemoteOnlyTrustPaths(sourceRoot = process.cwd()): string[] {
  const source = readFileSync(join(sourceRoot, "scripts/pr"), "utf8");
  const entries = /^pr_remote_only_trust_paths=\(\n([\s\S]*?)^\)/m.exec(source)?.[1];
  if (!entries?.trim()) {
    throw new Error("scripts/pr has no remote-only trust path declaration");
  }
  return entries.trim().split(/\s+/u);
}

export function copyPrWrapperFixture(repoDir: string): void {
  const sourceRoot = process.cwd();
  for (const file of [
    ...readPrAnchorRuntimePaths(sourceRoot),
    ...readPrRemoteOnlyTrustPaths(sourceRoot),
  ]) {
    const target = join(repoDir, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(sourceRoot, file), target);
  }
}

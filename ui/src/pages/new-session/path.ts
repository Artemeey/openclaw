import { comparableAbsolutePath } from "../../lib/local-path.ts";

/** Last path segment for the folder trigger label; preserves filesystem roots. */
export function folderDisplayName(path: string): string {
  return path.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? path;
}

export function parentFolderDisplayName(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/u, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separator < 0) {
    return undefined;
  }
  const parent = separator === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, separator);
  return folderDisplayName(parent) || undefined;
}

/** Client-side affordance check; the Gateway remains the realpath authority. */
function isWorkspaceContainedPath(workspace: string, candidate: string): boolean {
  const root = comparableAbsolutePath(workspace);
  const target = comparableAbsolutePath(candidate);
  if (!root || !target) {
    return false;
  }
  return target === root || target.startsWith(root === "/" ? root : `${root}/`);
}

/** Checks a path against every configured or Gateway-approved workspace spelling. */
export function isKnownWorkspacePath(
  workspaceRoots: readonly string[],
  candidate: string,
): boolean {
  return workspaceRoots.some((root) => isWorkspaceContainedPath(root, candidate));
}

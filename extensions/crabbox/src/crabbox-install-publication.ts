import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export class OccupiedInstallationError extends Error {
  constructor() {
    super("Managed Crabbox directory contains unexpected or modified files");
  }
}

// A crash can publish the verified archive before its KV record commits. Recover only
// an exact archive tree; never replace or execute unrecognized occupied files.
async function matchesPublishedArchive(verified: string, occupied: string): Promise<boolean> {
  const info = await lstat(occupied);
  if (!info.isDirectory()) {
    return false;
  }
  const names = (await readdir(verified)).toSorted();
  if (JSON.stringify(names) !== JSON.stringify((await readdir(occupied)).toSorted())) {
    return false;
  }
  for (const name of names) {
    const source = path.join(verified, name);
    const target = path.join(occupied, name);
    const sourceInfo = await lstat(source);
    const targetInfo = await lstat(target);
    if (sourceInfo.isDirectory()) {
      if (!(await matchesPublishedArchive(source, target))) {
        return false;
      }
    } else if (
      !sourceInfo.isFile() ||
      !targetInfo.isFile() ||
      sourceInfo.size !== targetInfo.size ||
      (sourceInfo.mode & 0o111) !== (targetInfo.mode & 0o111) ||
      digest(await readFile(source)) !== digest(await readFile(target))
    ) {
      return false;
    }
  }
  return true;
}

/** The caller must authenticate and extract the official archive before publication. */
export async function publishVerifiedCrabboxInstallation(params: {
  extracted: string;
  destination: string;
  register: () => void;
}) {
  let occupied: boolean;
  try {
    await lstat(params.destination);
    occupied = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    occupied = false;
  }
  if (occupied) {
    if (!(await matchesPublishedArchive(params.extracted, params.destination))) {
      throw new OccupiedInstallationError();
    }
  } else {
    await rename(params.extracted, params.destination);
  }
  params.register();
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
}

/** Lexical comparison only; the Gateway remains the realpath authority. */
export function comparableAbsolutePath(value: string): string | null {
  if (!isAbsolutePath(value)) {
    return null;
  }
  const path = value.trim();
  const parts: string[] = [];
  // Keep drive/UNC roots at ".."; POSIX backslashes remain literal filename data.
  const floor = /^[A-Za-z]:[\\/]/u.test(path) ? 1 : /^[\\/]{2}/u.test(path) ? 2 : 0;
  for (const part of path.split(floor > 0 || path.startsWith("\\") ? /[\\/]/u : "/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length > floor) {
        parts.pop();
      }
      continue;
    }
    parts.push(part);
  }
  const prefix = floor === 2 ? "//" : /^[\\/]/u.test(path) ? "/" : "";
  const normalized = `${prefix}${parts.join("/")}`.replace(/\/+$/u, "") || "/";
  return floor > 0 ? normalized.toLowerCase() : normalized;
}

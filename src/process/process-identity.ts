import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { err, ok, type Result } from "@openclaw/normalization-core/result";

let linuxBootId: string | undefined;
type ProcessIdentity = { start: string; parentPid: number; processGroupId: number };
let readDarwinIdentity: ((pid: number) => ProcessIdentity | undefined) | undefined;

/** Kernel start identity; unavailable evidence must never authorize a PID-based action. */
export function getProcessIdentity(pid: number): Result<ProcessIdentity, "unavailable"> {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return err("unavailable");
    }
    if (process.platform === "linux") {
      linuxBootId ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm may contain spaces or ')'; starttime is field 22, after comm (field 2).
      const fields = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/);
      const ticks = fields[19];
      return linuxBootId && ticks && /^\d+$/.test(ticks)
        ? ok({
            start: `linux:${linuxBootId}:${ticks}`,
            parentPid: Number(fields[1]),
            processGroupId: Number(fields[2]),
          })
        : err("unavailable");
    }
    if (process.platform === "darwin") {
      readDarwinIdentity ??= (() => {
        // Koffi is a host dependency; load only when a Darwin process is inspected.
        const koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi").default;
        const procPidInfo = koffi
          .load("/usr/lib/libproc.dylib")
          .func(
            "int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize)",
          );
        return (targetPid: number) => {
          // Darwin sys/proc_info.h: PROC_PIDTBSDINFO=3, 136-byte proc_bsdinfo;
          // PID/PPID at 12/16, PGID at 100, start timeval at 120/128.
          // Capture ancestry and microsecond start together; ps loses precision.
          const info = Buffer.alloc(136);
          if (
            procPidInfo(targetPid, 3, 0, info, info.length) !== info.length ||
            info.readUInt32LE(12) !== targetPid
          ) {
            return undefined;
          }
          return {
            start: `darwin:${info.readBigUInt64LE(120)}:${info.readBigUInt64LE(128)}`,
            parentPid: info.readUInt32LE(16),
            processGroupId: info.readUInt32LE(100),
          };
        };
      })();
      const identity = readDarwinIdentity(pid);
      return identity ? ok(identity) : err("unavailable");
    }
  } catch {
    // Exited, inaccessible, or unsupported processes carry no signal authority.
  }
  return err("unavailable");
}

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { z } from "zod";
import {
  captureCodexAppServerProcessIdentity,
  reapCodexAppServerOrphan,
} from "./transport-process-containment.js";

const processIdentity = z.object({
  pid: z.number().int().positive(),
  pgid: z.number().int().positive(),
  instance: z.string().min(1),
});
const registrationSchema = z.object({
  host: z.string(),
  stateDir: z.string(),
  owner: processIdentity,
  child: processIdentity,
});

/** Reconnect uses spawn facts, never process-name or command-line guesses. */
export async function prepareCodexAppServerProcessRegistration(
  env: NodeJS.ProcessEnv,
  assertCurrent: () => void,
) {
  // Freeze the owner's state directory; child env overrides cannot redirect custody.
  const stateEnv = { ...env };
  const store = createPluginStateSyncKeyedStore<z.infer<typeof registrationSchema>>("codex", {
    namespace: "app-server-processes",
    maxEntries: 512,
    overflowPolicy: "reject-new",
    env: stateEnv,
  });
  const entries = store.entries();
  const stateRoot = resolveStateDir(stateEnv);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const stateDir = await realpath(stateRoot);
  const host = hostname();
  const deadline = Date.now() + 5_000;
  for (const entry of entries) {
    assertCurrent();
    const parsed = registrationSchema.safeParse(entry.value);
    if (!parsed.success) {
      throw new Error(
        "Invalid Codex app-server process registration; inspect the OpenClaw state database before reconnecting.",
      );
    }
    const registration = parsed.data;
    if (registration.host !== host || registration.stateDir !== stateDir) {
      continue;
    }
    if (
      (await reapCodexAppServerOrphan(registration.owner, registration.child, deadline)) === "gone"
    ) {
      // Keys are unique per spawn and never updated, so concurrent reapers can
      // only delete this same completed registration.
      store.delete(entry.key);
    }
  }
  const owner = await captureCodexAppServerProcessIdentity(process.pid);
  return async (child: ChildProcess) => {
    if (!child.pid) {
      throw new Error("Codex app-server spawn did not return a process id.");
    }
    const identity = await captureCodexAppServerProcessIdentity(child.pid);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Codex app-server exited before process registration.");
    }
    const key = randomUUID();
    store.register(key, { host, stateDir, owner, child: identity });
    child.once("exit", () => {
      try {
        store.delete(key);
      } catch {
        // A failed cleanup retains custody; the next connect retires the dead row.
      }
    });
  };
}

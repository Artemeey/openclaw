import { fileURLToPath } from "node:url";
import { definePluginEntry, type OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { createCrabboxControlRunner } from "./src/crabbox-connections.js";
import { createCrabboxInstallation } from "./src/crabbox-install.js";
import { registerCrabboxSetup } from "./src/crabbox-setup.js";
import { createCrabboxWorkerProvider, resolveOpenClawRoot } from "./src/crabbox-worker-provider.js";

const workerWallpaperPath = fileURLToPath(
  new URL("./assets/openclaw-worker-wallpaper.png", import.meta.url),
);

export default definePluginEntry({
  id: "crabbox",
  name: "Crabbox Worker Provider",
  description: "Cloud worker provider backed by the Crabbox CLI",
  register(api) {
    const getConfig = () => api.runtime.config.current();
    const installation = createCrabboxInstallation(
      createCrabboxControlRunner({ runCommand: runCommandWithTimeout, getConfig }),
    );
    registerCrabboxSetup({ api, installation, runCommand: runCommandWithTimeout });
    const provider = createCrabboxWorkerProvider({
      openclawRoot: resolveOpenClawRoot(api.rootDir),
      wallpaperPath: workerWallpaperPath,
      warn: (message) => api.logger.warn(message),
      getConfig,
      requireConnectionBinary: installation.requireBinary,
    });
    api.registerWorkerProvider(provider);
    // Worker sidecars stop first; plugin services own generation-wide heartbeat cleanup.
    api.registerService({
      id: "crabbox-worker-cleanup",
      start() {},
      stop() {
        provider.dispose();
      },
    } satisfies OpenClawPluginService);
  },
});

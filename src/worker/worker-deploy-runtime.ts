import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { resolveSecureTempRoot } from "../infra/secure-temp-root.js";
import highlightJsRuntime from "./worker-deploy-highlight-runtime.mjs";
import json5Runtime from "./worker-deploy-json5-runtime.mjs";
import { setWorkerDeployRuntime } from "./worker-deploy-runtime-registry.js";

// The sealed worker has no dependency tree, so native executable bytes cannot
// participate in its hash-bound runtime. Keep filesystem operations on bundled JS.
configureFsSafeNative({ mode: "off" });

setWorkerDeployRuntime({
  highlightJs: highlightJsRuntime,
  json5: json5Runtime,
  resolveSecureTempRoot,
});

import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createBeamRequestHandler } from "./src/http.js";
import { createBeamMirrorService } from "./src/mirror.js";
import { createBeamSessionCatalog } from "./src/session-catalog.js";
import { createBeamStore } from "./src/store.js";

export default definePluginEntry({
  id: "beam",
  name: "Beam",
  description: "Receive redacted local coding sessions with native-session continuation",
  register(api) {
    const store = createBeamStore(api.runtime);
    api.registerSessionCatalog(createBeamSessionCatalog(store, api));
    api.registerHttpRoute({
      path: "/api/v1/beam/sessions",
      auth: "gateway",
      match: "exact",
      handler: createBeamRequestHandler({
        store,
        resolveControlUiTarget: () => {
          const config = api.runtime.config.current();
          return {
            // The resolver only reads; the plugin runtime exposes a DeepReadonly view.
            agentId: resolveDefaultAgentId(config as OpenClawConfig),
            basePath: config.gateway?.controlUi?.basePath,
          };
        },
      }),
    });
    api.registerService(createBeamMirrorService({ runtime: api.runtime }));
  },
});

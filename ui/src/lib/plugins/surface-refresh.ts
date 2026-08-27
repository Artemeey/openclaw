import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RuntimeConfigCapability } from "../config/runtime-config-capability.ts";

/** Observe the config owner's reload result; hello methods change only on reconnect. */
export function createPluginSurfaceRefresh(
  config: RuntimeConfigCapability,
  client: GatewayBrowserClient,
  isCurrent: () => boolean,
): (() => () => void) | undefined {
  const snapshot = config.state.configSnapshot;
  if (!snapshot?.hash) {
    return undefined;
  }
  const sourceHash = snapshot.hash;
  const revision = snapshot.configRevisionHash ?? sourceHash;
  return () => {
    const stop = () => unsubscribe();
    const refresh = () => {
      const current = config.state.configSnapshot;
      if (!current || !isCurrent() || current.hash !== sourceHash) {
        stop();
      } else if (current.appliedConfigHash === revision) {
        // Keep the client/auth identity and let the shared supervisor obtain a new hello.
        stop();
        client.forceReconnect("plugin policy changed");
      }
    };
    const unsubscribe = config.subscribe(refresh);
    refresh();
    return stop;
  };
}

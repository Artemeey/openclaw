import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { StoredCodexAppServerProcess } from "./transport-process-registry.js";

export function createCodexProcessRegistryTestStore(): Required<
  PluginStateSyncKeyedStore<StoredCodexAppServerProcess>
> {
  const values = new Map<string, StoredCodexAppServerProcess>();
  return {
    register(key, value) {
      values.set(key, value);
    },
    registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    update(key, updateValue) {
      const next = updateValue(values.get(key));
      if (next === undefined) {
        return false;
      }
      values.set(key, next);
      return true;
    },
    lookup: (key) => values.get(key),
    consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    delete: (key) => values.delete(key),
    deleteIf: (key, predicate) => {
      const value = values.get(key);
      return value !== undefined && predicate(value) && values.delete(key);
    },
    entries: () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
    clear: () => values.clear(),
  };
}

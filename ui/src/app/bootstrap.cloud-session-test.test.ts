import { describe, expect, it, vi } from "vitest";
import { bootstrapApplication } from "./bootstrap.ts";
import { createApplicationCloudSessionTest } from "./cloud-session-test.ts";
import { loadSettings, saveSettings } from "./settings.ts";

describe("application cloud test lifetime", () => {
  it.each([false, true])(
    "cannot initialize a late cloud page after disposal (previously initialized: %s)",
    (initialize) => {
      const previousSettings = loadSettings();
      const runtime = bootstrapApplication({
        sessionPathBuilderReady: new Promise<void>(() => {}),
      });
      const create = vi.fn(createApplicationCloudSessionTest);
      const subscribe = vi.spyOn(runtime.context.gateway, "subscribe");
      try {
        const observer = initialize ? runtime.context.getCloudSessionTest(create) : null;
        const dispose = observer ? vi.spyOn(observer, "dispose") : null;
        if (initialize) {
          // Returning to Settings reuses the observer instead of attaching another one.
          expect(runtime.context.getCloudSessionTest(create)).toBe(observer);
          expect(subscribe).toHaveBeenCalledTimes(1);
        }

        runtime.stop();
        const subscriptionsAfterStop = subscribe.mock.calls.length;
        expect(runtime.context.getCloudSessionTest(create)).toBeNull();
        expect(subscribe).toHaveBeenCalledTimes(subscriptionsAfterStop);
        expect(create).toHaveBeenCalledTimes(initialize ? 1 : 0);
        if (dispose) {
          expect(dispose).toHaveBeenCalledTimes(1);
          expect(observer?.state).toBeNull();
          expect(observer?.canStart).toBe(false);
        }
      } finally {
        runtime.stop();
        subscribe.mockRestore();
        saveSettings(previousSettings);
      }
    },
  );
});

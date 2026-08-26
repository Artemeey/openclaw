/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import "./app-host.ts";
import type { ApplicationContext } from "./context.ts";
import { resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings } from "./settings.ts";

type ShellServerPreferencesState = {
  runtime: { context: ApplicationContext };
  reconcileServerUiPrefs: (runtimeConfig: ApplicationContext["runtimeConfig"]) => void;
};

function createPreferenceContext(
  gatewayUrl: string,
  request: ReturnType<typeof vi.fn>,
  config: Record<string, unknown>,
) {
  const state = {
    connected: true,
    client: { request, gatewayUrl },
    configSnapshot: { config, hash: "config-hash" },
  };
  const runtimeConfig = { state } as unknown as ApplicationContext["runtimeConfig"];
  const context = {
    gateway: {
      connection: { gatewayUrl },
      snapshot: { selfUser: { id: "profile-ada" } },
    },
    navigation: { update: vi.fn() },
    theme: { recordServerSelection: vi.fn(), refresh: vi.fn(), serverSelection: null },
    runtimeConfig,
  } as unknown as ApplicationContext;
  return { context, runtimeConfig, state };
}

function createShell(context: ApplicationContext): ShellServerPreferencesState {
  const shell = document.createElement(
    "openclaw-app-shell",
  ) as unknown as ShellServerPreferencesState;
  shell.runtime = { context };
  return shell;
}

describe("OpenClaw shell profile preferences", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    resetServerUiPrefsSync();
  });

  afterEach(() => {
    resetServerUiPrefsSync();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses canonical profile locale provenance and clears a stale local pin", async () => {
    localStorage.setItem("openclaw.i18n.locale", "fr");
    const setLocale = vi.spyOn(i18n, "setLocale").mockResolvedValue();
    const useSystemLocale = vi.spyOn(i18n, "useSystemLocale").mockResolvedValue();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: "ok",
        entries: { "ui.migratedFromConfigPrefsV1": true, "ui.locale": "de" },
      })
      .mockResolvedValueOnce({
        status: "ok",
        entries: { "ui.migratedFromConfigPrefsV1": true },
      });
    const { context, runtimeConfig, state } = createPreferenceContext("ws://locale.test", request, {
      ui: { prefs: { locale: "de" } },
    });
    const shell = createShell(context);

    shell.reconcileServerUiPrefs(runtimeConfig);
    await vi.waitFor(() => expect(setLocale).toHaveBeenCalledExactlyOnceWith("de"));

    state.configSnapshot = {
      config: { ui: { prefs: {} } },
      hash: "locale-config-cleared-hash",
    };
    shell.reconcileServerUiPrefs(runtimeConfig);
    await vi.waitFor(() => expect(useSystemLocale).toHaveBeenCalledOnce());

    expect(loadSettings().locale).toBeUndefined();
  });

  it("publishes authored theme changes when the local mirror needs no patch", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: "ok",
        entries: { "ui.migratedFromConfigPrefsV1": true, "ui.theme": "custom" },
      })
      .mockResolvedValueOnce({
        status: "ok",
        entries: { "ui.migratedFromConfigPrefsV1": true, "ui.theme": "claw" },
      });
    const { context, runtimeConfig, state } = createPreferenceContext("ws://theme.test", request, {
      ui: { prefs: { theme: "custom" } },
    });
    const shell = createShell(context);

    shell.reconcileServerUiPrefs(runtimeConfig);
    await vi.waitFor(() =>
      expect(context.theme.recordServerSelection).toHaveBeenLastCalledWith(
        "custom",
        "ws://theme.test#profile-ada",
      ),
    );

    state.configSnapshot = {
      config: { ui: { prefs: { theme: "claw" } } },
      hash: "theme-claw",
    };
    shell.reconcileServerUiPrefs(runtimeConfig);
    await vi.waitFor(() =>
      expect(context.theme.recordServerSelection).toHaveBeenLastCalledWith(
        "claw",
        "ws://theme.test#profile-ada",
      ),
    );
    expect(loadSettings().theme).toBe("claw");
  });
});

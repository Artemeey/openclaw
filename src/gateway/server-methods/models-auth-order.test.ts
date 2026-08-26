import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import { testing as externalAuthTesting } from "../../agents/auth-profiles/external-auth.test-support.js";
import { loadPersistedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/runtime-snapshots.js";
import {
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
} from "../../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../../agents/auth-profiles/store.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { resolveModelAuthProfileOrder, updateModelAuthProfileOrder } from "./models-auth-order.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("updateModelAuthProfileOrder", () => {
  it("reports an alias-configured fallback behind a canonical stored override", () => {
    const cfg = {
      auth: { order: { "gmi-cloud": ["gmi:one", "gmi:two"] } },
    } satisfies OpenClawConfig;
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "gmi:one": { type: "api_key", provider: "gmi", key: "one" },
        "gmi:two": { type: "api_key", provider: "gmi", key: "two" },
      },
      order: { gmi: ["gmi:two", "gmi:one"] },
    };

    const order = resolveModelAuthProfileOrder(cfg, store, "gmi-cloud", "gmi", { config: cfg });

    expect(order.effective).toEqual(["gmi:two", "gmi:one"]);
    expect(order.configured).toEqual(["gmi:one", "gmi:two"]);
  });

  it("does not report an alias-configured order on a canonical status route", () => {
    const cfg = {
      auth: { order: { "gmi-cloud": ["gmi:two", "gmi:one"] } },
    } satisfies OpenClawConfig;
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "gmi:one": { type: "api_key", provider: "gmi", key: "one" },
        "gmi:two": { type: "api_key", provider: "gmi", key: "two" },
      },
    };

    const order = resolveModelAuthProfileOrder(cfg, store, "gmi", "gmi", { config: cfg });

    expect(order.effective).toBeUndefined();
    expect(order.configured).toBeUndefined();
    expect(order.orderProvider).toBe("gmi");
  });

  it("reports an alias-configured order on that exact alias route", () => {
    const cfg = {
      auth: { order: { "gmi-cloud": ["gmi:two", "gmi:one"] } },
    } satisfies OpenClawConfig;
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "gmi:one": { type: "api_key", provider: "gmi", key: "one" },
        "gmi:two": { type: "api_key", provider: "gmi", key: "two" },
      },
    };

    const order = resolveModelAuthProfileOrder(cfg, store, "gmi-cloud", "gmi", { config: cfg });

    expect(order.effective).toEqual(["gmi:two", "gmi:one"]);
    expect(order.configured).toEqual(["gmi:two", "gmi:one"]);
    expect(order.orderProvider).toBe("gmi-cloud");
  });

  it("rejects a reorder when runtime-external membership changes before the locked update", async () => {
    const stateDir = tempDirs.make("openclaw-auth-order-external-cas-");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const cfg = {
      models: {
        providers: {
          fixture: { baseUrl: "https://fixture.invalid", models: [] },
        },
      },
    } satisfies OpenClawConfig;

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      fs.mkdirSync(agentDir, { recursive: true });
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "fixture:a": { type: "api_key", provider: "fixture", key: "a" },
            "fixture:b": { type: "api_key", provider: "fixture", key: "b" },
          },
        },
        agentDir,
      );
      let externalReadCount = 0;
      const externalReadTransactionStates: boolean[] = [];
      externalAuthTesting.setResolveExternalAuthProfilesForTest(() => {
        externalReadCount += 1;
        externalReadTransactionStates.push(
          openOpenClawAgentDatabase({
            agentId: resolveAuthProfileDatabaseOwnerId(agentDir),
            path: resolveAuthProfileDatabasePath(agentDir),
          }).db.isTransaction,
        );
        return externalReadCount === 1
          ? []
          : [
              {
                profileId: "fixture:c",
                credential: {
                  type: "oauth",
                  provider: "fixture",
                  access: "external-access",
                  refresh: "external-refresh",
                  expires: Date.now() + 60_000,
                },
                persistence: "runtime-only",
              },
            ];
      });

      const result = await updateModelAuthProfileOrder({
        agentDir,
        agentId: "main",
        authProvider: "fixture",
        cfg,
        expectedProfileIds: null,
        expectedProfileMembership: ["fixture:a", "fixture:b"],
        profileIds: ["fixture:b", "fixture:a"],
        provider: "fixture",
      });

      expect(result).toEqual({ ok: false, reason: "conflict" });
      expect(externalReadCount).toBe(2);
      expect(externalReadTransactionStates).toEqual([false, false]);
      expect(loadPersistedAuthProfileStore(agentDir)?.order).toBeUndefined();
    });
  });
});

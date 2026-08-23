// Covers `models auth order get/set/clear`: read targeting, store writes, and gateway refresh.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  setAuthProfileOrder: vi.fn(),
  loadModelsConfig: vi.fn(),
  resolveModelsTargetAgent: vi.fn((_cfg: OpenClawConfig, rawAgentId?: string) => ({
    agentId: rawAgentId ?? "main",
    agentDir: `/tmp/agent-${rawAgentId ?? "main"}`,
  })),
  refreshRunningGatewayAuthState: vi.fn(async () => undefined),
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
    listProfilesForProvider: (store: AuthProfileStore, provider: string) =>
      Object.entries(store.profiles)
        .filter(([, credential]) => credential.provider === provider)
        .map(([profileId]) => profileId),
    setAuthProfileOrder: mocks.setAuthProfileOrder,
    externalCliDiscoveryForProviderAuth: (params: { provider: string }) => ({
      mode: "scoped",
      providerIds: [params.provider],
    }),
    resolveAuthStatePathForDisplay: (agentDir: string) => `${agentDir}/auth-profiles.json`,
  };
});

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    resolveModelsTargetAgent: mocks.resolveModelsTargetAgent,
  };
});

vi.mock("./auth-refresh.js", () => ({
  refreshRunningGatewayAuthState: mocks.refreshRunningGatewayAuthState,
}));

const { modelsAuthOrderClearCommand, modelsAuthOrderGetCommand, modelsAuthOrderSetCommand } =
  await import("./auth-order.js");

function createRuntime(): RuntimeEnv & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    log: (message: string) => {
      logs.push(message);
    },
    error: () => {},
  } as unknown as RuntimeEnv & { logs: string[] };
}

function storeWith(profileIds: string[], order?: string[]): AuthProfileStore {
  return {
    version: 1,
    profiles: Object.fromEntries(
      profileIds.map((profileId) => [
        profileId,
        { type: "oauth" as const, provider: profileId.split(":")[0] ?? "anthropic", access: "tok" },
      ]),
    ),
    ...(order ? { order: { anthropic: order } } : {}),
  } as unknown as AuthProfileStore;
}

describe("models auth order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadModelsConfig.mockResolvedValue({} as OpenClawConfig);
    mocks.ensureAuthProfileStore.mockReturnValue(
      storeWith(["anthropic:a", "anthropic:b"], ["anthropic:a"]),
    );
    mocks.setAuthProfileOrder.mockResolvedValue({
      ok: true,
      value: storeWith(["anthropic:a", "anthropic:b"], ["anthropic:b", "anthropic:a"]),
    });
  });

  it("get resolves an omitted agent through the read target", async () => {
    const runtime = createRuntime();
    await modelsAuthOrderGetCommand({ provider: "anthropic" }, runtime);

    expect(mocks.resolveModelsTargetAgent).toHaveBeenCalledWith(expect.anything(), undefined, {
      kind: "read",
    });
    expect(runtime.logs).toContain("Agent: main");
  });

  it("set writes the store order and refreshes a running gateway", async () => {
    const runtime = createRuntime();
    await modelsAuthOrderSetCommand(
      { provider: "anthropic", agent: "ops", order: ["anthropic:b", "anthropic:a"] },
      runtime,
    );

    expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith({
      agentDir: "/tmp/agent-ops",
      provider: "anthropic",
      order: ["anthropic:b", "anthropic:a"],
      authAliasLookupParams: { config: {} },
      expectedOrder: ["anthropic:a"],
      expectedOrderProvider: "anthropic",
      expectedProviderProfileIds: ["anthropic:a", "anthropic:b"],
      externalCli: { mode: "scoped", providerIds: ["anthropic"] },
    });
    expect(mocks.resolveModelsTargetAgent).toHaveBeenCalledWith(expect.anything(), "ops", {
      kind: "mutation",
    });
    expect(mocks.refreshRunningGatewayAuthState).toHaveBeenCalledWith("ops");
    expect(runtime.logs).toContain("Auth profile order override: anthropic:b, anthropic:a");
  });

  it("accepts alias-provider profiles and reports the canonical stored order", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "xai:a": { type: "oauth", provider: "xai", access: "tok" },
      },
    });
    mocks.setAuthProfileOrder.mockResolvedValue({
      ok: true,
      value: {
        version: 1,
        profiles: {},
        order: { xai: ["xai:a"] },
      },
    });
    const runtime = createRuntime();

    await modelsAuthOrderSetCommand({ provider: "x-ai", order: ["xai:a"] }, runtime);

    expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith({
      agentDir: "/tmp/agent-main",
      provider: "xai",
      order: ["xai:a"],
      authAliasLookupParams: { config: {} },
      expectedOrder: null,
      expectedProviderProfileIds: ["xai:a"],
      externalCli: { mode: "scoped", providerIds: ["x-ai"] },
    });
    expect(runtime.logs).toContain("Auth profile order override: xai:a");
  });

  it("clear removes the store order and refreshes a running gateway", async () => {
    const runtime = createRuntime();
    await modelsAuthOrderClearCommand({ provider: "anthropic" }, runtime);

    expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith({
      agentDir: "/tmp/agent-main",
      provider: "anthropic",
      order: null,
      authAliasLookupParams: { config: {} },
      expectedOrder: ["anthropic:a"],
      expectedOrderProvider: "anthropic",
      expectedProviderProfileIds: ["anthropic:a", "anthropic:b"],
      externalCli: { mode: "scoped", providerIds: ["anthropic"] },
    });
    expect(mocks.resolveModelsTargetAgent).toHaveBeenCalledWith(expect.anything(), undefined, {
      kind: "mutation",
    });
    expect(mocks.refreshRunningGatewayAuthState).toHaveBeenCalledWith("main");
    expect(runtime.logs.some((line) => line.includes("Auth profile order override cleared"))).toBe(
      true,
    );
  });

  it("sets a new order from an explicitly empty stored order", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue(storeWith(["anthropic:a", "anthropic:b"], []));

    await modelsAuthOrderSetCommand(
      { provider: "anthropic", order: ["anthropic:b", "anthropic:a"] },
      createRuntime(),
    );

    expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrder: [],
        expectedOrderProvider: "anthropic",
      }),
    );
  });

  it("clears an explicitly empty stored order without changing its CAS baseline", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue(storeWith(["anthropic:a", "anthropic:b"], []));

    await modelsAuthOrderClearCommand({ provider: "anthropic" }, createRuntime());

    expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrder: [],
        expectedOrderProvider: "anthropic",
      }),
    );
  });

  it.each(["set", "clear"] as const)(
    "%s includes runtime-external accounts in its membership baseline",
    async (action) => {
      const store = storeWith(["anthropic:a", "anthropic:cli"], ["anthropic:a"]);
      store.runtimeExternalProfileIds = ["anthropic:cli"];
      mocks.ensureAuthProfileStore.mockReturnValue(store);

      if (action === "set") {
        await modelsAuthOrderSetCommand(
          { provider: "anthropic", order: ["anthropic:cli", "anthropic:a"] },
          createRuntime(),
        );
      } else {
        await modelsAuthOrderClearCommand({ provider: "anthropic" }, createRuntime());
      }

      expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedProviderProfileIds: ["anthropic:a", "anthropic:cli"],
        }),
      );
    },
  );

  it("does not refresh the gateway when the store update fails", async () => {
    mocks.setAuthProfileOrder.mockResolvedValue({ ok: false, error: "store-update-failed" });

    await expect(
      modelsAuthOrderSetCommand({ provider: "anthropic", order: ["anthropic:a"] }, createRuntime()),
    ).rejects.toThrow("Failed to update auth state");
    expect(mocks.refreshRunningGatewayAuthState).not.toHaveBeenCalled();
  });
});

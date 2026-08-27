import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { EMPTY_MODEL_PROVIDERS_DATA, type ModelProvidersData } from "./load.ts";
import {
  ProfileOrderController,
  readProviderProfileMutationAccess,
  type ProfileOrderDrafts,
} from "./profile-order-controller.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

function createHarness() {
  const requests: Array<ReturnType<typeof createDeferred<unknown>>> = [];
  const request = vi.fn((method: string): Promise<unknown> => {
    if (method === "models.authOrderSet") {
      const pending = createDeferred<unknown>();
      requests.push(pending);
      return pending.promise;
    }
    return Promise.resolve({});
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot = {
    client,
    phase: "connected",
    hello: gatewayHelloForMethods([
      "models.authCooldownClear",
      "models.authLogout",
      "models.authOrderSet",
    ]),
  } as ApplicationGatewaySnapshot;
  let data: ModelProvidersData = {
    ...EMPTY_MODEL_PROVIDERS_DATA,
    config: {},
    authStatus: {
      ts: 1,
      providers: [
        {
          provider: "openai",
          authProvider: "openai",
          displayName: "OpenAI",
          status: "ok",
          profiles: [
            { profileId: "openai:one", type: "oauth", status: "ok" },
            { profileId: "openai:two", type: "oauth", status: "ok" },
          ],
          profileOrder: ["openai:one", "openai:two"],
        },
      ],
    },
  };
  let drafts: ProfileOrderDrafts = {};
  let current = { agentEpoch: 1, agentId: "main", clientEpoch: 1 };
  const busy: Record<string, boolean> = {};
  const refresh = vi.fn<() => Promise<void>>(async () => undefined);
  const setMessage = vi.fn();
  const prepareForMutation = vi.fn();
  const controller = new ProfileOrderController({
    snapshot: () => snapshot,
    current: () => current,
    isBusy: (key) => Boolean(busy[key]),
    isCurrentClient: (candidate, epoch) => candidate === client && epoch === 1,
    prepareForMutation,
    refresh,
    clearProbe: vi.fn(),
    getData: () => data,
    setData: (next) => {
      data = next;
    },
    getDrafts: () => drafts,
    setDrafts: (next) => {
      drafts = next;
    },
    setBusy: (key, value) => {
      busy[key] = value;
    },
    setMessage,
  });
  return {
    busy,
    controller,
    getData: () => data,
    getDrafts: () => drafts,
    prepareForMutation,
    refresh,
    request,
    requests,
    setCurrent: (next: typeof current) => {
      current = next;
    },
    setMessage,
  };
}

describe("ProfileOrderController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows only profile mutations advertised by the connected gateway", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const snapshot = {
      client,
      phase: "connected",
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["models.authLogout"] },
      },
    } as ApplicationGatewaySnapshot;

    expect(readProviderProfileMutationAccess(snapshot, "main")).toEqual({
      profileCanReorder: false,
      profileCanLogout: true,
      profileCanClearCooldown: false,
    });
  });

  it("renders a reorder immediately and saves it against the visible snapshot", async () => {
    const { controller, getData, getDrafts, refresh, request, requests } = createHarness();

    controller.queue("openai", ["openai:two", "openai:one"]);

    expect(controller.buildCards(getData())[0]?.profileOrder).toEqual(["openai:two", "openai:one"]);
    expect(getDrafts()).toEqual({ openai: ["openai:two", "openai:one"] });
    expect(request).toHaveBeenCalledWith("models.authOrderSet", {
      provider: "openai",
      profileIds: ["openai:two", "openai:one"],
      expectedProfileIds: ["openai:one", "openai:two"],
      expectedProfileMembership: ["openai:one", "openai:two"],
      agentId: "main",
    });

    requests[0]?.resolve({});
    await controller.waitFor("openai");

    expect(getDrafts()).toEqual({});
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("saves an alias-backed order through its resolved mutation route", async () => {
    const { controller, getData, request, requests } = createHarness();
    Object.assign(getData().authStatus!.providers[0]!, {
      provider: "gmi",
      authProvider: "gmi",
      profiles: [
        { profileId: "gmi:one", type: "oauth", status: "ok" },
        { profileId: "gmi:two", type: "oauth", status: "ok" },
      ],
      profileOrder: ["gmi:one", "gmi:two"],
      profileOrderProvider: "gmi-cloud",
    });

    controller.queue("gmi-cloud", ["gmi:two", "gmi:one"]);

    expect(request).toHaveBeenCalledWith("models.authOrderSet", {
      provider: "gmi-cloud",
      profileIds: ["gmi:two", "gmi:one"],
      expectedProfileIds: ["gmi:one", "gmi:two"],
      expectedProfileMembership: ["gmi:one", "gmi:two"],
      agentId: "main",
    });
    requests[0]?.resolve({});
    await controller.waitFor("gmi");
  });

  it("keeps accepting reorders while saving and sends only the latest next order", async () => {
    const { controller, getData, request, requests } = createHarness();

    controller.queue("openai", ["openai:two", "openai:one"]);
    controller.queue("openai", ["openai:one", "openai:two"]);
    expect(request).toHaveBeenCalledTimes(1);

    requests[0]?.resolve({});
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenLastCalledWith(
      "models.authOrderSet",
      expect.objectContaining({
        profileIds: ["openai:one", "openai:two"],
        expectedProfileIds: ["openai:two", "openai:one"],
      }),
    );

    requests[1]?.resolve({});
    await controller.waitFor("openai");
    expect(getData().authStatus?.providers[0]?.profileOrder).toEqual(["openai:one", "openai:two"]);
  });

  it("restores automatic rotation optimistically", async () => {
    const { controller, getData, request, requests } = createHarness();

    controller.queue("openai", []);

    expect(controller.buildCards(getData())[0]?.profileOrders).toEqual({});
    expect(request).toHaveBeenCalledWith("models.authOrderSet", {
      provider: "openai",
      profileIds: null,
      expectedProfileIds: ["openai:one", "openai:two"],
      expectedProfileMembership: ["openai:one", "openai:two"],
      agentId: "main",
    });

    requests[0]?.resolve({});
    await controller.waitFor("openai");

    expect(getData().authStatus?.providers[0]?.profileOrder).toBeUndefined();
  });

  it("keeps the configured order visible when its post-reset refresh fails", async () => {
    const { controller, getData, refresh, requests, setMessage } = createHarness();
    const provider = getData().authStatus!.providers[0]!;
    Object.assign(provider, {
      profileOrder: ["openai:two", "openai:one"],
      profileOrderFallback: "config",
      profileOrderFallbackOrder: ["openai:one", "openai:two"],
    });
    refresh.mockRejectedValueOnce(new Error("refresh failed"));

    controller.queue("openai", []);
    expect(controller.buildCards(getData())[0]?.profileOrder).toEqual(["openai:one", "openai:two"]);
    requests[0]?.resolve({});
    await controller.waitFor("openai");

    expect(getData().authStatus?.providers[0]).toMatchObject({
      profileOrder: ["openai:one", "openai:two"],
    });
    expect(getData().authStatus?.providers[0]?.profileOrderFallback).toBeUndefined();
    expect(setMessage).toHaveBeenLastCalledWith("profiles:openai", {
      kind: "warning",
      text: "refresh failed",
    });
  });

  it("saves a reorder queued during the post-commit refresh", async () => {
    const refreshPending = createDeferred();
    const { controller, getData, getDrafts, refresh, request, requests } = createHarness();
    refresh.mockImplementationOnce(() => refreshPending.promise);

    controller.queue("openai", ["openai:two", "openai:one"]);
    requests[0]?.resolve({});
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());

    controller.queue("openai", ["openai:one", "openai:two"]);
    expect(request).toHaveBeenCalledTimes(1);
    refreshPending.resolve();

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    requests[1]?.resolve({});
    await controller.waitFor("openai");

    expect(getDrafts()).toEqual({});
    expect(getData().authStatus?.providers[0]?.profileOrder).toEqual(["openai:one", "openai:two"]);
  });

  it("rolls back to refreshed data and reports a failed save", async () => {
    const { controller, getDrafts, refresh, requests, setMessage } = createHarness();

    controller.queue("openai", ["openai:two", "openai:one"]);
    requests[0]?.reject(new Error("profile order changed"));
    await controller.waitFor("openai");

    expect(getDrafts()).toEqual({});
    expect(refresh).toHaveBeenCalledOnce();
    expect(setMessage).toHaveBeenLastCalledWith("profiles:openai", {
      kind: "error",
      text: "profile order changed",
    });
  });

  it("saves a reorder queued while a failed save refreshes", async () => {
    const refreshPending = createDeferred();
    const { controller, getData, refresh, request, requests } = createHarness();
    refresh.mockImplementationOnce(() => refreshPending.promise);

    controller.queue("openai", ["openai:two", "openai:one"]);
    requests[0]?.reject(new Error("profile order changed"));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());

    controller.queue("openai", ["openai:one", "openai:two"]);
    refreshPending.resolve();

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    requests[1]?.resolve({});
    await controller.waitFor("openai");

    expect(getData().authStatus?.providers[0]?.profileOrder).toEqual(["openai:one", "openai:two"]);
  });

  it("keeps a newer reorder when the in-flight save fails", async () => {
    const { controller, getData, request, requests } = createHarness();

    controller.queue("openai", ["openai:two", "openai:one"]);
    controller.queue("openai", ["openai:one", "openai:two"]);
    requests[0]?.reject(new Error("profile order changed"));

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    requests[1]?.resolve({});
    await controller.waitFor("openai");

    expect(getData().authStatus?.providers[0]?.profileOrder).toEqual(["openai:one", "openai:two"]);
  });

  it("waits for a pending order save before logging out", async () => {
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const { controller, request, requests } = createHarness();

    controller.queue("openai", ["openai:two", "openai:one"]);
    const logout = controller.requestLogout(
      "openai",
      "openai",
      "openai",
      "openai:one",
      "one@example.com",
      "Signed out",
    );
    await vi.waitFor(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
    expect(request).not.toHaveBeenCalledWith("models.authLogout", expect.anything());

    requests[0]?.resolve({});
    await logout;

    expect(request).toHaveBeenCalledWith("models.authLogout", {
      provider: "openai",
      profileIds: ["openai:one"],
      agentId: "main",
    });
  });

  it("does not log out another agent after the confirmed agent changes", async () => {
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const { controller, request, requests, setCurrent } = createHarness();

    controller.queue("openai", ["openai:two", "openai:one"]);
    const logout = controller.requestLogout(
      "openai",
      "openai",
      "openai",
      "openai:one",
      "one@example.com",
      "Signed out",
    );
    await vi.waitFor(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
    setCurrent({ agentEpoch: 2, agentId: "writer", clientEpoch: 1 });

    requests[0]?.resolve({});
    await logout;

    expect(request).not.toHaveBeenCalledWith("models.authLogout", expect.anything());
  });
});

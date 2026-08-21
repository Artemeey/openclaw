import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { EMPTY_MODEL_PROVIDERS_DATA, type ModelProvidersData } from "./load.ts";
import { ProfileOrderController, type ProfileOrderDrafts } from "./profile-order-controller.ts";

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
  const snapshot = { client, phase: "connected", hello: null } as ApplicationGatewaySnapshot;
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
  const busy: Record<string, boolean> = {};
  const refresh = vi.fn(async () => undefined);
  const setMessage = vi.fn();
  const prepareForMutation = vi.fn();
  const controller = new ProfileOrderController({
    snapshot: () => snapshot,
    current: () => ({ agentEpoch: 1, agentId: "main", clientEpoch: 1 }),
    canMutate: () => true,
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
    setMessage,
  };
}

describe("ProfileOrderController", () => {
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
});

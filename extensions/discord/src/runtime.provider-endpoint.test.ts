// Discord tests prove endpoint initialization happens before the runtime becomes visible.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sealEndpointMock, setRuntimeStoreMock } = vi.hoisted(() => ({
  sealEndpointMock: vi.fn(),
  setRuntimeStoreMock: vi.fn(),
}));

vi.mock("./provider-endpoint.js", () => ({
  sealDiscordProviderEndpoint: sealEndpointMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-store", () => ({
  createPluginRuntimeStore: () => ({
    setRuntime: setRuntimeStoreMock,
    tryGetRuntime: vi.fn(),
    getRuntime: vi.fn(),
  }),
}));

import { setDiscordRuntime } from "./runtime.js";

describe("Discord provider endpoint runtime ordering", () => {
  beforeEach(() => {
    sealEndpointMock.mockReset();
    setRuntimeStoreMock.mockReset();
  });

  it("seals the endpoint before exposing the Discord runtime", () => {
    const runtime = {} as Parameters<typeof setDiscordRuntime>[0];

    setDiscordRuntime(runtime);

    expect(sealEndpointMock).toHaveBeenCalledOnce();
    expect(setRuntimeStoreMock).toHaveBeenCalledWith(runtime);
    expect(sealEndpointMock.mock.invocationCallOrder[0]).toBeLessThan(
      setRuntimeStoreMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("does not expose the Discord runtime when endpoint input is invalid", () => {
    const cachedError = new Error("invalid private endpoint input");
    sealEndpointMock.mockImplementation(() => {
      throw cachedError;
    });

    const runtime = {} as Parameters<typeof setDiscordRuntime>[0];
    expect(() => setDiscordRuntime(runtime)).toThrow(cachedError);
    expect(() => setDiscordRuntime(runtime)).toThrow(cachedError);
    expect(sealEndpointMock).toHaveBeenCalledTimes(2);
    expect(setRuntimeStoreMock).not.toHaveBeenCalled();
  });
});

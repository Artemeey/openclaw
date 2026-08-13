// Discord tests cover private provider endpoint startup and request boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DISCORD_DEFAULT_REST_API_BASE_URL,
  type DiscordProviderEndpointDescriptor,
} from "./provider-endpoint.constants.js";
import { resetDiscordProviderEndpointForTest } from "./provider-endpoint.test-support.js";

const { fetchWithSsrFGuardMock, releaseMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  releaseMock: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

let providerEndpoint: typeof import("./provider-endpoint.js");
let RequestClient: typeof import("./internal/rest.js").RequestClient;
let setDiscordRuntime: typeof import("./runtime.js").setDiscordRuntime;

const TEST_DESCRIPTOR: DiscordProviderEndpointDescriptor = {
  restApiBaseUrl: "http://127.0.0.1:43123/custom/rest/v10/",
  gatewayBotUrl: "http://127.0.0.1:43123/custom/gateway-metadata",
  gatewayOrigin: "ws://127.0.0.1:43124",
};

function initializeProviderEndpoint(
  descriptor: DiscordProviderEndpointDescriptor = TEST_DESCRIPTOR,
) {
  providerEndpoint.setDiscordProviderEndpointDescriptor(descriptor);
  return providerEndpoint.getDiscordProviderEndpointRuntime();
}

function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("expected operation to throw");
}

describe("Discord provider endpoint runtime", () => {
  beforeEach(async () => {
    resetDiscordProviderEndpointForTest();
    vi.resetModules();
    fetchWithSsrFGuardMock.mockReset().mockResolvedValue({
      response: new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      }),
      release: releaseMock,
    });
    releaseMock.mockClear();
    providerEndpoint = await import("./provider-endpoint.js");
    ({ RequestClient } = await import("./internal/rest.js"));
    ({ setDiscordRuntime } = await import("./runtime.js"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is absent for missing input and preserves the live REST base", () => {
    expect(providerEndpoint.getDiscordProviderEndpointRuntime()).toBeUndefined();
    expect(DISCORD_DEFAULT_REST_API_BASE_URL).toBe("https://discord.com/api/v10");
  });

  it("stores three independent normalized anchors from the private bootstrap", () => {
    initializeProviderEndpoint();

    expect(providerEndpoint.getDiscordProviderEndpointRuntime()?.descriptor).toEqual({
      restApiBaseUrl: "http://127.0.0.1:43123/custom/rest/v10",
      gatewayBotUrl: TEST_DESCRIPTOR.gatewayBotUrl,
      gatewayOrigin: TEST_DESCRIPTOR.gatewayOrigin,
    });
  });

  it("does not read ambient endpoint variables while installing the Discord runtime", () => {
    vi.stubEnv("DISCORD_REST_API_BASE_URL", TEST_DESCRIPTOR.restApiBaseUrl);
    vi.stubEnv("DISCORD_GATEWAY_BOT_URL", TEST_DESCRIPTOR.gatewayBotUrl);
    vi.stubEnv("DISCORD_GATEWAY_ORIGIN", TEST_DESCRIPTOR.gatewayOrigin);

    setDiscordRuntime({} as Parameters<typeof setDiscordRuntime>[0]);

    expect(providerEndpoint.getDiscordProviderEndpointRuntime()).toBeUndefined();
  });

  it("keeps Discord runtime installation closed after caching invalid bootstrap input", () => {
    const cachedError = captureError(() =>
      initializeProviderEndpoint({
        ...TEST_DESCRIPTOR,
        restApiBaseUrl: "http://provider.example/custom/rest/v10",
      }),
    );
    const runtime = {} as Parameters<typeof setDiscordRuntime>[0];

    expect(() => setDiscordRuntime(runtime)).toThrow(cachedError);
    expect(providerEndpoint.getDiscordProviderEndpointRuntime()).toBeUndefined();
  });

  it("accepts exactly one bootstrap descriptor", () => {
    const first = initializeProviderEndpoint();
    const replacementDescriptor = {
      ...TEST_DESCRIPTOR,
      restApiBaseUrl: "http://127.0.0.1:43125/replacement/rest/v10",
    };

    expect(() => initializeProviderEndpoint(replacementDescriptor)).toThrow(
      /configured exactly once before startup/,
    );
    expect(providerEndpoint.getDiscordProviderEndpointRuntime()).toBe(first);
  });

  it("keeps an absent startup endpoint absent after the runtime seals the bootstrap", () => {
    setDiscordRuntime({} as Parameters<typeof setDiscordRuntime>[0]);

    expect(() => initializeProviderEndpoint()).toThrow(/configured exactly once before startup/);
    expect(providerEndpoint.getDiscordProviderEndpointRuntime()).toBeUndefined();
  });

  it("rejects aggregate bootstrap input larger than 8 KiB", () => {
    expect(() =>
      initializeProviderEndpoint({
        ...TEST_DESCRIPTOR,
        restApiBaseUrl: `https://provider.example/${"x".repeat(8 * 1024)}`,
      }),
    ).toThrow(/exceeds 8192 aggregate bytes/);
  });

  it("caches invalid bootstrap input instead of accepting a late replacement", () => {
    const firstError = captureError(() =>
      initializeProviderEndpoint({
        ...TEST_DESCRIPTOR,
        gatewayOrigin: "ws://provider.example",
      }),
    );
    const secondError = captureError(() => initializeProviderEndpoint());

    expect(firstError.message).toContain("WSS or loopback WS");
    expect(secondError).toBe(firstError);
    expect(providerEndpoint.getDiscordProviderEndpointRuntime()).toBeUndefined();
  });

  it.each([
    {
      descriptor: {
        ...TEST_DESCRIPTOR,
        restApiBaseUrl: "http://provider.example/custom/rest/v10",
      },
      expectedError: /HTTPS or loopback HTTP/,
    },
    {
      descriptor: {
        ...TEST_DESCRIPTOR,
        gatewayOrigin: "ws://provider.example",
      },
      expectedError: /WSS or loopback WS/,
    },
  ])("rejects insecure non-loopback anchors %#", ({ descriptor, expectedError }) => {
    expect(() => initializeProviderEndpoint(descriptor)).toThrow(expectedError);
  });

  it.each([
    "wss://10.0.0.8",
    "wss://[fd00::8]",
    "wss://localhost",
    "wss://169.254.169.254",
    "wss://metadata.google.internal",
  ])("rejects blocked WSS Gateway origin %s", (gatewayOrigin) => {
    expect(() => initializeProviderEndpoint({ ...TEST_DESCRIPTOR, gatewayOrigin })).toThrow(
      "Discord provider Gateway origin must not target a private/internal/special-use hostname or IP address",
    );
  });

  it.each(["wss://8.8.8.8", "wss://[2606:4700:4700::1111]"])(
    "allows public literal WSS Gateway origin %s",
    (gatewayOrigin) => {
      initializeProviderEndpoint({ ...TEST_DESCRIPTOR, gatewayOrigin });

      expect(providerEndpoint.getDiscordProviderEndpointRuntime()?.descriptor.gatewayOrigin).toBe(
        gatewayOrigin,
      );
    },
  );

  it("routes REST clients through the exact configured base", async () => {
    initializeProviderEndpoint();
    const ignoredFetch = vi.fn();
    const client = new RequestClient("test-token", {
      fetch: ignoredFetch,
      queueRequests: false,
    });

    await expect(
      client.post("/channels/123/messages", { body: { content: "hello" } }),
    ).resolves.toEqual({ ok: true });

    expect(ignoredFetch).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    const guarded = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(guarded.url).toBe("http://127.0.0.1:43123/custom/rest/v10/channels/123/messages");
    expect(guarded.maxRedirects).toBe(0);
    expect(guarded.requireHttps).toBe(false);
    expect(guarded.policy).toEqual({
      allowedOrigins: ["http://127.0.0.1:43123"],
    });
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it("preserves Request method, headers, body, signal, and duplex", async () => {
    initializeProviderEndpoint();
    const runtime = providerEndpoint.getDiscordProviderEndpointRuntime();
    if (!runtime) {
      throw new Error("expected endpoint runtime");
    }
    const controller = new AbortController();
    const request = new Request(`${TEST_DESCRIPTOR.restApiBaseUrl}messages`, {
      method: "POST",
      headers: { "x-provider-test": "present" },
      body: "streamed body",
      signal: controller.signal,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await runtime.fetch(request);

    const guarded = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(guarded.init.method).toBe("POST");
    expect(new Headers(guarded.init.headers).get("x-provider-test")).toBe("present");
    expect(guarded.init.duplex).toBe("half");
    expect(guarded.init.body).toBeInstanceOf(ReadableStream);
    expect(await new Response(guarded.init.body).text()).toBe("streamed body");
    expect(guarded.signal).toBe(guarded.init.signal);
    expect(guarded.signal.aborted).toBe(false);
    controller.abort();
    expect(guarded.signal.aborted).toBe(true);
  });

  it("rejects requests outside both explicit HTTP anchors", async () => {
    initializeProviderEndpoint();
    const runtime = providerEndpoint.getDiscordProviderEndpointRuntime();
    if (!runtime) {
      throw new Error("expected endpoint runtime");
    }

    await expect(runtime.fetch("http://127.0.0.1:43123/not-the-provider")).rejects.toThrow(
      /outside the configured endpoint boundaries/,
    );
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("allows provider attachment uploads only on the configured REST origin", () => {
    expect(
      providerEndpoint.resolveDiscordProviderAttachmentUploadGuard(
        "https://cdn.discord.test/upload",
      ),
    ).toBeUndefined();

    initializeProviderEndpoint();

    expect(
      providerEndpoint.resolveDiscordProviderAttachmentUploadGuard(
        "http://127.0.0.1:43123/upload/voice.ogg?signature=test",
      ),
    ).toEqual({
      maxRedirects: 0,
      policy: { allowedOrigins: ["http://127.0.0.1:43123"] },
      requireHttps: false,
    });
    for (const uploadUrl of [
      "http://127.0.0.1:43124/upload",
      "https://127.0.0.1:43123/upload",
      "http://user@127.0.0.1:43123/upload",
      "http://127.0.0.1:43123/upload#fragment",
    ]) {
      expect(() =>
        providerEndpoint.resolveDiscordProviderAttachmentUploadGuard(uploadUrl),
      ).toThrow();
    }
  });

  it("allows inbound media only at the provider REST origin without redirects", () => {
    expect(
      providerEndpoint.resolveDiscordProviderMediaDownloadGuard(
        "https://cdn.discordapp.com/attachment.png",
      ),
    ).toBeUndefined();

    initializeProviderEndpoint();

    expect(
      providerEndpoint.resolveDiscordProviderMediaDownloadGuard(
        "http://127.0.0.1:43123/custom/media/attachment.png",
      ),
    ).toEqual({
      maxRedirects: 0,
      policy: {
        allowedOrigins: ["http://127.0.0.1:43123"],
        hostnameAllowlist: ["127.0.0.1"],
      },
    });
    expect(
      providerEndpoint.resolveDiscordProviderMediaDownloadGuard(
        "https://cdn.discordapp.com/attachment.png",
      ),
    ).toBeUndefined();
  });
});

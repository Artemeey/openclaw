import { fetch as undiciFetch, Pool } from "undici";
import { describe, expect, it, vi } from "vitest";
import {
  PROXY_FIXTURE_HOST as TARGET_HOST,
  PROXY_FIXTURE_PAYLOAD as PAYLOAD,
  withProxyFixture,
} from "../../test-helpers/proxy-fixture.js";
import { fetchWithSsrFGuard } from "./fetch-guard.js";
import { createHttp1EnvHttpProxyAgent, createHttp1ProxyAgent } from "./undici-runtime.js";

const TARGET_URL = `https://${TARGET_HOST}/media`;

async function fetchPayload(
  dispatcher: ReturnType<typeof createHttp1ProxyAgent>,
  protocolProof?: Promise<void>,
) {
  try {
    await Promise.all([
      undiciFetch(TARGET_URL, { dispatcher, signal: AbortSignal.timeout(5_000) }).then(
        async (response) => {
          expect(await response.text()).toBe(PAYLOAD);
        },
      ),
      protocolProof,
    ]);
  } finally {
    await dispatcher.destroy();
  }
}

describe("SOCKS proxy protocol boundaries", () => {
  it.each(["socks:", "socks5:"])(
    "keeps %s proxies plaintext with generated timeout/family defaults",
    async (protocol) => {
      await withProxyFixture(async ({ socksProxy, connections, certificate }) => {
        await fetchPayload(
          createHttp1ProxyAgent(
            { uri: socksProxy.replace("socks5:", protocol), requestTls: { ca: certificate } },
            5_000,
          ),
        );
        expect(connections).toEqual([`socks:${TARGET_HOST}`]);
      });
    },
  );

  it("preserves explicitly requested SOCKS-over-TLS", async () => {
    await withProxyFixture(async ({ tlsSocksProxy, connections, certificate }) => {
      await fetchPayload(
        createHttp1ProxyAgent(
          {
            uri: tlsSocksProxy,
            proxyTls: { ca: certificate, servername: TARGET_HOST },
            requestTls: { ca: certificate },
          },
          5_000,
        ),
      );
      expect(connections).toEqual([`socks:${TARGET_HOST}`]);
    });
  });

  it("keeps env SOCKS plaintext without changing HTTPS proxy CA trust in mixed settings", async () => {
    await withProxyFixture(
      async ({
        socksProxy,
        httpsProxy,
        connections,
        certificate,
        waitForProxyProtocol,
        waitForSocketsClosed,
      }) => {
        await fetchPayload(
          createHttp1EnvHttpProxyAgent(
            { httpsProxy: socksProxy, noProxy: "", requestTls: { ca: certificate } },
            5_000,
          ),
        );
        await fetchPayload(
          createHttp1EnvHttpProxyAgent(
            {
              httpProxy: socksProxy,
              httpsProxy,
              noProxy: "",
              proxyTls: { ca: certificate },
              requestTls: { ca: certificate },
            },
            5_000,
          ),
          waitForProxyProtocol().then((protocol) => {
            expect(protocol).toBe("http/1.1");
          }),
        );
        expect(connections).toEqual([`socks:${TARGET_HOST}`, `https:${TARGET_HOST}`]);
        await waitForSocketsClosed();
      },
    );
  });

  it.each(["explicit", "environment", "custom"])(
    "uses HTTP/1 and preserves TLS trust through an %s HTTPS proxy",
    async (mode) => {
      await withProxyFixture(
        async ({
          httpsProxy,
          certificate,
          connections,
          waitForProxyProtocol,
          waitForSocketsClosed,
        }) => {
          const clientFactory = vi.fn((origin: URL, options: object) => new Pool(origin, options));
          const options = {
            proxyTls: {
              ca: certificate,
              ...(mode === "custom" ? { allowH2: false, servername: TARGET_HOST } : {}),
            },
            requestTls: { ca: certificate },
          };
          const dispatcher =
            mode === "environment"
              ? createHttp1EnvHttpProxyAgent({ ...options, httpsProxy, noProxy: "" }, 5_000)
              : createHttp1ProxyAgent(
                  { ...options, uri: httpsProxy, ...(mode === "custom" ? { clientFactory } : {}) },
                  5_000,
                );
          await fetchPayload(
            dispatcher,
            waitForProxyProtocol().then((protocol) => {
              expect(protocol).toBe("http/1.1");
            }),
          );
          expect(connections).toEqual([`https:${TARGET_HOST}`]);
          if (mode === "custom") {
            expect(clientFactory).toHaveBeenCalledOnce();
          }
          await waitForSocketsClosed();
        },
      );
    },
  );

  it.each(["http", "socks"])(
    "allows trusted explicit %s media without target DNS but preserves target and redirect policy",
    async (kind) => {
      await withProxyFixture(async ({ httpProxy, socksProxy, connections, certificate }) => {
        const lookupFn = vi.fn(async (hostname: string) => {
          if (hostname === "127.0.0.1") {
            return [{ address: hostname, family: 4 }];
          }
          throw Object.assign(new Error("target DNS unavailable"), { code: "EAI_AGAIN" });
        });
        const options = {
          mode: "trusted_explicit_proxy" as const,
          dispatcherPolicy: {
            mode: "explicit-proxy" as const,
            proxyUrl: kind === "http" ? httpProxy : socksProxy,
            allowPrivateProxy: true,
            proxyTls: { ca: certificate },
          },
          policy: { hostnameAllowlist: [TARGET_HOST] },
          lookupFn,
          timeoutMs: 5_000,
        };
        const result = await fetchWithSsrFGuard({ ...options, url: TARGET_URL });
        try {
          expect(await result.response.text()).toBe(PAYLOAD);
        } finally {
          await result.release();
        }
        for (const url of [
          "https://outside.proxy.test/media",
          "https://127.0.0.1/media",
          `https://${TARGET_HOST}/redirect`,
        ]) {
          await expect(fetchWithSsrFGuard({ ...options, url })).rejects.toThrow("not in allowlist");
        }
        await expect(
          fetchWithSsrFGuard({
            ...options,
            url: "https://127.0.0.1/media",
            policy: undefined,
          }),
        ).rejects.toThrow(/private|internal/i);
        await expect(
          fetchWithSsrFGuard({
            ...options,
            url: TARGET_URL,
            dispatcherPolicy: { ...options.dispatcherPolicy, allowPrivateProxy: false },
          }),
        ).rejects.toThrow(/private|internal/i);
        expect(lookupFn.mock.calls.every(([hostname]) => hostname === "127.0.0.1")).toBe(true);
        expect(connections).toEqual([`${kind}:${TARGET_HOST}`, `${kind}:${TARGET_HOST}`]);
      });
    },
  );

  it("does not widen strict-mode SOCKS proxy policy", async () => {
    await withProxyFixture(async ({ socksProxy, connections }) => {
      await expect(
        fetchWithSsrFGuard({
          url: TARGET_URL,
          dispatcherPolicy: {
            mode: "explicit-proxy",
            proxyUrl: socksProxy,
            allowPrivateProxy: true,
          },
        }),
      ).rejects.toThrow("Explicit proxy URL must use http or https");
      expect(connections).toEqual([]);
    });
  });
});

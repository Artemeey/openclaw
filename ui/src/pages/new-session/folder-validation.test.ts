import { describe, expect, it, vi } from "vitest";
import { GatewayBrowserClient, GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { RestoredFolderValidation } from "./folder-validation.ts";

async function expectFolderFailure(error: GatewayRequestError, missing: boolean) {
  const client = new GatewayBrowserClient({ url: "ws://gateway.example.test" });
  const request = vi.spyOn(client, "request").mockRejectedValue(error);
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const callbacks = {
    isCurrent: () => true,
    onFound: vi.fn(),
    onMissing: vi.fn(),
    onFailure: vi.fn(),
  };
  const validation = new RestoredFolderValidation();
  validation.check(snapshot, "/work/project", true, callbacks);
  await vi.waitFor(() =>
    expect(missing ? callbacks.onMissing : callbacks.onFailure).toHaveBeenCalledOnce(),
  );
  expect(missing ? callbacks.onFailure : callbacks.onMissing).not.toHaveBeenCalled();
  expect(callbacks.onFound).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledWith("fs.listDir", { path: "/work/project" });
  if (!missing) {
    expect(validation.state).toBe("failed");
  }
}

describe("restored new-session folder validation", () => {
  it.each(["ENOENT: no such file or directory", "Error: ENOTDIR: not a directory"])(
    "recognizes a definitive stale path from %s",
    async (message) => {
      await expectFolderFailure(
        new GatewayRequestError({ code: "INVALID_REQUEST", message }),
        true,
      );
    },
  );

  it("keeps transient and unrelated request failures recoverable", async () => {
    for (const error of [
      new GatewayRequestError({ code: "UNAVAILABLE", message: "gateway restarting" }),
      new GatewayRequestError({ code: "INVALID_REQUEST", message: "EACCES: permission denied" }),
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Error: EACCES: permission denied, scandir '/work/: ENOENT:/project'",
      }),
    ]) {
      await expectFolderFailure(error, false);
    }
  });
});

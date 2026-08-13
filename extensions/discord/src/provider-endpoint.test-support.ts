import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { afterEach } from "vitest";
import {
  DISCORD_PROVIDER_ENDPOINT_BOOTSTRAP_STORE_KEY,
  type DiscordProviderEndpointDescriptor,
} from "./provider-endpoint.constants.js";

export function resetDiscordProviderEndpointForTest(): void {
  createPluginRuntimeStore<unknown>({
    key: DISCORD_PROVIDER_ENDPOINT_BOOTSTRAP_STORE_KEY,
    errorMessage: "Discord provider endpoint test bootstrap not initialized",
  }).clearRuntime();
}

afterEach(() => resetDiscordProviderEndpointForTest());

export async function initializeDiscordProviderEndpointForTest(
  descriptor: DiscordProviderEndpointDescriptor,
): Promise<void> {
  resetDiscordProviderEndpointForTest();
  const { setDiscordProviderEndpointDescriptor } = await import("../test-api.js");
  setDiscordProviderEndpointDescriptor(descriptor);
}

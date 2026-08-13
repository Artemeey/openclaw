export type DiscordProviderEndpointDescriptor = Readonly<{
  /** Complete versioned base URL for Discord REST routes. */
  restApiBaseUrl: string;
  /** Exact authenticated Gateway metadata URL. */
  gatewayBotUrl: string;
  /** Allowed WebSocket origin for initial and resumed Gateway connections. */
  gatewayOrigin: string;
}>;

export const DISCORD_PROVIDER_ENDPOINT_BOOTSTRAP_STORE_KEY = "discord-provider-endpoint-bootstrap";
export const DISCORD_DEFAULT_REST_API_BASE_URL = "https://discord.com/api/v10";

// Discord test API exposes transcript-provider fixtures without deep extension imports.
export {
  discordVoiceTranscriptsSourceProvider,
  setDiscordTranscriptsVoiceManager,
} from "./src/voice/transcripts-source.js";

// Discord test API exposes private QA/runtime fixtures.
export { setDiscordProviderEndpointDescriptor } from "./src/provider-endpoint.js";
export type { DiscordProviderEndpointDescriptor } from "./src/provider-endpoint.constants.js";

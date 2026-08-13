// Lazy handler loading and async handshake admission are consecutive pre-auth stages.
// Keep one queue ceiling so neither stage can drift into a weaker ingress policy.
export const MAX_QUEUED_GATEWAY_PREAUTH_FRAMES = 16;

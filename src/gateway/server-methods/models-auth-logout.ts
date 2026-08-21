import type { ChatAbortOps } from "../chat-abort.js";
import type { GatewayRequestContext } from "./types.js";

export { removeProviderAuthProfilesAcrossOwnerStores } from "../../agents/auth-profiles.js";

type LogoutProfileSelection = { ok: true; profileIds?: string[] } | { ok: false; message: string };

export function readLogoutProfileSelection(
  params: Record<string, unknown>,
): LogoutProfileSelection {
  if (!("profileIds" in params)) {
    return { ok: true };
  }
  if (!Array.isArray(params.profileIds) || params.profileIds.length === 0) {
    return { ok: false, message: "profileIds must be a non-empty string array" };
  }
  const profileIds: string[] = [];
  for (const value of params.profileIds) {
    if (typeof value !== "string" || !value.trim()) {
      return { ok: false, message: "profileIds must be a non-empty string array" };
    }
    const profileId = value.trim();
    if (!profileIds.includes(profileId)) {
      profileIds.push(profileId);
    }
  }
  return { ok: true, profileIds };
}

export function createAuthLogoutAbortOps(context: GatewayRequestContext): ChatAbortOps {
  return {
    chatAbortControllers: context.chatAbortControllers,
    chatRunState: context.chatRunState,
    removeChatRun: context.removeChatRun,
    agentRunSeq: context.agentRunSeq,
    broadcast: context.broadcast,
    nodeSendToSession: context.nodeSendToSession,
  };
}

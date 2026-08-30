import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listPairedDevicesReadOnly } from "../infra/device-pairing-store-readonly.js";
import { listBoundWebPushSubscriptions, type BoundWebPushSubscription } from "../infra/push-web.js";
import { resolveNotificationAuthority } from "./notification-authority.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const OPERATOR_ROLE = "operator";

export type CurrentWebPushTarget = {
  subscription: BoundWebPushSubscription;
  scopes: string[];
  userProfileId: string | null;
};

/** Reads every mutable authority fact in the caller's network-I/O continuation. */
export function listCurrentWebPushTargets(params: {
  cfg: OpenClawConfig;
  requiredScopes: readonly string[];
  stateDir?: string;
}): CurrentWebPushTarget[] {
  const pairedByDeviceId = new Map(
    listPairedDevicesReadOnly(params.stateDir).map((device) => [device.deviceId, device]),
  );
  return listBoundWebPushSubscriptions(params.stateDir).flatMap((subscription) => {
    const authority = resolveNotificationAuthority({
      userProfileId: subscription.userProfileId,
      device: pairedByDeviceId.get(subscription.deviceId),
      cfg: params.cfg,
      requiredScopes: params.requiredScopes,
    });
    return authority ? [{ subscription, ...authority }] : [];
  });
}

export function webPushTargetClient(target: CurrentWebPushTarget): GatewayWsClient {
  const client = {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        version: "web-push",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
      device: {
        id: target.subscription.deviceId,
        publicKey: "web-push",
        signature: "web-push",
        signedAt: 0,
        nonce: "web-push",
      },
      role: OPERATOR_ROLE,
      scopes: target.scopes,
    },
    ...(target.userProfileId
      ? {
          authenticatedUserProfile: {
            profileId: target.userProfileId,
            displayName: null,
            hasAvatar: false,
            updatedAt: 0,
          },
        }
      : {}),
  };
  // SAFETY: visibility checks read only the projected connection identity and scopes.
  return client as GatewayWsClient;
}

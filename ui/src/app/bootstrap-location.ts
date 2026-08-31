import type { RouteLocation } from "@openclaw/uirouter";
import type { AgentsListResult } from "../api/types.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { routeIdFromPath } from "../app-routes.ts";
import { pathForSession } from "../app-session-path-builder.ts";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import type { BoardFace } from "../lib/board/settings.ts";
import {
  SESSION_RESTORE_KEY_PARAM,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";
import { isDefaultChatLanding } from "../pages/model-setup/first-run.ts";
import type { ApplicationGateway } from "./context.ts";
import { waitForGatewayClient } from "./gateway-readiness.ts";

type ReleasedSessionQuery = {
  face: BoardFace;
  sessionKey: string;
};

function resolvePersistedAgentId(
  selectedAgentId: string | null | undefined,
  agentsList: AgentsListResult | null,
): string | null {
  const selectedId = selectedAgentId?.trim();
  if (!selectedId || !agentsList) {
    return null;
  }
  const normalizedId = normalizeAgentId(selectedId);
  return agentsList.agents.some((agent) => normalizeAgentId(agent.id) === normalizedId)
    ? normalizedId
    : null;
}

function releasedSessionQuery(
  location: RouteLocation,
  basePath: string,
): ReleasedSessionQuery | null {
  const params = new URLSearchParams(location.search);
  if (!params.has("session")) {
    return null;
  }
  const chatRoot = pathForRoute("chat", basePath);
  const dashboardRoot = pathForRoute("dashboard", basePath);
  const pathFace =
    location.pathname === chatRoot || location.pathname === `${chatRoot}/`
      ? "chat"
      : location.pathname === dashboardRoot || location.pathname === `${dashboardRoot}/`
        ? "dashboard"
        : null;
  if (!pathFace) {
    return null;
  }
  return {
    face: params.get("face") === "dashboard" ? "dashboard" : pathFace,
    sessionKey: params.get("session")?.trim() ?? "",
  };
}

async function normalizeReleasedSessionQueryLocation(params: {
  location: RouteLocation;
  basePath: string;
  gateway: Pick<ApplicationGateway, "snapshot" | "subscribe">;
  agentsList: () => AgentsListResult | null;
  selectedAgentId?: string | null;
  signal: AbortSignal;
}): Promise<RouteLocation | null> {
  const released = releasedSessionQuery(params.location, params.basePath);
  if (!released) {
    return null;
  }
  const defaultsKnown = Boolean(
    params.agentsList()?.mainKey?.trim() ||
    (params.gateway.snapshot.phase === "connected" && params.gateway.snapshot.hello),
  );
  const parsed = parseAgentSessionKey(released.sessionKey);
  if (released.sessionKey && !defaultsKnown) {
    await waitForGatewayClient(params.gateway, params.signal);
  }
  const defaults = {
    agentsList: params.agentsList(),
    hello: params.gateway.snapshot.hello,
  };
  const agentId =
    parsed?.agentId ??
    (resolvePersistedAgentId(params.selectedAgentId, defaults.agentsList) ||
      resolveUiDefaultAgentId(defaults));
  const mainKey = resolveUiConfiguredMainKey(defaults);
  const pathname = released.sessionKey
    ? pathForSession(released.face, agentId, released.sessionKey, params.basePath, {
        mainKey,
      })
    : null;
  const search = new URLSearchParams(params.location.search);
  search.delete("session");
  search.delete("face");
  const nextSearch = search.toString();
  return {
    ...params.location,
    pathname: pathname ?? pathForRoute(released.face, params.basePath),
    search: nextSearch ? `?${nextSearch}` : "",
  };
}

export function normalizeInitialApplicationLocation(
  location: RouteLocation,
  basePath: string,
  sessionKey: string,
  fallbackAgentId: string,
  mainKey?: string | null,
) {
  if (!isDefaultChatLanding(location, basePath, routeIdFromPath) || !sessionKey.trim()) {
    return location;
  }
  const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? fallbackAgentId.trim();
  if (!agentId) {
    return location;
  }
  const { options } = sessionNavigationTarget({
    face: "chat",
    sessionKey,
    fallbackAgentId: agentId,
    basePath,
    mainKey,
  });
  if (options.pathname === pathForRoute("chat", basePath)) {
    return location;
  }
  const search = new URLSearchParams(location.search);
  new URLSearchParams(options.search).forEach((value, key) => search.set(key, value));
  return { ...location, pathname: options.pathname, search: search.size ? `?${search}` : "" };
}

export async function resolveInitialApplicationLocation(params: {
  location: RouteLocation;
  basePath: string;
  sessionKey: string;
  gateway: Pick<ApplicationGateway, "snapshot" | "subscribe">;
  agentsList: () => AgentsListResult | null;
  selectedAgentId?: string | null;
  signal: AbortSignal;
}): Promise<RouteLocation> {
  const releasedLocation = await normalizeReleasedSessionQueryLocation(params);
  if (releasedLocation) {
    return releasedLocation;
  }
  if (!isDefaultChatLanding(params.location, params.basePath, routeIdFromPath)) {
    return params.location;
  }
  // Explicit routes must start immediately; only the implicit session landing
  // needs gateway defaults before its key and agent can be made authoritative.
  if (!parseAgentSessionKey(params.sessionKey)) {
    await waitForGatewayClient(params.gateway, params.signal);
  }
  const defaults = {
    agentsList: params.agentsList(),
    hello: params.gateway.snapshot.hello,
  };
  const sessionKey = params.sessionKey.trim() || params.gateway.snapshot.sessionKey;
  const defaultAgentId = resolveUiDefaultAgentId(defaults);
  const location = normalizeInitialApplicationLocation(
    params.location,
    params.basePath,
    sessionKey,
    resolvePersistedAgentId(params.selectedAgentId, defaults.agentsList) || defaultAgentId,
    resolveUiConfiguredMainKey(defaults),
  );
  const target = sessionRefFromPath(
    location.pathname,
    params.basePath,
    resolveUiConfiguredMainKey(defaults),
  );
  const knownDefaultMain =
    params.gateway.snapshot.phase === "connected" &&
    target?.kind === "main" &&
    target.agentId === defaultAgentId;
  if (!target || knownDefaultMain) {
    return location;
  }
  // A remembered selection is not an explicit link. Keep its full identity until
  // the route loader verifies it, so stale state and short-id collisions cannot win.
  const search = new URLSearchParams(location.search);
  search.set(SESSION_RESTORE_KEY_PARAM, sessionKey);
  return { ...location, search: `?${search}` };
}

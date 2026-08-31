import type { RouteLocation } from "@openclaw/uirouter";
import { notFound } from "@openclaw/uirouter";
import type { SessionsResolveResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { INTERNAL_SESSION_PATH_PARAM } from "../../app-route-paths.ts";
import { pathForSession } from "../../app-session-path-builder.ts";
import { sessionRefFromPath, type SessionPathTarget } from "../../app-session-route-paths.ts";
import { waitForGatewayClient } from "../../app/gateway-readiness.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import {
  buildCatalogSessionKey,
  catalogSessionKeyFromSearch,
} from "../../lib/sessions/catalog-key.ts";
import {
  consumeSessionNavigationHandoff,
  prepareSessionNavigationHandoff,
} from "../../lib/sessions/navigation-handoff.ts";
import {
  findUiSessionRow,
  resolveSessionNavigationAgentId,
  SESSION_FACE_PREFERENCE_PARAM,
  SESSION_NAVIGATION_KEY_PARAM,
  SESSION_RESTORE_KEY_PARAM,
} from "../../lib/sessions/route-navigation.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "../../lib/sessions/session-key.ts";
import { draftRouteDataFromLocation, draftSearchFromLocation } from "./route-draft.ts";
import { loadCatalogShareRouteFromLocation } from "./route-loader-catalog-share.ts";
import type { SessionRouteContext as ApplicationContext } from "./route-loader-context.ts";
import {
  missingSessionRouteData,
  querySessionReference,
  uniqueShortIdPrefix,
} from "./route-loader-session-reference.ts";
import { findCachedShortSession, sessionKeyUuid } from "./route-loader-short-cache.ts";
import {
  resolveShortSessionReference,
  type SessionReferenceResolution,
  type SessionRoutePresentation,
} from "./route-loader-short-resolve.ts";
import type { ChatRouteData, SessionRouteCandidate } from "./session-route-data.ts";

export type { ChatRouteData, SessionChatRouteData } from "./session-route-data.ts";

function isPreferenceDerivedFace(location: RouteLocation): boolean {
  return new URLSearchParams(location.search).get(SESSION_FACE_PREFERENCE_PARAM) === "1";
}

function locationWithoutSearchParams(location: RouteLocation, ...keys: string[]): RouteLocation {
  const params = new URLSearchParams(location.search);
  for (const key of keys) {
    params.delete(key);
  }
  const search = params.toString();
  return { ...location, search: search ? `?${search}` : "" };
}

function locationWithoutNavigationHints(location: RouteLocation): RouteLocation {
  return locationWithoutSearchParams(
    location,
    SESSION_FACE_PREFERENCE_PARAM,
    SESSION_NAVIGATION_KEY_PARAM,
    SESSION_RESTORE_KEY_PARAM,
  );
}

function preferredFace(row: Pick<GatewaySessionRow, "boardFace">): BoardFace {
  return row.boardFace === "dashboard" ? "dashboard" : "chat";
}

function configuredMainKey(context: ApplicationContext): string {
  return resolveUiConfiguredMainKey({
    agentsList: context.agents.state.agentsList,
    hello: context.gateway.snapshot.hello,
  });
}

function hasConfiguredMainKey(context: ApplicationContext): boolean {
  return Boolean(
    context.agents.state.agentsList?.mainKey?.trim() ||
    (context.gateway.snapshot.phase === "connected" && context.gateway.snapshot.hello),
  );
}

function canonicalMainLocation(
  context: ApplicationContext,
  location: RouteLocation,
  face: BoardFace,
  sessionKey: string,
): RouteLocation | null {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return null;
  }
  const mainKey = configuredMainKey(context).toLowerCase();
  const rest = parsed.rest.toLowerCase();
  if (rest !== mainKey) {
    return null;
  }
  const pathname = pathForSession(face, parsed.agentId, sessionKey, context.basePath, { mainKey });
  return pathname && pathname !== location.pathname
    ? { ...locationWithoutNavigationHints(location), pathname }
    : null;
}

function canonicalSessionLocation(params: {
  context: ApplicationContext;
  location: RouteLocation;
  face: BoardFace;
  row: SessionRoutePresentation;
  shortIdLength?: number;
}): RouteLocation | null | undefined {
  const face = params.face;
  const agentId = resolveAgentIdFromSessionKey(params.row.key);
  const pathname = pathForSession(face, agentId, params.row.key, params.context.basePath, {
    displayName: params.row.displayName,
    mainKey: configuredMainKey(params.context),
    shortIdLength: params.shortIdLength,
  });
  if (!pathname) {
    return undefined;
  }
  const location = locationWithoutNavigationHints(params.location);
  const changed =
    pathname !== params.location.pathname || location.search !== params.location.search;
  return changed ? { ...location, pathname } : null;
}

function targetFromLocation(context: ApplicationContext, location: RouteLocation) {
  const mainKey = configuredMainKey(context);
  const direct = sessionRefFromPath(location.pathname, context.basePath, mainKey);
  if (direct) {
    return { target: direct, location };
  }
  const internalPath = new URLSearchParams(location.search).get(INTERNAL_SESSION_PATH_PARAM);
  if (!internalPath) {
    return null;
  }
  const target = sessionRefFromPath(internalPath, context.basePath, mainKey);
  return target
    ? {
        target,
        location: {
          ...locationWithoutSearchParams(location, INTERNAL_SESSION_PATH_PARAM),
          pathname: internalPath,
        },
      }
    : null;
}

function mainSessionKey(
  context: ApplicationContext,
  target: Extract<SessionPathTarget, { kind: "main" }>,
): string {
  return buildAgentMainSessionKey({
    agentId: target.agentId,
    mainKey: configuredMainKey(context),
  });
}

function candidatesForResolution(
  context: ApplicationContext,
  face: BoardFace,
  resolution: Extract<SessionReferenceResolution, { kind: "ambiguous" }>,
  location: RouteLocation,
  preferenceDerived: boolean,
): SessionRouteCandidate[] {
  const resolvedRows = resolution.sessions.flatMap((row) => {
    const uuid = sessionKeyUuid(row.key);
    return uuid ? [{ row, uuid }] : [];
  });
  const uuids = resolvedRows.map(({ uuid }) => uuid);
  return resolvedRows.flatMap(({ row, uuid }) => {
    const prefix = uniqueShortIdPrefix(uuid, uuids, resolution.truncated);
    if (!prefix) {
      return [];
    }
    const agentId = resolveAgentIdFromSessionKey(row.key);
    const candidateFace = preferenceDerived ? preferredFace(row) : face;
    const href = pathForSession(candidateFace, agentId, row.key, context.basePath, {
      displayName: row.displayName,
      mainKey: configuredMainKey(context),
      shortIdLength: prefix.length,
    });
    return href
      ? [
          {
            agentId,
            displayName: row.displayName?.trim() || row.key,
            href: `${href}${draftSearchFromLocation(location)}`,
            idPrefix: prefix,
          },
        ]
      : [];
  });
}

function resolvedSessionRouteData(params: {
  context: ApplicationContext;
  location: RouteLocation;
  face: BoardFace;
  row: SessionRoutePresentation;
  preferenceDerived: boolean;
  shortId?: string;
}): Extract<ChatRouteData, { kind: "session" }> | null {
  // The loader owns face resolution: a preference-derived open adopts the row's stored
  // face, so the page renders that board directly and replaces the URL with the matching
  // namespace instead of re-deriving a face from the path it was handed.
  const face = params.preferenceDerived ? preferredFace(params.row) : params.face;
  const canonicalLocation = canonicalSessionLocation({
    context: params.context,
    location: params.location,
    face,
    row: params.row,
    ...(params.shortId ? { shortIdLength: params.shortId.length } : {}),
  });
  if (canonicalLocation === undefined) {
    return null;
  }
  return {
    kind: "session",
    sessionKey: params.row.key,
    ...draftRouteDataFromLocation(params.location),
    face,
    ...(params.shortId && params.shortId.length > 8 ? { shortId: params.shortId } : {}),
    ...(canonicalLocation ? { canonicalLocation, canonicalLocationSource: params.location } : {}),
  };
}

function resolvedMainSessionRouteData(params: {
  context: ApplicationContext;
  location: RouteLocation;
  face: BoardFace;
  row: SessionRoutePresentation;
  target: Extract<SessionPathTarget, { kind: "main" }>;
  preferenceDerived: boolean;
}): Extract<ChatRouteData, { kind: "session" }> | null {
  if (!isUiGlobalSessionKey(params.row.key)) {
    return resolvedSessionRouteData(params);
  }
  const face = params.preferenceDerived ? preferredFace(params.row) : params.face;
  const pathname = pathForSession(
    face,
    params.target.agentId,
    mainSessionKey(params.context, params.target),
    params.context.basePath,
    { mainKey: configuredMainKey(params.context) },
  );
  if (!pathname) {
    return null;
  }
  const location = locationWithoutNavigationHints(params.location);
  const canonicalLocation =
    pathname !== params.location.pathname || location.search !== params.location.search
      ? { ...location, pathname }
      : undefined;
  return {
    kind: "session",
    sessionKey: params.row.key,
    agentId: params.target.agentId,
    ...draftRouteDataFromLocation(params.location),
    face,
    ...(canonicalLocation ? { canonicalLocation, canonicalLocationSource: params.location } : {}),
  };
}

export async function loadChatRoute(
  context: ApplicationContext,
  location: RouteLocation,
  face: BoardFace,
  signal: AbortSignal,
): Promise<ChatRouteData | ReturnType<typeof notFound>> {
  const catalogShareRoute =
    face === "chat" && (await loadCatalogShareRouteFromLocation(context, location, signal));
  if (catalogShareRoute) {
    return catalogShareRoute;
  }
  const resolvedTarget = targetFromLocation(context, location);
  if (!resolvedTarget || resolvedTarget.target.namespace !== face) {
    return notFound({ routeId: face });
  }
  const { target } = resolvedTarget;
  const routeLocation = resolvedTarget.location;
  const preferenceDerived = isPreferenceDerivedFace(routeLocation);
  const catalogKey = catalogSessionKeyFromSearch(routeLocation.search);
  const restoreKey = new URLSearchParams(routeLocation.search).get(SESSION_RESTORE_KEY_PARAM);
  if (restoreKey) {
    const client = await waitForGatewayClient(context.gateway, signal);
    const hello = context.gateway.snapshot.hello;
    let agentId = parseAgentSessionKey(restoreKey)?.agentId ?? target.agentId;
    const defaultAgentId = resolveUiDefaultAgentId({ hello: context.gateway.snapshot.hello });
    const roster = agentId === defaultAgentId ? null : await context.agents.ensureList();
    signal.throwIfAborted();
    const removedAgent =
      roster !== null && !roster.agents.some((agent) => normalizeAgentId(agent.id) === agentId);
    if (removedAgent) {
      agentId = resolveSessionNavigationAgentId(context);
    }
    if (catalogKey && !removedAgent) {
      const catalogLocation = locationWithoutSearchParams(routeLocation, SESSION_RESTORE_KEY_PARAM);
      const catalog = await loadChatRoute(context, catalogLocation, face, signal);
      return "kind" in catalog && catalog.kind === "session"
        ? {
            ...catalog,
            canonicalLocation: catalog.canonicalLocation ?? catalogLocation,
            canonicalLocationSource: routeLocation,
          }
        : catalog;
    }
    const mainKey = configuredMainKey(context);
    const main = buildAgentMainSessionKey({ agentId, mainKey });
    const isMain =
      isUiGlobalSessionKey(restoreKey) ||
      (parseAgentSessionKey(restoreKey)?.rest ?? restoreKey) === mainKey;
    const resolved =
      removedAgent || isMain
        ? null
        : await client.request<SessionsResolveResult>("sessions.resolve", {
            key: restoreKey,
            agentId,
            allowMissing: true,
          });
    signal.throwIfAborted();
    // Only a confirmed miss retires remembered state. RPC errors keep the loader's
    // visible error boundary; the replacement is persisted when its route commits.
    const restored = resolvedMainSessionRouteData({
      context,
      location: catalogKey
        ? locationWithoutSearchParams(routeLocation, "catalog", "host", "thread")
        : routeLocation,
      face,
      row: resolved?.ok ? resolved : { key: main },
      target: { kind: "main", namespace: face, agentId },
      preferenceDerived,
    });
    if (resolved?.ok && restored?.canonicalLocation) {
      const pathname = restored.canonicalLocation.pathname;
      // Start the handoff at navigation, not before cold components finish loading.
      // Its proof belongs to this handshake and cannot cross a reconnect.
      restored.prepareCanonicalLocation = () => {
        const current = context.gateway.snapshot;
        if (current.client === client && current.hello === hello) {
          prepareSessionNavigationHandoff(context.gateway, pathname, resolved.key);
        }
      };
    }
    return restored
      ? { ...restored, canonicalLocationSource: routeLocation }
      : notFound({ routeId: face });
  }
  if (target.kind === "main" && catalogKey) {
    const sessionKey = buildCatalogSessionKey(catalogKey);
    let canonicalLocation = preferenceDerived
      ? locationWithoutNavigationHints(routeLocation)
      : null;
    let resolvedFace = face;
    if (preferenceDerived) {
      const resolution = await querySessionReference(
        context,
        { kind: "exact", value: sessionKey, agentId: target.agentId },
        signal,
      );
      if (resolution?.kind === "unique") {
        resolvedFace = preferredFace(resolution.session);
        const pathname = pathForSession(
          resolvedFace,
          target.agentId,
          mainSessionKey(context, target),
          context.basePath,
          { mainKey: configuredMainKey(context) },
        );
        if (pathname) {
          canonicalLocation = { ...locationWithoutNavigationHints(routeLocation), pathname };
        }
      }
    }
    return {
      kind: "session",
      sessionKey: buildCatalogSessionKey(catalogKey, target.agentId),
      agentId: target.agentId,
      ...draftRouteDataFromLocation(routeLocation),
      face: resolvedFace,
      // Non-null only on a preference-derived open, where it always at least drops the
      // marker from the URL.
      ...(canonicalLocation ? { canonicalLocation, canonicalLocationSource: routeLocation } : {}),
    };
  }
  if (target.kind === "main") {
    await waitForGatewayClient(context.gateway, signal);
    const sessionKey = mainSessionKey(context, target);
    if (preferenceDerived) {
      const resolution = await querySessionReference(
        context,
        { kind: "exact", value: sessionKey, agentId: target.agentId },
        signal,
      );
      if (resolution?.kind === "unique") {
        const resolved = resolvedMainSessionRouteData({
          context,
          location: routeLocation,
          face,
          row: resolution.session,
          target,
          preferenceDerived,
        });
        return resolved ?? notFound({ routeId: face });
      }
    }
    const canonicalLocation = preferenceDerived
      ? locationWithoutNavigationHints(routeLocation)
      : null;
    return {
      kind: "session",
      sessionKey,
      ...draftRouteDataFromLocation(routeLocation),
      face,
      ...(canonicalLocation && canonicalLocation.search !== routeLocation.search
        ? { canonicalLocation, canonicalLocationSource: routeLocation }
        : {}),
    };
  }
  if (target.kind === "literal") {
    let defaultsKnown = hasConfiguredMainKey(context);
    const needsGatewayResolution = preferenceDerived || Boolean(target.slugCandidate);
    if (!defaultsKnown && needsGatewayResolution) {
      await waitForGatewayClient(context.gateway, signal);
      defaultsKnown = hasConfiguredMainKey(context);
      if (defaultsKnown) {
        return await loadChatRoute(context, routeLocation, face, signal);
      }
    }
    if (needsGatewayResolution) {
      // Any single non-short-id segment is a slug candidate, so a plain literal route
      // would otherwise pay a sessions.list round-trip on every open. A cached row is
      // already proof the segment is a real key, which settles the exact lookup for
      // free; only genuinely unknown references reach the gateway.
      const handoffKey = consumeSessionNavigationHandoff(context.gateway, routeLocation.pathname);
      // Canonical URL replacement must retain an exact lookup's proof even when
      // that literal session is outside the currently loaded discovery window.
      const handedOffRow =
        handoffKey && areUiSessionKeysEquivalent(handoffKey, target.sessionKey)
          ? { key: handoffKey }
          : undefined;
      const cachedRow = defaultsKnown
        ? (findUiSessionRow(context, target.sessionKey, target.agentId) ?? handedOffRow)
        : undefined;
      const exactResolution = cachedRow
        ? ({ kind: "unique", session: cachedRow } as const)
        : await querySessionReference(
            context,
            { kind: "exact", value: target.sessionKey, agentId: target.agentId },
            signal,
          );
      if (exactResolution?.kind === "unique") {
        const resolved = resolvedSessionRouteData({
          context,
          location: routeLocation,
          face,
          row: exactResolution.session,
          preferenceDerived,
        });
        return resolved ?? notFound({ routeId: face });
      }
      if (target.slugCandidate && exactResolution?.kind === "not-found") {
        const slugResolution = await querySessionReference(
          context,
          { kind: "slug", value: target.slugCandidate, agentId: target.agentId },
          signal,
        );
        if (slugResolution?.kind === "not-found") {
          return missingSessionRouteData(context, face, target.agentId);
        }
        if (slugResolution?.kind === "ambiguous") {
          return {
            kind: "ambiguous",
            shortId: target.slugCandidate,
            candidates: candidatesForResolution(
              context,
              face,
              slugResolution,
              routeLocation,
              preferenceDerived,
            ),
            truncated: slugResolution.truncated,
            face,
          };
        }
        if (slugResolution?.kind === "unique") {
          // No shortId: a resolved slug canonicalizes to the same short reference every
          // other surface links to, so `/chat/main/deploy-monitor` settles on
          // `/chat/main/deploy-monitor-6db92d48` rather than a full uuid. A later
          // first-block collision lands in the disambiguation view like any short link.
          const resolved = resolvedSessionRouteData({
            context,
            location: routeLocation,
            face,
            row: slugResolution.session,
            preferenceDerived,
          });
          return resolved ?? notFound({ routeId: face });
        }
      }
    }
    const canonicalLocation = defaultsKnown
      ? canonicalMainLocation(context, routeLocation, face, target.sessionKey)
      : null;
    const parsed = parseAgentSessionKey(target.sessionKey);
    const canonicalLocationReady =
      !defaultsKnown && parsed
        ? waitForGatewayClient(context.gateway, signal)
            .then(() => canonicalMainLocation(context, routeLocation, face, target.sessionKey))
            .catch(() => null)
        : undefined;
    const preferenceLocation = preferenceDerived
      ? locationWithoutNavigationHints(routeLocation)
      : null;
    return {
      kind: "session",
      sessionKey: target.sessionKey,
      ...draftRouteDataFromLocation(routeLocation),
      face,
      ...(canonicalLocation
        ? { canonicalLocation, canonicalLocationSource: routeLocation }
        : preferenceLocation && preferenceLocation.search !== routeLocation.search
          ? { canonicalLocation: preferenceLocation, canonicalLocationSource: routeLocation }
          : {}),
      ...(canonicalLocationReady
        ? { canonicalLocationReady, canonicalLocationSource: routeLocation }
        : {}),
    };
  }
  const cached = findCachedShortSession(context, routeLocation, target);
  if (cached && !cached.row) {
    const canonicalLocation = locationWithoutNavigationHints(routeLocation);
    const canonicalLocationChanged = canonicalLocation.search !== routeLocation.search;
    return {
      kind: "session",
      sessionKey: cached.sessionKey,
      ...draftRouteDataFromLocation(routeLocation),
      face,
      ...(target.shortId.length > 8 ? { shortId: target.shortId } : {}),
      ...(canonicalLocationChanged
        ? { canonicalLocation, canonicalLocationSource: routeLocation }
        : {}),
    };
  }
  const resolution = cached?.row
    ? ({ kind: "unique", session: cached.row } as const)
    : await resolveShortSessionReference(context, target, signal);
  if (resolution.kind === "not-found") {
    // A mechanically composed literal, notably a full UUID, can match the short grammar.
    // Only after the authoritative short lookup misses may its exact decoded key win.
    const literalResolution = await querySessionReference(
      context,
      { kind: "exact", value: target.literalSessionKey, agentId: target.agentId },
      signal,
    );
    if (literalResolution?.kind === "unique") {
      const literal = resolvedSessionRouteData({
        context,
        location: routeLocation,
        face,
        row: literalResolution.session,
        preferenceDerived,
      });
      return literal ?? notFound({ routeId: face });
    }
    return literalResolution?.kind === "not-found"
      ? missingSessionRouteData(context, face, target.agentId)
      : notFound({ routeId: face });
  }
  if (resolution.kind === "ambiguous") {
    return {
      kind: "ambiguous",
      shortId: target.shortId,
      candidates: candidatesForResolution(
        context,
        face,
        resolution,
        routeLocation,
        preferenceDerived,
      ),
      truncated: resolution.truncated,
      face,
    };
  }
  const resolved = resolvedSessionRouteData({
    context,
    location: routeLocation,
    face,
    row: resolution.session,
    preferenceDerived,
    shortId: target.shortId,
  });
  return resolved ?? notFound({ routeId: face });
}

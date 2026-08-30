import { createHash } from "node:crypto";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  SessionCatalogProvider,
  SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import {
  createSessionCatalogAdoptionCoordinator,
  importSessionCatalogHistory,
  listAdoptedSessionCatalogSessions,
  sessionCatalogAdoptedSessionKey,
  sessionCatalogAdoptedSourceKey,
} from "openclaw/plugin-sdk/session-catalog";
import type { BeamStore } from "./store.js";
import { BEAM_HOST_ID, type BeamStoredSession } from "./types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const ADOPTED_SESSION_KEY_PREFIX = "plugin:beam:catalog-adopt:";

function boundedLimit(value: number | undefined): number {
  return Math.min(MAX_LIMIT, Math.max(1, value ?? DEFAULT_LIMIT));
}

function cursorOffset(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function searchableText(session: BeamStoredSession): string {
  return `${session.title}\n${session.source}`.toLowerCase();
}

function transcriptItems(session: BeamStoredSession): SessionCatalogTranscriptItem[] {
  return session.items.map((item, index) => ({
    id: `${session.beamId}:${index}`,
    type: item.type,
    text: item.text,
    timestamp: session.updatedAt,
  }));
}

type TranscriptCursor = { revision: string; end: number };

function transcriptRevision(session: BeamStoredSession): string {
  return createHash("sha256").update(JSON.stringify(session.items)).digest("base64url");
}

function encodeTranscriptCursor(cursor: TranscriptCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeTranscriptCursor(value: string): TranscriptCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as TranscriptCursor).revision === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test((parsed as TranscriptCursor).revision) &&
      typeof (parsed as TranscriptCursor).end === "number" &&
      Number.isSafeInteger((parsed as TranscriptCursor).end) &&
      (parsed as TranscriptCursor).end >= 0
    ) {
      return parsed as TranscriptCursor;
    }
  } catch {
    // Reject malformed cursors below.
  }
  throw new Error("invalid Beam transcript cursor");
}

function transcriptPage(
  items: SessionCatalogTranscriptItem[],
  limit: number,
  revision: string,
  cursor?: TranscriptCursor,
): { items: SessionCatalogTranscriptItem[]; nextCursor?: string } {
  if (cursor && cursor.revision !== revision) {
    throw new Error("stale Beam transcript cursor");
  }
  const end = Math.min(items.length, Math.max(0, cursor?.end ?? items.length));
  const start = Math.max(0, end - limit);
  return {
    items: items.slice(start, end),
    ...(start > 0 ? { nextCursor: encodeTranscriptCursor({ revision, end: start }) } : {}),
  };
}

function sourceThreadIdFromEntry(entry: {
  pluginExtensions?: Record<string, unknown>;
}): string | undefined {
  const beam = entry.pluginExtensions?.beam;
  if (!beam || typeof beam !== "object" || Array.isArray(beam)) {
    return undefined;
  }
  const catalog = (beam as Record<string, unknown>).sessionCatalog;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    return undefined;
  }
  const sourceThreadId = (catalog as Record<string, unknown>).sourceThreadId;
  return typeof sourceThreadId === "string" ? sourceThreadId : undefined;
}

export function createBeamSessionCatalog(
  store: BeamStore,
  api?: OpenClawPluginApi,
): SessionCatalogProvider {
  const continueAdoption = createSessionCatalogAdoptionCoordinator<{ sessionKey: string }>();
  const continueSession: SessionCatalogProvider["continueSession"] = api
    ? async (params) => {
        if (params.hostId !== BEAM_HOST_ID) {
          throw new Error(`unknown Beam host: ${params.hostId}`);
        }
        const session = await store.get(params.threadId);
        if (!session) {
          throw new Error(`unknown Beam session: ${params.threadId}`);
        }
        const config = api.runtime.config.current() as OpenClawConfig;
        const agentId = resolveSessionAgentIdsStrict({
          config,
          agentId: params.agentId,
        }).sessionAgentId;
        const sourceKey = sessionCatalogAdoptedSourceKey(BEAM_HOST_ID, session.beamId);
        const findExisting = () =>
          listAdoptedSessionCatalogSessions({
            agentId,
            config,
            pluginId: api.id,
            runtime: api.runtime,
            sourceFromEntry: (entry) => {
              const threadId = sourceThreadIdFromEntry(entry);
              return threadId ? { hostId: BEAM_HOST_ID, threadId } : undefined;
            },
          }).get(sourceKey);
        return await continueAdoption({
          sourceKey: `${agentId}\0${sourceKey}`,
          findExisting,
          create: async () => {
            const marker = { sourceThreadId: session.beamId };
            const created = await api.runtime.agent.session.createSessionEntry({
              cfg: config,
              key: sessionCatalogAdoptedSessionKey(ADOPTED_SESSION_KEY_PREFIX, session.beamId),
              agentId,
              recoverMatchingInitialEntry: true,
              displayName: session.title,
              initialEntry: {
                nativeExecution: true,
                pluginOwnerId: api.id,
                pluginExtensions: { beam: { sessionCatalog: marker } },
              },
              afterCreate: async (entry) => {
                await importSessionCatalogHistory({
                  catalogId: "beam",
                  threadId: session.beamId,
                  read: async ({ cursor, limit }) => {
                    const current = await store.get(session.beamId);
                    if (!current) {
                      throw new Error(`unknown Beam session: ${session.beamId}`);
                    }
                    return {
                      hostId: BEAM_HOST_ID,
                      label: current.title,
                      threadId: current.beamId,
                      ...transcriptPage(
                        transcriptItems(current),
                        boundedLimit(limit),
                        transcriptRevision(current),
                        cursor === undefined ? undefined : decodeTranscriptCursor(cursor),
                      ),
                    };
                  },
                  sessionId: entry.sessionId,
                  sessionKey: entry.key,
                  agentId: entry.agentId,
                  config,
                });
                return { pluginExtensions: { beam: { sessionCatalog: marker } } };
              },
            });
            return { sessionKey: created.key };
          },
          complete: async (continued) => continued,
        });
      }
    : undefined;
  return {
    id: "beam",
    label: "Beam",
    supportsProcessHomeIsolation: true,
    async list(params) {
      const search = params.search?.trim().toLowerCase();
      const sessions = (await store.list())
        .filter((session) => !search || searchableText(session).includes(search))
        .toSorted((left, right) => right.receivedAt - left.receivedAt);
      const offset = cursorOffset(params.cursors?.[BEAM_HOST_ID]);
      const limit = boundedLimit(params.limitPerHost);
      const page = sessions.slice(offset, offset + limit);
      return [
        {
          hostId: BEAM_HOST_ID,
          label: "Beamed sessions",
          kind: "gateway",
          connected: true,
          sessions: page.map((session) => ({
            threadId: session.beamId,
            name: session.title,
            status: session.completed ? "completed" : "live",
            createdAt: session.createdAt,
            updatedAt: session.receivedAt,
            recencyAt: session.receivedAt,
            source: session.source,
            archived: false,
            canContinue: continueSession !== undefined,
            canArchive: false,
          })),
          ...(offset + page.length < sessions.length
            ? { nextCursor: String(offset + page.length) }
            : {}),
        },
      ];
    },
    async read(params) {
      if (params.hostId !== BEAM_HOST_ID) {
        throw new Error(`unknown Beam host: ${params.hostId}`);
      }
      const session = await store.get(params.threadId);
      if (!session) {
        throw new Error(`unknown Beam session: ${params.threadId}`);
      }
      const page = transcriptPage(
        transcriptItems(session),
        boundedLimit(params.limit),
        transcriptRevision(session),
        params.cursor === undefined ? undefined : decodeTranscriptCursor(params.cursor),
      );
      return {
        hostId: BEAM_HOST_ID,
        label: session.title,
        threadId: session.beamId,
        ...page,
      };
    },
    ...(continueSession ? { continueSession } : {}),
  };
}

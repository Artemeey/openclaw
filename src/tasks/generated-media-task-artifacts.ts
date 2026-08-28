import path from "node:path";
import { isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentGeneratedAttachment } from "../agents/generated-attachments.js";
import { isPathInside, pathExists } from "../infra/fs-safe.js";
import { resolveConfigDir } from "../utils.js";
import type { JsonValue, TaskRecord } from "./task-registry.types.js";

const MAX_GENERATED_MEDIA_ARTIFACTS = 16;
const MAX_GENERATED_MEDIA_REFERENCE_CHARS = 4_096;
const MAX_GENERATED_MEDIA_TEXT_CHARS = 4_000;

type RetainedGeneratedMediaArtifact = {
  type: "image" | "audio" | "video" | "file";
  path?: string;
  url?: string;
  mimeType?: string;
  name?: string;
  sizeBytes?: number;
  durationMs?: number;
  width?: number;
  height?: number;
};

export type GeneratedMediaTaskDetail = {
  kind: "generated_media_completion";
  version: 1;
  generation: number;
  queueId?: string;
  result: string;
  artifacts: RetainedGeneratedMediaArtifact[];
};

function boundedString(value: unknown, maxChars: number): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.slice(0, maxChars) : undefined;
}

function boundedInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalizeArtifact(
  attachment: AgentGeneratedAttachment,
): RetainedGeneratedMediaArtifact | undefined {
  const reference = boundedString(
    attachment.path ?? attachment.filePath ?? attachment.url ?? attachment.mediaUrl,
    MAX_GENERATED_MEDIA_REFERENCE_CHARS,
  );
  if (!reference) {
    return undefined;
  }
  const localPath = isHttpUrl(reference) ? undefined : reference;
  const url = localPath ? undefined : reference;
  const mimeType = boundedString(attachment.mimeType, 200);
  const name = boundedString(attachment.name, 512);
  const sizeBytes = boundedInteger(attachment.sizeBytes);
  const durationMs = boundedInteger(attachment.durationMs);
  const width = boundedInteger(attachment.width);
  const height = boundedInteger(attachment.height);
  return {
    type: attachment.type ?? "file",
    ...(localPath ? { path: localPath } : { url }),
    ...(mimeType ? { mimeType } : {}),
    ...(name ? { name } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

export function createGeneratedMediaTaskDetail(params: {
  result?: string;
  wakeResult?: string;
  attachments?: readonly AgentGeneratedAttachment[];
  mediaUrls?: readonly string[];
  generation?: number;
}): GeneratedMediaTaskDetail {
  const attachments = [
    ...(params.attachments ?? []),
    ...(params.mediaUrls ?? []).map((url) => ({ mediaUrl: url })),
  ];
  const seen = new Set<string>();
  const artifacts: RetainedGeneratedMediaArtifact[] = [];
  for (const attachment of attachments) {
    const artifact = normalizeArtifact(attachment);
    const reference = artifact?.path ?? artifact?.url;
    if (!artifact || !reference || seen.has(reference)) {
      continue;
    }
    seen.add(reference);
    artifacts.push(artifact);
    if (artifacts.length === MAX_GENERATED_MEDIA_ARTIFACTS) {
      break;
    }
  }
  return {
    kind: "generated_media_completion",
    version: 1,
    generation: params.generation ?? 1,
    result: (params.result ?? params.wakeResult ?? "").slice(0, MAX_GENERATED_MEDIA_TEXT_CHARS),
    artifacts,
  };
}

export function parseGeneratedMediaTaskDetail(
  value: JsonValue | undefined,
): GeneratedMediaTaskDetail | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const generation = value.generation;
  if (
    value.kind !== "generated_media_completion" ||
    value.version !== 1 ||
    typeof value.result !== "string" ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !Array.isArray(value.artifacts)
  ) {
    return undefined;
  }
  const artifacts = value.artifacts.slice(0, MAX_GENERATED_MEDIA_ARTIFACTS).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const attachment: AgentGeneratedAttachment = {
      type:
        entry.type === "image" ||
        entry.type === "audio" ||
        entry.type === "video" ||
        entry.type === "file"
          ? entry.type
          : undefined,
      path: typeof entry.path === "string" ? entry.path : undefined,
      url: typeof entry.url === "string" ? entry.url : undefined,
      mimeType: typeof entry.mimeType === "string" ? entry.mimeType : undefined,
      name: typeof entry.name === "string" ? entry.name : undefined,
      sizeBytes: typeof entry.sizeBytes === "number" ? entry.sizeBytes : undefined,
      durationMs: typeof entry.durationMs === "number" ? entry.durationMs : undefined,
      width: typeof entry.width === "number" ? entry.width : undefined,
      height: typeof entry.height === "number" ? entry.height : undefined,
    };
    return normalizeArtifact(attachment) ?? [];
  });
  return {
    kind: "generated_media_completion",
    version: 1,
    generation,
    ...(typeof value.queueId === "string" ? { queueId: value.queueId } : {}),
    result: value.result.slice(0, MAX_GENERATED_MEDIA_TEXT_CHARS),
    artifacts,
  };
}

export async function retainedGeneratedMediaArtifactsAvailable(
  detail: GeneratedMediaTaskDetail,
): Promise<boolean> {
  const mediaDir = path.join(resolveConfigDir(), "media");
  for (const artifact of detail.artifacts) {
    if (artifact.path) {
      const resolved = path.resolve(artifact.path);
      if (!isPathInside(mediaDir, resolved) || !(await pathExists(resolved))) {
        return false;
      }
    }
  }
  return detail.artifacts.length > 0;
}

export function retainedGeneratedMediaPaths(tasks: readonly TaskRecord[]): string[] {
  const mediaDir = path.join(resolveConfigDir(), "media");
  return tasks.flatMap((task) =>
    task.deliveryStatus === "failed" ||
    task.deliveryStatus === "session_queued" ||
    task.deliveryStatus === "dismissed"
      ? (parseGeneratedMediaTaskDetail(task.detail)?.artifacts.flatMap((artifact) => {
          const localPath = artifact.path ? path.resolve(artifact.path) : undefined;
          return localPath && isPathInside(mediaDir, localPath) ? [localPath] : [];
        }) ?? [])
      : [],
  );
}

import { MAX_VIDEO_BYTES } from "@openclaw/media-core/constants";
import { saveMediaSource } from "../../media/store.js";
import type { MediaGenerationExecutionResult } from "./media-generate-background-shared.js";

export async function retainRemoteGeneratedMedia<T extends MediaGenerationExecutionResult>(
  executed: T,
): Promise<T> {
  if (!executed.attachments?.some((attachment) => attachment.url || attachment.mediaUrl)) {
    return executed;
  }
  const attachments = await Promise.all(
    executed.attachments.map(async (attachment) => {
      const url = attachment.url ?? attachment.mediaUrl;
      if (!url || attachment.path || attachment.filePath) {
        return attachment;
      }
      const saved = await saveMediaSource(url, undefined, "tool-video-generation", MAX_VIDEO_BYTES);
      return {
        ...attachment,
        path: saved.path,
        url: undefined,
        mediaUrl: undefined,
        sizeBytes: saved.size,
        mimeType: saved.contentType ?? attachment.mimeType,
      };
    }),
  );
  return {
    ...executed,
    attachments,
    mediaUrls: attachments.flatMap((attachment) => attachment.path ?? attachment.filePath ?? []),
  };
}

/** Generated-script fragment for assistant-specific PTY fixture messages. */
export const TUI_PTY_ASSISTANT_FIXTURE_SCRIPT = `
  let delayedPeerSessionKey: string | undefined;

  function emitDelayedPeerReplies(backend: Pick<TuiBackend, "onEvent">, sessionKey: string) {
    const runId = "peer-delayed-finals";
    const timestamp = Date.now();
    // Match the ID-less normal terminal and source-reply mirror producer shapes.
    const normalFinal = {
      event: "chat",
      payload: {
        runId, sessionKey, seq: 4, state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "PTY_PEER_NORMAL_REPLY" }],
          timestamp,
        },
      },
    };
    const mirrorFinal = {
      event: "chat",
      payload: {
        runId, sessionKey, seq: 1, state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "PTY_PEER_MIRROR_REPLY" }],
          text: "PTY_PEER_MIRROR_REPLY",
          timestamp,
          stopReason: "stop",
          usage: { input: 0, output: 0, totalTokens: 0 },
        },
      },
    };
    const prompt = {
      event: "session.message",
      payload: {
        sessionKey, messageId: "peer-persisted-user", messageSeq: 1,
        message: {
          role: "user",
          content: [{ type: "text", text: "PTY_PEER_DELAYED_PROMPT" }],
          timestamp,
          __openclaw: { id: "peer-persisted-user", seq: 1, idempotencyKey: runId + ":user" },
        },
      },
    };
    for (const event of [normalFinal, mirrorFinal, mirrorFinal, prompt, prompt]) {
      record("delayedPeerEvent", event);
      backend.onEvent?.(event);
    }
    record("delayedPeerComplete", { runId, sessionKey });
  }

  function assistantMessageFromSourceReplyPayloads(
    payloads: ReturnType<typeof buildEmbeddedRunPayloads>,
  ) {
    if (payloads.length === 0) {
      throw new Error("expected source reply payload");
    }
    for (const payload of payloads) {
      const metadata = getReplyPayloadMetadata(payload);
      if (!metadata?.sourceReplyTranscriptMirror) {
        throw new Error("expected source reply transcript mirror metadata");
      }
      record("sourceReplyMetadata", metadata.sourceReplyTranscriptMirror);
    }
    const normalized = normalizeReplyPayloadsForDelivery(payloads);
    const content = normalized.flatMap((payload) => {
      const text = payload.text?.trim();
      return text ? [{ type: "text", text }] : [];
    });
    if (content.length === 0) {
      throw new Error("expected displayable source reply content");
    }
    return { role: "assistant", content, timestamp: Date.now() };
  }

  function buildAttachmentOnlyAssistantMessage(prompt: string, runId: string) {
    if (prompt !== "attachment-only assistant proof") {
      return null;
    }
    record("attachmentOnlyComplete", { runId });
    return {
      role: "assistant",
      content: [
        {
          type: "image",
          data: "SECRET_PTY_IMAGE_BYTES",
          url: "file:///Users/operator/private/image.png",
          artifactId: "SECRET_PTY_ARTIFACT",
        },
      ],
      timestamp: Date.now(),
    };
  }
`;

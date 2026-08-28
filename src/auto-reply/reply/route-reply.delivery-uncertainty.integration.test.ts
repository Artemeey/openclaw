// Exercises retry safety through the real router, durable sender, and SQLite queue.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "../../infra/outbound/delivery-queue.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import type { ReplyPayload } from "../types.js";
import { deliverFollowupDecision } from "./followup-delivery.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import { routeReply } from "./route-reply.js";
import {
  createMockFollowupRun,
  createMockReplyOperation,
  createMockTypingController,
} from "./test-helpers.js";

vi.mock("../../agents/runtime-plan/build.js", () => ({
  buildAgentRuntimeDeliveryPlan: () => ({
    isSilentPayload: () => false,
    resolveFollowupRoute: () => undefined,
  }),
}));

const channels = ["telegram", "discord", "slack", "matrix"] as const;
type TestChannel = (typeof channels)[number];

describe("routed delivery uncertainty", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  const accepted: string[] = [];
  const payload = { text: "recipient accepted this reply" };

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
    accepted.length = 0;
    setActivePluginRegistry(
      createTestRegistry(
        channels.map((channel) => {
          const sendText: NonNullable<ChannelOutboundAdapter["sendText"]> = async ({
            text,
            onPlatformSendDispatch,
          }) => {
            await onPlatformSendDispatch?.();
            // The recipient accepts the send, but the connection drops before
            // the adapter can return an identity to the durable sender.
            accepted.push(text);
            throw new Error("connection lost after recipient accepted reply");
          };
          return {
            pluginId: channel,
            source: "test",
            plugin: createOutboundTestPlugin({
              id: channel,
              outbound: { deliveryMode: "direct", sendText },
            }),
          };
        }),
      ),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createTestRegistry());
    vi.unstubAllEnvs();
  });

  async function expectRetainedCustody(channel: TestChannel) {
    expect(await loadPendingDeliveries(fixtures.tmpDir())).toEqual([
      expect.objectContaining({
        channel,
        recoveryState: "unknown_after_send",
        retryCount: 1,
      }),
    ]);
    expect(accepted).toEqual([payload.text]);
  }

  it.each(channels)(
    "keeps %s routing failures non-retryable without a receipt",
    async (channel) => {
      const result = await routeReply({
        payload,
        channel,
        to: "recipient",
        cfg: {},
        replyKind: "final",
        mirror: false,
      });

      await expectRetainedCustody(channel);
      expect(result).toMatchObject({
        ok: false,
        delivered: true,
        error: `Failed to route reply to ${channel}: connection lost after recipient accepted reply`,
      });
      expect(result.messageId).toBeUndefined();
    },
  );

  it.each(channels)(
    "does not dispatch a second %s follow-up after identity loss",
    async (channel) => {
      const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
      const turn: AdmittedFollowupTurn = {
        runId: "uncertain-followup",
        queued: createMockFollowupRun({
          originatingChannel: channel,
          originatingTo: "recipient",
          run: { messageProvider: channel },
        }),
        operation: createMockReplyOperation().replyOperation,
        config: {},
        session: {
          kind: "detached",
          current: () => undefined,
          publish: () => undefined,
          adopt: () => undefined,
        },
        sendPolicy: "allow",
        preflightCompactionApplied: false,
      };

      await deliverFollowupDecision({
        decision: { kind: "deliver", payloads: [payload] },
        turn,
        defaults: {
          defaultModel: "claude",
          typingMode: "never",
          typing: createMockTypingController(),
          opts: { onBlockReply },
        },
        runId: turn.runId,
        runFollowup: vi.fn(async () => {}),
      });

      await expectRetainedCustody(channel);
      expect(onBlockReply).not.toHaveBeenCalled();
    },
  );
});

import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import { clearFollowupQueue, getFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { enqueueCommandInLane, resetAllLanes } from "../../process/command-queue.js";
import { hasQueuedSessionGoalWork } from "./chat-send-pre-admission.js";
import { resolveChatSendStopOwnerScope } from "./chat-send-stop-owner-scope.js";

describe("chat send stop ownership", () => {
  it("keeps the selected filter separate from the compatibility run fallback", () => {
    const cfg: OpenClawConfig = {
      session: { scope: "global", store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    expect(
      resolveChatSendStopOwnerScope({
        cfg,
        selectedAgentId: "research",
        sessionKey: "global",
      }),
    ).toEqual({ agentId: "research", defaultAgentId: "ops" });
  });
});

describe("structured Goal queue admission", () => {
  const sessionKey = "agent:main:goal-busy";

  afterEach(() => {
    clearFollowupQueue(sessionKey);
    resetAllLanes();
  });

  it.each([
    {
      name: "pending followup",
      prepare: () => {
        getFollowupQueue(sessionKey, { mode: "followup" }).items.push({} as never);
      },
    },
    {
      name: "in-flight followup",
      prepare: () => {
        getFollowupQueue(sessionKey, { mode: "followup" }).inFlight.add({} as never);
      },
    },
    {
      name: "dropped followup",
      prepare: () => {
        getFollowupQueue(sessionKey, { mode: "followup" }).droppedCount = 1;
      },
    },
  ])("detects $name state", ({ prepare }) => {
    prepare();
    expect(hasQueuedSessionGoalWork([sessionKey])).toBe(true);
  });

  it("detects work queued behind the active embedded command lane", async () => {
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const release = createDeferred();
    const active = enqueueCommandInLane(lane, async () => await release.promise);
    const queued = enqueueCommandInLane(lane, async () => undefined);
    await Promise.resolve();

    expect(hasQueuedSessionGoalWork([sessionKey])).toBe(true);
    release.resolve();
    await Promise.all([active, queued]);
  });
});

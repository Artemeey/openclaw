// User turn persistence tests cover the shared transcript writer.
import fs from "node:fs";
import path from "node:path";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { castAgentMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../agents/harness/hook-helpers.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "./user-turn-transcript.js";
import { persistUserTurnTranscript } from "./user-turn-transcript.test-support.js";

describe("persistUserTurnTranscript", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    resetGlobalHookRunner();
  });

  function createSqliteTranscriptTarget(params: {
    dir: string;
    sessionId?: string;
    sessionKey?: string;
  }) {
    const sessionId = params.sessionId ?? "session-1";
    const sessionKey = params.sessionKey ?? "agent:main:main";
    const storePath = path.join(params.dir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const sqliteMarker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    return {
      agentId: "main",
      cwd: params.dir,
      sessionEntry: undefined,
      sessionId,
      sessionKey,
      storePath,
      sqliteMarker,
    };
  }

  async function readTranscriptMessages(params: {
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }): Promise<Array<Record<string, unknown>>> {
    return (
      await loadTranscriptEvents({
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      })
    )
      .map((entry) => (entry as { message?: unknown }).message)
      .filter(
        (message): message is Record<string, unknown> =>
          typeof message === "object" && message !== null,
      );
  }

  it("appends a structured user turn through the shared transcript writer", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-");
    const target = createSqliteTranscriptTarget({ dir });
    const provenance = {
      kind: "inter_session" as const,
      sourceSessionKey: "source-main",
      sourceTool: "sessions_send",
    };

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "What is in this image?",
        media: [{ path: "/tmp/image.png", contentType: "image/png" }],
        timestamp: 123,
        senderIsOwner: true,
        provenance,
      },
      updateMode: "none",
    });

    const expected = {
      role: "user",
      content: "What is in this image?",
      timestamp: 123,
      __openclaw: {
        senderIsOwner: false,
        media: [{ path: "/tmp/image.png", contentType: "image/png" }],
      },
      provenance,
    };
    expect(appended?.message).toEqual(expected);
    expect(JSON.stringify(appended?.message)).toBe(JSON.stringify(expected));
    const messages = await readTranscriptMessages(target);
    expect(messages).toEqual([expected]);
    expect(JSON.stringify(messages[0])).toBe(JSON.stringify(expected));
  });

  it("round-trips a multi-attachment SQLite row byte-identically", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-media-");
    const target = createSqliteTranscriptTarget({ dir });
    const expected = {
      role: "user",
      content: "Inspect both",
      timestamp: 456,
      __openclaw: {
        media: [
          { path: "/tmp/image.png", contentType: "image/png" },
          { url: "https://example.test/report.pdf", contentType: "application/pdf" },
        ],
      },
    };

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "Inspect both",
        timestamp: 456,
        media: [
          { path: "/tmp/image.png", contentType: "image/png" },
          { url: "https://example.test/report.pdf", contentType: "application/pdf" },
        ],
      },
      updateMode: "none",
    });

    expect(appended?.message).toEqual(expected);
    expect(JSON.stringify(appended?.message)).toBe(JSON.stringify(expected));
    const messages = await readTranscriptMessages(target);
    expect(messages).toEqual([expected]);
    expect(JSON.stringify(messages[0])).toBe(JSON.stringify(expected));
  });

  it("persists sender metadata as __openclaw envelope", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-sender-");
    const target = createSqliteTranscriptTarget({ dir });
    // Deliberately attach runtime-only profile fields to prove durable sender
    // attribution is a whitelist, not a copy of the inbound sender object.
    const runtimeOnlySenderFields = {
      senderProfileAvatarUrl: "/api/users/8489979671/avatar?v=1989876543210",
      profileRevision: 1_989_876_543_210,
      avatarBytes: "volatile-avatar-bytes",
      avatarHash: "volatile-avatar-hash",
    };
    const sender = {
      id: "8489979671",
      name: "Ram Shenoy",
      username: "ram_s",
      ...runtimeOnlySenderFields,
    };
    const expected = {
      role: "user",
      content: "hello from group",
      timestamp: 1_700_000_000_000,
      __openclaw: {
        senderId: "8489979671",
        senderName: "Ram Shenoy",
        senderUsername: "ram_s",
      },
    };

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello from group",
        timestamp: expected.timestamp,
        sender,
      },
      updateMode: "none",
    });

    const reloaded = await readTranscriptMessages(target);
    const durableMessages = [appended?.message, reloaded[0]];
    expect(durableMessages).toEqual([expected, expected]);
    for (const durableMessage of durableMessages) {
      const serialized = JSON.stringify(durableMessage);
      for (const [key, value] of Object.entries(runtimeOnlySenderFields)) {
        expect(serialized).not.toContain(key);
        expect(serialized).not.toContain(String(value));
      }
    }
  });

  it("omits __openclaw when no sender metadata is provided", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-nosender-");
    const target = createSqliteTranscriptTarget({ dir });

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello without sender",
        sender: { id: "", name: null },
      },
      updateMode: "none",
    });

    expect(appended?.message).not.toHaveProperty("__openclaw");
  });

  it("uses inline update mode by default", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-inline-");
    const target = createSqliteTranscriptTarget({ dir });

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello from runtime",
      },
    });

    expect(appended?.message).toMatchObject({
      role: "user",
      content: "hello from runtime",
      timestamp: expect.any(Number),
    });
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "hello from runtime",
        timestamp: expect.any(Number),
      }),
    ]);
  });

  it("returns the existing user turn when the idempotency key was already persisted", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-idempotent-");
    const target = createSqliteTranscriptTarget({ dir });

    const first = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello once",
        timestamp: 123,
        idempotencyKey: "chat-run-1:user",
      },
      updateMode: "none",
    });
    const second = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello once replayed",
        timestamp: 456,
        idempotencyKey: "chat-run-1:user",
      },
      updateMode: "none",
    });

    expect(second?.messageId).toBe(first?.messageId);
    expect(second?.message).toMatchObject({
      role: "user",
      content: "hello once",
      timestamp: 123,
      idempotencyKey: "chat-run-1:user",
    });
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "hello once",
        timestamp: 123,
        idempotencyKey: "chat-run-1:user",
      }),
    ]);
  });

  it("commits a session Goal, transcript turn, and receipt atomically and replays exactly", async () => {
    const dir = tempDirs.make("openclaw-user-turn-goal-start-");
    const target = createSqliteTranscriptTarget({ dir });
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const input = {
      text: "/ship\nwithout command interpretation",
      timestamp: 123,
      idempotencyKey: "goal-run-1:user",
      sessionGoalStart: {
        kind: "session-goal-start" as const,
        version: 1 as const,
        goalId: "goal-1",
        operationId: "goal-run-1",
        sourceRunId: "goal-run-1",
        sourceTurnId: "goal-run-1:user",
      },
    };
    const mutation = {
      ...input.sessionGoalStart,
      now: 123,
      objective: input.text,
      requestFingerprint: `sha256:${"a".repeat(64)}` as const,
      result: { runId: "goal-run-1", goalId: "goal-1", status: "started" as const },
    };

    const first = await persistUserTurnTranscript({
      ...target,
      expectedSessionId: target.sessionId,
      input,
      sessionTurnMutation: mutation,
      updateMode: "none",
    });
    const replay = await persistUserTurnTranscript({
      ...target,
      expectedSessionId: target.sessionId,
      input,
      sessionTurnMutation: mutation,
      updateMode: "none",
    });

    expect(first?.sessionTurnMutation).toEqual({ status: "inserted", result: mutation.result });
    expect(replay?.sessionTurnMutation).toEqual({ status: "replay", result: mutation.result });
    expect(replay?.messageId).toBe(first?.messageId);
    expect(loadSessionEntry(target)?.goal).toMatchObject({
      id: "goal-1",
      objective: input.text,
      status: "active",
    });
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        content: input.text,
        idempotencyKey: input.idempotencyKey,
        __openclaw: expect.objectContaining({ sessionGoalStart: input.sessionGoalStart }),
      }),
    ]);
  });

  it("rolls back the transcript and Goal when receipt persistence fails", async () => {
    const dir = tempDirs.make("openclaw-user-turn-goal-rollback-");
    const target = createSqliteTranscriptTarget({ dir });
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });

    await expect(
      persistUserTurnTranscript({
        ...target,
        expectedSessionId: target.sessionId,
        input: { text: "atomic objective", idempotencyKey: "goal-fault:user" },
        sessionTurnMutation: {
          kind: "session-goal-start",
          version: 1,
          goalId: "goal-fault",
          operationId: "goal-fault",
          sourceRunId: "goal-fault",
          sourceTurnId: "goal-fault:user",
          now: -1,
          objective: "atomic objective",
          requestFingerprint: `sha256:${"b".repeat(64)}`,
          result: { runId: "goal-fault", goalId: "goal-fault", status: "started" },
        },
        updateMode: "none",
      }),
    ).rejects.toThrow("creation time must be a non-negative safe integer");
    expect(loadSessionEntry(target)?.goal).toBeUndefined();
    await expect(readTranscriptMessages(target)).resolves.toEqual([]);
  });

  it.each([
    { name: "blocks the turn", replacement: undefined },
    { name: "rewrites the objective", replacement: "hook replacement" },
  ])("rolls back Goal start when before_message_write $name", async ({ replacement }) => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: () =>
            replacement === undefined
              ? { block: true }
              : { message: castAgentMessage({ role: "user", content: replacement }) },
        },
      ]),
    );
    const dir = tempDirs.make("openclaw-user-turn-goal-hook-rollback-");
    const target = createSqliteTranscriptTarget({ dir });
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });

    await expect(
      persistUserTurnTranscript({
        ...target,
        expectedSessionId: target.sessionId,
        input: { text: "original objective", idempotencyKey: "goal-hook:user" },
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
        sessionTurnMutation: {
          kind: "session-goal-start",
          version: 1,
          goalId: "goal-hook",
          operationId: "goal-hook",
          sourceRunId: "goal-hook",
          sourceTurnId: "goal-hook:user",
          now: 1,
          objective: "original objective",
          requestFingerprint: `sha256:${"e".repeat(64)}`,
          result: { runId: "goal-hook", goalId: "goal-hook", status: "started" },
        },
        updateMode: "none",
      }),
    ).rejects.toThrow("requires one unchanged new transcript turn");
    expect(loadSessionEntry(target)?.goal).toBeUndefined();
    await expect(readTranscriptMessages(target)).resolves.toEqual([]);
  });

  it("rejects a structured Goal operation that reuses an ordinary transcript turn", async () => {
    const dir = tempDirs.make("openclaw-user-turn-goal-text-collision-");
    const target = createSqliteTranscriptTarget({ dir });
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    await persistUserTurnTranscript({
      ...target,
      input: { text: "ordinary text", idempotencyKey: "goal-collision:user" },
      updateMode: "none",
    });

    await expect(
      persistUserTurnTranscript({
        ...target,
        expectedSessionId: target.sessionId,
        input: { text: "ordinary text", idempotencyKey: "goal-collision:user" },
        sessionTurnMutation: {
          kind: "session-goal-start",
          version: 1,
          goalId: "goal-collision",
          operationId: "goal-collision",
          sourceRunId: "goal-collision",
          sourceTurnId: "goal-collision:user",
          now: 1,
          objective: "ordinary text",
          requestFingerprint: `sha256:${"f".repeat(64)}`,
          result: { runId: "goal-collision", goalId: "goal-collision", status: "started" },
        },
        updateMode: "none",
      }),
    ).rejects.toThrow("requires one unchanged new transcript turn");
    expect(loadSessionEntry(target)?.goal).toBeUndefined();
    await expect(readTranscriptMessages(target)).resolves.toHaveLength(1);
  });

  it.each([
    { name: "operation fingerprint changed", existingGoal: false, fingerprint: "d" },
    { name: "the session already has a Goal", existingGoal: true, fingerprint: "c" },
  ])("rejects $name before inserting a turn", async ({ existingGoal, fingerprint }) => {
    const dir = tempDirs.make("openclaw-user-turn-goal-conflict-");
    const target = createSqliteTranscriptTarget({ dir });
    await upsertSessionEntryCore(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
      ...(existingGoal
        ? {
            goal: {
              schemaVersion: 1,
              id: "existing-goal",
              objective: "existing",
              status: "active",
              createdAt: 1,
              updatedAt: 1,
              tokenStart: 0,
              tokenStartFresh: true,
              tokensUsed: 0,
              continuationTurns: 0,
            } as const,
          }
        : {}),
    });
    if (!existingGoal) {
      await persistUserTurnTranscript({
        ...target,
        expectedSessionId: target.sessionId,
        input: { text: "first", idempotencyKey: "goal-conflict:user" },
        sessionTurnMutation: {
          kind: "session-goal-start",
          version: 1,
          goalId: "goal-first",
          operationId: "goal-conflict",
          sourceRunId: "goal-conflict",
          sourceTurnId: "goal-conflict:user",
          now: 1,
          objective: "first",
          requestFingerprint: `sha256:${"c".repeat(64)}`,
          result: { runId: "goal-conflict", goalId: "goal-first", status: "started" },
        },
        updateMode: "none",
      });
    }

    await expect(
      persistUserTurnTranscript({
        ...target,
        expectedSessionId: target.sessionId,
        input: { text: "changed", idempotencyKey: "goal-conflict:user" },
        sessionTurnMutation: {
          kind: "session-goal-start",
          version: 1,
          goalId: "goal-changed",
          operationId: "goal-conflict",
          sourceRunId: "goal-conflict",
          sourceTurnId: "goal-conflict:user",
          now: 2,
          objective: "changed",
          requestFingerprint: `sha256:${fingerprint.repeat(64)}`,
          result: { runId: "goal-conflict", goalId: "goal-changed", status: "started" },
        },
        updateMode: "none",
      }),
    ).rejects.toThrow(existingGoal ? "goal already exists" : "reused with different input");
    await expect(readTranscriptMessages(target)).resolves.toHaveLength(existingGoal ? 0 : 1);
  });

  it("preserves transcript metadata when before_message_write replaces a user turn", async () => {
    let hookCalls = 0;
    const provenance = {
      kind: "inter_session" as const,
      sourceSessionKey: "source-main",
      sourceTool: "sessions_send",
    };
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => {
            hookCalls += 1;
            const message = (event as { message: Record<string, unknown> }).message;
            const meta = message["__openclaw"] as {
              transport?: { conversationRef?: string; messageId?: string };
            };
            if (meta.transport) {
              meta.transport.conversationRef = "conv_tampered";
              meta.transport.messageId = "tampered-message";
            }
            return {
              message: castAgentMessage({
                role: "user",
                content: "[redacted by hook]",
                __openclaw: { hookOwned: true },
              }),
            };
          },
        },
      ]),
    );
    const dir = tempDirs.make("openclaw-user-turn-redacted-idempotent-");
    const target = createSqliteTranscriptTarget({ dir });

    await persistUserTurnTranscript({
      ...target,
      input: {
        text: "secret prompt",
        idempotencyKey: "chat-run-1:user",
        replyToId: "transcript-reply-1",
        replyToPreview: { text: "Original reply", senderLabel: "Molty" },
        senderIsOwner: true,
        provenance,
        sender: { id: "user-42", name: "Ada" },
        transport: {
          channel: "reef",
          conversationRef: "conv_0123456789abcdef0123456789abcdef",
          messageId: "inbound-1",
          replyToId: "outbound-1",
        },
      },
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    });
    await persistUserTurnTranscript({
      ...target,
      input: {
        text: "secret prompt",
        idempotencyKey: "chat-run-1:user",
        replyToId: "transcript-reply-1",
        replyToPreview: { text: "Original reply", senderLabel: "Molty" },
        senderIsOwner: true,
        provenance,
        sender: { id: "user-42", name: "Ada" },
        transport: {
          channel: "reef",
          conversationRef: "conv_0123456789abcdef0123456789abcdef",
          messageId: "inbound-1",
          replyToId: "outbound-1",
        },
      },
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    });

    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "[redacted by hook]",
        idempotencyKey: "chat-run-1:user",
        provenance,
        __openclaw: {
          hookOwned: true,
          replyToId: "transcript-reply-1",
          replyToPreview: { text: "Original reply", senderLabel: "Molty" },
          senderIsOwner: false,
          transport: {
            channel: "reef",
            conversationRef: "conv_0123456789abcdef0123456789abcdef",
            messageId: "inbound-1",
            replyToId: "outbound-1",
          },
        },
      }),
    ]);
    expect(hookCalls).toBe(1);
  });

  it("protects structured Goal metadata from before_message_write forgery and erasure", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => {
            const message = (event as { message: Record<string, unknown> }).message;
            return {
              message: castAgentMessage({
                ...message,
                __openclaw: {
                  ...(message["__openclaw"] as Record<string, unknown>),
                  sessionGoalStart: {
                    kind: "session-goal-start",
                    version: 1,
                    goalId: "forged",
                    operationId: "forged",
                    sourceRunId: "forged",
                    sourceTurnId: "forged:user",
                  },
                },
              }),
            };
          },
        },
      ]),
    );
    const dir = tempDirs.make("openclaw-user-turn-goal-hook-");
    const target = createSqliteTranscriptTarget({ dir });
    const sessionGoalStart = {
      kind: "session-goal-start" as const,
      version: 1 as const,
      goalId: "goal-real",
      operationId: "run-real",
      sourceRunId: "run-real",
      sourceTurnId: "run-real:user",
    };

    await persistUserTurnTranscript({
      ...target,
      input: { text: "objective", sessionGoalStart },
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      updateMode: "none",
    });

    const [message] = await readTranscriptMessages(target);
    expect(message?.["__openclaw"]).toMatchObject({ sessionGoalStart });
  });

  it("drops hook-forged structured Goal metadata when the producer supplied none", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => {
            const message = (event as { message: Record<string, unknown> }).message;
            return {
              message: castAgentMessage({
                ...message,
                __openclaw: {
                  sessionGoalStart: {
                    kind: "session-goal-start",
                    version: 1,
                    goalId: "forged",
                    operationId: "forged",
                    sourceRunId: "forged",
                    sourceTurnId: "forged:user",
                  },
                },
              }),
            };
          },
        },
      ]),
    );
    const dir = tempDirs.make("openclaw-user-turn-goal-hook-forgery-");
    const target = createSqliteTranscriptTarget({ dir });

    await persistUserTurnTranscript({
      ...target,
      input: { text: "ordinary turn" },
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      updateMode: "none",
    });

    const [message] = await readTranscriptMessages(target);
    expect(
      (message?.["__openclaw"] as Record<string, unknown> | undefined)?.sessionGoalStart,
    ).toBeUndefined();
  });

  it.each([
    {
      name: "restores an erased producer target",
      producerTarget: "active-run",
      hookTarget: undefined,
      expectedTarget: "active-run",
    },
    {
      name: "rejects a replacement target",
      producerTarget: "active-run",
      hookTarget: "forged-run",
      expectedTarget: "active-run",
    },
    {
      name: "rejects a target forged without producer provenance",
      producerTarget: undefined,
      hookTarget: "forged-run",
      expectedTarget: undefined,
    },
  ])(
    "$name across before_message_write",
    async ({ producerTarget, hookTarget, expectedTarget }) => {
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_message_write",
            handler: (event) => {
              const message = (event as { message: Record<string, unknown> }).message;
              const metadata = {
                ...(message["__openclaw"] as Record<string, unknown> | undefined),
              };
              delete metadata.steerTargetRunId;
              return {
                message: castAgentMessage({
                  ...message,
                  __openclaw: {
                    ...metadata,
                    ...(hookTarget ? { steerTargetRunId: hookTarget } : {}),
                  },
                }),
              };
            },
          },
        ]),
      );
      const dir = tempDirs.make("openclaw-user-turn-steer-target-hook-");
      const target = createSqliteTranscriptTarget({ dir });

      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: "steer or queue",
          idempotencyKey: "chat-run-steer-target:user",
        },
        target,
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      });
      if (producerTarget) {
        await recorder.confirmSteerTargetRunIdForPersistence?.(producerTarget);
      }
      await recorder.persistApproved();

      const [message] = await readTranscriptMessages(target);
      const metadata = message?.["__openclaw"] as Record<string, unknown> | undefined;
      expect(metadata?.steerTargetRunId).toBe(expectedTarget);
    },
  );
});

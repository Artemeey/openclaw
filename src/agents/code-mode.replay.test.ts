/** Tests Code Mode restart-safe replay. */

import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPluginToolMeta } from "../plugins/tools.js";
import { consumeUncertainCodeModeMutations } from "./code-mode-repair-provenance.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import {
  resetCodeModeTestState,
  fakeTool,
  pluginTool,
  pluginToolWithExecute,
  mcpTool,
  resultDetails,
  createCodeModeHarness,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { createToolSearchCatalogRef } from "./tool-search.js";
import { jsonResult } from "./tools/common.js";

describe("Code Mode restart-safe replay", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCodeModeTestState();
  });

  it("keeps restart-safe mode across audited core reads", async () => {
    const targetTool = fakeTool("read", "Read");
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-replay-safety",
        {
          restartSafe: true,
          code: `
          const [read] = await catalog.search(${JSON.stringify(targetTool.name)});
          return await read({});
        `,
        },
      ),
    );
    expect(first.status).toBe("waiting");
    expect(first.replaySafe).toBe(true);

    const second = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-replay-safety",
        { runId: first.runId },
      ),
    );
    expect(second.status).toBe("waiting");
    expect(second.replaySafe).toBe(true);

    const completed = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-replay-safety-complete",
        {
          runId: second.runId,
        },
      ),
    );
    expect(completed.status).toBe("completed");
  });

  it("allows explicitly replay-safe plugin tools through callable search", async () => {
    const targetTool = pluginTool("fake_plugin_read", "Plugin read");
    setPluginToolMeta(targetTool, {
      pluginId: "fake-code-mode",
      optional: true,
      replaySafe: true,
    });
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const completed = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      restartSafe: true,
      code: `
        const [read] = await catalog.search("fake_plugin_read");
        return await read({});
      `,
    });

    expect(completed.status).toBe("completed");
    expect(completed.replaySafe).toBe(true);
    expect(targetTool.execute).toHaveBeenCalledTimes(1);
  });

  it("resolves a replay-safe tool through its reserved-name catalog handle", async () => {
    const targetTool = pluginTool("catalog", "Reserved-name plugin read");
    setPluginToolMeta(targetTool, {
      pluginId: "fake-code-mode",
      optional: true,
      replaySafe: true,
    });
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const completed = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      restartSafe: true,
      code: `
        const [read] = await catalog.search("catalog");
        return await read({});
      `,
    });

    expect(completed.status).toBe("completed");
    expect(completed.replaySafe).toBe(true);
    expect(targetTool.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects MCP tools even when their metadata claims replay safety", async () => {
    const targetTool = mcpTool({
      name: "mcp_github_read_file",
      serverName: "github",
      toolName: "read_file",
    });
    setPluginToolMeta(targetTool, {
      pluginId: "bundle-mcp",
      optional: false,
      replaySafe: true,
      mcp: {
        serverName: "github",
        safeServerName: "github",
        toolName: "read_file",
        operation: "tool",
      },
    });
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const completed = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      restartSafe: true,
      code: 'return await MCP.github.readFile({ path: "README.md" });',
    });

    expect(completed.status).toBe("failed");
    expect(completed.replaySafe).toBe(true);
    expect(completed.error).toContain("cannot call namespace tools");
    expect(targetTool.execute).not.toHaveBeenCalled();
  });

  it("rejects side-effecting calls before executing them in restart-safe mode", async () => {
    const targetTool = pluginTool("fake_write", "Write");
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-unsafe-restart",
        {
          restartSafe: true,
          code: `
          const [write] = await catalog.search("fake_write");
          return await write({});
        `,
        },
      ),
    );
    expect(first.status).toBe("waiting");
    expect(first.replaySafe).toBe(true);

    const failed = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-unsafe-restart",
        { runId: first.runId },
      ),
    );
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("not proven replay-safe");
    expect(failed.error).toContain("audited read, grep, or find tools");
    expect(targetTool.execute).not.toHaveBeenCalled();
  });

  it("preserves bridge evidence when a later restart-safe call is rejected", async () => {
    const readTool = pluginTool("fake_safe_read", "Read");
    setPluginToolMeta(readTool, {
      pluginId: "fake-code-mode",
      optional: true,
      replaySafe: true,
    });
    const writeTool = pluginTool("fake_unsafe_write", "Write");
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, readTool, writeTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const failed = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      restartSafe: true,
      code: `
        const [read] = await catalog.search("fake_safe_read");
        await read({});
        const [write] = await catalog.search("fake_unsafe_write");
        return await write({});
      `,
    });

    expect(failed).toMatchObject({
      status: "failed",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
      replaySafe: true,
    });
    expect(failed.error).toContain("not proven replay-safe");
    expect(readTool.execute).toHaveBeenCalledTimes(1);
    expect(writeTool.execute).not.toHaveBeenCalled();
  });

  it("fences nested exec replay across host-derived yield budgets", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const config = {
      tools: { codeMode: { enabled: true, timeoutMs: 10_000 } },
    } as never;
    const shellCalls: unknown[] = [];
    const originalCode = 'return await exec({ command: "same", yieldMs: 4_000 });';

    const createHarness = (mutationKeys?: readonly string[]) => {
      const catalogRef = createToolSearchCatalogRef();
      const ctx = {
        config,
        runtimeConfig: config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
        ...(mutationKeys
          ? { codeModeReconciliationReplayFence: { code: originalCode, mutationKeys } }
          : {}),
      };
      const codeModeTools = createCodeModeTools(ctx);
      const consumeBudget = pluginToolWithExecute(
        "fake_consume_budget",
        "Consume most of the shared Code Mode deadline",
        async () => {
          vi.advanceTimersByTime(9_600);
          return jsonResult({ consumed: true });
        },
      );
      const shell = pluginToolWithExecute("exec", "Run shell", async (_toolCallId, input) => {
        shellCalls.push(input);
        throw new Error("shell reply lost after dispatch");
      });
      shell.parameters = Type.Object({
        command: Type.String(),
        yieldMs: Type.Optional(Type.Number()),
      });
      applyCodeModeCatalog({
        tools: [...codeModeTools, consumeBudget, shell],
        config,
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        runId: ctx.runId,
        catalogRef,
      });
      return { codeModeTools, consumeBudget };
    };

    const firstHarness = createHarness();
    const first = resultDetails(
      await expectDefined(firstHarness.codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-shell-first",
        { code: originalCode },
      ),
    );
    const mutationKeys = consumeUncertainCodeModeMutations(first);
    expect(mutationKeys).toHaveLength(1);
    expect(shellCalls).toEqual([{ command: "same", yieldMs: 4_000 }]);

    const replayHarness = createHarness(mutationKeys);
    const replay = resultDetails(
      await expectDefined(replayHarness.codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-shell-replay",
        {
          code: 'await fake_consume_budget({}); return await exec({ command: "same" });',
        },
      ),
    );

    expect(replay).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Blocked a replay"),
    });
    expect(replayHarness.consumeBudget.execute).toHaveBeenCalledOnce();
    expect(shellCalls).toEqual([{ command: "same", yieldMs: 4_000 }]);
  });

  it("keeps host-forced restart safety when the model clears the exec flag", async () => {
    const targetTool = pluginTool("fake_forced_write", "Write");
    const {
      config,
      catalogRef,
      tools: codeModeTools,
    } = createCodeModeHarness({
      forceRestartSafeTools: true,
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-forced-restart",
        {
          restartSafe: false,
          code: `
          const [write] = await catalog.search("fake_forced_write");
          return await write({});
        `,
        },
      ),
    );
    expect(first.status).toBe("waiting");
    expect(first.replaySafe).toBe(true);

    const failed = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-forced-restart",
        { runId: first.runId },
      ),
    );
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("not proven replay-safe");
    expect(targetTool.execute).not.toHaveBeenCalled();
  });
});

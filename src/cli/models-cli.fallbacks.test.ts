import fs from "node:fs/promises";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { defaultRuntime } from "../runtime.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerModelsCli } from "./models-cli.js";

describe("models fallback CLI config flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { group: "fallbacks", key: "model" as const, other: "imageModel" as const, label: "Fallback" },
    {
      group: "image-fallbacks",
      key: "imageModel" as const,
      other: "model" as const,
      label: "Image fallback",
    },
  ])(
    "persists only default $key fallbacks through all four commands",
    async ({ group, key, other, label }) => {
      const state = await createOpenClawTestState({ label: "models-fallback-cli" });
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const stdout = vi.spyOn(defaultRuntime, "writeStdout").mockImplementation(() => {});
      const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
        throw new Error(`CLI exit ${code}`);
      });
      const primary = "openai/gpt-4.1-mini";
      const fallback = "zai/glm-4.7";
      const sibling = { primary, fallbacks: ["openai/gpt-4.1"] };
      const agents = { helper: { model: { primary, fallbacks: ["openai/gpt-4.1"] } } };
      const read = async (): Promise<OpenClawConfig> =>
        JSON.parse(await fs.readFile(state.configPath, "utf8"));
      const run = async (...args: string[]) => {
        vi.clearAllMocks();
        const program = new Command().enablePositionalOptions();
        registerModelsCli(program);
        await program.parseAsync(["models", "--agent", "helper", group, ...args], { from: "user" });
      };

      try {
        await state.writeConfig({
          agents: {
            ownership: "explicit",
            entries: agents,
            defaults: {
              [key]: primary,
              [other]: sibling,
              models: { [fallback]: { alias: "backup", params: { temperature: 0.4 } } },
            },
          },
        });

        await run("add", "backup");
        const added = await read();
        expect(added.agents?.defaults?.[key]).toEqual({ primary, fallbacks: [fallback] });
        expect(added.agents?.defaults?.[other]).toEqual(sibling);
        expect(added.agents?.entries).toEqual(agents);
        expect(added.agents?.defaults?.models?.[fallback]).toEqual({
          alias: "backup",
          params: { temperature: 0.4 },
        });
        expect(log).toHaveBeenLastCalledWith(`${label}s: ${fallback}`);

        await run("add", "z-ai/glm-4.7");
        expect((await read()).agents).toEqual(added.agents);
        await run("list", "--json");
        expect(json).toHaveBeenCalledExactlyOnceWith({ fallbacks: [fallback] }, 2);
        expect(stdout).not.toHaveBeenCalled();
        await run("list", "--plain");
        expect(stdout).toHaveBeenCalledExactlyOnceWith(fallback);
        expect(log).not.toHaveBeenCalled();
        await run("list");
        expect(log.mock.calls).toEqual([[`${label}s (1):`], [`- ${fallback}`]]);

        await run("remove", "backup");
        expect((await read()).agents?.defaults?.[key]).toEqual({ primary, fallbacks: [] });
        expect(log).toHaveBeenLastCalledWith(`${label}s: `);
        const beforeError = await fs.readFile(state.configPath, "utf8");
        await expect(run("remove", "backup")).rejects.toThrow("CLI exit 1");
        expect(error).toHaveBeenCalledWith(
          `${label} not found: ${fallback}. Run openclaw models ${group} list to see configured fallbacks.`,
        );
        expect(exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(await fs.readFile(state.configPath, "utf8")).toBe(beforeError);

        await run("add", "backup");
        await run("clear");
        const cleared = await read();
        expect(cleared.agents?.defaults?.[key]).toEqual({ primary, fallbacks: [] });
        expect(cleared.agents?.defaults?.[other]).toEqual(sibling);
        expect(cleared.agents?.entries).toEqual(agents);
        expect(log).toHaveBeenLastCalledWith(`${label} list cleared.`);
        await run("list");
        expect(log.mock.calls).toEqual([[`${label}s (0):`], ["- none"]]);
      } finally {
        await state.cleanup();
      }
    },
  );
});

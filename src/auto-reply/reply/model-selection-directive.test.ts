// Covers direct model directive authorization and upgrade-era repair guidance.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildModelAliasIndex } from "../../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "../../plugins/loader.test-fixtures.js";
import {
  preparePluginMetadata,
  withPluginMetadataCollectionScope,
} from "../../plugins/plugin-metadata-collection.js";
import { resolveModelDirectiveSelection } from "./model-selection-directive.js";

let directivePlugin: ReturnType<typeof writePlugin>;

beforeEach(() => {
  directivePlugin = writePlugin({
    id: "directive-provider-fixture",
    body: `module.exports = {
  id: "directive-provider-fixture",
  register(api) {
    api.registerProvider({ id: "openai", label: "Fixture", auth: [] });
  },
};`,
  });
  fs.writeFileSync(
    path.join(directivePlugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: directivePlugin.id,
      providers: ["openai"],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
});

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

function resolveDirective(params: { cfg: OpenClawConfig; raw: string; agentId?: string }) {
  const cfg: OpenClawConfig = {
    ...params.cfg,
    plugins: {
      allow: [directivePlugin.id],
      entries: { [directivePlugin.id]: { enabled: true } },
      load: { paths: [directivePlugin.file] },
      slots: { memory: "none" },
    },
  };
  const metadata = preparePluginMetadata({
    config: cfg,
    workspaceDir: directivePlugin.dir,
    allowCurrent: false,
  });
  return withPluginMetadataCollectionScope(
    metadata,
    () => {
      const defaultProvider = "openai";
      const defaultModel = "safe";
      const policy = createModelVisibilityPolicy({
        cfg,
        catalog: [],
        defaultProvider,
        defaultModel,
        agentId: params.agentId,
        workspaceDir: directivePlugin.dir,
      });
      return {
        policy,
        result: resolveModelDirectiveSelection({
          raw: params.raw,
          defaultProvider,
          defaultModel,
          aliasIndex: buildModelAliasIndex({
            cfg,
            defaultProvider,
            agentId: params.agentId,
            workspaceDir: directivePlugin.dir,
          }),
          allowedModelKeys: policy.allowedKeys,
          cfg,
          agentId: params.agentId,
          workspaceDir: directivePlugin.dir,
        }),
      };
    },
    { config: cfg, workspaceDir: directivePlugin.dir },
  );
}

describe("resolveModelDirectiveSelection", () => {
  it.each([
    { raw: "custom/custom/model", alias: undefined },
    { raw: "custom/nested-nick", alias: "nested-nickname" },
  ])("preserves the configured model namespace for $raw", ({ raw, alias }) => {
    const { result } = resolveDirective({
      cfg: {
        models: {
          providers: {
            custom: {
              baseUrl: "https://models.example.test",
              models: ["model", "custom/model"].map((id) => ({
                id,
                name: id,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                maxTokens: 1_024,
              })),
            },
          },
        },
        agents: {
          defaults: {
            models: {
              "custom/model": { alias: "plain" },
              "custom/custom/model": { alias: "nested-nickname" },
            },
            modelPolicy: { allow: ["custom/model", "custom/custom/model"] },
          },
        },
      },
      raw,
    });

    expect(result.selection).toEqual({
      provider: "custom",
      model: "custom/model",
      isDefault: false,
      alias,
    });
  });

  it("rejects a configured fallback that the explicit policy does not allow", () => {
    const { policy, result } = resolveDirective({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/safe", fallbacks: ["external/sensitive"] },
            modelPolicy: { allow: ["openai/safe"] },
          },
        },
      },
      raw: "external/sensitive",
    });

    expect(policy.allowedKeys.has("external/sensitive")).toBe(false);
    expect(result.selection).toBeUndefined();
    expect(result.error).toContain('Model "external/sensitive" is not allowed.');
  });

  it.each([
    {
      name: "defaults",
      cfg: {
        agents: { defaults: { models: { "openai/safe": {} } } },
      } as OpenClawConfig,
      agentId: undefined,
      repairPath: "agents.defaults.modelPolicy.allow",
      legacyPath: "agents.defaults.models",
    },
    // Only agents.defaults.models is a legacy allowlist; per-agent models maps are
    // metadata-only, so there is no per-agent legacy-repair case to cover here.
  ])("points unmarked legacy $name repair at modelPolicy.allow", (testCase) => {
    const { result } = resolveDirective({
      cfg: testCase.cfg,
      raw: "external/sensitive",
      agentId: testCase.agentId,
    });

    expect(result.error).toContain(
      `Add "external/sensitive" or its provider wildcard to ${testCase.repairPath}.`,
    );
    expect(result.error).not.toContain(`to ${testCase.legacyPath}.`);
  });
});

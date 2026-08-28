// Mcp Channels Seed script supports OpenClaw repository automation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const SESSION_ID = "sess-main";
const SESSION_KEY = "agent:main:main";

export async function seedMcpChannelsState(params: {
  env: NodeJS.ProcessEnv;
  now?: number;
  seededConfig: OpenClawConfig;
}) {
  const stateDir = params.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  const configPath =
    params.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "openclaw.json");
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  const sessionFile = path.join(sessionsDir, `${SESSION_ID}.jsonl`);
  const now = params.now ?? Date.now();
  const transcriptEvents = [
    { type: "session", version: 1, id: SESSION_ID },
    {
      id: "msg-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello from seeded transcript" }],
        timestamp: now,
      },
    },
    {
      id: "msg-attachment",
      message: {
        role: "user",
        content: "seeded image attachment",
        __openclaw: {
          media: [
            {
              url: "media://inbound/seeded-image.png",
              contentType: "image/png",
              kind: "image",
              fileName: "seeded-image.png",
              sizeBytes: 3,
            },
          ],
        },
        timestamp: now + 1,
      },
    },
  ];

  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(params.seededConfig, null, 2), "utf-8");

  await replaceSessionEntry(
    { agentId: "main", env: params.env, sessionKey: SESSION_KEY },
    {
      sessionId: SESSION_ID,
      updatedAt: now,
      deliveryContext: {
        channel: "imessage",
        to: "+15551234567",
        accountId: "imessage-default",
        threadId: "thread-42",
      },
      displayName: "Docker MCP Channel Smoke",
      derivedTitle: "Docker MCP Channel Smoke",
      lastMessagePreview: "seeded transcript",
    },
  );
  await replaceTranscriptEvents(
    { agentId: "main", env: params.env, sessionId: SESSION_ID, sessionKey: SESSION_KEY },
    transcriptEvents,
  );

  await fs.writeFile(
    sessionFile,
    transcriptEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf-8",
  );

  return {
    stateDir,
    configPath,
    sessionFile,
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
  };
}

async function main() {
  const { applyDockerOpenAiProviderConfig } = await import("./docker-openai-seed.ts");
  const seededConfig = applyDockerOpenAiProviderConfig(
    {
      gateway: {
        controlUi: {
          enabled: false,
        },
      },
      agents: {
        defaults: {
          heartbeat: {
            every: "0m",
          },
        },
      },
      plugins: {
        enabled: false,
      },
    } satisfies OpenClawConfig,
    "sk-docker-smoke-test",
  );
  const result = await seedMcpChannelsState({ env: process.env, seededConfig });
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

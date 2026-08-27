#!/usr/bin/env node
// Deterministic Codex CLI/app-server fixture for the macOS app onboarding lane.
import fs from "node:fs";
import readline from "node:readline";

const version = "0.149.1";
const requestLog = "/private/tmp/openclaw-onboarding-codex-app-server.jsonl";

if (process.argv.includes("--version")) {
  process.stdout.write(`codex-cli ${version}\n`);
  process.exit(0);
}

if (process.argv[2] !== "app-server") {
  process.stderr.write("fixture supports only --version and app-server\n");
  process.exit(2);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(request) {
  fs.appendFileSync(requestLog, `${JSON.stringify(request)}\n`);
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const request = JSON.parse(line);
  log(request);
  if (request.id === undefined) {
    return;
  }
  const result = (value) => send({ id: request.id, result: value });
  const notify = (method, params) => send({ method, params });

  switch (request.method) {
    case "initialize":
      result({
        protocolVersion: "2",
        serverInfo: { name: "openclaw-parallels-onboarding", version },
        userAgent: `openclaw-parallels-onboarding/${version} (macOS; test)`,
      });
      break;
    case "account/read":
      result({
        account: {
          type: "chatgpt",
          email: "parallels-onboarding@example.com",
          planType: "pro",
        },
        requiresOpenaiAuth: true,
      });
      break;
    case "account/rateLimits/read":
      result({
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: null,
          secondary: null,
          credits: null,
          individualLimit: null,
          spendControlReached: null,
          planType: "pro",
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      });
      break;
    case "thread/start": {
      const now = Date.now();
      result({
        thread: {
          id: "thread-parallels-onboarding",
          sessionId: "session-parallels-onboarding",
          forkedFromId: null,
          preview: "",
          ephemeral: false,
          projectId: null,
          modelProvider: "openai",
          createdAt: now,
          updatedAt: now,
          status: { type: "idle" },
          path: null,
          cwd: request.params?.cwd ?? process.cwd(),
          cliVersion: version,
          source: "unknown",
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: request.params?.model ?? "gpt-5.6-luna",
        modelProvider: "openai",
        serviceTier: null,
        cwd: request.params?.cwd ?? process.cwd(),
        runtimeWorkspaceRoots: [],
        instructionSources: [],
        approvalPolicy: request.params?.approvalPolicy ?? "never",
        approvalsReviewer: request.params?.approvalsReviewer ?? "user",
        sandbox: { type: "dangerFullAccess" },
        activePermissionProfile: null,
        reasoningEffort: null,
        multiAgentMode: "explicitRequestOnly",
      });
      break;
    }
    case "turn/start": {
      const threadId = request.params?.threadId ?? "thread-parallels-onboarding";
      const turnId = "turn-parallels-onboarding";
      const message = {
        type: "agentMessage",
        id: "message-parallels-onboarding",
        text: "PARALLELS_ONBOARDING_CODEX_READY",
      };
      result({
        turn: {
          id: turnId,
          items: [],
          itemsView: "notLoaded",
          status: "inProgress",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      });
      setImmediate(() => {
        const completedAtMs = Date.now();
        notify("item/completed", { item: message, threadId, turnId, completedAtMs });
        notify("turn/completed", {
          threadId,
          turn: {
            id: turnId,
            items: [message],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: Math.floor(completedAtMs / 1000),
            completedAt: Math.floor(completedAtMs / 1000),
            durationMs: 0,
          },
        });
      });
      break;
    }
    default:
      result({});
      break;
  }
});

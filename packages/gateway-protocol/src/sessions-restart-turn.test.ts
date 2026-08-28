import { describe, expect, it } from "vitest";
import { validateSessionsRestartTurnParams } from "./index.js";

const params = {
  key: "agent:main:main",
  runId: "run-current",
  reason: "permission-change",
  permissionMode: "workspace",
  idempotencyKey: "restart-1",
};

describe("validateSessionsRestartTurnParams", () => {
  it("accepts the closed permission-change restart contract", () => {
    for (const value of [
      params,
      { ...params, permissionMode: null },
      { ...params, permissionMode: "read-only", agentId: "main" },
    ]) {
      expect(validateSessionsRestartTurnParams(value)).toBe(true);
    }
  });

  it("rejects ambiguous lifecycle requests", () => {
    for (const value of [
      { ...params, runId: "" },
      { ...params, reason: "retry" },
      { ...params, permissionMode: "invalid" },
      { ...params, unexpected: true },
    ]) {
      expect(validateSessionsRestartTurnParams(value)).toBe(false);
    }
  });
});

import { describe, expect, it } from "vitest";
import { resolveSystemNoticeKind } from "./system-notice-kinds.ts";

describe("resolveSystemNoticeKind", () => {
  it.each([
    [
      "main_session_restart_recovery",
      "chat.systemNotice.restartRecovery.label",
      "chat.systemNotice.restartRecovery.summary",
      "cpu",
    ],
    ["restart-sentinel", "chat.systemNotice.gatewayRestarted.label", undefined, "cpu"],
    [
      "permission_change_restart",
      "chat.systemNotice.permissionRestart.label",
      undefined,
      "shieldCheck",
    ],
  ])("resolves the canonical %s source tool", (sourceTool, labelKey, summaryKey, icon) => {
    expect(resolveSystemNoticeKind(sourceTool)).toEqual(
      summaryKey === undefined ? { icon, labelKey } : { icon, labelKey, summaryKey },
    );
  });

  it.each([
    undefined,
    "heartbeat",
    "main-session-restart-recovery",
    "restart_sentinel",
    " restart-sentinel ",
  ])("does not normalize or guess the unknown %s source tool", (sourceTool) => {
    expect(resolveSystemNoticeKind(sourceTool)).toBeUndefined();
  });
});

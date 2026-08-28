import { settleCorrelatedSubagentDelivery } from "../agents/subagents/completion/subagent-completion-delivery.js";
import { settleCorrelatedGeneratedMediaDelivery } from "../agents/tools/generated-media-completion-delivery.js";
import type { SettleSessionDeliveryFn } from "../infra/session-delivery-queue-recovery.js";
import { removeCronRunContinuationSessionIfIdle } from "../tasks/cron-run-continuation-cleanup.js";

export const settleQueuedSessionDelivery: SettleSessionDeliveryFn = (entry, outcome) =>
  settleCorrelatedSubagentDelivery(entry, outcome)
    .then(() => settleCorrelatedGeneratedMediaDelivery(entry, outcome))
    .then(() => removeCronRunContinuationSessionIfIdle(entry.sessionKey, entry.id));

import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type {
  SessionAccessScope,
  SessionEntrySummary,
} from "./session-accessor.sqlite-contract.js";
import { projectSqliteSessionParticipants } from "./session-accessor.sqlite-participant-projection.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  canonicalSessionKeyMigrationRequiredError,
} from "./session-canonical-key.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "./store-entry.js";

/** Counts visible entries and owns only the requested recent payloads, without warming the store cache. */
export function readSessionStoreSummaryReadOnly(
  scope: Pick<SessionAccessScope, "agentId" | "defaultAgentId" | "env" | "storePath">,
  options: { recentLimit: number; excludeSessionKeys?: readonly string[] },
): { count: number; recent: SessionEntrySummary[] } {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const excluded = new Set(options.excludeSessionKeys);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(database.db, () => {
        assertCanonicalSqliteSessionKeysCurrent(database);
        const db = getSessionKysely(database.db);
        const recent: SessionEntrySummary[] = [];
        let count = 0;
        // The read transaction keeps count, ordering, and selected payloads on one
        // generation. Existing keys/indexes bound JSON work, not the cold canonical check.
        for (const row of iterateSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_nodes")
            .select(["session_key", "entry_valid"])
            .orderBy("updated_at", "desc")
            .orderBy("session_key", "asc"),
        )) {
          if (excluded.has(row.session_key) || isInternalSessionEffectsKey(row.session_key)) {
            continue;
          }
          if (row.entry_valid === 1 && recent.length >= options.recentLimit) {
            count += 1;
            continue;
          }
          // Raw updates clear entry_valid. Preserve listing's warm-row semantics:
          // skip unreadable JSON/retained placeholders, but include readable pending rows.
          const stored = executeSqliteQueryTakeFirstSync(
            database.db,
            db.selectFrom("session_nodes").selectAll().where("session_key", "=", row.session_key),
          );
          if (!stored) {
            continue;
          }
          const { current_session_id: _currentSessionId, ...listRow } = stored;
          const parsed = parseSessionEntryJson(listRow);
          if (!parsed) {
            continue;
          }
          const entry = projectSqliteSessionParticipants(database.db, row.session_key, parsed);
          const deliveryCanonicalKey = resolveDeliveryProvenCanonicalSessionKey(
            row.session_key,
            entry,
          );
          if (deliveryCanonicalKey !== row.session_key) {
            throw canonicalSessionKeyMigrationRequiredError(
              `non-canonical persisted row resolves to session key ${deliveryCanonicalKey}`,
            );
          }
          count += 1;
          if (recent.length < options.recentLimit) {
            recent.push({ sessionKey: row.session_key, entry });
          }
        }
        return { count, recent };
      }),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : { count: 0, recent: [] };
}

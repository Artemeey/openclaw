import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const SESSION_RPC_RECEIPTS_TABLE = "session_rpc_receipts";

const RECEIPT_SCHEMA_START = `CREATE TABLE IF NOT EXISTS ${SESSION_RPC_RECEIPTS_TABLE} (`;
const RECEIPT_SCHEMA_END = "CREATE TABLE IF NOT EXISTS board_tabs (";
const ensuredDatabases = new WeakSet<DatabaseSync>();

function sessionRpcReceiptSchemaSql(): string {
  const start = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(RECEIPT_SCHEMA_START);
  const end = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(RECEIPT_SCHEMA_END, start);
  if (start === -1 || end === -1) {
    throw new Error("OpenClaw session RPC receipt schema markers are missing.");
  }
  return OPENCLAW_AGENT_SCHEMA_SQL.slice(start, end);
}

/** Lazily installs the additive receipt owner without escaping the caller's transaction. */
export function ensureSessionRpcReceiptSchema(db: DatabaseSync): void {
  if (ensuredDatabases.has(db)) {
    return;
  }
  const ensure = () => {
    db.exec(sessionRpcReceiptSchemaSql()); // sqlite-allow-raw -- Canonical additive DDL only.
  };
  if (db.isTransaction) {
    // Do not cache transactional DDL: rollback must make the next attempt ensure again.
    ensure();
    return;
  }
  runSqliteImmediateTransactionSync(db, ensure);
  ensuredDatabases.add(db);
}

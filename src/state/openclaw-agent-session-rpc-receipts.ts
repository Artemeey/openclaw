import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB as OpenClawAgentKyselyDatabase } from "./openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db.js";
import { ensureSessionRpcReceiptSchema } from "./openclaw-agent-session-rpc-receipt-schema.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

export type SessionRpcReceiptJson =
  | null
  | boolean
  | number
  | string
  | SessionRpcReceiptJson[]
  | { [key: string]: SessionRpcReceiptJson };

export type SessionRpcReceiptFingerprint = `sha256:${string}`;

export type SessionRpcReceiptKey = {
  sessionId: string;
  method: string;
  operationId: string;
};

export type SessionRpcReceipt = SessionRpcReceiptKey & {
  requestFingerprint: SessionRpcReceiptFingerprint;
  result: SessionRpcReceiptJson;
  createdAt: number;
};

export type SessionRpcReceiptInsertResult =
  | { status: "inserted"; receipt: SessionRpcReceipt }
  | { status: "replay"; receipt: SessionRpcReceipt };

type SessionRpcReceiptDatabase = Pick<OpenClawAgentKyselyDatabase, "session_rpc_receipts">;
type SessionRpcReceiptDatabaseHandle = Pick<OpenClawAgentDatabase, "db">;
type SessionRpcReceiptRow = Selectable<OpenClawAgentKyselyDatabase["session_rpc_receipts"]>;

const SESSION_RPC_RECEIPT_MAX_RESULT_BYTES = 16 * 1024;
const SESSION_RPC_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export class SessionRpcReceiptConflictError extends Error {
  constructor(readonly key: SessionRpcReceiptKey) {
    super(
      `Session RPC operation was reused with different input: ${key.method} ${key.operationId}`,
    );
    this.name = "SessionRpcReceiptConflictError";
  }
}

function receiptDb(database: SessionRpcReceiptDatabaseHandle) {
  return getNodeSqliteKysely<SessionRpcReceiptDatabase>(database.db);
}

function requiredBoundedText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`Session RPC receipt ${field} must contain 1 to ${maxLength} characters`);
  }
  return normalized;
}

function normalizeKey(key: SessionRpcReceiptKey): SessionRpcReceiptKey {
  return {
    sessionId: requiredBoundedText(key.sessionId, "session id", 1_024),
    method: requiredBoundedText(key.method, "method", 128),
    operationId: requiredBoundedText(key.operationId, "operation id", 256),
  };
}

function assertFingerprint(value: string): asserts value is SessionRpcReceiptFingerprint {
  if (!FINGERPRINT_PATTERN.test(value)) {
    throw new Error("Session RPC receipt fingerprint must be a canonical SHA-256 digest");
  }
}

function isSessionRpcReceiptJson(value: unknown): value is SessionRpcReceiptJson {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isSessionRpcReceiptJson);
  }
  return isRecord(value) && Object.values(value).every(isSessionRpcReceiptJson);
}

function canonicalJsonValue(value: SessionRpcReceiptJson, label: string): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error(`Session RPC receipt ${label} must be JSON`);
  }
  if (json === undefined) {
    throw new Error(`Session RPC receipt ${label} must be JSON`);
  }
  const parsed: unknown = JSON.parse(json);
  if (!isSessionRpcReceiptJson(parsed)) {
    throw new Error(`Session RPC receipt ${label} must be JSON`);
  }
  const canonicalJson = stableStringify(parsed);
  if (canonicalJson !== stableStringify(value)) {
    throw new Error(`Session RPC receipt ${label} must be JSON`);
  }
  return canonicalJson;
}

function canonicalResultJson(result: SessionRpcReceiptJson): string {
  const resultJson = canonicalJsonValue(result, "result");
  const resultBytes = Buffer.byteLength(resultJson, "utf8");
  if (resultBytes < 1 || resultBytes > SESSION_RPC_RECEIPT_MAX_RESULT_BYTES) {
    throw new Error("Session RPC receipt result exceeds 16 KiB");
  }
  return resultJson;
}

function parseReceiptRow(row: SessionRpcReceiptRow): SessionRpcReceipt {
  const createdAt = normalizeSqliteNumber(row.created_at);
  const resultBytes = normalizeSqliteNumber(row.result_bytes);
  assertFingerprint(row.request_fingerprint);
  if (
    createdAt === undefined ||
    createdAt < 0 ||
    resultBytes === undefined ||
    resultBytes < 1 ||
    resultBytes > SESSION_RPC_RECEIPT_MAX_RESULT_BYTES ||
    Buffer.byteLength(row.result_json, "utf8") !== resultBytes
  ) {
    throw new Error("Corrupt session RPC receipt metadata");
  }
  let result: unknown;
  try {
    result = JSON.parse(row.result_json);
  } catch {
    throw new Error("Corrupt session RPC receipt result JSON");
  }
  if (!isSessionRpcReceiptJson(result) || stableStringify(result) !== row.result_json) {
    throw new Error("Corrupt session RPC receipt result encoding");
  }
  return {
    sessionId: row.session_id,
    method: row.method,
    operationId: row.operation_id,
    requestFingerprint: row.request_fingerprint,
    result,
    createdAt,
  };
}

function selectReceipt(
  database: SessionRpcReceiptDatabaseHandle,
  key: SessionRpcReceiptKey,
): SessionRpcReceipt | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    receiptDb(database)
      .selectFrom("session_rpc_receipts")
      .selectAll()
      .where("session_id", "=", key.sessionId)
      .where("operation_id", "=", key.operationId),
  );
  return row ? parseReceiptRow(row) : undefined;
}

function pruneSessionRpcReceipts(database: SessionRpcReceiptDatabaseHandle, now: number): void {
  executeSqliteQuerySync(
    database.db,
    receiptDb(database)
      .deleteFrom("session_rpc_receipts")
      .where("created_at", "<", Math.max(0, now - SESSION_RPC_RECEIPT_RETENTION_MS)),
  );
}

/** Fingerprint one validated RPC input independently of object key order. */
export function fingerprintSessionRpcReceiptInput(
  input: SessionRpcReceiptJson,
): SessionRpcReceiptFingerprint {
  return `sha256:${createHash("sha256").update(canonicalJsonValue(input, "input")).digest("hex")}`;
}

/** Read one exact retained receipt, lazily installing the optional owner table. */
export function readSessionRpcReceipt(
  database: SessionRpcReceiptDatabaseHandle,
  key: SessionRpcReceiptKey,
  now = Date.now(),
): SessionRpcReceipt | undefined {
  if (!tableExists(database.db, "session_rpc_receipts")) {
    return undefined;
  }
  const receipt = selectReceipt(database, normalizeKey(key));
  return receipt && receipt.createdAt >= now - SESSION_RPC_RECEIPT_RETENTION_MS
    ? receipt
    : undefined;
}

/** Insert one immutable receipt in the caller's synchronous transaction. */
export function insertSessionRpcReceiptInTransaction(
  database: SessionRpcReceiptDatabaseHandle,
  input: SessionRpcReceipt,
): SessionRpcReceiptInsertResult {
  if (!database.db.isTransaction) {
    throw new Error("Session RPC receipts must be inserted inside an existing transaction");
  }
  const key = normalizeKey(input);
  assertFingerprint(input.requestFingerprint);
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new Error("Session RPC receipt creation time must be a non-negative safe integer");
  }
  const resultJson = canonicalResultJson(input.result);
  ensureSessionRpcReceiptSchema(database.db);
  pruneSessionRpcReceipts(database, input.createdAt);
  const existing = selectReceipt(database, key);
  if (existing) {
    if (
      existing.method !== key.method ||
      existing.requestFingerprint !== input.requestFingerprint
    ) {
      throw new SessionRpcReceiptConflictError(key);
    }
    return { status: "replay", receipt: existing };
  }
  executeSqliteQuerySync(
    database.db,
    receiptDb(database)
      .insertInto("session_rpc_receipts")
      .values({
        session_id: key.sessionId,
        method: key.method,
        operation_id: key.operationId,
        request_fingerprint: input.requestFingerprint,
        result_json: resultJson,
        result_bytes: Buffer.byteLength(resultJson, "utf8"),
        created_at: input.createdAt,
      }),
  );
  const receipt = selectReceipt(database, key);
  if (!receipt) {
    throw new Error("Session RPC receipt was not persisted");
  }
  return { status: "inserted", receipt };
}

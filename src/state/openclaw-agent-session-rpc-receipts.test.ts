import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  ensureSessionRpcReceiptSchema,
  SESSION_RPC_RECEIPTS_TABLE,
} from "./openclaw-agent-session-rpc-receipt-schema.js";
import {
  fingerprintSessionRpcReceiptInput,
  insertSessionRpcReceiptInTransaction,
  readSessionRpcReceipt,
  SessionRpcReceiptConflictError,
  type SessionRpcReceipt,
} from "./openclaw-agent-session-rpc-receipts.js";

const RECEIPT_SCHEMA_START = `CREATE TABLE IF NOT EXISTS ${SESSION_RPC_RECEIPTS_TABLE} (`;
const RECEIPT_SCHEMA_END = "CREATE TABLE IF NOT EXISTS board_tabs (";
const SESSION_RPC_RECEIPT_MAX_RESULT_BYTES = 16 * 1024;
const SESSION_RPC_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const databases: DatabaseSync[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.isOpen) {
      database.close();
    }
  }
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function schemaWithoutReceipts(): string {
  const start = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(RECEIPT_SCHEMA_START);
  const end = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(RECEIPT_SCHEMA_END, start);
  if (start === -1 || end === -1) {
    throw new Error("Session RPC receipt schema markers are missing in the test fixture");
  }
  return `${OPENCLAW_AGENT_SCHEMA_SQL.slice(0, start)}${OPENCLAW_AGENT_SCHEMA_SQL.slice(end)}`;
}

function openDatabase(pathname = ":memory:", includeReceipts = false): DatabaseSync {
  const database = new DatabaseSync(pathname);
  databases.push(database);
  database.exec(includeReceipts ? OPENCLAW_AGENT_SCHEMA_SQL : schemaWithoutReceipts());
  database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
  return database;
}

function receipt(overrides: Partial<SessionRpcReceipt> = {}): SessionRpcReceipt {
  return {
    sessionId: "session-main",
    method: "sessions.goal.start",
    operationId: "operation-1",
    requestFingerprint: fingerprintSessionRpcReceiptInput({
      objective: "Ship durable goal receipts",
    }),
    result: { ok: true, goal: { id: "goal-1", status: "active" } },
    createdAt: Date.now(),
    ...overrides,
  };
}

function insert(database: DatabaseSync, value: SessionRpcReceipt) {
  return runSqliteImmediateTransactionSync(database, () =>
    insertSessionRpcReceiptInTransaction({ db: database }, value),
  );
}

describe("per-agent session RPC receipts", () => {
  it.each(["sessions.goal.start", "sessions.goal.update", "sessions.goal.clear"])(
    "lazily ensures storage and replays an exact %s result",
    (method) => {
      const database = openDatabase();
      const value = receipt({ method });
      const versionBefore = database.prepare("PRAGMA user_version").get();

      expect(
        database
          .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(SESSION_RPC_RECEIPTS_TABLE),
      ).toBeUndefined();
      expect(readSessionRpcReceipt({ db: database }, value, value.createdAt)).toBeUndefined();
      expect(insert(database, value)).toEqual({ status: "inserted", receipt: value });

      expect(
        insert(database, {
          ...value,
          result: { ok: true, ignoredReplacement: true },
          createdAt: 2,
        }),
      ).toEqual({ status: "replay", receipt: value });
      expect(readSessionRpcReceipt({ db: database }, value, value.createdAt)).toEqual(value);
      expect(database.prepare("PRAGMA user_version").get()).toEqual(versionBefore);
    },
  );

  it("accepts the missing lazy table through the current-version agent schema opener", () => {
    const tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rpc-receipt-schema-")),
    );
    tempDirs.push(tempDir);
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");
    const database = openDatabase(databasePath);
    database
      .prepare(
        `INSERT INTO schema_meta (
          meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
        ) VALUES ('primary', 'agent', ?, 'main', 'test', 1, 1)`,
      )
      .run(OPENCLAW_AGENT_SCHEMA_VERSION);

    expect(() =>
      ensureOpenClawAgentDatabaseSchema(database, { agentId: "main", path: databasePath }),
    ).not.toThrow();
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(SESSION_RPC_RECEIPTS_TABLE),
    ).toBeUndefined();

    ensureSessionRpcReceiptSchema(database);
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(SESSION_RPC_RECEIPTS_TABLE),
    ).toEqual({ 1: 1 });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
  });

  it("rolls back first-use DDL and retries without a stale ensure cache", () => {
    const database = openDatabase();
    const value = receipt();

    expect(() =>
      runSqliteImmediateTransactionSync(database, () => {
        insertSessionRpcReceiptInTransaction({ db: database }, value);
        throw new Error("abort receipt transaction");
      }),
    ).toThrow("abort receipt transaction");
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(SESSION_RPC_RECEIPTS_TABLE),
    ).toBeUndefined();

    expect(insert(database, value)).toEqual({ status: "inserted", receipt: value });
  });

  it("rejects an operation key reused with a changed request fingerprint", () => {
    const database = openDatabase();
    const value = receipt();
    insert(database, value);

    expect(() =>
      insert(database, {
        ...value,
        requestFingerprint: fingerprintSessionRpcReceiptInput({ objective: "Different goal" }),
      }),
    ).toThrow(SessionRpcReceiptConflictError);
    expect(readSessionRpcReceipt({ db: database }, value, value.createdAt)).toEqual(value);
  });

  it("rejects an operation id reused by another method", () => {
    const database = openDatabase();
    const value = receipt({ method: "sessions.goal.update" });
    insert(database, value);

    expect(() => insert(database, { ...value, method: "sessions.goal.clear" })).toThrow(
      SessionRpcReceiptConflictError,
    );
    expect(readSessionRpcReceipt({ db: database }, value, value.createdAt)).toEqual(value);
  });

  it("rejects malformed fingerprints and oversized result JSON before writing", () => {
    const database = openDatabase();
    expect(() =>
      insert(database, {
        ...receipt(),
        requestFingerprint: "sha256:invalid",
      }),
    ).toThrow("canonical SHA-256 digest");
    expect(() =>
      insert(database, receipt({ result: "x".repeat(SESSION_RPC_RECEIPT_MAX_RESULT_BYTES) })),
    ).toThrow("exceeds 16 KiB");
    expect(readSessionRpcReceipt({ db: database }, receipt(), Date.now())).toBeUndefined();
  });

  it("prunes only receipts outside the retention window", () => {
    const database = openDatabase();
    const now = SESSION_RPC_RECEIPT_RETENTION_MS + 10;
    insert(database, receipt({ operationId: "expired", createdAt: 1 }));
    insert(database, receipt({ operationId: "retained", createdAt: 11 }));
    insert(database, receipt({ operationId: "current", createdAt: now }));

    expect(
      database.prepare(`SELECT count(*) AS count FROM ${SESSION_RPC_RECEIPTS_TABLE}`).get(),
    ).toEqual({ count: 2 });
    expect(
      readSessionRpcReceipt({ db: database }, receipt({ operationId: "expired" }), now),
    ).toBeUndefined();
    expect(
      readSessionRpcReceipt({ db: database }, receipt({ operationId: "retained" }), now),
    ).toBeDefined();
  });

  it("retains exact receipts across database reopen", () => {
    const tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rpc-receipt-")),
    );
    tempDirs.push(tempDir);
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");
    const value = receipt();
    const initial = openDatabase(databasePath);
    insert(initial, value);
    initial.close();

    const reopened = new DatabaseSync(databasePath);
    databases.push(reopened);
    expect(readSessionRpcReceipt({ db: reopened }, value, value.createdAt)).toEqual(value);
  });

  it("keeps populated storage safe for the current-version older reader contract", () => {
    const database = openDatabase(":memory:", true);
    const value = receipt();
    insert(database, value);

    expect(() =>
      assertSqliteSchemaContains(database, "previous agent schema", schemaWithoutReceipts()),
    ).not.toThrow();
    expect(readSessionRpcReceipt({ db: database }, value, value.createdAt)).toEqual(value);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
  });
});

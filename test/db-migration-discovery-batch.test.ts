import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { resetDb, getDb, createSchema } from "../src/db.js";

/**
 * P7-COST-5 migration: discovery_queue gets `batch_id` column +
 * widened status CHECK that allows 'batched'; discovery_batches
 * table appears. Verifies the migration is correct on:
 *  - a fresh install (SCHEMA-only path)
 *  - a pre-P7-COST-5 DB with rows in discovery_queue (must survive)
 *  - re-running createSchema twice (idempotent)
 */
describe("discovery batch migration (P7-COST-5)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-batch-migrate-"));
    dbPath = join(tempDir, "grove.db");
    process.env.GROVE_DB_PATH = dbPath;
    resetDb();
  });

  afterEach(() => {
    resetDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedPreBatch(): void {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    // Pre-P7-COST-5 shape — no batch_id, narrow status CHECK that
    // refuses 'batched'. Matches the post-multi-vault shape so we
    // exercise the realistic upgrade path on prod.
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        role TEXT NOT NULL DEFAULT 'viewer',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE vaults (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id),
        slug TEXT,
        display_name TEXT NOT NULL,
        git_repo_path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE discovery_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        trigger TEXT NOT NULL,
        queued_at TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'done', 'error')),
        attempts INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        vault_id TEXT NOT NULL DEFAULT 'vault_00000000'
      );
    `);
    db.prepare("INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)")
      .run("user_00000000", "admin", "admin@grove.local", "owner");
    db.prepare(
      "INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
    ).run("vault_00000000", "user_00000000", "personal", "Personal", "/root/life");
    // Seed a few discovery_queue rows so we can verify they survive
    // the rebuild + carry batch_id = NULL.
    db.prepare(
      "INSERT INTO discovery_queue (path, trigger, status, attempts, vault_id) VALUES (?, ?, ?, ?, ?)",
    ).run("Journal/2026-05-11.md", "write", "done", 1, "vault_00000000");
    db.prepare(
      "INSERT INTO discovery_queue (path, trigger, status, attempts, vault_id) VALUES (?, ?, ?, ?, ?)",
    ).run("Resources/Concepts/Foo.md", "commit", "pending", 0, "vault_00000000");
    db.close();
  }

  it("fresh install: createSchema yields the post-P7-COST-5 shape", () => {
    createSchema();
    const db = getDb();

    const cols = db.prepare("PRAGMA table_info(discovery_queue)").all() as {
      name: string;
      notnull: number;
    }[];
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("batch_id")).toBe(true);
    const batchCol = cols.find((c) => c.name === "batch_id")!;
    expect(batchCol.notnull).toBe(0); // nullable

    // CHECK constraint allows 'batched'.
    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='discovery_queue'")
      .get() as { sql: string };
    expect(sql.sql).toContain("'batched'");

    // discovery_batches table + indexes.
    const batches = db.prepare("PRAGMA table_info(discovery_batches)").all() as {
      name: string;
      type: string;
    }[];
    const batchNames = new Set(batches.map((c) => c.name));
    expect(batchNames.has("id")).toBe(true);
    expect(batchNames.has("vault_id")).toBe(true);
    expect(batchNames.has("submitted_at")).toBe(true);
    expect(batchNames.has("completed_at")).toBe(true);
    expect(batchNames.has("status")).toBe(true);
    expect(batchNames.has("row_count")).toBe(true);

    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='discovery_batches'",
      )
      .all() as { name: string }[];
    const idxNames = new Set(idx.map((i) => i.name));
    expect(idxNames.has("idx_discovery_batches_status")).toBe(true);
    expect(idxNames.has("idx_discovery_batches_vault")).toBe(true);

    // Discovery_queue.batch_id index also present.
    const queueIdx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='discovery_queue'",
      )
      .all() as { name: string }[];
    expect(queueIdx.some((i) => i.name === "idx_discovery_queue_batch_id")).toBe(true);
  });

  it("upgrade path: rebuilds discovery_queue + preserves existing rows", () => {
    seedPreBatch();
    createSchema();
    const db = getDb();

    const cols = db.prepare("PRAGMA table_info(discovery_queue)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "batch_id")).toBe(true);

    const rows = db
      .prepare(
        "SELECT path, trigger, status, attempts, vault_id, batch_id FROM discovery_queue ORDER BY id",
      )
      .all() as Array<{
        path: string;
        trigger: string;
        status: string;
        attempts: number;
        vault_id: string;
        batch_id: string | null;
      }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].path).toBe("Journal/2026-05-11.md");
    expect(rows[0].trigger).toBe("write");
    expect(rows[0].status).toBe("done");
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].vault_id).toBe("vault_00000000");
    expect(rows[0].batch_id).toBeNull();
    expect(rows[1].path).toBe("Resources/Concepts/Foo.md");
    expect(rows[1].trigger).toBe("commit");
    expect(rows[1].batch_id).toBeNull();
  });

  it("status='batched' is accepted post-migration", () => {
    seedPreBatch();
    createSchema();
    const db = getDb();

    // Update an existing row to 'batched' — should not throw.
    expect(() =>
      db
        .prepare("UPDATE discovery_queue SET status = 'batched', batch_id = ? WHERE path = ?")
        .run("msgbatch_xyz", "Resources/Concepts/Foo.md"),
    ).not.toThrow();

    const row = db
      .prepare("SELECT status, batch_id FROM discovery_queue WHERE path = ?")
      .get("Resources/Concepts/Foo.md") as { status: string; batch_id: string | null };
    expect(row.status).toBe("batched");
    expect(row.batch_id).toBe("msgbatch_xyz");
  });

  it("idempotency: running createSchema twice preserves rows including batch_id", () => {
    createSchema();
    const db = getDb();

    db.prepare(
      "INSERT INTO discovery_queue (path, trigger, status, batch_id, vault_id) VALUES (?, ?, ?, ?, ?)",
    ).run("p.md", "commit", "batched", "msgbatch_keep", "vault_00000000");
    db.prepare(
      "INSERT INTO discovery_batches (id, vault_id, row_count, status) VALUES (?, ?, ?, ?)",
    ).run("msgbatch_keep", "vault_00000000", 1, "submitted");

    // Re-run — should be a no-op for our seeded rows.
    expect(() => createSchema()).not.toThrow();

    const queueRow = db
      .prepare("SELECT batch_id, status FROM discovery_queue WHERE path = ?")
      .get("p.md") as { batch_id: string; status: string };
    expect(queueRow.batch_id).toBe("msgbatch_keep");
    expect(queueRow.status).toBe("batched");

    const batchRow = db
      .prepare("SELECT row_count, status FROM discovery_batches WHERE id = ?")
      .get("msgbatch_keep") as { row_count: number; status: string };
    expect(batchRow.row_count).toBe(1);
    expect(batchRow.status).toBe("submitted");
  });

  it("idempotency from pre-P7-COST-5: runs migration once, then again is a no-op", () => {
    seedPreBatch();
    createSchema();

    const firstSchema = getDb()
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='discovery_queue'")
      .get() as { sql: string };

    resetDb();
    createSchema();

    const secondSchema = getDb()
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='discovery_queue'")
      .get() as { sql: string };

    // Both runs produce the same final shape.
    expect(secondSchema.sql).toBe(firstSchema.sql);

    // Rows still present.
    const count = getDb()
      .prepare("SELECT COUNT(*) AS n FROM discovery_queue")
      .get() as { n: number };
    expect(count.n).toBe(2);
  });
});

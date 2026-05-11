import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { resetDb, getDb, createSchema } from "../src/db.js";

/**
 * P19-1 migration — shared_links table rebuild so `max_views` is nullable and
 * `last_accessed_at`, `revoked_by`, `revoked_at` columns exist. Verifies
 * existing rows survive, the new schema is in place, and running twice is a
 * no-op.
 */
describe("shared_links migration (P19-1)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-migrate-test-"));
    dbPath = join(tempDir, "grove.db");
    process.env.GROVE_DB_PATH = dbPath;
    resetDb();
  });

  afterEach(() => {
    resetDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedOldSchema(): void {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        role TEXT NOT NULL DEFAULT 'viewer',
        display_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at TEXT,
        bio TEXT
      );
      CREATE TABLE shared_links (
        id TEXT PRIMARY KEY,
        note_path TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL,
        max_views INTEGER DEFAULT 100,
        view_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)")
      .run("user_00000000", "admin", "admin@grove.local", "owner");

    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 1000).toISOString();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO shared_links (id, note_path, created_by, expires_at, max_views, view_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("sh_keep1", "a.md", "user_00000000", future, 100, 3, now);
    db.prepare(
      "INSERT INTO shared_links (id, note_path, created_by, expires_at, max_views, view_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("sh_keep2", "b.md", "user_00000000", past, 10, 10, now);
    db.close();
  }

  it("adds new columns and preserves existing rows", () => {
    seedOldSchema();

    createSchema();
    const db = getDb();

    const cols = db.prepare("PRAGMA table_info(shared_links)").all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("last_accessed_at")).toBe(true);
    expect(names.has("revoked_by")).toBe(true);
    expect(names.has("revoked_at")).toBe(true);

    const maxViewsCol = cols.find((c) => c.name === "max_views");
    expect(maxViewsCol).toBeDefined();
    expect(maxViewsCol!.notnull).toBe(0); // nullable

    const rows = db.prepare("SELECT * FROM shared_links ORDER BY id").all() as Array<{
      id: string;
      note_path: string;
      max_views: number | null;
      view_count: number;
      last_accessed_at: string | null;
      revoked_by: string | null;
      revoked_at: string | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe("sh_keep1");
    expect(rows[0].max_views).toBe(100);
    expect(rows[0].view_count).toBe(3);
    expect(rows[0].last_accessed_at).toBeNull();
    expect(rows[0].revoked_by).toBeNull();
    expect(rows[0].revoked_at).toBeNull();
    expect(rows[1].id).toBe("sh_keep2");
    expect(rows[1].view_count).toBe(10);

    const fkCheck = db.prepare("PRAGMA foreign_key_check").all();
    expect(fkCheck).toHaveLength(0);
  });

  it("allows inserting NULL max_views after migration", () => {
    seedOldSchema();
    createSchema();
    const db = getDb();

    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO shared_links (id, note_path, created_by, expires_at, max_views, view_count, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    ).run("sh_unlim", "u.md", "user_00000000", future, null, new Date().toISOString());

    const row = db.prepare("SELECT max_views FROM shared_links WHERE id = ?").get("sh_unlim") as {
      max_views: number | null;
    };
    expect(row.max_views).toBeNull();
  });

  it("running migration twice is a no-op", () => {
    seedOldSchema();

    createSchema();
    const dbAfterFirst = getDb();
    const rowsAfterFirst = dbAfterFirst.prepare("SELECT * FROM shared_links ORDER BY id").all();

    // Second run — should not rebuild, should not lose data, should not throw.
    createSchema();
    const dbAfterSecond = getDb();
    const rowsAfterSecond = dbAfterSecond.prepare("SELECT * FROM shared_links ORDER BY id").all();

    expect(rowsAfterSecond).toEqual(rowsAfterFirst);

    const fkCheck = dbAfterSecond.prepare("PRAGMA foreign_key_check").all();
    expect(fkCheck).toHaveLength(0);
  });

  it("fresh schema (no pre-existing table) creates the new shape directly", () => {
    createSchema();
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(shared_links)").all() as {
      name: string;
      notnull: number;
    }[];
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("last_accessed_at")).toBe(true);
    expect(names.has("revoked_by")).toBe(true);
    expect(names.has("revoked_at")).toBe(true);
    expect(cols.find((c) => c.name === "max_views")!.notnull).toBe(0);
  });
});

/**
 * P7-COST-4a — discovery_cost_daily table is created with the expected
 * columns and indexes on fresh installs, and re-running createSchema()
 * is a no-op.
 */
describe("discovery_cost_daily schema (P7-COST-4a)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-cost-schema-test-"));
    dbPath = join(tempDir, "grove.db");
    process.env.GROVE_DB_PATH = dbPath;
    resetDb();
  });

  afterEach(() => {
    resetDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates the discovery_cost_daily table with the expected columns", () => {
    createSchema();
    const db = getDb();

    const cols = db.prepare("PRAGMA table_info(discovery_cost_daily)").all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    expect(cols.length).toBeGreaterThan(0);

    const colsByName = new Map(cols.map((c) => [c.name, c]));
    // PK columns
    expect(colsByName.get("day")?.pk).toBeGreaterThan(0);
    expect(colsByName.get("api_key_id")?.pk).toBeGreaterThan(0);
    expect(colsByName.get("model")?.pk).toBeGreaterThan(0);
    // Token columns
    expect(colsByName.has("uncached_input_tokens")).toBe(true);
    expect(colsByName.has("cache_read_tokens")).toBe(true);
    expect(colsByName.has("cache_creation_5m_tokens")).toBe(true);
    expect(colsByName.has("cache_creation_1h_tokens")).toBe(true);
    expect(colsByName.has("output_tokens")).toBe(true);
    // Cost is nullable (unknown-model rows can't be priced)
    const cost = colsByName.get("estimated_cost_usd");
    expect(cost).toBeDefined();
    expect(cost!.notnull).toBe(0);
    // Bookkeeping
    expect(colsByName.has("ingested_at")).toBe(true);
  });

  it("creates the day and api_key/day indexes", () => {
    createSchema();
    const db = getDb();
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='discovery_cost_daily'",
      )
      .all() as { name: string }[];
    const names = new Set(indexes.map((i) => i.name));
    expect(names.has("idx_cost_daily_day")).toBe(true);
    expect(names.has("idx_cost_daily_key")).toBe(true);
  });

  it("running createSchema twice is a no-op", () => {
    createSchema();
    const db = getDb();
    db.prepare(
      "INSERT INTO discovery_cost_daily (day, api_key_id, model, uncached_input_tokens, output_tokens, estimated_cost_usd) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("2026-05-07", "apikey_abc", "claude-haiku-4-5-20251001", 1000, 500, 0.0028);

    // Second call must not throw and must not drop our row.
    expect(() => createSchema()).not.toThrow();

    const rows = db.prepare("SELECT * FROM discovery_cost_daily").all() as Array<{
      day: string;
      api_key_id: string;
      model: string;
      uncached_input_tokens: number;
      output_tokens: number;
      estimated_cost_usd: number | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].api_key_id).toBe("apikey_abc");
    expect(rows[0].uncached_input_tokens).toBe(1000);
    expect(rows[0].estimated_cost_usd).toBeCloseTo(0.0028);
  });

  it("permits null estimated_cost_usd (unknown-model rows)", () => {
    createSchema();
    const db = getDb();
    db.prepare(
      "INSERT INTO discovery_cost_daily (day, api_key_id, model, uncached_input_tokens, output_tokens, estimated_cost_usd) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("2026-05-07", "apikey_abc", "unknown", 100, 50, null);

    const row = db
      .prepare("SELECT estimated_cost_usd FROM discovery_cost_daily WHERE model = 'unknown'")
      .get() as { estimated_cost_usd: number | null };
    expect(row.estimated_cost_usd).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { resetDb, getDb, createSchema } from "../src/db.js";

/**
 * P8-A1 multi-vault migration — adds server_port/discovery_port to vaults,
 * vault_id to the four discovery/graph tables, and creates vault_members +
 * vault_usage_daily. Seeds a pre-P8 schema, runs the migration, verifies
 * shape + data + idempotency.
 */
describe("multi-vault migration (P8-A1)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-p8a1-"));
    dbPath = join(tempDir, "grove.db");
    process.env.GROVE_DB_PATH = dbPath;
    resetDb();
  });

  afterEach(() => {
    resetDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedPreP8(): void {
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
      CREATE TABLE vaults (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id),
        slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        git_repo_path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        storage_bytes INTEGER NOT NULL DEFAULT 0,
        storage_quota_bytes INTEGER NOT NULL DEFAULT 104857600,
        UNIQUE(owner_id, slug)
      );
      CREATE TABLE discovery_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        trigger TEXT NOT NULL,
        queued_at TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        error_message TEXT
      );
      CREATE TABLE discovery_results (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        similarity REAL NOT NULL,
        relationship TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        dismissed_at TEXT
      );
      CREATE TABLE graph_health (
        id TEXT PRIMARY KEY,
        measured_at TEXT NOT NULL,
        metrics TEXT NOT NULL,
        score INTEGER NOT NULL
      );
      CREATE TABLE graph_health_flags (
        id TEXT PRIMARY KEY,
        flag_type TEXT NOT NULL,
        source_path TEXT,
        target_path TEXT,
        details TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );
    `);
    db.prepare("INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)")
      .run("user_00000000", "admin", "admin@grove.local", "owner");
    db.prepare(
      "INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
    ).run("vault_00000000", "user_00000000", "life", "Life", "/root/life");
    db.prepare(
      "INSERT INTO discovery_queue (path, trigger) VALUES (?, ?)",
    ).run("Journal/2026-04-22.md", "write");
    db.prepare(
      "INSERT INTO discovery_results (id, source_path, target_path, similarity, relationship) VALUES (?, ?, ?, ?, ?)",
    ).run("dr_1", "Journal/2026-04-22.md", "Resources/Concepts/Grove.md", 0.91, "mentions");
    db.prepare(
      "INSERT INTO graph_health (id, measured_at, metrics, score) VALUES (?, ?, ?, ?)",
    ).run("gh_1", new Date().toISOString(), "{}", 80);
    db.prepare(
      "INSERT INTO graph_health_flags (id, flag_type, details) VALUES (?, ?, ?)",
    ).run("ghf_1", "long_orphan", "{}");
    db.close();
  }

  it("adds server_port/discovery_port + renames slug + backfills vault_id", () => {
    seedPreP8();
    createSchema();
    const db = getDb();

    const vaultCols = db.prepare("PRAGMA table_info(vaults)").all() as { name: string }[];
    const vaultNames = new Set(vaultCols.map((c) => c.name));
    expect(vaultNames.has("server_port")).toBe(true);
    expect(vaultNames.has("discovery_port")).toBe(true);

    const vault = db
      .prepare("SELECT slug, server_port, discovery_port FROM vaults WHERE id = ?")
      .get("vault_00000000") as { slug: string; server_port: number; discovery_port: number };
    expect(vault.slug).toBe("personal");
    expect(vault.server_port).toBe(8190);
    expect(vault.discovery_port).toBe(8091);

    for (const t of ["discovery_queue", "discovery_results", "graph_health", "graph_health_flags"]) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[];
      expect(cols.some((c) => c.name === "vault_id")).toBe(true);
      const row = db.prepare(`SELECT vault_id FROM ${t} LIMIT 1`).get() as { vault_id: string };
      expect(row.vault_id).toBe("vault_00000000");
    }
  });

  it("creates vault_members + vault_usage_daily tables with correct shape", () => {
    seedPreP8();
    createSchema();
    const db = getDb();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = new Set(tables.map((t) => t.name));
    expect(names.has("vault_members")).toBe(true);
    expect(names.has("vault_usage_daily")).toBe(true);

    const memberCols = db.prepare("PRAGMA table_info(vault_members)").all() as { name: string }[];
    const memberNames = new Set(memberCols.map((c) => c.name));
    for (const col of ["user_id", "vault_id", "role", "joined_at", "last_active_at"]) {
      expect(memberNames.has(col)).toBe(true);
    }

    const usageCols = db.prepare("PRAGMA table_info(vault_usage_daily)").all() as { name: string }[];
    const usageNames = new Set(usageCols.map((c) => c.name));
    for (const col of ["vault_id", "date", "requests", "writes", "embed_tokens", "search_queries", "bytes_stored"]) {
      expect(usageNames.has(col)).toBe(true);
    }
  });

  it("leaves foreign_key_check clean after migration", () => {
    seedPreP8();
    createSchema();
    const db = getDb();
    const fkErrors = db.prepare("PRAGMA foreign_key_check").all();
    expect(fkErrors).toEqual([]);
  });

  it("is idempotent — running twice is a no-op", () => {
    seedPreP8();
    createSchema();
    const afterFirst = getDb()
      .prepare("SELECT slug, server_port FROM vaults WHERE id = ?")
      .get("vault_00000000");
    resetDb();
    createSchema();
    const afterSecond = getDb()
      .prepare("SELECT slug, server_port FROM vaults WHERE id = ?")
      .get("vault_00000000");
    expect(afterSecond).toEqual(afterFirst);
  });

  it("rejects duplicate slugs via UNIQUE index", () => {
    seedPreP8();
    createSchema();
    const db = getDb();
    db.prepare(
      "INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
    ).run("vault_11111111", "user_00000000", "second", "Second", "/root/vaults/second");
    expect(() =>
      db
        .prepare(
          "INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
        )
        .run("vault_22222222", "user_00000000", "second", "Dup", "/root/vaults/dup"),
    ).toThrow(/UNIQUE/i);
  });

  it("rejects duplicate ports via UNIQUE indexes", () => {
    seedPreP8();
    createSchema();
    const db = getDb();
    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path, server_port, discovery_port)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("vault_aaaaaaaa", "user_00000000", "team", "Team", "/root/vaults/team", 8191, 8092);
    expect(() =>
      db
        .prepare(
          `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path, server_port, discovery_port)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("vault_bbbbbbbb", "user_00000000", "dup-port", "Dup", "/root/vaults/dp", 8191, 8093),
    ).toThrow(/UNIQUE/i);
  });
});

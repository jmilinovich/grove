import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { resetDb, getDb, createSchema } from "../src/db.js";

/**
 * P8-B3 follow-up — `api_keys.vault_id` backfill.
 *
 * The original column stored the legacy slug (`"life"`), but every other
 * vault_id column in the system (`vault_members`, `vault_keys`,
 * `vault_usage_daily`, `resolveAdminVaultId`) expected the canonical
 * `vaults.id` UUID. MRU tracking revealed the mismatch — the
 * `UPDATE vault_members WHERE vault_id = ?` always hit zero rows because
 * it was called with `"life"` but the rows said `"vault_00000000"`.
 *
 * These tests seed a pre-fix DB with stale api_keys, run createSchema
 * (which triggers migrateApiKeyVaultId), and assert the backfill
 * translates slug-style and orphan values to the proper `vaults.id`.
 */
describe("api_keys.vault_id backfill (P8-B3 follow-up)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-apikey-vault-"));
    dbPath = join(tempDir, "grove.db");
    process.env.GROVE_DB_PATH = dbPath;
    resetDb();
  });

  afterEach(() => {
    resetDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedWithBadKeys(): void {
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
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        vault_id TEXT NOT NULL,
        name TEXT NOT NULL,
        hashed_token TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL DEFAULT 'read,write',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        expires_at TEXT,
        session_id TEXT
      );
    `);
    db.prepare("INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)")
      .run("user_00000000", "jm", "jm@example.com", "owner");
    // Pre-rename slug on the vault — the P8-A1 migration will flip it to "personal".
    db.prepare(
      "INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
    ).run("vault_00000000", "user_00000000", "life", "Life", "/root/life");

    // Three api_keys with the stale slug value (the real-world bug state).
    for (const [id, tokenHash] of [
      ["key_aaaa", "hash_aaaa"],
      ["key_bbbb", "hash_bbbb"],
      ["key_cccc", "hash_cccc"],
    ] as const) {
      db.prepare(
        "INSERT INTO api_keys (id, user_id, vault_id, name, hashed_token) VALUES (?, ?, ?, ?, ?)",
      ).run(id, "user_00000000", "life", `test-${id}`, tokenHash);
    }
    // One key with a completely orphan value that won't resolve via slug.
    db.prepare(
      "INSERT INTO api_keys (id, user_id, vault_id, name, hashed_token) VALUES (?, ?, ?, ?, ?)",
    ).run("key_orphan", "user_00000000", "definitely-not-a-vault", "orphan", "hash_orphan");
    db.close();
  }

  it("rewrites stale slug values to the canonical vaults.id", () => {
    seedWithBadKeys();
    createSchema();
    const db = getDb();

    const keys = db
      .prepare("SELECT id, vault_id FROM api_keys ORDER BY id")
      .all() as Array<{ id: string; vault_id: string }>;
    for (const k of keys) {
      expect(k.vault_id).toBe("vault_00000000");
    }
  });

  it("routes orphans (unknown slug) to the oldest vault as a fallback", () => {
    seedWithBadKeys();
    createSchema();
    const db = getDb();

    const orphan = db
      .prepare("SELECT vault_id FROM api_keys WHERE id = ?")
      .get("key_orphan") as { vault_id: string };
    expect(orphan.vault_id).toBe("vault_00000000");

    // And the whole table is now clean.
    const bad = db
      .prepare(
        "SELECT COUNT(*) AS n FROM api_keys WHERE vault_id NOT IN (SELECT id FROM vaults)",
      )
      .get() as { n: number };
    expect(bad.n).toBe(0);
  });

  it("is idempotent — second createSchema() run is a no-op", () => {
    seedWithBadKeys();
    createSchema();
    resetDb();

    // Open the db a second time and re-run.
    createSchema();
    const db = getDb();
    const bad = db
      .prepare(
        "SELECT COUNT(*) AS n FROM api_keys WHERE vault_id NOT IN (SELECT id FROM vaults)",
      )
      .get() as { n: number };
    expect(bad.n).toBe(0);
  });

  it("is a no-op when api_keys is already clean", () => {
    // Seed with already-correct vault_id values.
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT UNIQUE, email TEXT UNIQUE,
        role TEXT NOT NULL DEFAULT 'viewer', display_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT, bio TEXT
      );
      CREATE TABLE vaults (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
        slug TEXT NOT NULL, display_name TEXT NOT NULL, git_repo_path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        storage_bytes INTEGER NOT NULL DEFAULT 0,
        storage_quota_bytes INTEGER NOT NULL DEFAULT 104857600,
        UNIQUE(owner_id, slug)
      );
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        vault_id TEXT NOT NULL, name TEXT NOT NULL,
        hashed_token TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL DEFAULT 'read,write',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT, expires_at TEXT, session_id TEXT
      );
    `);
    db.prepare("INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)")
      .run("user_00000000", "jm", "jm@example.com", "owner");
    db.prepare(
      "INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
    ).run("vault_00000000", "user_00000000", "personal", "Life", "/root/life");
    db.prepare(
      "INSERT INTO api_keys (id, user_id, vault_id, name, hashed_token) VALUES (?, ?, ?, ?, ?)",
    ).run("key_aaaa", "user_00000000", "vault_00000000", "clean", "hash_clean");
    db.close();

    createSchema();

    const gotDb = getDb();
    const row = gotDb.prepare("SELECT vault_id FROM api_keys WHERE id = ?").get("key_aaaa") as {
      vault_id: string;
    };
    expect(row.vault_id).toBe("vault_00000000");
  });
});

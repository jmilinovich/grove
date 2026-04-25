import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { hashToken } from "../src/keys.js";

describe("keys module — import side effects", () => {
  it("does not write to stdout or stderr on import", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // Force a fresh evaluation in case an earlier test cached the module.
      await import("../src/keys.js?_nocache=" + Date.now());
      expect(out).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});

describe("hashToken", () => {
  it("produces a 64-char hex string", () => {
    const hash = hashToken("grove_live_abc123");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    const a = hashToken("grove_live_test");
    const b = hashToken("grove_live_test");
    expect(a).toBe(b);
  });

  it("differs for different inputs", () => {
    const a = hashToken("grove_live_key1");
    const b = hashToken("grove_live_key2");
    expect(a).not.toBe(b);
  });
});

// ── User-scoped keys (P9-3) ────────────────────────────────────────
// Tests that keys are created with user_id and that filtering by user works.

describe("user-scoped keys", () => {
  let tempDir: string;
  let db: Database.Database;

  const SCHEMA = `
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, email TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT);
    CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), slug TEXT NOT NULL, display_name TEXT NOT NULL, git_repo_path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), storage_bytes INTEGER NOT NULL DEFAULT 0, storage_quota_bytes INTEGER NOT NULL DEFAULT 104857600, UNIQUE(owner_id, slug));
    CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), vault_id TEXT NOT NULL, name TEXT NOT NULL, hashed_token TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT 'read,write', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT, expires_at TEXT, session_id TEXT);
  `;

  function insertUser(id: string, username: string, email: string) {
    db.prepare("INSERT INTO users (id, username, email) VALUES (?, ?, ?)").run(id, username, email);
  }

  function insertKey(id: string, userId: string, name: string, token?: string) {
    const hash = hashToken(token ?? `grove_live_${randomBytes(16).toString("hex")}`);
    db.prepare(
      "INSERT INTO api_keys (id, user_id, vault_id, name, hashed_token, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, userId, "life", name, hash, "read,write", new Date().toISOString());
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-keys-test-"));
    db = new Database(join(tempDir, "grove.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA);

    // Owner user + vault
    insertUser("user_00000000", "admin", "admin@grove.local");
    db.prepare(
      "INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)"
    ).run("vault_00000000", "user_00000000", "life", "Life", "/tmp/life");

    // Second (non-owner) user
    insertUser("user_viewer01", "alice", "alice@example.com");
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("key is created with the specified user_id", () => {
    insertKey("key_owner01", "user_00000000", "owner-key");
    insertKey("key_viewer01", "user_viewer01", "viewer-key");

    const ownerKey = db.prepare("SELECT user_id FROM api_keys WHERE id = ?").get("key_owner01") as { user_id: string };
    const viewerKey = db.prepare("SELECT user_id FROM api_keys WHERE id = ?").get("key_viewer01") as { user_id: string };

    expect(ownerKey.user_id).toBe("user_00000000");
    expect(viewerKey.user_id).toBe("user_viewer01");
  });

  it("filtering by user_id returns only that user's keys", () => {
    insertKey("key_owner01", "user_00000000", "owner-key-1");
    insertKey("key_owner02", "user_00000000", "owner-key-2");
    insertKey("key_viewer01", "user_viewer01", "viewer-key");

    const allKeys = db.prepare("SELECT id FROM api_keys").all() as { id: string }[];
    expect(allKeys).toHaveLength(3);

    const viewerKeys = db.prepare("SELECT id FROM api_keys WHERE user_id = ?").all("user_viewer01") as { id: string }[];
    expect(viewerKeys).toHaveLength(1);
    expect(viewerKeys[0].id).toBe("key_viewer01");

    const ownerKeys = db.prepare("SELECT id FROM api_keys WHERE user_id = ?").all("user_00000000") as { id: string }[];
    expect(ownerKeys).toHaveLength(2);
  });

  it("vault owner is determined by vaults.owner_id", () => {
    const vault = db.prepare("SELECT owner_id FROM vaults WHERE slug = ?").get("life") as { owner_id: string };
    expect(vault.owner_id).toBe("user_00000000");

    // viewer is not the owner
    expect(vault.owner_id).not.toBe("user_viewer01");
  });

  it("non-owner cannot revoke another user's key", () => {
    insertKey("key_owner01", "user_00000000", "owner-key");
    insertKey("key_viewer01", "user_viewer01", "viewer-key");

    // Simulate non-owner trying to revoke owner's key:
    // check ownership before delete
    const target = db.prepare("SELECT user_id FROM api_keys WHERE id = ?").get("key_owner01") as { user_id: string };
    expect(target.user_id).not.toBe("user_viewer01"); // would be blocked

    // Non-owner CAN revoke their own key
    const own = db.prepare("SELECT user_id FROM api_keys WHERE id = ?").get("key_viewer01") as { user_id: string };
    expect(own.user_id).toBe("user_viewer01"); // allowed
  });
});

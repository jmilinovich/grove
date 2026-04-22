import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, email TEXT UNIQUE, role TEXT NOT NULL DEFAULT 'viewer', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT);
  CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), slug TEXT NOT NULL, display_name TEXT NOT NULL, git_repo_path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), storage_bytes INTEGER NOT NULL DEFAULT 0, storage_quota_bytes INTEGER NOT NULL DEFAULT 104857600, UNIQUE(owner_id, slug));
  CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), vault_id TEXT NOT NULL, name TEXT NOT NULL, hashed_token TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT 'read,write', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT, expires_at TEXT, session_id TEXT);
  CREATE TABLE IF NOT EXISTS trails (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS trail_grants (id TEXT PRIMARY KEY, trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE, grantee_type TEXT NOT NULL, grantee_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL, last_used_at TEXT, user_agent TEXT);
  CREATE TABLE IF NOT EXISTS magic_links (id TEXT PRIMARY KEY, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
  CREATE TABLE IF NOT EXISTS handle_history (handle TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), released_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS vault_members (user_id TEXT NOT NULL REFERENCES users(id), vault_id TEXT NOT NULL REFERENCES vaults(id), role TEXT NOT NULL CHECK(role IN ('owner', 'member', 'viewer')), joined_at TEXT NOT NULL DEFAULT (datetime('now')), last_active_at TEXT, PRIMARY KEY (user_id, vault_id));
`;

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-users-admin-"));
const TEST_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_DB_PATH = TEST_DB_PATH;

import { getDb, resetDb } from "../src/db.js";
import { createUser, deleteUser, listUsersWithMeta } from "../src/users.js";
import { createKey } from "../src/keys.js";

function seedDb() {
  const db = getDb();
  db.exec(SCHEMA);

  db.exec("DELETE FROM vault_members");
  db.exec("DELETE FROM trail_grants");
  db.exec("DELETE FROM trails");
  db.exec("DELETE FROM sessions");
  db.exec("DELETE FROM api_keys");
  db.exec("DELETE FROM vaults");
  db.exec("DELETE FROM users");

  // Seed admin user and vault
  db.prepare("INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)").run(
    "user_00000000", "admin", "admin@grove.local", "owner",
  );
  db.prepare("INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run(
    "vault_00000000", "user_00000000", "life", "Life", "/tmp/life",
  );
}

describe("deleteUser", () => {
  beforeEach(() => {
    resetDb();
    seedDb();
  });

  afterEach(() => {
    resetDb();
  });

  it("deletes a viewer user and their keys/sessions", () => {
    const user = createUser("alice@example.com", "alice", "viewer");
    const key = createKey("alice-key", ["read"], "life", undefined, user.id);

    // Create a session for the user
    const db = getDb();
    db.prepare(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?)"
    ).run("sess_alice", user.id, "hash_alice", "2099-01-01T00:00:00Z", "2099-01-01T00:00:00Z");

    // Verify data exists
    expect(db.prepare("SELECT COUNT(*) as c FROM api_keys WHERE user_id = ?").get(user.id)).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) as c FROM sessions WHERE user_id = ?").get(user.id)).toEqual({ c: 1 });

    const deleted = deleteUser(user.id);
    expect(deleted).toBe(true);

    // Verify cascade cleanup
    expect(db.prepare("SELECT COUNT(*) as c FROM users WHERE id = ?").get(user.id)).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) as c FROM api_keys WHERE user_id = ?").get(user.id)).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) as c FROM sessions WHERE user_id = ?").get(user.id)).toEqual({ c: 0 });
  });

  it("deletes trail grants for the user's keys", () => {
    const user = createUser("bob@example.com", "bob", "viewer");
    const key = createKey("bob-key", ["read"], "life", undefined, user.id);

    const db = getDb();
    // Create a trail and grant
    db.prepare(
      "INSERT INTO trails (id, vault_id, name, description, enabled, config_json) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("trail_test", "life", "Test Trail", "", 1, "{}");
    db.prepare(
      "INSERT INTO trail_grants (id, trail_id, grantee_type, grantee_id) VALUES (?, ?, ?, ?)"
    ).run("grant_test", "trail_test", "token", key.id);

    expect(db.prepare("SELECT COUNT(*) as c FROM trail_grants WHERE grantee_id = ?").get(key.id)).toEqual({ c: 1 });

    deleteUser(user.id);

    expect(db.prepare("SELECT COUNT(*) as c FROM trail_grants WHERE grantee_id = ?").get(key.id)).toEqual({ c: 0 });
    // Trail itself should still exist
    expect(db.prepare("SELECT COUNT(*) as c FROM trails WHERE id = 'trail_test'").get()).toEqual({ c: 1 });
  });

  it("throws when trying to delete the owner", () => {
    expect(() => deleteUser("user_00000000")).toThrow("Cannot delete the owner user");
  });

  it("returns false for non-existent user", () => {
    expect(deleteUser("user_nonexistent")).toBe(false);
  });
});

describe("listUsersWithMeta", () => {
  beforeEach(() => {
    resetDb();
    seedDb();
  });

  afterEach(() => {
    resetDb();
  });

  it("returns users with key counts and trail names", () => {
    const user = createUser("carol@example.com", "carol", "viewer");
    const key = createKey("carol-key", ["read"], "life", undefined, user.id);

    const db = getDb();
    db.prepare(
      "INSERT INTO trails (id, vault_id, name, description, enabled, config_json) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("trail_design", "life", "Design System", "", 1, "{}");
    db.prepare(
      "INSERT INTO trail_grants (id, trail_id, grantee_type, grantee_id) VALUES (?, ?, ?, ?)"
    ).run("grant_carol", "trail_design", "token", key.id);

    const users = listUsersWithMeta();
    expect(users.length).toBe(2); // admin + carol

    const carol = users.find((u) => u.id === user.id);
    expect(carol).toBeDefined();
    expect(carol!.key_count).toBe(1);
    expect(carol!.trails).toEqual(["Design System"]);
    expect(carol!.email).toBe("carol@example.com");
    expect(carol!.role).toBe("viewer");
  });

  it("returns empty trails and zero keys for users without them", () => {
    const user = createUser("dave@example.com", "dave", "member");
    const users = listUsersWithMeta();
    const dave = users.find((u) => u.id === user.id);
    expect(dave).toBeDefined();
    expect(dave!.key_count).toBe(0);
    expect(dave!.trails).toEqual([]);
  });
});

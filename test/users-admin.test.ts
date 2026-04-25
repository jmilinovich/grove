import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-users-admin-"));
const TEST_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_DB_PATH = TEST_DB_PATH;

import { getDb, resetDb, createSchema } from "../src/db.js";
import { createUser, deleteUser, listUsersWithMeta } from "../src/users.js";
import { createKey } from "../src/keys.js";

function seedDb() {
  createSchema();
  const db = getDb();
  db.pragma("foreign_keys = OFF");
  db.exec("DELETE FROM vault_members");
  db.exec("DELETE FROM trail_grants");
  db.exec("DELETE FROM trails");
  db.exec("DELETE FROM sessions");
  db.exec("DELETE FROM api_keys");
  db.exec("DELETE FROM vaults");
  db.exec("DELETE FROM users");
  db.pragma("foreign_keys = ON");

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

  it("removes vault_members rows so DELETE FROM users doesn't hit the FK", () => {
    // Regression for P8-B3 — `vault_members.user_id` has no ON DELETE CASCADE,
    // so a delete that skips the membership row throws with
    // `FOREIGN KEY constraint failed`. Before the fix, the earlier DELETEs
    // (keys, sessions) had already committed, leaving the user half-deleted.
    const user = createUser("eve@example.com", "eve", "viewer");
    const db = getDb();
    db.prepare(
      "INSERT INTO vault_members (user_id, vault_id, role) VALUES (?, ?, ?)",
    ).run(user.id, "vault_00000000", "viewer");
    expect(
      db.prepare("SELECT COUNT(*) as c FROM vault_members WHERE user_id = ?").get(user.id),
    ).toEqual({ c: 1 });

    const deleted = deleteUser(user.id);
    expect(deleted).toBe(true);
    expect(
      db.prepare("SELECT COUNT(*) as c FROM vault_members WHERE user_id = ?").get(user.id),
    ).toEqual({ c: 0 });
    expect(
      db.prepare("SELECT COUNT(*) as c FROM users WHERE id = ?").get(user.id),
    ).toEqual({ c: 0 });
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

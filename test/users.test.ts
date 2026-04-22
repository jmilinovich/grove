import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-users-suite-"));
const TEST_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_DB_PATH = TEST_DB_PATH;

import { getDb, resetDb, createSchema } from "../src/db.js";
import {
  createUser,
  getUserById,
  getUserByEmail,
  getUserRole,
  updateUserDisplayName,
  listUserSessions,
  revokeUserSession,
  revokeAllOtherSessions,
  isValidHandle,
  changeUserHandle,
  deriveHandleFromEmail,
  updateUserBio,
  type UserRole,
} from "../src/users.js";
import { createSession, getSessionIdFromToken } from "../src/auth.js";
import { createKey } from "../src/keys.js";

describe("user roles", () => {
  beforeEach(() => {
    resetDb();
    createSchema();
    // Seed admin user (mirrors runMigration fresh-install path)
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO users (id, username, email, role) VALUES (?, ?, ?, ?)").run(
      "user_00000000", "admin", "admin@grove.local", "owner",
    );
    db.prepare("INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run(
      "vault_00000000", "user_00000000", "life", "Life", "/tmp/life",
    );
  });

  afterEach(() => {
    resetDb();
  });

  it("admin user has owner role", () => {
    const role = getUserRole("user_00000000");
    expect(role).toBe("owner");
  });

  it("createUser defaults to viewer role", () => {
    const user = createUser("alice@example.com", "alice");
    expect(user.role).toBe("viewer");

    const role = getUserRole(user.id);
    expect(role).toBe("viewer");
  });

  it("createUser accepts explicit role", () => {
    const member = createUser("bob@example.com", "bob", "member");
    expect(member.role).toBe("member");
    expect(getUserRole(member.id)).toBe("member");

    const owner = createUser("carol@example.com", "carol", "owner");
    expect(owner.role).toBe("owner");
    expect(getUserRole(owner.id)).toBe("owner");
  });

  it("getUserRole returns null for non-existent user", () => {
    const role = getUserRole("user_nonexistent");
    expect(role).toBeNull();
  });

  it("role column persists in the database", () => {
    const user = createUser("dave@example.com", "dave", "member");
    const fetched = getUserById(user.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.role).toBe("member");
  });

  it("getUserByEmail includes role", () => {
    createUser("eve@example.com", "eve", "viewer");
    const fetched = getUserByEmail("eve@example.com");
    expect(fetched).not.toBeNull();
    expect(fetched!.role).toBe("viewer");
  });
});

describe("role migration", () => {
  it("migrateUserRoles adds role column to existing table and sets admin to owner", () => {
    // Use a separate DB to avoid conflicts with the seeded state above
    const { mkdtempSync: mkdtemp } = require("node:fs");
    const migrationDir = mkdtemp(join(tmpdir(), "grove-migration-test-"));
    const migrationDbPath = join(migrationDir, "grove.db");
    const Database = require("better-sqlite3");
    const db = new Database(migrationDbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Create a users table WITHOUT the role column (simulates pre-migration schema)
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at TEXT
      );
      CREATE TABLE IF NOT EXISTS vaults (
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
    `);
    db.prepare("INSERT INTO users (id, username, email) VALUES (?, ?, ?)").run(
      "user_00000000", "admin", "admin@grove.local",
    );
    db.prepare("INSERT INTO users (id, username, email) VALUES (?, ?, ?)").run(
      "user_viewer01", "viewer1", "viewer@example.com",
    );

    // Verify role column doesn't exist yet
    const colsBefore = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
    expect(colsBefore.some((c: { name: string }) => c.name === "role")).toBe(false);

    // Point the singleton at this DB, run createSchema (which triggers migrateUserRoles)
    const origPath = process.env.GROVE_DB_PATH;
    process.env.GROVE_DB_PATH = migrationDbPath;
    db.close();
    resetDb();
    createSchema();

    const migratedDb = getDb();
    const adminRole = migratedDb.prepare("SELECT role FROM users WHERE id = ?").get("user_00000000") as { role: string };
    expect(adminRole.role).toBe("owner");

    const viewerRole = migratedDb.prepare("SELECT role FROM users WHERE id = ?").get("user_viewer01") as { role: string };
    expect(viewerRole.role).toBe("viewer");

    // Restore original DB path
    process.env.GROVE_DB_PATH = origPath;
    resetDb();

    const { rmSync: rm } = require("node:fs");
    rm(migrationDir, { recursive: true, force: true });
  });
});

// ── P15-1: profile endpoints (display name, sessions, key linkage) ────────

describe("profile (P15-1)", () => {
  beforeEach(() => {
    resetDb();
    createSchema();
    // Truncate state between tests — createSchema uses IF NOT EXISTS so rows persist
    // across test cases when the underlying SQLite file is reused.
    const db = getDb();
    db.exec("DELETE FROM vault_members; DELETE FROM api_keys; DELETE FROM sessions; DELETE FROM trail_grants; DELETE FROM trails; DELETE FROM vaults; DELETE FROM users;");
    db.prepare("INSERT OR IGNORE INTO users (id, username, email, role) VALUES (?, ?, ?, ?)").run(
      "user_00000000", "admin", "admin@grove.local", "owner",
    );
    db.prepare("INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run(
      "vault_00000000", "user_00000000", "life", "Life", "/tmp/life",
    );
  });

  afterEach(() => {
    resetDb();
  });

  describe("display name", () => {
    it("updateUserDisplayName persists a new name", () => {
      const ok = updateUserDisplayName("user_00000000", "Jane");
      expect(ok).toBe(true);
      expect(getUserById("user_00000000")!.display_name).toBe("Jane");
    });

    it("trims whitespace and collapses empty input to null", () => {
      updateUserDisplayName("user_00000000", "  Jane  ");
      expect(getUserById("user_00000000")!.display_name).toBe("Jane");
      updateUserDisplayName("user_00000000", "   ");
      expect(getUserById("user_00000000")!.display_name).toBeNull();
    });

    it("returns false for a non-existent user", () => {
      expect(updateUserDisplayName("user_missing", "x")).toBe(false);
    });
  });

  describe("sessions", () => {
    it("createSession persists user_agent when provided", () => {
      const { id } = createSession("user_00000000", "Mozilla/5.0 (Macintosh) Chrome/121");
      const db = getDb();
      const row = db.prepare("SELECT user_agent FROM sessions WHERE id = ?").get(id) as { user_agent: string };
      expect(row.user_agent).toBe("Mozilla/5.0 (Macintosh) Chrome/121");
    });

    it("listUserSessions returns fresh sessions with user_agent", () => {
      createSession("user_00000000", "Chrome on Mac");
      createSession("user_00000000", "iOS Safari");
      const rows = listUserSessions("user_00000000");
      expect(rows.length).toBe(2);
      const uas = rows.map((r) => r.user_agent).sort();
      expect(uas).toEqual(["Chrome on Mac", "iOS Safari"]);
    });

    it("listUserSessions excludes expired sessions", () => {
      const { id: freshId } = createSession("user_00000000", "fresh");
      const { id: staleId } = createSession("user_00000000", "stale");
      // Expire one session in the past
      getDb()
        .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 60_000).toISOString(), staleId);
      const rows = listUserSessions("user_00000000");
      expect(rows.map((r) => r.id)).toEqual([freshId]);
    });

    it("revokeUserSession only deletes the caller's own session", () => {
      createUser("mallory@example.com", "mallory", "viewer");
      const { id: ownSession } = createSession("user_00000000", "own");
      const { id: foreignSession } = createSession(getUserByEmail("mallory@example.com")!.id, "mallory's");

      // user_00000000 can't revoke mallory's session
      expect(revokeUserSession("user_00000000", foreignSession)).toBe(false);
      // …but can revoke their own
      expect(revokeUserSession("user_00000000", ownSession)).toBe(true);

      const db = getDb();
      const remaining = db.prepare("SELECT id FROM sessions").all() as { id: string }[];
      expect(remaining.map((r) => r.id)).toEqual([foreignSession]);
    });

    it("revokeAllOtherSessions keeps the nominated current session", () => {
      const { id: current } = createSession("user_00000000", "current");
      createSession("user_00000000", "other-1");
      createSession("user_00000000", "other-2");

      const removed = revokeAllOtherSessions("user_00000000", current);
      expect(removed).toBe(2);
      const rows = listUserSessions("user_00000000");
      expect(rows.map((r) => r.id)).toEqual([current]);
    });

    it("revokeAllOtherSessions with empty keep param wipes everything (legacy behavior)", () => {
      createSession("user_00000000", "a");
      createSession("user_00000000", "b");
      const removed = revokeAllOtherSessions("user_00000000", "");
      expect(removed).toBe(2);
      expect(listUserSessions("user_00000000").length).toBe(0);
    });
  });

  describe("api-key ↔ session linkage (is_current)", () => {
    it("createKey persists session_id when supplied", () => {
      const { id: sessionId } = createSession("user_00000000", "ua");
      const key = createKey("web", ["read"], "life", undefined, "user_00000000", sessionId);
      const row = getDb()
        .prepare("SELECT session_id FROM api_keys WHERE id = ?")
        .get(key.id) as { session_id: string | null };
      expect(row.session_id).toBe(sessionId);
    });

    it("createKey defaults session_id to null for non-session (bearer) creation", () => {
      const key = createKey("cli", ["read", "write"], "life", undefined, "user_00000000");
      const row = getDb()
        .prepare("SELECT session_id FROM api_keys WHERE id = ?")
        .get(key.id) as { session_id: string | null };
      expect(row.session_id).toBeNull();
    });

    it("getSessionIdFromToken resolves the id for a fresh session token", () => {
      const { token, id } = createSession("user_00000000", "ua");
      expect(getSessionIdFromToken(token)).toBe(id);
    });

    it("getSessionIdFromToken returns null for an unknown token", () => {
      expect(getSessionIdFromToken("not-a-real-token")).toBeNull();
    });
  });

  describe("profile data aggregation (mirrors /v1/me)", () => {
    it("owner sees their own keys, trails, and sessions with is_current flag", () => {
      // Create the caller's session + linked web key
      const { id: sessionId } = createSession("user_00000000", "Chrome on Mac");
      const webKey = createKey("grove-www", ["read"], "life", undefined, "user_00000000", sessionId);
      // A second key with no session (CLI)
      createKey("cli", ["read", "write"], "life", undefined, "user_00000000");
      // Another browser session unrelated to the key
      createSession("user_00000000", "iOS Safari");

      const user = getUserById("user_00000000")!;
      const db = getDb();
      const keys = db
        .prepare("SELECT id, name, scopes FROM api_keys WHERE user_id = ?")
        .all(user.id) as Array<{ id: string; name: string; scopes: string }>;
      expect(keys.length).toBe(2);

      const currentSessionRow = db
        .prepare("SELECT session_id FROM api_keys WHERE id = ?")
        .get(webKey.id) as { session_id: string | null };
      const currentSessionId = currentSessionRow.session_id;

      const sessions = listUserSessions(user.id).map((s) => ({
        ...s,
        is_current: s.id === currentSessionId,
      }));
      expect(sessions.length).toBe(2);
      expect(sessions.filter((s) => s.is_current).map((s) => s.id)).toEqual([sessionId]);
    });

    it("viewer role is preserved through profile queries", () => {
      const viewer = createUser("victor@example.com", "victor", "viewer");
      createSession(viewer.id, "ua");
      const fetched = getUserById(viewer.id)!;
      expect(fetched.role).toBe("viewer");
      expect(listUserSessions(viewer.id).length).toBe(1);
    });
  });
});

// ── P16-1: handles ──────────────────────────────────────────────────

describe("isValidHandle (P16-1)", () => {
  beforeEach(() => {
    resetDb();
    createSchema();
    const db = getDb();
    db.exec("DELETE FROM vault_members; DELETE FROM handle_history; DELETE FROM vault_members; DELETE FROM api_keys; DELETE FROM sessions; DELETE FROM trail_grants; DELETE FROM trails; DELETE FROM vaults; DELETE FROM users;");
    db.prepare("INSERT OR IGNORE INTO users (id, username, email, role) VALUES (?, ?, ?, ?)").run(
      "user_00000000", "admin-owner", "admin@grove.local", "owner",
    );
    db.prepare("INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run(
      "vault_00000000", "user_00000000", "life", "Life", "/tmp/life",
    );
  });

  afterEach(() => {
    resetDb();
  });

  it("accepts valid handles", () => {
    expect(isValidHandle("jm").valid).toBe(true);
    expect(isValidHandle("j-doe").valid).toBe(true);
    expect(isValidHandle("j_doe_2").valid).toBe(true);
    expect(isValidHandle("a").valid).toBe(true);
    expect(isValidHandle("abc123").valid).toBe(true);
  });

  it("rejects reserved handles", () => {
    const reserved = ["admin", "api", "v1", "login", "logout", "signup", "dashboard", "profile", "keys", "images", "home", "trails", "s", "u", "me", "settings", "help", "about", "docs", "support", "privacy", "terms", "well-known", "auth"];
    for (const r of reserved) {
      expect(isValidHandle(r).valid).toBe(false);
    }
  });

  it("rejects uppercase or mixed-case handles", () => {
    expect(isValidHandle("J").valid).toBe(false);
    expect(isValidHandle("Jsmith").valid).toBe(false);
  });

  it("rejects handles starting with non-alphanumeric", () => {
    expect(isValidHandle("-jm").valid).toBe(false);
    expect(isValidHandle("_jm").valid).toBe(false);
  });

  it("rejects invalid characters", () => {
    expect(isValidHandle("j@m").valid).toBe(false);
    expect(isValidHandle("j.m").valid).toBe(false);
    expect(isValidHandle("j m").valid).toBe(false);
  });

  it("rejects handles over 30 chars", () => {
    const thirtyOne = "a".repeat(31);
    expect(isValidHandle(thirtyOne).valid).toBe(false);
    const thirty = "a".repeat(30);
    expect(isValidHandle(thirty).valid).toBe(true);
  });

  it("rejects empty or non-string handles", () => {
    expect(isValidHandle("").valid).toBe(false);
    // @ts-expect-error — runtime guard for non-strings
    expect(isValidHandle(undefined).valid).toBe(false);
  });

  it("rejects handles taken by another user", () => {
    createUser("alice@example.com", "alice");
    expect(isValidHandle("alice").valid).toBe(false);
  });

  it("accepts the caller's own handle when excludeUserId is passed", () => {
    const alice = createUser("alice@example.com", "alice");
    expect(isValidHandle("alice", { excludeUserId: alice.id }).valid).toBe(true);
  });
});

describe("changeUserHandle + handle_history (P16-1)", () => {
  beforeEach(() => {
    resetDb();
    createSchema();
    const db = getDb();
    db.exec("DELETE FROM vault_members; DELETE FROM handle_history; DELETE FROM vault_members; DELETE FROM api_keys; DELETE FROM sessions; DELETE FROM trail_grants; DELETE FROM trails; DELETE FROM vaults; DELETE FROM users;");
    db.prepare("INSERT OR IGNORE INTO users (id, username, email, role) VALUES (?, ?, ?, ?)").run(
      "user_00000000", "admin-owner", "admin@grove.local", "owner",
    );
    db.prepare("INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run(
      "vault_00000000", "user_00000000", "life", "Life", "/tmp/life",
    );
  });

  afterEach(() => {
    resetDb();
  });

  it("changes the handle and writes the old one into handle_history", () => {
    const u = createUser("alice@example.com", "alice");
    changeUserHandle(u.id, "alice-the-great");

    const db = getDb();
    const refreshed = db.prepare("SELECT username FROM users WHERE id = ?").get(u.id) as { username: string };
    expect(refreshed.username).toBe("alice-the-great");

    const hist = db.prepare("SELECT handle, user_id FROM handle_history").all() as Array<{ handle: string; user_id: string }>;
    expect(hist).toHaveLength(1);
    expect(hist[0].handle).toBe("alice");
    expect(hist[0].user_id).toBe(u.id);
  });

  it("is a no-op when the handle is unchanged", () => {
    const u = createUser("alice@example.com", "alice");
    changeUserHandle(u.id, "alice");
    const db = getDb();
    const hist = db.prepare("SELECT handle FROM handle_history").all() as Array<{ handle: string }>;
    expect(hist).toHaveLength(0);
  });

  it("blocks another user from reclaiming a historical handle", () => {
    const alice = createUser("alice@example.com", "alice");
    changeUserHandle(alice.id, "alice2");

    const bob = createUser("bob@example.com", "bob");
    expect(() => changeUserHandle(bob.id, "alice")).toThrow(/previously used/);
  });

  it("lets the original owner reclaim their own historical handle", () => {
    const alice = createUser("alice@example.com", "alice");
    changeUserHandle(alice.id, "alice2");
    changeUserHandle(alice.id, "alice");

    const db = getDb();
    const refreshed = db.prepare("SELECT username FROM users WHERE id = ?").get(alice.id) as { username: string };
    expect(refreshed.username).toBe("alice");
  });

  it("rejects a reserved handle", () => {
    const u = createUser("alice@example.com", "alice");
    expect(() => changeUserHandle(u.id, "admin")).toThrow(/reserved/);
  });

  it("rejects an invalid handle shape", () => {
    const u = createUser("alice@example.com", "alice");
    expect(() => changeUserHandle(u.id, "J@M")).toThrow();
  });
});

describe("deriveHandleFromEmail (P16-1)", () => {
  beforeEach(() => {
    resetDb();
    createSchema();
    const db = getDb();
    db.exec("DELETE FROM vault_members; DELETE FROM handle_history; DELETE FROM vault_members; DELETE FROM api_keys; DELETE FROM sessions; DELETE FROM trail_grants; DELETE FROM trails; DELETE FROM vaults; DELETE FROM users;");
  });

  afterEach(() => {
    resetDb();
  });

  it("lowercases the email local part and strips invalid chars", () => {
    expect(deriveHandleFromEmail("Jane.Doe@example.com")).toBe("janedoe");
  });

  it("appends a 3-digit suffix on collision", () => {
    const db = getDb();
    db.prepare("INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)").run(
      "user_1", "jane", "jane@example.com", "viewer",
    );
    expect(deriveHandleFromEmail("jane@other.com")).toBe("jane-000");
  });

  it("avoids reserved handles by suffixing", () => {
    expect(deriveHandleFromEmail("admin@example.com")).toBe("admin-000");
  });
});

describe("updateUserBio (P16-1)", () => {
  beforeEach(() => {
    resetDb();
    createSchema();
    const db = getDb();
    db.exec("DELETE FROM vault_members; DELETE FROM handle_history; DELETE FROM vault_members; DELETE FROM api_keys; DELETE FROM sessions; DELETE FROM trail_grants; DELETE FROM trails; DELETE FROM vaults; DELETE FROM users;");
    db.prepare("INSERT OR IGNORE INTO users (id, username, email, role) VALUES (?, ?, ?, ?)").run(
      "user_00000000", "admin-owner", "admin@grove.local", "owner",
    );
    db.prepare("INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run(
      "vault_00000000", "user_00000000", "life", "Life", "/tmp/life",
    );
  });

  afterEach(() => {
    resetDb();
  });

  it("persists a bio on the user", () => {
    updateUserBio("user_00000000", "Makes things.");
    expect(getUserById("user_00000000")!.bio).toBe("Makes things.");
  });

  it("rejects bios over 280 chars", () => {
    expect(() => updateUserBio("user_00000000", "x".repeat(281))).toThrow(/too long/);
  });

  it("accepts null to clear", () => {
    updateUserBio("user_00000000", "first");
    updateUserBio("user_00000000", null);
    expect(getUserById("user_00000000")!.bio).toBeNull();
  });
});

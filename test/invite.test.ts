import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, email TEXT UNIQUE, role TEXT NOT NULL DEFAULT 'member', display_name TEXT, bio TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT);
  CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), slug TEXT NOT NULL, display_name TEXT NOT NULL, git_repo_path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), storage_bytes INTEGER NOT NULL DEFAULT 0, storage_quota_bytes INTEGER NOT NULL DEFAULT 104857600, UNIQUE(owner_id, slug));
  CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), vault_id TEXT NOT NULL, name TEXT NOT NULL, hashed_token TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT 'read,write', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT, expires_at TEXT, session_id TEXT);
  CREATE TABLE IF NOT EXISTS trails (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS trail_grants (id TEXT PRIMARY KEY, trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE, grantee_type TEXT NOT NULL, grantee_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL, last_used_at TEXT, user_agent TEXT);
  CREATE TABLE IF NOT EXISTS magic_links (id TEXT PRIMARY KEY, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
  CREATE TABLE IF NOT EXISTS auth_codes (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS handle_history (handle TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), released_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS vault_members (user_id TEXT NOT NULL REFERENCES users(id), vault_id TEXT NOT NULL REFERENCES vaults(id), role TEXT NOT NULL CHECK(role IN ('owner', 'member', 'viewer')), joined_at TEXT NOT NULL DEFAULT (datetime('now')), last_active_at TEXT, PRIMARY KEY (user_id, vault_id));
`;

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-invite-suite-"));
const TEST_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_DB_PATH = TEST_DB_PATH;

// Import after setting env var
import { getDb, resetDb } from "../src/db.js";
import { inviteUser } from "../src/invite.js";
import { stopCleanup } from "../src/auth.js";

function seedDb() {
  const db = getDb();
  db.exec(SCHEMA);

  // Clear tables
  db.exec("DELETE FROM vault_members");
  db.exec("DELETE FROM trail_grants");
  db.exec("DELETE FROM trails");
  db.exec("DELETE FROM magic_links");
  db.exec("DELETE FROM api_keys");
  db.exec("DELETE FROM vaults");
  db.exec("DELETE FROM users");

  // Seed admin user and vault
  db.prepare("INSERT INTO users (id, username, email) VALUES (?, ?, ?)").run(
    "user_00000000", "admin", "admin@example.com"
  );
  db.prepare("INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run(
    "vault_00000000", "user_00000000", "life", "Life", "/tmp/life"
  );

  // Seed a trail
  db.prepare(
    "INSERT INTO trails (id, vault_id, name, description, enabled, config_json) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("trail_abc123", "life", "Design System", "Curated design notes", 1, JSON.stringify({
    allow_tags: ["design"], deny_tags: [], allow_types: [], deny_types: [],
    allow_paths: [], deny_paths: [], rate_limit_reads: 60, rate_limit_writes: 0,
  }));
}

describe("invite", () => {
  beforeEach(() => {
    resetDb();
    seedDb();
  });

  afterEach(() => {
    stopCleanup();
    vi.restoreAllMocks();
  });

  it("creates a new user, trail grant, and magic link", async () => {
    const result = await inviteUser("alice@example.com", "trail_abc123", "viewer", "https://api.grove.md");

    expect(result.email).toBe("alice@example.com");
    expect(result.trail_id).toBe("trail_abc123");
    expect(result.created).toBe(true);
    expect(result.user_id).toMatch(/^user_/);
    expect(result.key_id).toMatch(/^key_/);

    // Verify user was created
    const db = getDb();
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get("alice@example.com") as any;
    expect(user).toBeDefined();
    expect(user.id).toBe(result.user_id);

    // Verify API key was created for the user
    const key = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(result.key_id) as any;
    expect(key).toBeDefined();
    expect(key.user_id).toBe(result.user_id);
    expect(key.scopes).toBe("read");

    // Verify trail grant was created
    const grant = db.prepare(
      "SELECT * FROM trail_grants WHERE trail_id = ? AND grantee_id = ?"
    ).get("trail_abc123", result.key_id) as any;
    expect(grant).toBeDefined();
    expect(grant.grantee_type).toBe("token");

    // Verify magic link was created
    const ml = db.prepare("SELECT * FROM magic_links WHERE email = ?").get("alice@example.com") as any;
    expect(ml).toBeDefined();
    expect(ml.used_at).toBeNull();
  });

  it("is idempotent — re-inviting same email for same trail does not duplicate", async () => {
    const first = await inviteUser("bob@example.com", "trail_abc123", "viewer", "https://api.grove.md");
    const second = await inviteUser("bob@example.com", "trail_abc123", "viewer", "https://api.grove.md");

    expect(second.user_id).toBe(first.user_id);
    expect(second.key_id).toBe(first.key_id);
    expect(second.created).toBe(false);

    // Only one user, one key, one grant
    const db = getDb();
    const users = db.prepare("SELECT * FROM users WHERE email = ?").all("bob@example.com");
    expect(users).toHaveLength(1);

    const grants = db.prepare(
      "SELECT * FROM trail_grants WHERE trail_id = ? AND grantee_type = 'token' AND grantee_id IN (SELECT id FROM api_keys WHERE user_id = ?)"
    ).all("trail_abc123", first.user_id);
    expect(grants).toHaveLength(1);
  });

  it("returns 404 for invalid trail ID", async () => {
    await expect(
      inviteUser("carol@example.com", "trail_nonexistent", "viewer", "https://api.grove.md")
    ).rejects.toThrow("Trail not found: trail_nonexistent");
  });

  it("normalizes email to lowercase", async () => {
    const result = await inviteUser("Alice@Example.COM", "trail_abc123", "viewer", "https://api.grove.md");
    expect(result.email).toBe("alice@example.com");

    const db = getDb();
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get("alice@example.com") as any;
    expect(user).toBeDefined();
  });

  it("derives a valid username from email", async () => {
    await inviteUser("jane.doe@example.com", "trail_abc123", "viewer", "https://api.grove.md");

    const db = getDb();
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get("jane.doe@example.com") as any;
    expect(user).toBeDefined();
    // Username should be derived from local part, cleaned up
    expect(user.username).toMatch(/^[a-z0-9][a-z0-9-]{2,30}$/);
  });

  it("embeds the owning resident handle in the magic-link redirect (P16-4)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await inviteUser("dana@example.com", "trail_abc123", "viewer", "https://api.grove.md");

    // Dev-mode email logs the verify URL. Decode the embedded redirect
    // and confirm it carries resident=admin + the existing trail param.
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const verifyMatch = logged.match(/https:\/\/[^\s]+/);
    expect(verifyMatch).not.toBeNull();
    const verifyUrl = new URL(verifyMatch![0]);
    const redirectParam = verifyUrl.searchParams.get("redirect");
    expect(redirectParam).not.toBeNull();
    const redirectUrl = new URL(redirectParam!);
    expect(redirectUrl.pathname).toBe("/api/auth/callback");
    expect(redirectUrl.searchParams.get("trail")).toBe("trail_abc123");
    expect(redirectUrl.searchParams.get("resident")).toBe("admin");
  });
});

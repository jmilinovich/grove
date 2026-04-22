import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";

/**
 * Auth tests work against a fresh SQLite database per test.
 * We create the db directly (bypassing the getDb singleton) and seed it.
 * Auth functions also use getDb(), so we must ensure it opens the same db.
 *
 * Since DB_PATH in db.ts is a module-level constant captured at import time,
 * we must set GROVE_DB_PATH before the FIRST import of db.ts. To work around
 * this, we set GROVE_DB_PATH in a common parent dir, and the tests create
 * the db file directly in the same location.
 */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, email TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT);
  CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), slug TEXT NOT NULL, display_name TEXT NOT NULL, git_repo_path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), storage_bytes INTEGER NOT NULL DEFAULT 0, storage_quota_bytes INTEGER NOT NULL DEFAULT 104857600, UNIQUE(owner_id, slug));
  CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), vault_id TEXT NOT NULL, name TEXT NOT NULL, hashed_token TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT 'read,write', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT, expires_at TEXT, session_id TEXT);
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL, last_used_at TEXT, user_agent TEXT);
  CREATE TABLE IF NOT EXISTS magic_links (id TEXT PRIMARY KEY, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
  CREATE TABLE IF NOT EXISTS auth_codes (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
`;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Use a stable test dir so the module-level DB_PATH is consistent across tests.
// Each test truncates the tables instead of creating a new db file.
const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-auth-suite-"));
const TEST_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_DB_PATH = TEST_DB_PATH;

// Import after setting env var so the singleton uses our test db
import { getDb, resetDb } from "../src/db.js";
import {
  requestMagicLink,
  verifyMagicLink,
  createSession,
  validateSession,
  destroySession,
  createAuthCode,
  exchangeAuthCode,
  generateCsrfToken,
  validateCsrfToken,
  stopCleanup,
} from "../src/auth.js";

describe("auth", () => {
  beforeEach(() => {
    // Ensure clean state — reset the singleton and recreate schema + seed
    resetDb();
    const db = getDb();
    db.exec(SCHEMA);

    // Truncate all auth-related tables
    db.exec("DELETE FROM auth_codes");
    db.exec("DELETE FROM magic_links");
    db.exec("DELETE FROM sessions");
    db.exec("DELETE FROM api_keys");
    db.exec("DELETE FROM vaults");
    db.exec("DELETE FROM users");

    // Seed admin user
    db.prepare("INSERT INTO users (id, username, email) VALUES (?, ?, ?)").run(
      "user_00000000", "admin", "admin@example.com"
    );
    db.prepare("INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run(
      "vault_00000000", "user_00000000", "life", "Life", "/tmp/life"
    );
  });

  afterEach(() => {
    stopCleanup();
  });

  // ── Magic Links ─────────────────────────────────────────────────

  describe("requestMagicLink", () => {
    it("stores a hashed token with correct expiry", async () => {
      const result = await requestMagicLink("admin@example.com", "https://api.grove.md");
      expect(result.ok).toBe(true);

      const db = getDb();
      const links = db.prepare("SELECT * FROM magic_links").all() as any[];
      expect(links).toHaveLength(1);
      expect(links[0].email).toBe("admin@example.com");
      expect(links[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
      const expiresAt = new Date(links[0].expires_at).getTime();
      const now = Date.now();
      expect(expiresAt - now).toBeGreaterThan(14 * 60 * 1000);
      expect(expiresAt - now).toBeLessThan(16 * 60 * 1000);
    });

    it("normalizes email to lowercase", async () => {
      await requestMagicLink("Admin@EXAMPLE.com", "https://api.grove.md");
      const db = getDb();
      const links = db.prepare("SELECT * FROM magic_links").all() as any[];
      expect(links[0].email).toBe("admin@example.com");
    });

    it("rate limits after 3 requests for same email in 15 min", async () => {
      for (let i = 0; i < 3; i++) {
        await requestMagicLink("admin@example.com", "https://api.grove.md");
      }
      const result = await requestMagicLink("admin@example.com", "https://api.grove.md");
      expect(result.ok).toBe(true);

      const db = getDb();
      const count = db.prepare("SELECT COUNT(*) as count FROM magic_links").get() as { count: number };
      expect(count.count).toBe(3);
    });

    it("always returns ok even for unknown emails", async () => {
      const result = await requestMagicLink("nobody@example.com", "https://api.grove.md");
      expect(result.ok).toBe(true);

      const db = getDb();
      const links = db.prepare("SELECT * FROM magic_links").all() as any[];
      expect(links).toHaveLength(1);
    });
  });

  // ── Verification ──────────────────────────────────────────────────

  describe("verifyMagicLink", () => {
    it("succeeds with valid token and returns session", () => {
      const db = getDb();
      const token = randomBytes(32).toString("hex");
      db.prepare(
        "INSERT INTO magic_links (id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)"
      ).run("ml_test1", "admin@example.com", hashToken(token), new Date(Date.now() + 900_000).toISOString());

      const result = verifyMagicLink(token, "admin@example.com");
      expect(result).not.toBeNull();
      expect(result!.user.email).toBe("admin@example.com");
      expect(result!.user.id).toBe("user_00000000");
      expect(result!.sessionToken).toMatch(/^[a-f0-9]{64}$/);

      const sessions = db.prepare("SELECT * FROM sessions").all() as any[];
      expect(sessions).toHaveLength(1);
    });

    it("marks the link as used", () => {
      const db = getDb();
      const token = randomBytes(32).toString("hex");
      db.prepare(
        "INSERT INTO magic_links (id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)"
      ).run("ml_test2", "admin@example.com", hashToken(token), new Date(Date.now() + 900_000).toISOString());

      verifyMagicLink(token, "admin@example.com");

      const link = db.prepare("SELECT used_at FROM magic_links WHERE id = 'ml_test2'").get() as any;
      expect(link.used_at).not.toBeNull();
    });

    it("rejects already-used link", () => {
      const db = getDb();
      const token = randomBytes(32).toString("hex");
      db.prepare(
        "INSERT INTO magic_links (id, email, token_hash, expires_at, used_at) VALUES (?, ?, ?, ?, ?)"
      ).run("ml_used", "admin@example.com", hashToken(token), new Date(Date.now() + 900_000).toISOString(), new Date().toISOString());

      expect(verifyMagicLink(token, "admin@example.com")).toBeNull();
    });

    it("rejects expired link", () => {
      const db = getDb();
      const token = randomBytes(32).toString("hex");
      db.prepare(
        "INSERT INTO magic_links (id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)"
      ).run("ml_expired", "admin@example.com", hashToken(token), new Date(Date.now() - 1000).toISOString());

      expect(verifyMagicLink(token, "admin@example.com")).toBeNull();
    });

    it("rejects wrong email", () => {
      const db = getDb();
      const token = randomBytes(32).toString("hex");
      db.prepare(
        "INSERT INTO magic_links (id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)"
      ).run("ml_wrong", "admin@example.com", hashToken(token), new Date(Date.now() + 900_000).toISOString());

      expect(verifyMagicLink(token, "other@example.com")).toBeNull();
    });

    it("returns null when user doesn't exist", () => {
      const db = getDb();
      const token = randomBytes(32).toString("hex");
      db.prepare(
        "INSERT INTO magic_links (id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)"
      ).run("ml_nouser", "nobody@example.com", hashToken(token), new Date(Date.now() + 900_000).toISOString());

      expect(verifyMagicLink(token, "nobody@example.com")).toBeNull();
    });
  });

  // ── Sessions ──────────────────────────────────────────────────────

  describe("sessions", () => {
    it("stores hash, not raw token", () => {
      const { token } = createSession("user_00000000");
      const db = getDb();
      const session = db.prepare("SELECT token_hash FROM sessions").get() as any;
      expect(session.token_hash).toBe(hashToken(token));
      expect(session.token_hash).not.toBe(token);
    });

    it("validates a fresh session", () => {
      const { token } = createSession("user_00000000");
      const user = validateSession(token);
      expect(user).not.toBeNull();
      expect(user!.id).toBe("user_00000000");
      expect(user!.email).toBe("admin@example.com");
    });

    it("updates last_login_at on the user", () => {
      const db = getDb();
      const before = db.prepare("SELECT last_login_at FROM users WHERE id = 'user_00000000'").get() as any;
      expect(before.last_login_at).toBeNull();

      createSession("user_00000000");

      const after = db.prepare("SELECT last_login_at FROM users WHERE id = 'user_00000000'").get() as any;
      expect(after.last_login_at).not.toBeNull();
      const loginTime = new Date(after.last_login_at).getTime();
      expect(Math.abs(loginTime - Date.now())).toBeLessThan(5000);
    });

    it("rejects expired session", () => {
      const db = getDb();
      const token = randomBytes(32).toString("hex");
      db.prepare(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at, absolute_expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        "sess_expired", "user_00000000", hashToken(token),
        new Date(Date.now() - 1000).toISOString(),
        new Date(Date.now() + 86400_000).toISOString(),
        new Date().toISOString(),
      );

      expect(validateSession(token)).toBeNull();
      expect(db.prepare("SELECT * FROM sessions WHERE id = 'sess_expired'").get()).toBeUndefined();
    });

    it("rejects session past absolute expiry", () => {
      const db = getDb();
      const token = randomBytes(32).toString("hex");
      db.prepare(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at, absolute_expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        "sess_abs", "user_00000000", hashToken(token),
        new Date(Date.now() + 86400_000).toISOString(),
        new Date(Date.now() - 1000).toISOString(),
        new Date().toISOString(),
      );

      expect(validateSession(token)).toBeNull();
    });

    it("extends sliding expiry when within 7 days", () => {
      const db = getDb();
      const token = randomBytes(32).toString("hex");
      const sixDaysFromNow = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
      const ninetyDaysFromNow = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

      db.prepare(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at, absolute_expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        "sess_refresh", "user_00000000", hashToken(token),
        sixDaysFromNow.toISOString(),
        ninetyDaysFromNow.toISOString(),
        new Date().toISOString(),
      );

      const user = validateSession(token);
      expect(user).not.toBeNull();

      const session = db.prepare("SELECT expires_at FROM sessions WHERE id = 'sess_refresh'").get() as any;
      const newExpiry = new Date(session.expires_at).getTime();
      expect(newExpiry).toBeGreaterThan(sixDaysFromNow.getTime());
    });

    it("caps sliding extension at absolute expiry", () => {
      const db = getDb();
      const token = randomBytes(32).toString("hex");
      const twoDaysFromNow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      const fiveDaysFromNow = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

      db.prepare(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at, absolute_expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        "sess_capped", "user_00000000", hashToken(token),
        twoDaysFromNow.toISOString(),
        fiveDaysFromNow.toISOString(),
        new Date().toISOString(),
      );

      validateSession(token);

      const session = db.prepare("SELECT expires_at FROM sessions WHERE id = 'sess_capped'").get() as any;
      const newExpiry = new Date(session.expires_at).getTime();
      expect(newExpiry).toBeLessThanOrEqual(fiveDaysFromNow.getTime() + 1000);
    });

    it("destroySession invalidates future lookups", () => {
      const { token } = createSession("user_00000000");
      expect(validateSession(token)).not.toBeNull();
      destroySession(token);
      expect(validateSession(token)).toBeNull();
    });
  });

  // ── Auth Codes ────────────────────────────────────────────────────

  describe("auth codes", () => {
    it("createAuthCode stores hashed code with 60s expiry", () => {
      const code = createAuthCode("user_00000000");
      expect(code).toMatch(/^[a-f0-9]{64}$/);

      const db = getDb();
      const row = db.prepare("SELECT * FROM auth_codes").get() as any;
      expect(row.code_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.code_hash).not.toBe(code); // stored as hash
      expect(row.user_id).toBe("user_00000000");
      const expiresAt = new Date(row.expires_at).getTime();
      expect(expiresAt - Date.now()).toBeLessThan(61_000);
      expect(expiresAt - Date.now()).toBeGreaterThan(58_000);
    });

    it("exchangeAuthCode succeeds with valid code", () => {
      const code = createAuthCode("user_00000000");
      const result = exchangeAuthCode(code);
      expect(result).not.toBeNull();
      expect(result!.user.id).toBe("user_00000000");
      expect(result!.user.email).toBe("admin@example.com");
      expect(result!.sessionToken).toMatch(/^[a-f0-9]{64}$/);
    });

    it("exchangeAuthCode is single-use", () => {
      const code = createAuthCode("user_00000000");
      expect(exchangeAuthCode(code)).not.toBeNull();
      expect(exchangeAuthCode(code)).toBeNull();
    });

    it("exchangeAuthCode rejects expired code", () => {
      const db = getDb();
      const code = randomBytes(32).toString("hex");
      db.prepare(
        "INSERT INTO auth_codes (id, code_hash, user_id, expires_at) VALUES (?, ?, ?, ?)"
      ).run("ac_expired", hashToken(code), "user_00000000", new Date(Date.now() - 1000).toISOString());
      expect(exchangeAuthCode(code)).toBeNull();
    });

    it("exchangeAuthCode rejects invalid code", () => {
      expect(exchangeAuthCode("not-a-real-code")).toBeNull();
    });
  });

  // ── CSRF ──────────────────────────────────────────────────────────

  describe("CSRF tokens", () => {
    it("round-trip: generate → validate succeeds", () => {
      const token = generateCsrfToken();
      expect(validateCsrfToken(token)).toBe(true);
    });

    it("rejects tampered token", () => {
      const token = generateCsrfToken();
      // Flip the first char to something guaranteed-different. The
      // original implementation used "x" + token.slice(1), which
      // accidentally passed through the original token ~1.5% of the
      // time (base64url → 1/64 chance first char is already 'x'),
      // flaking CI on Dependabot bumps.
      const first = token[0];
      const replacement = first === "x" ? "y" : "x";
      const tampered = replacement + token.slice(1);
      expect(tampered).not.toBe(token);
      expect(validateCsrfToken(tampered)).toBe(false);
    });

    it("rejects malformed token", () => {
      expect(validateCsrfToken("not-a-valid-token")).toBe(false);
      expect(validateCsrfToken("")).toBe(false);
    });
  });
});

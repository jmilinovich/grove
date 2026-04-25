import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-users-handles-"));
const TEST_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_DB_PATH = TEST_DB_PATH;

import { getDb, resetDb, createSchema } from "../../src/db.js";
import {
  createUser,
  getUserById,
  isValidHandle,
  changeUserHandle,
  deriveHandleFromEmail,
} from "../../src/users.js";

function seedAdmin() {
  resetDb();
  createSchema();
  const db = getDb();
  db.exec(
    "DELETE FROM vault_members; DELETE FROM handle_history; DELETE FROM api_keys; DELETE FROM sessions; DELETE FROM trail_grants; DELETE FROM trails; DELETE FROM vaults; DELETE FROM users;",
  );
  db.prepare("INSERT OR IGNORE INTO users (id, username, email, role) VALUES (?, ?, ?, ?)").run(
    "user_00000000", "admin-owner", "admin@grove.local", "owner",
  );
  db.prepare("INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run(
    "vault_00000000", "user_00000000", "life", "Life", "/tmp/life",
  );
}

// ── isValidHandle (P16-1) ───────────────────────────────────────────

describe("isValidHandle (P16-1)", () => {
  beforeEach(seedAdmin);
  afterEach(() => resetDb());

  // Shape contract — independent of any DB seed.
  const validHandles = ["jm", "j-doe", "j_doe_2", "a", "abc123", "a".repeat(30)];
  it.each(validHandles)("accepts %s", (h) => {
    expect(isValidHandle(h).valid).toBe(true);
  });

  const invalidShapes: [string, unknown][] = [
    ["uppercase", "J"],
    ["mixed case", "Jsmith"],
    ["leading dash", "-jm"],
    ["leading underscore", "_jm"],
    ["@ sign", "j@m"],
    ["dot", "j.m"],
    ["space", "j m"],
    ["31 chars", "a".repeat(31)],
    ["empty string", ""],
    ["undefined", undefined],
  ];
  it.each(invalidShapes)("rejects %s", (_label, h) => {
    // @ts-expect-error — undefined is part of the runtime-guard contract
    expect(isValidHandle(h).valid).toBe(false);
  });

  const RESERVED = ["admin", "api", "v1", "login", "logout", "signup", "dashboard", "profile", "keys", "images", "home", "trails", "s", "u", "me", "settings", "help", "about", "docs", "support", "privacy", "terms", "well-known", "auth"];
  it.each(RESERVED)("rejects reserved handle: %s", (r) => {
    expect(isValidHandle(r).valid).toBe(false);
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

// ── changeUserHandle + handle_history (P16-1) ────────────────────

describe("changeUserHandle + handle_history (P16-1)", () => {
  beforeEach(seedAdmin);
  afterEach(() => resetDb());

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

// ── deriveHandleFromEmail (P16-1) ────────────────────────────────

describe("deriveHandleFromEmail (P16-1)", () => {
  beforeEach(() => {
    resetDb();
    createSchema();
    const db = getDb();
    db.exec(
      "DELETE FROM vault_members; DELETE FROM handle_history; DELETE FROM api_keys; DELETE FROM sessions; DELETE FROM trail_grants; DELETE FROM trails; DELETE FROM vaults; DELETE FROM users;",
    );
  });

  afterEach(() => resetDb());

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

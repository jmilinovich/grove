/**
 * Tests for `adminAuth(req, vaultId?)` — the proxy's per-vault admin
 * authorization helper. Covers:
 *
 *   - 401 when neither session cookie nor Bearer token is present.
 *   - 401 when Bearer token is unknown.
 *   - 403 when caller's `vault_members.role` is not `owner` for the
 *     requested vault.
 *   - 403 when caller has global `users.role='owner'` but no membership
 *     in the requested vault — the regression at the heart of this
 *     batch.
 *   - 200/ok for a per-vault owner.
 *   - vaultId-omitted path falls back to global `users.role='owner'`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage } from "node:http";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-admin-auth-"));
const TEST_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_DB_PATH = TEST_DB_PATH;

import { getDb, resetDb, createSchema } from "../src/db.js";
import { createKey } from "../src/keys.js";
import { adminAuth } from "../src/admin-auth.js";

/** Build a fake `IncomingMessage` for the auth helper. We only
 *  exercise the headers / cookie parsing path, so a duck-typed object
 *  is enough — adminAuth never reads the body or method. */
function fakeReq(opts: { authorization?: string; cookie?: string } = {}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.authorization) headers.authorization = opts.authorization;
  if (opts.cookie) headers.cookie = opts.cookie;
  return { headers } as unknown as IncomingMessage;
}

function seedDb() {
  createSchema();
  const db = getDb();
  db.pragma("foreign_keys = OFF");
  db.exec("DELETE FROM vault_members");
  db.exec("DELETE FROM sessions");
  db.exec("DELETE FROM api_keys");
  db.exec("DELETE FROM vaults");
  db.exec("DELETE FROM users");
  db.pragma("foreign_keys = ON");

  // Two tenants. `alice` owns vault A and is a global owner. `bob` owns
  // vault B and is also a global owner. `mallory` is a global owner with
  // NO membership in either vault — this is the audit's "common thread"
  // attacker shape.
  db.prepare("INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)").run(
    "user_alice", "alice", "alice@grove.local", "owner",
  );
  db.prepare("INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)").run(
    "user_bob", "bob", "bob@grove.local", "owner",
  );
  db.prepare("INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)").run(
    "user_mallory", "mallory", "mallory@grove.local", "owner",
  );
  db.prepare("INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)").run(
    "user_carol", "carol", "carol@grove.local", "member",
  );

  db.prepare("INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run(
    "vault_alice", "user_alice", "alice", "Alice's Vault", "/tmp/alice",
  );
  db.prepare("INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run(
    "vault_bob", "user_bob", "bob", "Bob's Vault", "/tmp/bob",
  );

  // Membership rows. Carol is a `member` (not `owner`) in vault_alice —
  // she's authorized to read/write notes there but should NOT be able
  // to administer the vault.
  db.prepare("INSERT INTO vault_members (user_id, vault_id, role) VALUES (?, ?, ?)").run(
    "user_alice", "vault_alice", "owner",
  );
  db.prepare("INSERT INTO vault_members (user_id, vault_id, role) VALUES (?, ?, ?)").run(
    "user_bob", "vault_bob", "owner",
  );
  db.prepare("INSERT INTO vault_members (user_id, vault_id, role) VALUES (?, ?, ?)").run(
    "user_carol", "vault_alice", "member",
  );
  // Note: mallory has no vault_members rows — globally an owner but
  // a stranger to every vault.
}

describe("adminAuth(req, vaultId?)", () => {
  beforeEach(() => {
    resetDb();
    seedDb();
  });

  afterEach(() => {
    resetDb();
  });

  it("returns 401 when no auth is present", () => {
    const result = adminAuth(fakeReq(), "vault_alice");
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it("returns 401 for an unknown Bearer token", () => {
    const result = adminAuth(
      fakeReq({ authorization: "Bearer grove_live_does_not_exist" }),
      "vault_alice",
    );
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it("returns ok for a vault owner", () => {
    const aliceKey = createKey("alice-key", ["read", "write"], "vault_alice", undefined, "user_alice");
    const result = adminAuth(
      fakeReq({ authorization: `Bearer ${aliceKey.token}` }),
      "vault_alice",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.userId).toBe("user_alice");
  });

  it("returns 403 for a non-owner member of the vault", () => {
    // Carol is a `member` in vault_alice — she can write notes but
    // she's not the vault's admin. Expected: 403.
    const carolKey = createKey("carol-key", ["read", "write"], "vault_alice", undefined, "user_carol");
    const result = adminAuth(
      fakeReq({ authorization: `Bearer ${carolKey.token}` }),
      "vault_alice",
    );
    expect(result).toEqual({ ok: false, status: 403 });
  });

  it("returns 403 when global-owner caller is not a member of the requested vault", () => {
    // The bug this batch fixes: mallory has `users.role='owner'`
    // (Grove-wide admin) but no `vault_members` row for vault_alice.
    // The old adminAuth would have returned ok; the new one must 403.
    const malloryKey = createKey("mallory-key", ["read", "write"], "vault_alice", undefined, "user_mallory");
    const result = adminAuth(
      fakeReq({ authorization: `Bearer ${malloryKey.token}` }),
      "vault_alice",
    );
    expect(result).toEqual({ ok: false, status: 403 });
  });

  it("returns 403 when bob (owner of vault_bob) tries to admin vault_alice", () => {
    // Cross-tenant: bob is a vault owner, just not of vault_alice.
    const bobKey = createKey("bob-key", ["read", "write"], "vault_bob", undefined, "user_bob");
    const result = adminAuth(
      fakeReq({ authorization: `Bearer ${bobKey.token}` }),
      "vault_alice",
    );
    expect(result).toEqual({ ok: false, status: 403 });
  });

  it("falls back to global owner check when vaultId is omitted", () => {
    // Grove-wide admin surfaces (/admin/login, /metrics, /keys, /).
    // Mallory is `users.role='owner'` so she passes here even though
    // she has no vault membership — that's the legacy behavior.
    const malloryKey = createKey("mallory-key2", ["read", "write"], "vault_alice", undefined, "user_mallory");
    const result = adminAuth(fakeReq({ authorization: `Bearer ${malloryKey.token}` }));
    expect(result.ok).toBe(true);
  });

  it("returns 403 for a global non-owner when vaultId is omitted", () => {
    const carolKey = createKey("carol-key2", ["read", "write"], "vault_alice", undefined, "user_carol");
    const result = adminAuth(fakeReq({ authorization: `Bearer ${carolKey.token}` }));
    expect(result).toEqual({ ok: false, status: 403 });
  });
});

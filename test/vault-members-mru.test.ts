import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resetDb, getDb, createSchema } from "../src/db.js";
import { touchVaultMember, __resetVaultMruThrottle } from "../src/vault-mru.js";

describe("P8-B3 — vault_members.last_active_at MRU touch", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-mru-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    resetDb();
    createSchema();
    __resetVaultMruThrottle();

    const db = getDb();
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_alice", "alice", "alice@example.com", "member");
    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path, server_port, discovery_port)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("vault_personal", "user_alice", "personal", "Personal", "/tmp/life", 8190, 8091);
    db.prepare(
      "INSERT OR REPLACE INTO vault_members (user_id, vault_id, role, last_active_at) VALUES (?, ?, ?, NULL)",
    ).run("user_alice", "vault_personal", "owner");
  });

  afterEach(() => {
    __resetVaultMruThrottle();
    resetDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function readLastActive(userId: string, vaultId: string): string | null {
    const row = getDb()
      .prepare(
        "SELECT last_active_at FROM vault_members WHERE user_id = ? AND vault_id = ?",
      )
      .get(userId, vaultId) as { last_active_at: string | null } | undefined;
    return row?.last_active_at ?? null;
  }

  it("first request writes last_active_at", () => {
    expect(readLastActive("user_alice", "vault_personal")).toBeNull();
    const wrote = touchVaultMember("user_alice", "vault_personal", 1_700_000_000_000);
    expect(wrote).toBe(true);
    const after = readLastActive("user_alice", "vault_personal");
    expect(after).not.toBeNull();
    expect(typeof after).toBe("string");
  });

  it("debounces a second request within 60s", () => {
    const t0 = 1_700_000_000_000;
    expect(touchVaultMember("user_alice", "vault_personal", t0)).toBe(true);
    const firstTs = readLastActive("user_alice", "vault_personal");

    // 30s later — should be throttled.
    expect(touchVaultMember("user_alice", "vault_personal", t0 + 30_000)).toBe(false);
    expect(readLastActive("user_alice", "vault_personal")).toBe(firstTs);

    // 59.999s later — still throttled.
    expect(touchVaultMember("user_alice", "vault_personal", t0 + 59_999)).toBe(false);
    expect(readLastActive("user_alice", "vault_personal")).toBe(firstTs);
  });

  it("writes again after the 60s window elapses", () => {
    const t0 = 1_700_000_000_000;
    expect(touchVaultMember("user_alice", "vault_personal", t0)).toBe(true);
    // Exactly 60s boundary: still considered throttled (strict <).
    expect(touchVaultMember("user_alice", "vault_personal", t0 + 60_000)).toBe(true);
    // And after a longer gap too.
    expect(touchVaultMember("user_alice", "vault_personal", t0 + 5 * 60_000)).toBe(true);
  });

  it("is a no-op when no vault_members row exists for the pair", () => {
    const before = getDb()
      .prepare("SELECT COUNT(*) AS c FROM vault_members WHERE user_id = ? AND vault_id = ?")
      .get("user_alice", "vault_missing") as { c: number };
    expect(before.c).toBe(0);

    expect(() =>
      touchVaultMember("user_alice", "vault_missing", 1_700_000_000_000),
    ).not.toThrow();

    const after = getDb()
      .prepare("SELECT COUNT(*) AS c FROM vault_members WHERE user_id = ? AND vault_id = ?")
      .get("user_alice", "vault_missing") as { c: number };
    expect(after.c).toBe(0);
  });

  it("throttles independently per (user, vault)", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_bob", "bob", "bob@example.com", "member");
    db.prepare(
      "INSERT INTO vault_members (user_id, vault_id, role) VALUES (?, ?, ?)",
    ).run("user_bob", "vault_personal", "member");

    const t0 = 1_700_000_000_000;
    expect(touchVaultMember("user_alice", "vault_personal", t0)).toBe(true);
    // Different user, same vault — not throttled by alice's recent touch.
    expect(touchVaultMember("user_bob", "vault_personal", t0 + 1_000)).toBe(true);
    // Alice again within 60s — still throttled.
    expect(touchVaultMember("user_alice", "vault_personal", t0 + 1_000)).toBe(false);
  });
});

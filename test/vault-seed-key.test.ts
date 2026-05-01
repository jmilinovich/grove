/**
 * Unit tests for `mintVaultSeedKey` — the platform-owner-only key-mint
 * helper that powers `POST /v1/admin/vaults/seed-key` and the
 * `grove vault seed-key <slug>` CLI.
 *
 * The companion gate `resolveMintVaultId` (covered by
 * `keys-mint-vault-bypass.test.ts`) intentionally denies cross-vault
 * mints for non-members — see the 2026-04-26 audit. That gate left the
 * platform-owner with no sanctioned path to pre-load content into a
 * freshly-onboarded tenant's vault before the new owner logs in. This
 * helper is the bypass: HTTP-layer authorization (platform-owner gate
 * in proxy.ts) is the only thing standing between callers and the
 * cross-vault mint, so the tests assert the helper:
 *
 *   - finds the vault by slug (404 shape if missing)
 *   - mints a key bound to vault.id (not the actor's default vault)
 *   - persists the api_keys row with the right user_id and vault_id
 *
 * The HTTP-level platform-owner gate is exercised by admin-auth.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { resetDb, getDb, createSchema } from "../src/db.js";
import { mintVaultSeedKey } from "../src/proxy.js";

describe("mintVaultSeedKey — platform-owner seed-key mint", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-seed-key-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    resetDb();
    createSchema();
    const db = getDb();

    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_admin", "admin", "admin@grove.local", "owner");
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_ryan", "ryan", "ryan@example.com", "owner");

    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("vault_admin", "user_admin", "personal", "Life", "/tmp/personal");
    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("vault_ryan", "user_ryan", "ryan", "Ryan's Vault", "/tmp/ryan");

    db.prepare(
      "INSERT INTO vault_members (user_id, vault_id, role) VALUES (?, ?, ?)",
    ).run("user_admin", "vault_admin", "owner");
    db.prepare(
      "INSERT INTO vault_members (user_id, vault_id, role) VALUES (?, ?, ?)",
    ).run("user_ryan", "vault_ryan", "owner");
    // Critical: admin is NOT a member of vault_ryan. The whole point
    // of seed-key is bypassing that gate for platform owners.
  });

  afterEach(() => {
    resetDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns vault_not_found for an unknown slug", () => {
    const r = mintVaultSeedKey({
      slug: "does-not-exist",
      name: "seed",
      actorUserId: "user_admin",
    });
    expect(r.kind).toBe("vault_not_found");
  });

  it("mints a key bound to the requested vault — even when the actor is not a member", () => {
    // Pre-condition: admin has NO vault_members row in vault_ryan.
    const db = getDb();
    const pre = db
      .prepare("SELECT 1 FROM vault_members WHERE user_id = ? AND vault_id = ?")
      .get("user_admin", "vault_ryan");
    expect(pre).toBeUndefined();

    const r = mintVaultSeedKey({
      slug: "ryan",
      name: "ingest-bootstrap",
      actorUserId: "user_admin",
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.vaultId).toBe("vault_ryan");
    expect(r.vaultSlug).toBe("ryan");
    expect(r.name).toBe("ingest-bootstrap");
    // Plaintext token uses Grove's standard key format.
    expect(r.token).toMatch(/^grove_live_[0-9a-f]+$/);
  });

  it("persists the api_keys row with correct user_id, vault_id, and scopes", () => {
    const r = mintVaultSeedKey({
      slug: "ryan",
      name: "ingest-bootstrap",
      actorUserId: "user_admin",
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;

    const db = getDb();
    const row = db
      .prepare("SELECT user_id, vault_id, name, scopes, hashed_token FROM api_keys WHERE id = ?")
      .get(r.keyId) as
      | { user_id: string; vault_id: string; name: string; scopes: string; hashed_token: string }
      | undefined;
    expect(row).toBeDefined();
    if (!row) return;
    // user_id is the actor (the platform owner who triggered the mint),
    // NOT the vault's owner. This matches createKey's contract — the
    // actor is responsible for the key and revokes it after seeding.
    expect(row.user_id).toBe("user_admin");
    expect(row.vault_id).toBe("vault_ryan");
    expect(row.name).toBe("ingest-bootstrap");
    expect(row.scopes).toBe("read,write");
    // Token is hashed at rest, never stored as plaintext.
    expect(row.hashed_token).toBe(createHash("sha256").update(r.token).digest("hex"));
  });

  it("does NOT add the actor to vault_members as a side effect", () => {
    // Regression guard: a tempting "fix" for the underlying problem
    // would be to auto-insert the actor into vault_members so the
    // standard /keys mint works. That would also grant the actor
    // ongoing read/write access to the vault — not what we want for a
    // one-shot bootstrap. The seed-key path must NOT modify
    // vault_members.
    mintVaultSeedKey({
      slug: "ryan",
      name: "seed",
      actorUserId: "user_admin",
    });
    const db = getDb();
    const after = db
      .prepare("SELECT 1 FROM vault_members WHERE user_id = ? AND vault_id = ?")
      .get("user_admin", "vault_ryan");
    expect(after).toBeUndefined();
  });
});

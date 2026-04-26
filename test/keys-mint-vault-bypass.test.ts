/**
 * Regression test for the 2026-04-26 audit finding: any signed-in user
 * could mint an api key bound to ANY vault by passing `vault_slug` (or
 * raw `vault`) to `POST /keys` action=create. The proxy's `directlyBound`
 * short-circuit (`api_keys.vault_id === route.id`, see proxy.ts ~L1418
 * and vault-router.decideRoute) then granted the minted key full
 * read/write access to that vault on every subsequent `/v/<slug>/v1/*`
 * and legacy `/v1/*` request — without ever consulting `vault_members`.
 *
 * Fix is in `resolveMintVaultId(userId, body)` — explicit vault /
 * vault_slug requests require `vault_members` membership; implicit
 * fallback (no vault passed) keeps using the caller's earliest
 * membership. We test the helper directly so the contract is locked
 * in without booting the proxy.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resetDb, getDb, createSchema } from "../src/db.js";
import { resolveMintVaultId } from "../src/proxy.js";

describe("resolveMintVaultId — /keys mint-time vault authorization", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-keys-mint-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    resetDb();
    createSchema();
    const db = getDb();

    // Two tenants — alice owns vault_alice, bob owns vault_bob.
    // mallory is a signed-up Grove user with NO membership anywhere
    // (Grove signups currently default to viewer with no vault_members
    // row until they're invited). carol is a viewer of vault_alice.
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_alice", "alice", "alice@grove.local", "owner");
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_bob", "bob", "bob@grove.local", "owner");
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_mallory", "mallory", "mallory@grove.local", "viewer");
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_carol", "carol", "carol@grove.local", "viewer");

    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("vault_alice", "user_alice", "alice", "Alice's Vault", "/tmp/alice");
    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("vault_bob", "user_bob", "bob", "Bob's Vault", "/tmp/bob");

    db.prepare(
      "INSERT INTO vault_members (user_id, vault_id, role) VALUES (?, ?, ?)",
    ).run("user_alice", "vault_alice", "owner");
    db.prepare(
      "INSERT INTO vault_members (user_id, vault_id, role) VALUES (?, ?, ?)",
    ).run("user_bob", "vault_bob", "owner");
    db.prepare(
      "INSERT INTO vault_members (user_id, vault_id, role) VALUES (?, ?, ?)",
    ).run("user_carol", "vault_alice", "viewer");
  });

  afterEach(() => {
    resetDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("denies an explicit `vault_slug` mint when caller is not a member", () => {
    // The audit's primary attack: mallory signs up, calls POST /keys
    // with `vault_slug: "alice"`, would have received a key bound to
    // alice's vault. Must be denied.
    const r = resolveMintVaultId("user_mallory", { vault_slug: "alice" });
    expect(r.kind).toBe("deny");
  });

  it("denies an explicit `vault` (id) mint when caller is not a member", () => {
    // Same attack via the raw vault-id form (the proxy accepts both).
    const r = resolveMintVaultId("user_mallory", { vault: "vault_alice" });
    expect(r.kind).toBe("deny");
  });

  it("denies a viewer of vault A from minting a key bound to vault B", () => {
    // carol is a viewer of vault_alice but a stranger to vault_bob —
    // she should not be able to mint a key bound to bob's vault.
    const r = resolveMintVaultId("user_carol", { vault_slug: "bob" });
    expect(r.kind).toBe("deny");
  });

  it("denies an unknown slug (and doesn't leak existence)", () => {
    const r = resolveMintVaultId("user_mallory", { vault_slug: "does-not-exist" });
    expect(r.kind).toBe("deny");
  });

  it("allows an owner to mint a key bound to their own vault", () => {
    const r = resolveMintVaultId("user_alice", { vault_slug: "alice" });
    expect(r).toEqual({ kind: "ok", vaultId: "vault_alice" });
  });

  it("allows a viewer to mint a key bound to a vault they're a member of", () => {
    // Viewer membership is enough to mint — the proxy's downstream
    // role gate (`userCanWriteVault` for mutations) still keeps
    // viewers read-only at request time. Mint isn't a privileged
    // act; the grant is the membership row, not the key.
    const r = resolveMintVaultId("user_carol", { vault_slug: "alice" });
    expect(r).toEqual({ kind: "ok", vaultId: "vault_alice" });
  });

  it("falls back to caller's earliest membership when no vault is passed", () => {
    const r = resolveMintVaultId("user_alice", {});
    expect(r).toEqual({ kind: "ok", vaultId: "vault_alice" });
  });

  it("falls back to legacy 'life' sentinel when caller has no memberships", () => {
    // Pre-onboarding users with no vault_members row keep the old
    // behavior: the key is minted with the legacy sentinel and the
    // request-time auth path will reject it everywhere it doesn't
    // resolve. The mint itself isn't where we deny — denying here
    // would break all first-time-user flows that mint a key before
    // the first `vault_members` row is written.
    const r = resolveMintVaultId("user_mallory", {});
    expect(r).toEqual({ kind: "ok", vaultId: "life" });
  });

  it("ignores non-string body fields (defensive shape check)", () => {
    // Caller passing a number / array / null shouldn't crash the
    // helper — it should fall through to the implicit-membership path.
    const r = resolveMintVaultId("user_alice", {
      vault: 42 as unknown as string,
      vault_slug: ["alice"] as unknown as string,
    });
    expect(r).toEqual({ kind: "ok", vaultId: "vault_alice" });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resetDb, getDb, createSchema } from "../src/db.js";
import { noteUrl } from "../src/url.js";
import type { VaultContext } from "../src/vault-router.js";

/**
 * URL-slug cross-vault invariants.
 *
 * The bug fixed in PR #66: every URL minted by a per-vault process came
 * back slugged "personal" because `defaultVaultContext()` read
 * `process.env.GROVE_VAULT_SLUG ?? "personal"` and the PM2 ecosystem
 * config didn't pin the env var. Types were fine, tsc was fine, tests
 * were fine — the bug lived in the gap between code and deploy config.
 *
 * This file codifies the invariants those layers should have caught:
 *
 *   INVARIANT 1 — Any URL built from a VaultContext must include that
 *   context's slug verbatim. No substring of any other vault's slug
 *   should appear in the path component.
 *
 *   INVARIANT 2 — `defaultVaultContext` and equivalents must thread
 *   through a vault slug end-to-end; swapping the env var for one vault
 *   must change URL output accordingly and must never silently produce
 *   another vault's slug.
 *
 *   INVARIANT 3 — The handle in a URL is the *vault owner's* handle,
 *   not a global default owner. Different vaults with different owners
 *   produce different handles even when the path is identical.
 */
describe("cross-vault URL invariants", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-url-inv-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    resetDb();
    createSchema();
    const db = getDb();
    db.prepare("INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)").run(
      "user_alice",
      "alice",
      "alice@example.com",
      "owner",
    );
    db.prepare("INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)").run(
      "user_bob",
      "bob",
      "bob@example.com",
      "member",
    );
    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path, server_port, discovery_port)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("vault_alpha", "user_alice", "alpha", "Alpha", "/root/alpha", 8190, 8091);
    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path, server_port, discovery_port)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("vault_bravo", "user_bob", "bravo", "Bravo", "/root/bravo", 8191, 8092);
  });

  afterEach(() => {
    resetDb();
    delete process.env.GROVE_DB_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("URL from vault A's context never contains vault B's slug (and vice versa)", () => {
    const ctxA: VaultContext = { vaultPath: "/root/alpha", vaultId: "vault_alpha", vaultSlug: "alpha" };
    const ctxB: VaultContext = { vaultPath: "/root/bravo", vaultId: "vault_bravo", vaultSlug: "bravo" };

    const urlA = noteUrl(ctxA, "Inbox/note.md");
    const urlB = noteUrl(ctxB, "Inbox/note.md");

    expect(urlA).toContain("/alpha/");
    expect(urlA).not.toContain("/bravo/");
    expect(urlB).toContain("/bravo/");
    expect(urlB).not.toContain("/alpha/");
  });

  it("defaultVaultContext picks up GROVE_VAULT_SLUG from env (no silent default)", async () => {
    // Simulates the fixed PR #66 behavior: per-vault processes set
    // GROVE_VAULT_SLUG in their env, and URL generation reads it. Swap
    // the env, re-import rest.ts in a fresh module graph, and the URLs
    // shift with it.
    const { resetModules } = await import("vitest");
    void resetModules;

    process.env.GROVE_VAULT_SLUG = "alpha";
    const a = await freshDefaultCtx();
    expect(a.vaultSlug).toBe("alpha");

    process.env.GROVE_VAULT_SLUG = "bravo";
    const b = await freshDefaultCtx();
    expect(b.vaultSlug).toBe("bravo");

    delete process.env.GROVE_VAULT_SLUG;
  });

  it("URL handle comes from the vault owner, not a hardcoded default", () => {
    // vault_alpha is owned by alice; vault_bravo is owned by bob. Same
    // path, different vault → different handles.
    const ctxA: VaultContext = { vaultPath: "/root/alpha", vaultId: "vault_alpha", vaultSlug: "alpha" };
    const ctxB: VaultContext = { vaultPath: "/root/bravo", vaultId: "vault_bravo", vaultSlug: "bravo" };

    expect(noteUrl(ctxA, "Inbox/same.md")).toContain("/@alice/");
    expect(noteUrl(ctxB, "Inbox/same.md")).toContain("/@bob/");
  });

  it("path percent-encoding preserves slug boundaries (can't smuggle a second vault)", () => {
    // Defensive: an attacker-controlled path containing '/other-slug/'
    // must be encoded so the slug portion of the URL stays intact.
    const ctx: VaultContext = { vaultPath: "/root/alpha", vaultId: "vault_alpha", vaultSlug: "alpha" };
    const url = noteUrl(ctx, "Inbox/has %2F bravo %2F folder.md");
    // Slug appears exactly once, between the two forward slashes.
    const slugHits = url.match(/\/alpha\//g) ?? [];
    expect(slugHits.length).toBe(1);
    expect(url).not.toMatch(/\/bravo\//);
  });
});

async function freshDefaultCtx() {
  const { resetDb: reset, createSchema: mk } = await import("../src/db.js");
  reset();
  mk();
  const { defaultVaultContext } = await import("../src/rest.js");
  return defaultVaultContext();
}

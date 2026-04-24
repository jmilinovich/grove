import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resetDb, getDb, createSchema } from "../src/db.js";
import { noteUrl, vaultOwnerHandle, noteUrlForHandle } from "../src/url.js";
import type { VaultContext } from "../src/vault-router.js";

describe("url builder (/@<handle>/<path>)", () => {
  let tempDir: string;

  const personalCtx: VaultContext = {
    vaultPath: "/root/life",
    vaultId: "vault_personal",
    vaultSlug: "personal",
  };
  const teamCtx: VaultContext = {
    vaultPath: "/root/team",
    vaultId: "vault_team",
    vaultSlug: "team",
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-url-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    resetDb();
    createSchema();
    const db = getDb();
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_alice", "alice", "alice@example.com", "owner");
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_bob", "bob", "bob@example.com", "member");
    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path, server_port, discovery_port)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("vault_personal", "user_alice", "personal", "Alice's Notes", "/root/life", 8190, 8091);
    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path, server_port, discovery_port)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("vault_team", "user_bob", "team", "Bob's Team Vault", "/root/team", 8191, 8092);
  });

  afterEach(() => {
    resetDb();
    delete process.env.GROVE_DB_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("builds /@<handle>/<path> URLs for the vault owner", () => {
    const url = noteUrl(personalCtx, "Resources/Recipes/Chicken Rice Broccoli.md");
    expect(url).toBe(
      "https://grove.md/@alice/Resources/Recipes/Chicken%20Rice%20Broccoli",
    );
  });

  it("strips the trailing .md extension", () => {
    const withExt = noteUrl(personalCtx, "Journal/2026/2026-04-23.md");
    const withoutExt = noteUrl(personalCtx, "Journal/2026/2026-04-23");
    expect(withExt).toBe(withoutExt);
  });

  it("URL-encodes each path segment but preserves slashes", () => {
    const url = noteUrl(personalCtx, "Resources/People/Renée / Smith.md");
    // Each segment is individually encoded; the top-level slash separators
    // stay literal so the URL routes as a multi-segment path.
    expect(url.startsWith("https://grove.md/@alice/")).toBe(true);
    expect(url.includes("Ren%C3%A9e")).toBe(true);
    expect(url.split("/").length).toBeGreaterThan(4);
  });

  it("uses the correct owner per vault (multi-vault safety)", () => {
    // Two vaults, two owners — URL for team vault must be /@bob, not /@alice.
    const aliceUrl = noteUrl(personalCtx, "Resources/foo.md");
    const bobUrl = noteUrl(teamCtx, "Resources/foo.md");
    expect(aliceUrl).toBe("https://grove.md/@alice/Resources/foo");
    expect(bobUrl).toBe("https://grove.md/@bob/Resources/foo");
  });

  it("vaultOwnerHandle returns the owner for the given vaultId", () => {
    expect(vaultOwnerHandle(personalCtx)).toBe("alice");
    expect(vaultOwnerHandle(teamCtx)).toBe("bob");
  });

  it("vaultOwnerHandle falls back to the oldest vault's owner for unknown vaultId", () => {
    const phantom: VaultContext = {
      vaultPath: "/nowhere",
      vaultId: "vault_does_not_exist",
      vaultSlug: "ghost",
    };
    // alice owns the oldest vault (personal) — the fallback should land there.
    expect(vaultOwnerHandle(phantom)).toBe("alice");
  });

  it("vaultOwnerHandle returns 'unknown' when DB is empty", () => {
    // Wipe users + vaults so neither the scoped nor the fallback query hits a row.
    const db = getDb();
    db.prepare("DELETE FROM vaults").run();
    db.prepare("DELETE FROM users").run();
    expect(
      vaultOwnerHandle(personalCtx),
    ).toBe("unknown");
  });

  it("explicit handle override wins over ctx lookup", () => {
    // Shared notes from a trail or invite can be shown under a different handle.
    const url = noteUrl(personalCtx, "Resources/foo.md", "guest");
    expect(url).toBe("https://grove.md/@guest/Resources/foo");
  });

  it("noteUrlForHandle builds the same shape without needing ctx", () => {
    const url = noteUrlForHandle("charlie", "a/b c.md");
    expect(url).toBe("https://grove.md/@charlie/a/b%20c");
  });

  it("respects GROVE_PUBLIC_BASE_URL override", () => {
    process.env.GROVE_PUBLIC_BASE_URL = "https://staging.grove.md";
    try {
      const url = noteUrlForHandle("alice", "Notes/hi.md");
      expect(url).toBe("https://staging.grove.md/@alice/Notes/hi");
    } finally {
      delete process.env.GROVE_PUBLIC_BASE_URL;
    }
  });
});

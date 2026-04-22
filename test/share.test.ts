import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, email TEXT UNIQUE, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT);
  CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), slug TEXT NOT NULL, display_name TEXT NOT NULL, git_repo_path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), storage_bytes INTEGER NOT NULL DEFAULT 0, storage_quota_bytes INTEGER NOT NULL DEFAULT 104857600, UNIQUE(owner_id, slug));
  CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), vault_id TEXT NOT NULL, name TEXT NOT NULL, hashed_token TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT 'read,write', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT, expires_at TEXT, session_id TEXT);
  CREATE TABLE IF NOT EXISTS shared_links (id TEXT PRIMARY KEY, note_path TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, max_views INTEGER, view_count INTEGER NOT NULL DEFAULT 0, last_accessed_at TEXT, revoked_by TEXT REFERENCES users(id), revoked_at TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS vault_members (user_id TEXT NOT NULL REFERENCES users(id), vault_id TEXT NOT NULL REFERENCES vaults(id), role TEXT NOT NULL CHECK(role IN ('owner', 'member', 'viewer')), joined_at TEXT NOT NULL DEFAULT (datetime('now')), last_active_at TEXT, PRIMARY KEY (user_id, vault_id));
`;

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-share-test-"));
const TEST_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_DB_PATH = TEST_DB_PATH;

import { getDb, resetDb } from "../src/db.js";
import {
  createShareLink,
  resolveShareLink,
  resolveSharePublic,
  deriveShareStatus,
  getShareLink,
  listShareLinks,
  deleteShareLink,
  revokeShareLink,
  type SharedLink,
} from "../src/share.js";

function seedDb() {
  const db = getDb();
  db.exec(SCHEMA);
  db.exec("DELETE FROM vault_members");
  db.exec("DELETE FROM shared_links");
  db.exec("DELETE FROM api_keys");
  db.exec("DELETE FROM vaults");
  db.exec("DELETE FROM users");

  db.prepare("INSERT INTO users (id, username, email) VALUES (?, ?, ?)").run(
    "user_00000000", "admin", "admin@example.com",
  );
  db.prepare("INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run(
    "vault_00000000", "user_00000000", "life", "Life", "/tmp/life",
  );
}

describe("share-a-note links", () => {
  beforeEach(() => {
    resetDb();
    seedDb();
  });

  afterEach(() => {
    resetDb();
  });

  it("creates a share link with defaults", () => {
    const result = createShareLink("Resources/Concepts/taste-graph.md", "user_00000000", "https://api.grove.md");
    expect(result.id).toMatch(/^sh_/);
    expect(result.url).toContain("/@admin/s/");
    expect(result.url).toContain("grove.md");
    expect(result.expires_at).toBeTruthy();

    // Verify in DB
    const link = getShareLink(result.id);
    expect(link).not.toBeNull();
    expect(link!.note_path).toBe("Resources/Concepts/taste-graph.md");
    expect(link!.max_views).toBe(100);
    expect(link!.view_count).toBe(0);
  });

  it("creates a share link with custom TTL and max_views", () => {
    const result = createShareLink(
      "Journal/2026/2026-04-01.md", "user_00000000", "https://api.grove.md",
      { ttl_days: 1, max_views: 5 },
    );
    const link = getShareLink(result.id);
    expect(link!.max_views).toBe(5);

    // TTL should be ~1 day from now
    const expiresAt = new Date(link!.expires_at).getTime();
    const expectedExpiry = Date.now() + 1 * 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresAt - expectedExpiry)).toBeLessThan(5000);
  });

  it("resolves a valid share link and increments view count", () => {
    const result = createShareLink("Resources/Concepts/test.md", "user_00000000", "https://api.grove.md");

    const resolved = resolveShareLink(result.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.note_path).toBe("Resources/Concepts/test.md");
    expect(resolved!.view_count).toBe(1);

    // Second resolve should show view_count=2
    const resolved2 = resolveShareLink(result.id);
    expect(resolved2!.view_count).toBe(2);
  });

  it("returns null for non-existent share link", () => {
    expect(resolveShareLink("sh_nonexistent")).toBeNull();
  });

  it("returns null for expired share link", () => {
    const db = getDb();
    const id = "sh_expired";
    const pastDate = new Date(Date.now() - 1000).toISOString();
    db.prepare(
      "INSERT INTO shared_links (id, note_path, created_by, expires_at, max_views, view_count, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    ).run(id, "test.md", "user_00000000", pastDate, 100, new Date().toISOString());

    expect(resolveShareLink(id)).toBeNull();
  });

  it("returns null when max_views is exhausted", () => {
    const result = createShareLink("test.md", "user_00000000", "https://api.grove.md", { max_views: 2 });

    // Use up both views
    resolveShareLink(result.id);
    resolveShareLink(result.id);

    // Third should fail
    expect(resolveShareLink(result.id)).toBeNull();
  });

  it("lists share links for a user", () => {
    createShareLink("note1.md", "user_00000000", "https://api.grove.md");
    createShareLink("note2.md", "user_00000000", "https://api.grove.md");

    const links = listShareLinks("user_00000000");
    expect(links).toHaveLength(2);
  });

  it("deletes a share link", () => {
    const result = createShareLink("note.md", "user_00000000", "https://api.grove.md");
    expect(deleteShareLink(result.id)).toBe(true);
    expect(getShareLink(result.id)).toBeNull();
  });

  it("delete returns false for non-existent link", () => {
    expect(deleteShareLink("sh_ghost")).toBe(false);
  });

  it("URL uses grove.md domain with canonical /@<handle>/s/<id> shape", () => {
    const result = createShareLink("test.md", "user_00000000", "https://api.grove.md");
    expect(result.url).toMatch(/^https:\/\/grove\.md\/@admin\/s\/sh_/);
  });

  it("creates a share link with max_views: null (unlimited) and stores NULL", () => {
    const result = createShareLink(
      "unlimited.md", "user_00000000", "https://api.grove.md",
      { max_views: null },
    );
    const link = getShareLink(result.id);
    expect(link).not.toBeNull();
    expect(link!.max_views).toBeNull();
  });

  it("resolves an unlimited share link repeatedly without view-cap", () => {
    const result = createShareLink(
      "unlimited.md", "user_00000000", "https://api.grove.md",
      { max_views: null },
    );
    for (let i = 0; i < 50; i++) {
      const resolved = resolveShareLink(result.id);
      expect(resolved).not.toBeNull();
      expect(resolved!.max_views).toBeNull();
    }
  });

  it("stamps last_accessed_at on each successful resolve", () => {
    const result = createShareLink("accessed.md", "user_00000000", "https://api.grove.md");

    let link = getShareLink(result.id);
    expect(link!.last_accessed_at).toBeNull();

    const resolved1 = resolveShareLink(result.id);
    expect(resolved1!.last_accessed_at).toBeTruthy();
    const firstStamp = resolved1!.last_accessed_at!;

    // Small gap so the second stamp is strictly later than the first.
    const sleepUntil = Date.now() + 10;
    while (Date.now() < sleepUntil) { /* spin */ }

    const resolved2 = resolveShareLink(result.id);
    expect(resolved2!.last_accessed_at).toBeTruthy();
    expect(new Date(resolved2!.last_accessed_at!).getTime()).toBeGreaterThanOrEqual(
      new Date(firstStamp).getTime(),
    );

    link = getShareLink(result.id);
    expect(link!.last_accessed_at).toBe(resolved2!.last_accessed_at);
  });

  it("revokeShareLink stamps audit columns and prevents subsequent resolve", () => {
    const result = createShareLink("revoke-me.md", "user_00000000", "https://api.grove.md");

    const revoker = "user_00000000";
    expect(revokeShareLink(result.id, revoker)).toBe(true);

    const link = getShareLink(result.id);
    expect(link!.revoked_by).toBe(revoker);
    expect(link!.revoked_at).toBeTruthy();

    expect(resolveShareLink(result.id)).toBeNull();
  });

  it("revokeShareLink is idempotent — second call returns false", () => {
    const result = createShareLink("revoke-twice.md", "user_00000000", "https://api.grove.md");
    expect(revokeShareLink(result.id, "user_00000000")).toBe(true);
    expect(revokeShareLink(result.id, "user_00000000")).toBe(false);
  });

  it("revokeShareLink returns false for non-existent id", () => {
    expect(revokeShareLink("sh_missing", "user_00000000")).toBe(false);
  });

  it("listShareLinks filters by note_path", () => {
    createShareLink("a.md", "user_00000000", "https://api.grove.md");
    createShareLink("b.md", "user_00000000", "https://api.grove.md");
    createShareLink("a.md", "user_00000000", "https://api.grove.md");

    const filtered = listShareLinks("user_00000000", { note_path: "a.md" });
    expect(filtered).toHaveLength(2);
    expect(filtered.every((l) => l.note_path === "a.md")).toBe(true);
  });

  it("listShareLinks excludes revoked & expired by default, includes them with include_expired", () => {
    const active = createShareLink("active.md", "user_00000000", "https://api.grove.md");
    const revoked = createShareLink("revoked.md", "user_00000000", "https://api.grove.md");
    revokeShareLink(revoked.id, "user_00000000");

    // Manually insert an already-expired row
    const db = getDb();
    const pastDate = new Date(Date.now() - 1000).toISOString();
    db.prepare(
      "INSERT INTO shared_links (id, note_path, created_by, expires_at, max_views, view_count, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    ).run("sh_expired1", "old.md", "user_00000000", pastDate, 100, new Date().toISOString());

    const activeOnly = listShareLinks("user_00000000");
    expect(activeOnly.map((l) => l.id)).toEqual([active.id]);

    const all = listShareLinks("user_00000000", { include_expired: true });
    const ids = all.map((l) => l.id).sort();
    expect(ids).toEqual([active.id, revoked.id, "sh_expired1"].sort());
  });

  it("listShareLinks excludes view-capped rows by default", () => {
    const capped = createShareLink("capped.md", "user_00000000", "https://api.grove.md", { max_views: 1 });
    resolveShareLink(capped.id);

    const activeOnly = listShareLinks("user_00000000");
    expect(activeOnly.find((l) => l.id === capped.id)).toBeUndefined();

    const all = listShareLinks("user_00000000", { include_expired: true });
    expect(all.find((l) => l.id === capped.id)).toBeDefined();
  });

  // ── deriveShareStatus ────────────────────────────────────────────
  describe("deriveShareStatus", () => {
    function baseRow(overrides: Partial<SharedLink> = {}): SharedLink {
      return {
        id: "sh_x",
        note_path: "n.md",
        created_by: "user_00000000",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        max_views: 100,
        view_count: 0,
        last_accessed_at: null,
        revoked_by: null,
        revoked_at: null,
        ...overrides,
      };
    }

    it("active row → 'active'", () => {
      expect(deriveShareStatus(baseRow())).toBe("active");
    });

    it("revoked_at set → 'revoked' (even if also past TTL)", () => {
      const row = baseRow({
        revoked_at: new Date().toISOString(),
        revoked_by: "user_00000000",
        expires_at: new Date(Date.now() - 1000).toISOString(),
      });
      expect(deriveShareStatus(row)).toBe("revoked");
    });

    it("past TTL → 'expired'", () => {
      const row = baseRow({ expires_at: new Date(Date.now() - 1000).toISOString() });
      expect(deriveShareStatus(row)).toBe("expired");
    });

    it("view_count >= max_views → 'expired'", () => {
      expect(deriveShareStatus(baseRow({ max_views: 5, view_count: 5 }))).toBe("expired");
      expect(deriveShareStatus(baseRow({ max_views: 5, view_count: 10 }))).toBe("expired");
    });

    it("unlimited max_views never view-caps", () => {
      expect(deriveShareStatus(baseRow({ max_views: null, view_count: 1000 }))).toBe("active");
    });
  });

  // ── resolveSharePublic ───────────────────────────────────────────
  describe("resolveSharePublic", () => {
    it("returns not_found for unknown id", () => {
      expect(resolveSharePublic("sh_nope")).toEqual({ status: "not_found" });
    });

    it("returns gone/revoked for revoked links", () => {
      const r = createShareLink("r.md", "user_00000000", "https://api.grove.md");
      revokeShareLink(r.id, "user_00000000");
      const out = resolveSharePublic(r.id);
      expect(out.status).toBe("gone");
      if (out.status === "gone") expect(out.reason).toBe("revoked");
    });

    it("returns gone/expired for past-TTL links", () => {
      const db = getDb();
      const id = "sh_expired_public";
      const past = new Date(Date.now() - 1000).toISOString();
      db.prepare(
        "INSERT INTO shared_links (id, note_path, created_by, expires_at, max_views, view_count, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
      ).run(id, "e.md", "user_00000000", past, 100, new Date().toISOString());

      const out = resolveSharePublic(id);
      expect(out.status).toBe("gone");
      if (out.status === "gone") expect(out.reason).toBe("expired");
    });

    it("returns gone/expired for view-capped links", () => {
      const r = createShareLink("vc.md", "user_00000000", "https://api.grove.md", { max_views: 1 });
      expect(resolveSharePublic(r.id).status).toBe("ok");
      const out = resolveSharePublic(r.id);
      expect(out.status).toBe("gone");
      if (out.status === "gone") expect(out.reason).toBe("expired");
    });

    it("returns ok + bumps view_count + stamps last_accessed_at on success", () => {
      const r = createShareLink("ok.md", "user_00000000", "https://api.grove.md");
      const out = resolveSharePublic(r.id);
      expect(out.status).toBe("ok");
      if (out.status === "ok") {
        expect(out.link.view_count).toBe(1);
        expect(out.link.last_accessed_at).toBeTruthy();
      }
    });
  });
});

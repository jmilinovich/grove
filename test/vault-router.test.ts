import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resetDb, getDb, createSchema } from "../src/db.js";
import {
  loadVaultMap,
  lookupBySlug,
  lookupById,
  parseVaultPath,
  decideRoute,
  vaultMapSize,
  RESERVED_SLUGS,
  SLUG_PATTERN,
  sunsetDate,
} from "../src/vault-router.js";

describe("vault-router (P8-A2)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-router-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    resetDb();
    createSchema();
    const db = getDb();
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_admin", "admin", "admin@grove.local", "owner");
    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path, server_port, discovery_port)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("vault_00000000", "user_admin", "personal", "Personal", "/root/life", 8190, 8091);
    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path, server_port, discovery_port)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("vault_team", "user_admin", "team", "Team", "/root/vaults/team", 8191, 8092);
  });

  afterEach(() => {
    resetDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads slug + id maps from the vaults table", () => {
    const n = loadVaultMap();
    expect(n).toBe(2);
    expect(vaultMapSize()).toBe(2);

    const personal = lookupBySlug("personal");
    expect(personal).not.toBeNull();
    expect(personal!.id).toBe("vault_00000000");
    expect(personal!.server_port).toBe(8190);

    expect(lookupById("vault_team")?.slug).toBe("team");
    expect(lookupBySlug("ghost")).toBeNull();
  });

  it("skips vaults without server_port/discovery_port (not yet provisioned)", () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("vault_half", "user_admin", "half", "Half-Prov", "/root/vaults/half");
    const n = loadVaultMap();
    expect(n).toBe(2); // the two provisioned ones
    expect(lookupBySlug("half")).toBeNull();
  });

  it("reloads on repeated calls (SIGHUP semantics)", () => {
    loadVaultMap();
    expect(vaultMapSize()).toBe(2);

    const db = getDb();
    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path, server_port, discovery_port)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("vault_new", "user_admin", "new", "New", "/root/vaults/new", 8192, 8093);

    expect(lookupBySlug("new")).toBeNull(); // not yet reloaded
    loadVaultMap();
    expect(lookupBySlug("new")).not.toBeNull();
  });

  describe("parseVaultPath", () => {
    it("parses /v/<slug>/<rest>", () => {
      expect(parseVaultPath("/v/team/mcp")).toEqual({
        slug: "team",
        rest: "/mcp",
        isLegacy: false,
      });
      expect(parseVaultPath("/v/team/v1/notes/a.md")).toEqual({
        slug: "team",
        rest: "/v1/notes/a.md",
        isLegacy: false,
      });
      expect(parseVaultPath("/v/personal")).toEqual({
        slug: "personal",
        rest: "/",
        isLegacy: false,
      });
    });

    it("flags /mcp and /v1/* as legacy (no slug)", () => {
      expect(parseVaultPath("/mcp")).toEqual({
        slug: null,
        rest: "/mcp",
        isLegacy: true,
      });
      expect(parseVaultPath("/v1/notes/foo.md")).toEqual({
        slug: null,
        rest: "/v1/notes/foo.md",
        isLegacy: true,
      });
    });

    it("treats infra routes as non-legacy non-vault", () => {
      for (const path of ["/health", "/metrics", "/login", "/callback", "/oauth/token"]) {
        const p = parseVaultPath(path);
        expect(p.slug).toBeNull();
        expect(p.isLegacy).toBe(false);
      }
    });
  });

  describe("decideRoute", () => {
    beforeEach(() => loadVaultMap());

    it("routes when slug matches token's vault_id", () => {
      const parsed = parseVaultPath("/v/team/mcp");
      const d = decideRoute(parsed, "vault_team");
      expect(d.kind).toBe("route");
      expect(d.vault?.server_port).toBe(8191);
    });

    it("denies on slug mismatch (403, not 404)", () => {
      const parsed = parseVaultPath("/v/team/mcp");
      const d = decideRoute(parsed, "vault_00000000"); // token for personal but URL is team
      expect(d.kind).toBe("deny");
      expect(d.reason).toContain("mismatch");
    });

    it("denies unknown slug with the same 403 signal — no 404 leak", () => {
      const parsed = parseVaultPath("/v/ghost/mcp");
      const d = decideRoute(parsed, "vault_00000000");
      expect(d.kind).toBe("deny");
    });

    it("falls through legacy /mcp to the token's vault (with sunset header caller-side)", () => {
      const parsed = parseVaultPath("/mcp");
      const d = decideRoute(parsed, "vault_00000000");
      expect(d.kind).toBe("legacy");
      expect(d.vault?.id).toBe("vault_00000000");
    });

    it("denies legacy when the token references an unknown vault", () => {
      const parsed = parseVaultPath("/v1/notes/x.md");
      const d = decideRoute(parsed, "vault_removed");
      expect(d.kind).toBe("deny");
    });

    it("returns 'route' with no vault for infra paths", () => {
      const parsed = parseVaultPath("/health");
      const d = decideRoute(parsed, null);
      expect(d.kind).toBe("route");
      expect(d.vault).toBeUndefined();
    });

    it("denies vault-scoped paths when there is no token at all", () => {
      const parsed = parseVaultPath("/v/team/mcp");
      const d = decideRoute(parsed, null);
      expect(d.kind).toBe("deny");
    });
  });

  describe("slug validation", () => {
    it("enforces SLUG_PATTERN (P8-A4 lines up with P8-A2 reserved list)", () => {
      expect(SLUG_PATTERN.test("team")).toBe(true);
      expect(SLUG_PATTERN.test("team-one")).toBe(true);
      expect(SLUG_PATTERN.test("t")).toBe(false);           // too short (<2)
      expect(SLUG_PATTERN.test("Team")).toBe(false);         // uppercase
      expect(SLUG_PATTERN.test("1team")).toBe(false);        // leading digit
      expect(SLUG_PATTERN.test("team_one")).toBe(false);     // underscore
    });

    it("includes the PLAN reserved list", () => {
      for (const word of [
        "admin", "api", "mcp", "v", "v1", "oauth",
        "health", "metrics", "login", "dashboard", "profile",
      ]) {
        expect(RESERVED_SLUGS.has(word)).toBe(true);
      }
    });
  });

  it("sunsetDate returns an HTTP-date 90 days out", () => {
    const before = Date.now();
    const d = new Date(sunsetDate());
    const delta = d.getTime() - before;
    // within 90 days ± 1 day tolerance for clock drift
    expect(delta).toBeGreaterThan(89 * 24 * 3600 * 1000);
    expect(delta).toBeLessThan(91 * 24 * 3600 * 1000);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resetDb, getDb, createSchema } from "../src/db.js";
import {
  provisionVault,
  validateSlug,
  nextAvailablePorts,
  ProvisionError,
  type Effects,
} from "../src/vault-provision.js";

const noopEffects: Effects = {
  initRepo: () => {},
  initQmd: () => {},
  writeEcosystem: () => {},
  reloadPm2: () => {},
  waitForHealth: async () => {},
};

describe("vault-provision (P8-A4)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-provision-"));
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
  });

  afterEach(() => {
    resetDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("validateSlug", () => {
    it("accepts good slugs", () => {
      for (const slug of ["team", "team-one", "a1", "ab-cd-ef"]) {
        expect(() => validateSlug(slug)).not.toThrow();
      }
    });

    it("rejects malformed slugs", () => {
      for (const bad of ["Team", "1team", "a", "_team", "team_one", "TEAM", "team ", " team"]) {
        expect(() => validateSlug(bad)).toThrow(ProvisionError);
      }
    });

    it("rejects reserved slugs that still match SLUG_PATTERN", () => {
      // "v" and "v1" fail SLUG_PATTERN first (too short / not in range), so
      // they throw invalid_slug — we only assert /reserved/i on the ones
      // long enough to reach the reserved check.
      for (const reserved of ["admin", "api", "mcp", "oauth", "health", "metrics", "login", "dashboard", "profile"]) {
        expect(() => validateSlug(reserved)).toThrow(/reserved/i);
      }
    });
  });

  describe("nextAvailablePorts", () => {
    it("allocates 8191/8092 when only personal exists", () => {
      const p = nextAvailablePorts();
      expect(p.serverPort).toBe(8191);
      expect(p.discoveryPort).toBe(8092);
    });

    it("skips to the next gap when more vaults exist", () => {
      const db = getDb();
      db.prepare(
        `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path, server_port, discovery_port)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("v_t", "user_admin", "team", "Team", "/root/t", 8191, 8092);
      db.prepare(
        `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path, server_port, discovery_port)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("v_c", "user_admin", "client", "Client", "/root/c", 8193, 8094);

      const p = nextAvailablePorts();
      expect(p.serverPort).toBe(8192);
      expect(p.discoveryPort).toBe(8093);
    });
  });

  describe("provisionVault", () => {
    it("creates vault + user + member + api key and regenerates ecosystem", async () => {
      let ecosystemWritten = "";
      const effects: Effects = {
        ...noopEffects,
        writeEcosystem: (_path, content) => {
          ecosystemWritten = content;
        },
      };
      const r = await provisionVault(
        { slug: "team", ownerEmail: "team@example.com" },
        { skipReload: true, effects },
      );

      expect(r.slug).toBe("team");
      expect(r.serverPort).toBe(8191);
      expect(r.discoveryPort).toBe(8092);
      expect(r.ownerApiToken).toMatch(/^grove_live_[a-f0-9]{64}$/);
      expect(r.connectorUrl).toBe("https://api.grove.md/v/team/mcp");

      const db = getDb();
      const vault = db.prepare("SELECT slug, server_port FROM vaults WHERE id = ?").get(r.vaultId) as
        { slug: string; server_port: number };
      expect(vault.slug).toBe("team");
      expect(vault.server_port).toBe(8191);

      const member = db
        .prepare("SELECT role FROM vault_members WHERE vault_id = ?")
        .get(r.vaultId) as { role: string };
      expect(member.role).toBe("owner");

      const key = db
        .prepare("SELECT vault_id, scopes FROM api_keys WHERE vault_id = ?")
        .get(r.vaultId) as { vault_id: string; scopes: string };
      expect(key.scopes).toContain("write");

      // Ecosystem regen must include the new vault's server + discovery
      expect(ecosystemWritten).toContain(`"name": "grove-server-team"`);
      expect(ecosystemWritten).toContain(`"name": "grove-discovery-team"`);
    });

    it("refuses a slug that already exists (slug_taken)", async () => {
      await provisionVault(
        { slug: "team", ownerEmail: "team@example.com" },
        { skipReload: true, effects: noopEffects },
      );
      await expect(
        provisionVault(
          { slug: "team", ownerEmail: "team2@example.com" },
          { skipReload: true, effects: noopEffects },
        ),
      ).rejects.toThrow(/already exists/i);
    });

    it("refuses invalid slugs without touching the DB", async () => {
      await expect(
        provisionVault(
          { slug: "BAD!", ownerEmail: "a@b.com" },
          { skipReload: true, effects: noopEffects },
        ),
      ).rejects.toThrow(ProvisionError);

      const db = getDb();
      const count = (db.prepare("SELECT COUNT(*) as c FROM vaults").get() as { c: number }).c;
      expect(count).toBe(1); // only personal
    });

    it("reuses an existing user when the email matches", async () => {
      const db = getDb();
      db.prepare(
        "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
      ).run("user_reuse", "reuse", "reuse@example.com", "member");

      const r = await provisionVault(
        { slug: "team", ownerEmail: "reuse@example.com" },
        { skipReload: true, effects: noopEffects },
      );
      expect(r.ownerUserId).toBe("user_reuse");
    });

    it("emits a 60s health poll when skipReload is false (via effects mock)", async () => {
      let reloaded = false;
      let polledPort = 0;
      const effects: Effects = {
        ...noopEffects,
        reloadPm2: () => {
          reloaded = true;
        },
        waitForHealth: async (port) => {
          polledPort = port;
        },
      };
      await provisionVault(
        { slug: "team", ownerEmail: "team@example.com" },
        { effects },
      );
      expect(reloaded).toBe(true);
      expect(polledPort).toBe(8191);
    });
  });
});

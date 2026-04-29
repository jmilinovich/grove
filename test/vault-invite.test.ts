import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Hoisted module mock — silence email sends across the suite. The
// `lastInvite*` accessors let individual tests assert on the URL the email
// would have carried (we can't import the spies from inside the factory).
const lastInvite = {
  vaultUrl: null as string | null,
  connectorUrl: null as string | null,
  magicVerifyUrl: null as string | null,
};

vi.mock("../src/email.js", async (orig) => ({
  ...(await orig<typeof import("../src/email.js")>()),
  sendVaultInviteEmail: async (
    _email: string,
    urlOrVaultUrl: string,
    connectorUrl: string,
    opts: { magicLink?: boolean },
  ) => {
    lastInvite.connectorUrl = connectorUrl;
    if (opts.magicLink) {
      lastInvite.magicVerifyUrl = urlOrVaultUrl;
    } else {
      lastInvite.vaultUrl = urlOrVaultUrl;
    }
  },
  sendMagicLinkEmail: async () => {},
}));

import { resetDb, getDb, createSchema } from "../src/db.js";
import { inviteUserToVault } from "../src/invite.js";

describe("P8-B1/B2 — vault_members backfill + vault invites", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-vinvite-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    resetDb();
    createSchema();
    lastInvite.vaultUrl = null;
    lastInvite.connectorUrl = null;
    lastInvite.magicVerifyUrl = null;
    const db = getDb();
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_admin", "admin", "admin@grove.local", "owner");
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_alice", "alice", "alice@example.com", "member");
    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path, server_port, discovery_port)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("vault_00000000", "user_admin", "personal", "Personal", "/root/life", 8190, 8091);
    db.prepare(
      `INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path, server_port, discovery_port)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("vault_team", "user_admin", "team", "Team", "/root/vaults/team", 8191, 8092);
    // Re-trigger createSchema so the P8-B1 backfill picks up the seeded users
    // (the initial createSchema ran against an empty users table and no-op'd).
    createSchema();
  });

  afterEach(() => {
    resetDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("vault_members backfill (P8-B1)", () => {
    it("backfills one row per existing user into the default vault", () => {
      const db = getDb();
      const rows = db
        .prepare("SELECT user_id, vault_id, role FROM vault_members ORDER BY user_id")
        .all() as Array<{ user_id: string; vault_id: string; role: string }>;

      // We expect 2 rows — one per pre-existing user — all against the personal vault.
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const r of rows) {
        expect(r.vault_id).toBe("vault_00000000");
      }
      const admin = rows.find((r) => r.user_id === "user_admin");
      const alice = rows.find((r) => r.user_id === "user_alice");
      expect(admin?.role).toBe("owner");
      expect(alice?.role).toBe("member");
    });

    it("is idempotent — rerunning createSchema doesn't duplicate rows", () => {
      const db = getDb();
      const before = (db.prepare("SELECT COUNT(*) as c FROM vault_members").get() as { c: number }).c;
      createSchema();
      const after = (db.prepare("SELECT COUNT(*) as c FROM vault_members").get() as { c: number }).c;
      expect(after).toBe(before);
    });
  });

  describe("inviteUserToVault (P8-B2)", () => {

    it("adds existing user to new vault with a fresh vault_members row + scoped key", async () => {
      const result = await inviteUserToVault(
        "alice@example.com",
        "team",
        "member",
        "https://api.grove.md",
      );
      expect(result.created).toBe(false);
      expect(result.newMembership).toBe(true);
      expect(result.role).toBe("member");
      expect(result.vault_slug).toBe("team");

      const db = getDb();
      const member = db
        .prepare("SELECT role FROM vault_members WHERE user_id = ? AND vault_id = ?")
        .get("user_alice", "vault_team") as { role: string } | undefined;
      expect(member?.role).toBe("member");

      const key = db
        .prepare("SELECT vault_id, scopes FROM api_keys WHERE id = ?")
        .get(result.key_id) as { vault_id: string; scopes: string };
      expect(key.vault_id).toBe("vault_team");
      expect(key.scopes).toContain("read");
    });

    it("creates a new user for an unknown email", async () => {
      const result = await inviteUserToVault(
        "new-person@example.com",
        "team",
        "viewer",
        "https://api.grove.md",
      );
      expect(result.created).toBe(true);
      expect(result.newMembership).toBe(true);
      expect(result.role).toBe("viewer");

      const db = getDb();
      const user = db
        .prepare("SELECT id FROM users WHERE email = ?")
        .get("new-person@example.com") as { id: string };
      expect(user.id).toBe(result.user_id);

      // viewer role → read-only scope
      const key = db
        .prepare("SELECT scopes FROM api_keys WHERE id = ?")
        .get(result.key_id) as { scopes: string };
      expect(key.scopes).toBe("read");
    });

    it("is idempotent — second invite returns the existing membership + key", async () => {
      const first = await inviteUserToVault(
        "alice@example.com",
        "team",
        "member",
        "https://api.grove.md",
      );
      const second = await inviteUserToVault(
        "alice@example.com",
        "team",
        "member",
        "https://api.grove.md",
      );
      expect(second.newMembership).toBe(false);
      expect(second.key_id).toBe(first.key_id);
    });

    it("rejects unknown vault slug", async () => {
      await expect(
        inviteUserToVault(
          "alice@example.com",
          "does-not-exist",
          "member",
          "https://api.grove.md",
        ),
      ).rejects.toThrow(/vault not found/);
    });

    it("rejects invalid role", async () => {
      await expect(
        inviteUserToVault(
          "alice@example.com",
          "team",
          "superadmin" as never,
          "https://api.grove.md",
        ),
      ).rejects.toThrow(/invalid role/);
    });

    it("invite URL addresses the vault by its OWNER's handle, not the invitee's", async () => {
      // Pre-existing user → vaultUrl wraps the dashboard through
      // /api/auth/callback (PR #101); the dashboard URL embedded in the
      // redirect query param must use the OWNER's handle. The owner of
      // `team` is `user_admin` (handle `admin`); inviting
      // `alice@example.com` must NOT produce `/@alice/team/...` anywhere
      // in the resulting URL chain.
      await inviteUserToVault(
        "alice@example.com",
        "team",
        "member",
        "https://api.grove.md",
      );
      // Owner handle present, invitee handle absent. URL is double-
      // encoded through the verify→callback→dashboard redirect chain,
      // so decode twice before substring-matching.
      const fullyDecoded = decodeURIComponent(decodeURIComponent(lastInvite.vaultUrl));
      expect(fullyDecoded).toContain("/@admin/team/");
      expect(fullyDecoded).not.toContain("/@alice/");
      expect(lastInvite.connectorUrl).toBe("https://api.grove.md/v/team/mcp");
    });

    it("magic-link redirect for new users also uses the OWNER's handle", async () => {
      await inviteUserToVault(
        "newcomer@example.com",
        "team",
        "viewer",
        "https://api.grove.md",
      );
      // The verify URL embeds the redirect via `redirect=` query param —
      // assert the vault-owner handle appears there (possibly wrapped
      // through /api/auth/callback), not the invitee's (`newcomer`).
      expect(lastInvite.magicVerifyUrl).toBeTruthy();
      const verify = new URL(lastInvite.magicVerifyUrl!);
      const redirect = verify.searchParams.get("redirect");
      expect(redirect).toBeTruthy();
      // Owner handle must appear somewhere in the redirect chain.
      const decoded = decodeURIComponent(redirect!);
      expect(decoded).toContain("/@admin/team/");
      expect(decoded).not.toContain("/@newcomer/");
    });

    it("fails closed when the vault's owner user row is missing", async () => {
      const db = getDb();
      // Simulate an orphaned vault: temporarily drop FK enforcement, delete
      // the owner's user row, leaving a dangling owner_id. The previous
      // shape would have happily emitted `/@<invitee>/team/...` here; the
      // URL builder must refuse rather than substitute a wrong handle.
      db.exec("PRAGMA foreign_keys = OFF");
      try {
        db.prepare("DELETE FROM api_keys WHERE user_id = ?").run("user_admin");
        db.prepare("DELETE FROM vault_members WHERE user_id = ?").run("user_admin");
        db.prepare("DELETE FROM users WHERE id = ?").run("user_admin");
      } finally {
        db.exec("PRAGMA foreign_keys = ON");
      }
      await expect(
        inviteUserToVault(
          "alice@example.com",
          "team",
          "member",
          "https://api.grove.md",
        ),
      ).rejects.toThrow(/no owner/);
    });
  });
});

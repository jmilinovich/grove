import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-invite-suite-"));
const TEST_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_DB_PATH = TEST_DB_PATH;

// Import after setting env var
import { getDb, resetDb, createSchema } from "../src/db.js";
import { inviteUser, inviteUserToVault } from "../src/invite.js";
import { stopCleanup } from "../src/auth.js";

function seedDb() {
  createSchema();
  const db = getDb();

  // Clear tables
  db.pragma("foreign_keys = OFF");
  db.exec("DELETE FROM vault_members");
  db.exec("DELETE FROM trail_grants");
  db.exec("DELETE FROM trails");
  db.exec("DELETE FROM magic_links");
  db.exec("DELETE FROM api_keys");
  db.exec("DELETE FROM vaults");
  db.exec("DELETE FROM users");
  db.pragma("foreign_keys = ON");

  // Seed admin user and vault
  db.prepare("INSERT INTO users (id, username, email) VALUES (?, ?, ?)").run(
    "user_00000000", "admin", "admin@example.com"
  );
  db.prepare("INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run(
    "vault_00000000", "user_00000000", "life", "Life", "/tmp/life"
  );

  // Seed a trail
  db.prepare(
    "INSERT INTO trails (id, vault_id, name, description, enabled, config_json) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("trail_abc123", "life", "Design System", "Curated design notes", 1, JSON.stringify({
    allow_tags: ["design"], deny_tags: [], allow_types: [], deny_types: [],
    allow_paths: [], deny_paths: [], rate_limit_reads: 60, rate_limit_writes: 0,
  }));
}

describe("invite", () => {
  beforeEach(() => {
    resetDb();
    seedDb();
  });

  afterEach(() => {
    stopCleanup();
    vi.restoreAllMocks();
  });

  it("creates a new user, trail grant, and magic link", async () => {
    const result = await inviteUser("alice@example.com", "trail_abc123", "viewer", "https://api.grove.md");

    expect(result.email).toBe("alice@example.com");
    expect(result.trail_id).toBe("trail_abc123");
    expect(result.created).toBe(true);
    expect(result.user_id).toMatch(/^user_/);
    expect(result.key_id).toMatch(/^key_/);

    // Verify user was created
    const db = getDb();
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get("alice@example.com") as any;
    expect(user).toBeDefined();
    expect(user.id).toBe(result.user_id);

    // Verify API key was created for the user
    const key = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(result.key_id) as any;
    expect(key).toBeDefined();
    expect(key.user_id).toBe(result.user_id);
    expect(key.scopes).toBe("read");

    // Verify trail grant was created
    const grant = db.prepare(
      "SELECT * FROM trail_grants WHERE trail_id = ? AND grantee_id = ?"
    ).get("trail_abc123", result.key_id) as any;
    expect(grant).toBeDefined();
    expect(grant.grantee_type).toBe("token");

    // Verify magic link was created
    const ml = db.prepare("SELECT * FROM magic_links WHERE email = ?").get("alice@example.com") as any;
    expect(ml).toBeDefined();
    expect(ml.used_at).toBeNull();
  });

  it("is idempotent — re-inviting same email for same trail does not duplicate", async () => {
    const first = await inviteUser("bob@example.com", "trail_abc123", "viewer", "https://api.grove.md");
    const second = await inviteUser("bob@example.com", "trail_abc123", "viewer", "https://api.grove.md");

    expect(second.user_id).toBe(first.user_id);
    expect(second.key_id).toBe(first.key_id);
    expect(second.created).toBe(false);

    // Only one user, one key, one grant
    const db = getDb();
    const users = db.prepare("SELECT * FROM users WHERE email = ?").all("bob@example.com");
    expect(users).toHaveLength(1);

    const grants = db.prepare(
      "SELECT * FROM trail_grants WHERE trail_id = ? AND grantee_type = 'token' AND grantee_id IN (SELECT id FROM api_keys WHERE user_id = ?)"
    ).all("trail_abc123", first.user_id);
    expect(grants).toHaveLength(1);
  });

  it("returns 404 for invalid trail ID", async () => {
    await expect(
      inviteUser("carol@example.com", "trail_nonexistent", "viewer", "https://api.grove.md")
    ).rejects.toThrow("Trail not found: trail_nonexistent");
  });

  it("normalizes email to lowercase", async () => {
    const result = await inviteUser("Alice@Example.COM", "trail_abc123", "viewer", "https://api.grove.md");
    expect(result.email).toBe("alice@example.com");

    const db = getDb();
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get("alice@example.com") as any;
    expect(user).toBeDefined();
  });

  it("derives a valid username from email", async () => {
    await inviteUser("jane.doe@example.com", "trail_abc123", "viewer", "https://api.grove.md");

    const db = getDb();
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get("jane.doe@example.com") as any;
    expect(user).toBeDefined();
    // Username should be derived from local part, cleaned up
    expect(user.username).toMatch(/^[a-z0-9][a-z0-9-]{2,30}$/);
  });

  it("vault invite as 'owner' sets users.role to 'owner' so the new user passes the global owner check on /keys", async () => {
    // Regression: invitees were created with the default users.role='viewer'
    // even when their vault membership was 'owner'. The dashboard's
    // /access/keys page calls /keys (no vault context), which falls
    // through to admin-auth.ts's `getUserRole(userId) !== 'owner'` check
    // and 403'd, producing a redirect("/") that looked like the magic
    // link was broken.
    const db = getDb();
    db.prepare(
      "INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
    ).run("vault_friend", "user_00000000", "friend", "Friend", "/tmp/friend");

    await inviteUserToVault("friend@example.com", "friend", "owner", "https://api.grove.md");

    const user = db
      .prepare("SELECT role FROM users WHERE email = ?")
      .get("friend@example.com") as { role: string } | undefined;
    expect(user?.role).toBe("owner");
  });

  it("vault invite as 'member' leaves users.role at the default 'viewer'", async () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
    ).run("vault_team", "user_00000000", "team", "Team", "/tmp/team");

    await inviteUserToVault("member@example.com", "team", "member", "https://api.grove.md");

    const user = db
      .prepare("SELECT role FROM users WHERE email = ?")
      .get("member@example.com") as { role: string } | undefined;
    expect(user?.role).toBe("viewer");
  });

  it("promoting an existing viewer to vault owner upgrades users.role", async () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
    ).run("vault_promo", "user_00000000", "promo", "Promo", "/tmp/promo");
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_existing", "existing", "existing@example.com", "viewer");

    await inviteUserToVault("existing@example.com", "promo", "owner", "https://api.grove.md");

    const user = db
      .prepare("SELECT role FROM users WHERE id = ?")
      .get("user_existing") as { role: string };
    expect(user.role).toBe("owner");
  });

  it("embeds the owning resident handle in the magic-link redirect (P16-4)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await inviteUser("dana@example.com", "trail_abc123", "viewer", "https://api.grove.md");

    // Dev-mode email logs the verify URL. Decode the embedded redirect
    // and confirm it carries resident=admin + the existing trail param.
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const verifyMatch = logged.match(/https:\/\/[^\s]+/);
    expect(verifyMatch).not.toBeNull();
    const verifyUrl = new URL(verifyMatch![0]);
    const redirectParam = verifyUrl.searchParams.get("redirect");
    expect(redirectParam).not.toBeNull();
    const redirectUrl = new URL(redirectParam!);
    expect(redirectUrl.pathname).toBe("/api/auth/callback");
    expect(redirectUrl.searchParams.get("trail")).toBe("trail_abc123");
    expect(redirectUrl.searchParams.get("resident")).toBe("admin");
  });
});

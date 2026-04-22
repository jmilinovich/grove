/**
 * Profile handle change flow (P16-5).
 *
 * Covers the behavior the `PATCH /v1/me` handler depends on:
 *   - `changeUserHandle` returns the old handle on a real change (so the
 *     caller can emit an audit event) and `null` on a no-op.
 *   - `handle_history` picks up the old handle atomically — no row is
 *     written when validation rejects the input.
 *   - Reserved + collision cases are rejected and don't mutate state.
 *   - `auditUserAction` emits a structured `audit.user` entry matching the
 *     spec shape `{ action: "handle_change", user_id, old_handle, new_handle }`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-profile-handle-"));
const TEST_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_DB_PATH = TEST_DB_PATH;

import { getDb, resetDb, createSchema } from "../src/db.js";
import { createUser, changeUserHandle } from "../src/users.js";
import { auditUserAction } from "../src/logger.js";

function seed() {
  resetDb();
  createSchema();
  const db = getDb();
  db.exec(
    "DELETE FROM vault_members; DELETE FROM handle_history; DELETE FROM vault_members; DELETE FROM api_keys; DELETE FROM sessions; DELETE FROM trail_grants; DELETE FROM trails; DELETE FROM vaults; DELETE FROM users;",
  );
  db.prepare("INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)").run(
    "user_00000000", "admin-owner", "admin@grove.local", "owner",
  );
  db.prepare("INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run(
    "vault_00000000", "user_00000000", "life", "Life", "/tmp/life",
  );
}

describe("changeUserHandle return value (P16-5)", () => {
  beforeEach(seed);
  afterEach(() => resetDb());

  it("returns the previous handle when a change is applied", () => {
    const u = createUser("alice@example.com", "alice");
    const old = changeUserHandle(u.id, "alice2");
    expect(old).toBe("alice");
  });

  it("returns null for a no-op (new handle equals current)", () => {
    const u = createUser("alice@example.com", "alice");
    const old = changeUserHandle(u.id, "alice");
    expect(old).toBeNull();
  });
});

describe("handle_history integrity on rejected changes (P16-5)", () => {
  beforeEach(seed);
  afterEach(() => resetDb());

  it("writes nothing to handle_history when the new handle is reserved", () => {
    const u = createUser("alice@example.com", "alice");
    expect(() => changeUserHandle(u.id, "admin")).toThrow(/reserved/);

    const db = getDb();
    const rows = db.prepare("SELECT handle FROM handle_history WHERE user_id = ?").all(u.id);
    expect(rows).toEqual([]);
    const row = db.prepare("SELECT username FROM users WHERE id = ?").get(u.id) as { username: string };
    expect(row.username).toBe("alice");
  });

  it("writes nothing to handle_history when the new handle collides with another user", () => {
    const alice = createUser("alice@example.com", "alice");
    createUser("bob@example.com", "bob");
    expect(() => changeUserHandle(alice.id, "bob")).toThrow(/taken/);

    const db = getDb();
    const rows = db.prepare("SELECT handle FROM handle_history WHERE user_id = ?").all(alice.id);
    expect(rows).toEqual([]);
  });

  it("writes nothing to handle_history when the new handle is shape-invalid", () => {
    const u = createUser("alice@example.com", "alice");
    expect(() => changeUserHandle(u.id, "NOT-lower")).toThrow();

    const db = getDb();
    const rows = db.prepare("SELECT handle FROM handle_history WHERE user_id = ?").all(u.id);
    expect(rows).toEqual([]);
  });
});

describe("auditUserAction (P16-5)", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    seed();
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    resetDb();
  });

  it("emits a structured audit.user entry for a handle change", () => {
    auditUserAction("rid_abc", "user_00000000", "handle_change", {
      old_handle: "alice",
      new_handle: "alice2",
    });

    expect(writeSpy).toHaveBeenCalledOnce();
    const line = writeSpy.mock.calls[0]![0] as string;
    const entry = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("audit.user");
    expect(entry.rid).toBe("rid_abc");
    expect(entry.user_id).toBe("user_00000000");
    expect(entry.action).toBe("handle_change");
    expect(entry.old_handle).toBe("alice");
    expect(entry.new_handle).toBe("alice2");
    expect(typeof entry.ts).toBe("string");
  });
});

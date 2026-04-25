/**
 * Shared test seeds.
 *
 * Many tests need the canonical "admin owns the life vault" pair as a
 * starting point. Centralizing the seed here means schema changes (new
 * required columns on `users` or `vaults`) only need to be reflected in
 * one place.
 *
 * Callers should have already called `createSchema()` before invoking.
 */

import { getDb } from "../../src/db.js";

export const ADMIN_USER_ID = "user_00000000";
export const ADMIN_VAULT_ID = "vault_00000000";

export interface AdminVaultSeed {
  userId: string;
  vaultId: string;
  email?: string;
  username?: string;
  role?: string;
  vaultSlug?: string;
  vaultDisplay?: string;
  vaultPath?: string;
}

const DEFAULTS: Required<AdminVaultSeed> = {
  userId: ADMIN_USER_ID,
  vaultId: ADMIN_VAULT_ID,
  email: "admin@example.com",
  username: "admin",
  role: "owner",
  vaultSlug: "life",
  vaultDisplay: "Life",
  vaultPath: "/tmp/life",
};

/**
 * Seed the admin user + life vault. Idempotent — uses INSERT OR IGNORE
 * so callers can call it after a partial truncate without exploding.
 *
 * Returns the resolved seed values so callers can reference them
 * by name instead of hard-coding ids.
 */
export function seedAdminVault(opts: AdminVaultSeed = {} as AdminVaultSeed): Required<AdminVaultSeed> {
  const seed = { ...DEFAULTS, ...opts };
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email, role) VALUES (?, ?, ?, ?)"
  ).run(seed.userId, seed.username, seed.email, seed.role);
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)"
  ).run(seed.vaultId, seed.userId, seed.vaultSlug, seed.vaultDisplay, seed.vaultPath);
  return seed;
}

/**
 * User management for Grove.
 */

import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";

export type UserRole = "owner" | "member" | "viewer";

export interface User {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  display_name: string | null;
  bio: string | null;
  created_at: string;
  last_login_at: string | null;
}

/** Update a user's display name. Returns true if the row was updated. */
export function updateUserDisplayName(userId: string, displayName: string): boolean {
  const db = getDb();
  const result = db
    .prepare("UPDATE users SET display_name = ? WHERE id = ?")
    .run(displayName.trim() || null, userId);
  return result.changes > 0;
}

/** List active sessions for a user (for profile page). */
export interface SessionRow {
  id: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  user_agent: string | null;
}
export function listUserSessions(userId: string): SessionRow[] {
  const db = getDb();
  // expires_at is stored as ISO-8601 (…T…Z) but datetime('now') returns a
  // space-separated form. Normalize both sides through datetime() so the
  // comparison is date-aware, not a lexical string compare.
  return db
    .prepare(
      `SELECT id, created_at, last_used_at, expires_at, user_agent
         FROM sessions
        WHERE user_id = ? AND datetime(expires_at) > datetime('now')
        ORDER BY last_used_at DESC NULLS LAST, created_at DESC`,
    )
    .all(userId) as SessionRow[];
}

/** Revoke a single session by id (user-scoped — can only revoke own). */
export function revokeUserSession(userId: string, sessionId: string): boolean {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?")
    .run(sessionId, userId);
  return result.changes > 0;
}

/** Revoke all sessions for a user except the current one. */
export function revokeAllOtherSessions(userId: string, keepSessionId: string): number {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?")
    .run(userId, keepSessionId);
  return result.changes;
}

// ── Handles (P16-1) ───────────────────────────────────────────────

/**
 * Reserved handles — rejected for new and changed handles. Superset of
 * RESERVED_USERNAMES; covers top-level routes that the resident URL space
 * must not shadow (`/@admin`, `/@api`, …) and paths grove-www serves
 * outside a resident context.
 */
export const RESERVED_HANDLES = new Set([
  "admin", "api", "v1", "login", "logout", "signup", "dashboard", "profile",
  "keys", "images", "home", "trails", "s", "u", "me", "settings", "help",
  "about", "docs", "support", "privacy", "terms", "well-known", "auth",
]);

/**
 * Handle syntax: 1–30 chars, lowercase `[a-z0-9_-]` only, must start with
 * `[a-z0-9]`. No leading hyphen/underscore to avoid URL-routing footguns.
 */
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,29}$/;

export interface HandleValidation {
  valid: boolean;
  reason?: string;
}

/**
 * Validate a candidate handle against shape, reserved list, and uniqueness
 * (users.username + handle_history.handle). Pass `excludeUserId` to ignore
 * the caller's current handle when checking for availability (so a user
 * submitting their own current handle isn't rejected as "taken").
 */
export function isValidHandle(
  handle: string,
  opts: { excludeUserId?: string } = {},
): HandleValidation {
  if (typeof handle !== "string" || handle.length === 0) {
    return { valid: false, reason: "handle is required" };
  }
  if (handle.length > 30) {
    return { valid: false, reason: "handle must be 30 chars or fewer" };
  }
  if (!HANDLE_RE.test(handle)) {
    return {
      valid: false,
      reason: "handle must be lowercase [a-z0-9_-], starting with a letter or digit",
    };
  }
  if (RESERVED_HANDLES.has(handle)) {
    return { valid: false, reason: "handle is reserved" };
  }

  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM users WHERE username = ?")
    .get(handle) as { id: string } | undefined;
  if (existing && existing.id !== opts.excludeUserId) {
    return { valid: false, reason: "handle is taken" };
  }

  const historical = db
    .prepare("SELECT user_id FROM handle_history WHERE handle = ?")
    .get(handle) as { user_id: string } | undefined;
  if (historical && historical.user_id !== opts.excludeUserId) {
    return { valid: false, reason: "handle was previously used and cannot be reclaimed" };
  }

  return { valid: true };
}

/** Update a user's bio (nullable, max 280 chars). Returns true if updated. */
export function updateUserBio(userId: string, bio: string | null): boolean {
  if (bio !== null && bio.length > 280) {
    throw new Error("bio too long (max 280 chars)");
  }
  const db = getDb();
  const value = bio === null ? null : bio.trim() || null;
  const result = db.prepare("UPDATE users SET bio = ? WHERE id = ?").run(value, userId);
  return result.changes > 0;
}

/**
 * Change a user's handle. Validates the new value, moves the old handle
 * into `handle_history` (so it can't be reclaimed), and atomically updates
 * `users.username`. Throws with a descriptive message on validation failure.
 *
 * Returns the old handle when the change was applied, or `null` when the
 * new value matched the current handle (no-op). Callers use the return
 * value to emit an audit entry without a second lookup.
 */
export function changeUserHandle(userId: string, newHandle: string): string | null {
  const db = getDb();
  const user = db
    .prepare("SELECT id, username FROM users WHERE id = ?")
    .get(userId) as { id: string; username: string | null } | undefined;
  if (!user) throw new Error("user not found");

  if (user.username === newHandle) return null;

  const validation = isValidHandle(newHandle, { excludeUserId: userId });
  if (!validation.valid) throw new Error(validation.reason ?? "invalid handle");

  const oldHandle = user.username;
  const tx = db.transaction(() => {
    if (oldHandle) {
      db.prepare(
        "INSERT OR REPLACE INTO handle_history (handle, user_id, released_at) VALUES (?, ?, datetime('now'))",
      ).run(oldHandle, userId);
    }
    db.prepare("UPDATE users SET username = ? WHERE id = ?").run(newHandle, userId);
  });
  tx();
  return oldHandle;
}

/**
 * Derive a handle from an email local-part for backfill / invite flows.
 * Lowercases, strips disallowed chars, ensures an alphanumeric first char,
 * clamps to 30 chars, and appends a 3-digit numeric suffix on collision.
 * Never returns a reserved handle.
 */
export function deriveHandleFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "user";
  let candidate = local
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[-_]+/, "");
  if (candidate.length === 0 || !/^[a-z0-9]/.test(candidate)) candidate = `user${candidate}`;
  candidate = candidate.slice(0, 30);

  if (isValidHandle(candidate).valid) return candidate;

  // Collision or reserved — append a numeric suffix. Up to 1000 tries, then fall back.
  const base = candidate.slice(0, 26); // leave room for "-NNN"
  for (let i = 0; i < 1000; i++) {
    const suffix = String(i).padStart(3, "0");
    const withSuffix = `${base}-${suffix}`;
    if (isValidHandle(withSuffix).valid) return withSuffix;
  }
  throw new Error(`could not derive a unique handle from ${email}`);
}

export function createUser(email: string, username: string, role: UserRole = "viewer"): User {
  const validation = isValidHandle(username);
  if (!validation.valid) throw new Error(validation.reason);

  const id = "user_" + randomBytes(4).toString("hex");
  const db = getDb();
  db.prepare(
    "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)"
  ).run(id, username, email, role);

  return { id, username, email, role, display_name: null, bio: null, created_at: new Date().toISOString(), last_login_at: null };
}

export function getUserById(id: string): User | null {
  const db = getDb();
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | null;
}

export function getUserByUsername(username: string): User | null {
  const db = getDb();
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as User | null;
}

export function getUserByEmail(email: string): User | null {
  const db = getDb();
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email) as User | null;
}

export function getUserRole(userId: string): UserRole | null {
  const db = getDb();
  const row = db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: UserRole } | undefined;
  return row?.role ?? null;
}

/**
 * Delete a user and all associated data (keys, sessions, trail grants).
 * Cannot delete the owner user.
 */
export function deleteUser(userId: string): boolean {
  const db = getDb();

  const user = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId) as { id: string; role: string } | undefined;
  if (!user) return false;
  if (user.role === "owner") throw new Error("Cannot delete the owner user");

  // Must wrap in a transaction so partial state doesn't survive a FK
  // failure — before P8, vault_members didn't exist and each DELETE
  // could stand alone; now any missing cleanup on the vault_members
  // side throws on `DELETE FROM users` with `FOREIGN KEY constraint
  // failed`, leaving the user with no keys/sessions but still visible
  // in the users table. Observed in prod after P8-B1 landed.
  const tx = db.transaction((id: string) => {
    // Trail grants tied to this user's keys
    db.prepare(
      "DELETE FROM trail_grants WHERE grantee_type = 'token' AND grantee_id IN (SELECT id FROM api_keys WHERE user_id = ?)",
    ).run(id);
    // Vault memberships — FK(vault_members.user_id → users.id) has no
    // ON DELETE CASCADE, so we clean explicitly. This also revokes
    // vault access as part of the same txn.
    db.prepare("DELETE FROM vault_members WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM api_keys WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  });
  tx(userId);

  return true;
}

export interface UserWithMeta {
  id: string;
  username: string | null;
  email: string | null;
  role: string;
  created_at: string;
  last_login_at: string | null;
  key_count: number;
  trails: string[];
}

/**
 * List all users with their key counts and trail names.
 */
export function listUsersWithMeta(): UserWithMeta[] {
  const db = getDb();
  const users = db.prepare(
    "SELECT id, username, email, role, created_at, last_login_at FROM users"
  ).all() as { id: string; username: string | null; email: string | null; role: string; created_at: string; last_login_at: string | null }[];

  return users.map((u) => {
    const keyCount = db.prepare(
      "SELECT COUNT(*) as count FROM api_keys WHERE user_id = ?"
    ).get(u.id) as { count: number };

    const trails = db.prepare(
      `SELECT DISTINCT t.name FROM trails t
       JOIN trail_grants tg ON t.id = tg.trail_id
       JOIN api_keys ak ON tg.grantee_id = ak.id AND tg.grantee_type = 'token'
       WHERE ak.user_id = ?`
    ).all(u.id) as { name: string }[];

    return {
      ...u,
      key_count: keyCount.count,
      trails: trails.map((t) => t.name),
    };
  });
}

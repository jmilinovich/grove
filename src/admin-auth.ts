/**
 * Admin authorization helper for the proxy.
 *
 * Lives in its own module so unit tests can import it without pulling in
 * proxy.ts's HTTP server side-effects (the import would call
 * `server.listen()` immediately).
 *
 * Two flavors of authorization, distinguished by whether `vaultId` is
 * supplied:
 *
 *   - **vaultId given (vault-scoped admin):** caller must be `owner` in
 *     `vault_members` for that vault. Global `users.role='owner'` alone
 *     is NOT sufficient — that would let one tenant's Grove-wide admin
 *     administer another tenant's vault. This is the audit's
 *     "common-thread" consolidation: every `/v/<slug>/v1/admin/*` and
 *     every legacy `/v1/admin/*` (which threads the token's vault id)
 *     gets the per-vault check.
 *
 *   - **vaultId omitted (Grove-wide admin):** legacy global owner
 *     check, used only by `/admin/login`, `/keys`, `/metrics`, and the
 *     setup page at `/`. These surfaces aren't per-vault.
 *
 * Authentication itself is unchanged: session cookie first, Bearer
 * fallback. The result shape is stable so callers don't have to
 * change.
 */

import type { IncomingMessage } from "node:http";
import { validateSession, getSessionFromCookie } from "./auth.js";
import { hashToken, isExpired, type StoredKey } from "./keys.js";
import { getUserRole } from "./users.js";
import { getDb } from "./db.js";
import { userRoleInVault } from "./vault-router.js";

export type AdminAuthResult =
  | { ok: true; keyName: string; userId: string }
  | { ok: false; status: 401 | 403 };

const GROVE_ADMIN_KEY = process.env.GROVE_ADMIN_KEY; // optional: restrict admin to a specific key name

function validateToken(token: string): StoredKey | null {
  const hash = hashToken(token);
  const db = getDb();
  const key = db.prepare("SELECT * FROM api_keys WHERE hashed_token = ?").get(hash) as StoredKey | null;
  if (!key) return null;
  if (isExpired(key)) return null;
  return key;
}

/**
 * Grove-wide platform owner — `users.role='owner'`. Distinct from
 * `vault_members(role='owner')` which is per-vault. A platform owner can
 * administer any vault even when they're not a member; lets us back the
 * `grove onboard` paved path without forcing the operator to insert a
 * throwaway `vault_members` row before every cross-vault admin call.
 */
export function isPlatformOwner(userId: string): boolean {
  return getUserRole(userId) === "owner";
}

export function adminAuth(req: IncomingMessage, vaultId?: string): AdminAuthResult {
  let userId: string | null = null;
  let keyName = "";

  // Session cookie first (persistent in SQLite).
  const sessionToken = getSessionFromCookie(req);
  if (sessionToken) {
    const user = validateSession(sessionToken);
    if (user) {
      userId = user.id;
      keyName = user.username ?? user.email;
    }
  }

  // Bearer token fallback.
  if (!userId) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return { ok: false, status: 401 };
    const key = validateToken(token);
    if (!key) return { ok: false, status: 401 };
    if (GROVE_ADMIN_KEY && key.name !== GROVE_ADMIN_KEY) return { ok: false, status: 403 };
    userId = key.user_id;
    keyName = key.name;
  }

  if (vaultId) {
    if (userRoleInVault(userId, vaultId) !== "owner") return { ok: false, status: 403 };
  } else {
    if (getUserRole(userId) !== "owner") return { ok: false, status: 403 };
  }

  return { ok: true, keyName, userId };
}

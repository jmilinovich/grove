/**
 * P8-B3 (decision #11) — MRU vault tracking.
 *
 * Every authenticated request records activity against
 * `vault_members.last_active_at` so grove-www can 301 bare `/dashboard`
 * to the user's most-recently-used vault. Writes are debounced in-memory
 * to at most one per minute per (user, vault) — we keep the hook on the
 * request hot path, so the DB must not be.
 */

import { getDb } from "./db.js";

const TOUCH_INTERVAL_MS = 60_000;
const SEP = String.fromCharCode(0);
const throttle = new Map<string, number>();

/**
 * Mark (userId, vaultId) active. Returns true if an UPDATE was attempted,
 * false if debounced. The UPDATE is a no-op when no `vault_members` row
 * exists for the pair.
 */
export function touchVaultMember(
  userId: string,
  vaultId: string,
  now: number = Date.now(),
): boolean {
  const key = userId + SEP + vaultId;
  const last = throttle.get(key);
  if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return false;
  throttle.set(key, now);
  getDb()
    .prepare(
      "UPDATE vault_members SET last_active_at = datetime('now') WHERE user_id = ? AND vault_id = ?",
    )
    .run(userId, vaultId);
  return true;
}

/** Test helper — clear the throttle map between scenarios. */
export function __resetVaultMruThrottle(): void {
  throttle.clear();
}

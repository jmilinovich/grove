/**
 * Canonical URL builder for Grove notes.
 *
 * Every external-facing note URL lives at `/@<handle>/<vaultSlug>/<path>`
 * on grove.md. The handle is the owner's `users.username` for the
 * specific vault being served — NOT "the oldest vault in the DB". That
 * distinction matters once more than one vault exists: URLs for vault B
 * must point at B's owner.
 *
 * Multi-vault shape was gated on grove-www's route support. Now that
 * `(resident)/[atHandle]/[...path]` detects the slug from `path[0]`,
 * write / move / resolve responses include the slug so following the
 * returned URL lands in the right vault. Unscoped `/@<handle>/<path>`
 * still resolves via the legacy catch-all (falls back to the token's
 * bound vault), but we stop minting those for new writes.
 */

import { getDb } from "./db.js";
import type { VaultContext } from "./vault-router.js";

function publicBase(): string {
  return process.env.GROVE_PUBLIC_BASE_URL ?? "https://grove.md";
}

/**
 * Resolve the username (handle) of the owner of `ctx.vaultId`.
 * Falls back to the oldest vault's owner — and then to "unknown" — so that
 * fresh test databases (no vaults yet) don't crash the URL builder.
 */
export function vaultOwnerHandle(ctx: VaultContext): string {
  try {
    const db = getDb();
    const scoped = db
      .prepare(
        "SELECT u.username FROM vaults v JOIN users u ON u.id = v.owner_id WHERE v.id = ? LIMIT 1",
      )
      .get(ctx.vaultId) as { username: string | null } | undefined;
    if (scoped?.username) return scoped.username;

    const anyVault = db
      .prepare(
        "SELECT u.username FROM vaults v JOIN users u ON u.id = v.owner_id ORDER BY v.created_at ASC LIMIT 1",
      )
      .get() as { username: string | null } | undefined;
    if (anyVault?.username) return anyVault.username;

    const owner = db
      .prepare("SELECT username FROM users WHERE role = 'owner' LIMIT 1")
      .get() as { username: string | null } | undefined;
    return owner?.username ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Encode a vault-relative path for use in a URL (per-segment, preserve slashes). */
function encodePath(vaultPath: string): string {
  return vaultPath.replace(/\.md$/, "").split("/").map(encodeURIComponent).join("/");
}

/**
 * Build the canonical external URL for a note.
 *
 * The `handle` parameter is optional; when omitted the owner is resolved
 * from `ctx.vaultId`. Pass it explicitly only when you already know which
 * resident you're building the URL for (e.g., a shared note that belongs
 * to a non-owner).
 *
 * Always includes `ctx.vaultSlug` so following the URL routes to the
 * exact vault the response came from, not "whichever vault the legacy
 * catch-all guesses" (which for multi-vault users drifts to the
 * token's bound vault rather than the one that was just written).
 */
export function noteUrl(ctx: VaultContext, vaultPath: string, handle?: string): string {
  const resident = handle ?? vaultOwnerHandle(ctx);
  const slug = ctx.vaultSlug;
  if (slug) {
    return `${publicBase()}/@${resident}/${slug}/${encodePath(vaultPath)}`;
  }
  return `${publicBase()}/@${resident}/${encodePath(vaultPath)}`;
}

/**
 * Build a URL when all you have is the handle (no full ctx).
 * Used by search flows that already resolved the handle upstream.
 *
 * Accepts an optional `vaultSlug` so multi-vault callers can anchor the
 * URL to a specific vault; legacy single-vault callers can still omit
 * it and get the un-scoped shape.
 */
export function noteUrlForHandle(
  handle: string,
  vaultPath: string,
  vaultSlug?: string,
): string {
  if (vaultSlug) {
    return `${publicBase()}/@${handle}/${vaultSlug}/${encodePath(vaultPath)}`;
  }
  return `${publicBase()}/@${handle}/${encodePath(vaultPath)}`;
}

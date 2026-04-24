/**
 * Canonical URL builder for Grove notes.
 *
 * Every external-facing note URL lives at `/@<handle>/<path>` on grove.md.
 * The handle is the owner's `users.username` for the specific vault being
 * served — NOT "the oldest vault in the DB". That distinction matters once
 * more than one vault exists: URLs for vault B must point at B's owner.
 *
 * Future shape (multi-vault, not yet routed by grove-www):
 *   https://grove.md/@<handle>/<vaultSlug>/<path>
 * When grove-www adds `(resident)/[atHandle]/[vaultSlug]/[...path]` for
 * arbitrary notes, flip `buildNoteUrl` to include the slug. Every call site
 * already passes `ctx`, so no caller changes.
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
 */
export function noteUrl(ctx: VaultContext, vaultPath: string, handle?: string): string {
  const resident = handle ?? vaultOwnerHandle(ctx);
  return `${publicBase()}/@${resident}/${encodePath(vaultPath)}`;
}

/**
 * Build a URL when all you have is the handle (no full ctx).
 * Used by search flows that already resolved the handle upstream.
 */
export function noteUrlForHandle(handle: string, vaultPath: string): string {
  return `${publicBase()}/@${handle}/${encodePath(vaultPath)}`;
}

/**
 * URL builder for Grove notes.
 *
 * Grove is single-user, single-vault now. The URL just points at the vault
 * via the configured public base (default `obsidian://`-style) so MCP
 * responses can include a link the user can paste/click. There's no resident
 * handle, no slug, no multi-vault routing.
 */

/**
 * Public base URL prefix used in `noteUrl`. Defaults to `grove://` so the
 * link is unambiguous; override with `$GROVE_PUBLIC_BASE_URL` to point at a
 * static reader (e.g. `https://example.com/notes`) or use the `obsidian://`
 * scheme to deep-link into Obsidian.
 */
function publicBase(): string {
  return process.env.GROVE_PUBLIC_BASE_URL ?? "grove://vault";
}

/** Encode a vault-relative path for use in a URL (per-segment, preserve slashes). */
function encodePath(vaultPath: string): string {
  return vaultPath.replace(/\.md$/, "").split("/").map(encodeURIComponent).join("/");
}

/** Build a URL for a note relative to the vault. */
export function noteUrl(vaultPath: string): string {
  return `${publicBase()}/${encodePath(vaultPath)}`;
}

/**
 * Vault routing (P8-A2).
 *
 * Owns the slug→(id, server_port, discovery_port) map used by grove-proxy
 * to route `/v/<slug>/*` requests to the correct backend. The map is built
 * from the `vaults` table at startup and reloads on `SIGHUP` so operators
 * can point new vaults at a running proxy without a restart.
 *
 * Security invariant: the proxy ALSO checks that the bearer token's
 * `api_keys.vault_id` matches the URL slug. A mismatch returns 403 (not
 * 404 — 404 would leak which vault slugs exist). This is defense-in-depth
 * alongside P8-A3's per-request backend self-auth.
 */

import { getDb } from "./db.js";

export interface VaultRoute {
  id: string;
  slug: string;
  server_port: number;
  discovery_port: number;
}

// Reserved URL-level slugs that collide with the proxy's own routes. Kept
// in sync with `src/vault-provision.ts` (P8-A4) — both consult the same
// list so a slug rejected at create time can never end up in routing.
export const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "mcp",
  "v",
  "v1",
  "oauth",
  "health",
  "metrics",
  "login",
  "logout",
  "callback",
  "dashboard",
  "profile",
  "settings",
]);

// Valid slug pattern per PLAN.md P8-A4. Shared here so both proxy routing
// and vault provisioning reject the same inputs.
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,29}$/;

let bySlug: Map<string, VaultRoute> = new Map();
let byId: Map<string, VaultRoute> = new Map();
let loadedAt = 0;

/**
 * Load (or reload) the vault map from SQLite. Callers should invoke this
 * at startup and on SIGHUP. Returns the number of vaults loaded.
 */
export function loadVaultMap(): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, slug, server_port, discovery_port
         FROM vaults
        WHERE server_port IS NOT NULL AND discovery_port IS NOT NULL`,
    )
    .all() as VaultRoute[];

  const nextSlug = new Map<string, VaultRoute>();
  const nextId = new Map<string, VaultRoute>();
  for (const row of rows) {
    nextSlug.set(row.slug, row);
    nextId.set(row.id, row);
  }
  bySlug = nextSlug;
  byId = nextId;
  loadedAt = Date.now();
  return rows.length;
}

export function lookupBySlug(slug: string): VaultRoute | null {
  return bySlug.get(slug) ?? null;
}

export function lookupById(id: string): VaultRoute | null {
  return byId.get(id) ?? null;
}

export function vaultMapLoadedAt(): number {
  return loadedAt;
}

export function vaultMapSize(): number {
  return bySlug.size;
}

export interface ParsedVaultPath {
  slug: string | null;
  rest: string;
  isLegacy: boolean;
}

/**
 * Parse a URL path into (slug, rest, isLegacy):
 *
 *   /v/team/mcp         → { slug: "team", rest: "/mcp", isLegacy: false }
 *   /v/team/v1/notes/x  → { slug: "team", rest: "/v1/notes/x", isLegacy: false }
 *   /mcp                → { slug: null,   rest: "/mcp",   isLegacy: true  }
 *   /v1/notes/x         → { slug: null,   rest: "/v1/notes/x", isLegacy: true }
 *   /health             → { slug: null,   rest: "/health", isLegacy: false } (infrastructure)
 *
 * The proxy treats `isLegacy: true` as "route to the token's bound vault
 * and emit a `Sunset` header so callers migrate". Non-legacy infra routes
 * (/health, /metrics, /login, /callback) skip vault routing entirely.
 */
export function parseVaultPath(path: string): ParsedVaultPath {
  const match = /^\/v\/([^/?#]+)(.*)$/.exec(path);
  if (match) {
    return { slug: match[1], rest: match[2] || "/", isLegacy: false };
  }
  if (path === "/mcp" || path.startsWith("/mcp?") || path.startsWith("/v1/")) {
    return { slug: null, rest: path, isLegacy: true };
  }
  return { slug: null, rest: path, isLegacy: false };
}

/**
 * Given a request's URL slug + the token's bound vault id, decide whether
 * to route, 403, or fall through to the legacy vault. Centralizes the
 * security invariant so the proxy's request handler doesn't re-litigate
 * it at every callsite.
 */
export interface RouteDecision {
  kind: "route" | "deny" | "legacy";
  vault?: VaultRoute;
  reason?: string;
}

export function decideRoute(parsed: ParsedVaultPath, tokenVaultId: string | null): RouteDecision {
  if (parsed.isLegacy) {
    if (!tokenVaultId) return { kind: "deny", reason: "missing auth" };
    const vault = byId.get(tokenVaultId);
    if (!vault) return { kind: "deny", reason: "token references unknown vault" };
    return { kind: "legacy", vault };
  }
  if (parsed.slug === null) {
    // Not a vault-scoped path (e.g. /health). Infra route — caller handles.
    return { kind: "route" };
  }
  const vault = bySlug.get(parsed.slug);
  if (!vault) {
    // Return 403 (NOT 404) so we don't leak which slugs exist.
    return { kind: "deny", reason: "unknown or forbidden vault" };
  }
  if (!tokenVaultId) return { kind: "deny", reason: "missing auth" };
  if (tokenVaultId !== vault.id) {
    return { kind: "deny", reason: "vault slug mismatch" };
  }
  return { kind: "route", vault };
}

/**
 * Returns the ISO date 90 days from now — used as the `Sunset` header value
 * for legacy routes per RFC 8594.
 */
export function sunsetDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 90);
  return d.toUTCString();
}

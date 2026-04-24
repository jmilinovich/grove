/**
 * Trail configuration and filtering for Grove.
 *
 * A trail is: a name + topic boundaries (tags, types, paths) + permission level + API key.
 * Consumers connect via MCP and see only what the trail allows.
 *
 * Config stored in SQLite (grove.db).
 */

import { randomBytes } from "node:crypto";
import { createKey } from "./keys.js";
import { getDb } from "./db.js";

// ── Trail config schema ───────────────────────────────────────────

export interface TrailConfig {
  id: string;
  name: string;
  description: string;
  key_id: string;        // associated API key
  enabled: boolean;
  created_at: string;
  // Scope filters — ALL must pass (AND logic)
  allow_tags: string[];   // note must have at least one of these tags
  deny_tags: string[];    // note must NOT have any of these tags
  allow_types: string[];  // note type must be one of these (empty = all)
  deny_types: string[];   // note type must NOT be one of these
  allow_paths: string[];  // note path must start with one of these prefixes (empty = all)
  deny_paths: string[];   // note path must NOT start with any of these prefixes
  // Rate limits
  rate_limit_reads: number;   // per minute
  rate_limit_writes: number;  // per minute (0 = no writes)
}

// ── Internal helpers ─────────────────────────────────────────────

interface TrailRow {
  id: string;
  vault_id: string;
  name: string;
  description: string;
  enabled: number;
  config_json: string;
  created_at: string;
  updated_at: string;
}

interface TrailGrantRow {
  grantee_id: string;
}

function rowToConfig(row: TrailRow, keyId: string): TrailConfig {
  const config = JSON.parse(row.config_json);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    key_id: keyId,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    allow_tags: config.allow_tags ?? [],
    deny_tags: config.deny_tags ?? [],
    allow_types: config.allow_types ?? [],
    deny_types: config.deny_types ?? [],
    allow_paths: config.allow_paths ?? [],
    deny_paths: config.deny_paths ?? [],
    rate_limit_reads: config.rate_limit_reads ?? 60,
    rate_limit_writes: config.rate_limit_writes ?? 0,
  };
}

// ── CRUD operations ───────────────────────────────────────────────

export function loadTrails(vaultId?: string): TrailConfig[] {
  const db = getDb();
  const rows = vaultId
    ? (db.prepare("SELECT * FROM trails WHERE vault_id = ?").all(vaultId) as TrailRow[])
    : (db.prepare("SELECT * FROM trails").all() as TrailRow[]);
  return rows.map((r) => rowToConfig(r, ""));
}

export function generateTrailId(): string {
  return "trail_" + randomBytes(4).toString("hex");
}

export function createTrail(opts: {
  name: string;
  description?: string;
  allow_tags?: string[];
  deny_tags?: string[];
  allow_types?: string[];
  deny_types?: string[];
  allow_paths?: string[];
  deny_paths?: string[];
  rate_limit_reads?: number;
  rate_limit_writes?: number;
  /**
   * Vault the trail belongs to. Pre-P20 this was hard-coded to the
   * string `"life"` — the result was that every trail row was
   * assigned to a non-existent vault id, so per-vault trail filtering
   * (shipped in grove#53) silently returned zero rows. Callers must
   * now pass the routed vault's id.
   */
  vault_id: string;
}): { trail: TrailConfig; token: string } {
  const db = getDb();

  // Create a read-only API key for this trail, bound to the same
  // vault as the trail itself.
  const keyResult = createKey(`trail:${opts.name}`, ["read"], opts.vault_id);

  const trailId = generateTrailId();
  const now = new Date().toISOString();
  const configJson = JSON.stringify({
    allow_tags: opts.allow_tags ?? [],
    deny_tags: opts.deny_tags ?? [],
    allow_types: opts.allow_types ?? [],
    deny_types: opts.deny_types ?? [],
    allow_paths: opts.allow_paths ?? [],
    deny_paths: opts.deny_paths ?? [],
    rate_limit_reads: opts.rate_limit_reads ?? 60,
    rate_limit_writes: opts.rate_limit_writes ?? 0,
  });

  db.prepare(
    "INSERT INTO trails (id, vault_id, name, description, enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(trailId, opts.vault_id, opts.name, opts.description ?? "", 1, configJson, now, now);

  db.prepare(
    "INSERT INTO trail_grants (id, trail_id, grantee_type, grantee_id, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run("grant_" + randomBytes(4).toString("hex"), trailId, "token", keyResult.id, now);

  const trail: TrailConfig = {
    id: trailId,
    name: opts.name,
    description: opts.description ?? "",
    key_id: keyResult.id,
    enabled: true,
    created_at: now,
    allow_tags: opts.allow_tags ?? [],
    deny_tags: opts.deny_tags ?? [],
    allow_types: opts.allow_types ?? [],
    deny_types: opts.deny_types ?? [],
    allow_paths: opts.allow_paths ?? [],
    deny_paths: opts.deny_paths ?? [],
    rate_limit_reads: opts.rate_limit_reads ?? 60,
    rate_limit_writes: opts.rate_limit_writes ?? 0,
  };

  return { trail, token: keyResult.token };
}

export function updateTrail(id: string, updates: {
  name?: string;
  description?: string;
  enabled?: boolean;
  allow_tags?: string[];
  deny_tags?: string[];
  allow_types?: string[];
  deny_types?: string[];
  allow_paths?: string[];
  deny_paths?: string[];
  rate_limit_reads?: number;
  rate_limit_writes?: number;
}): boolean {
  const db = getDb();
  const now = new Date().toISOString();

  // Fetch existing row to merge config
  const row = db.prepare("SELECT * FROM trails WHERE id = ?").get(id) as TrailRow | undefined;
  if (!row) return false;

  const existing = JSON.parse(row.config_json);

  // Merge config fields
  const newConfig = {
    allow_tags: updates.allow_tags ?? existing.allow_tags,
    deny_tags: updates.deny_tags ?? existing.deny_tags,
    allow_types: updates.allow_types ?? existing.allow_types,
    deny_types: updates.deny_types ?? existing.deny_types,
    allow_paths: updates.allow_paths ?? existing.allow_paths,
    deny_paths: updates.deny_paths ?? existing.deny_paths,
    rate_limit_reads: updates.rate_limit_reads ?? existing.rate_limit_reads,
    rate_limit_writes: updates.rate_limit_writes ?? existing.rate_limit_writes,
  };

  const newName = updates.name ?? row.name;
  const newDesc = updates.description ?? row.description;
  const newEnabled = updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : row.enabled;

  const result = db.prepare(
    "UPDATE trails SET name = ?, description = ?, enabled = ?, config_json = ?, updated_at = ? WHERE id = ?"
  ).run(newName, newDesc, newEnabled, JSON.stringify(newConfig), now, id);

  return result.changes > 0;
}

export function disableTrail(id: string): boolean {
  const db = getDb();
  const result = db.prepare("UPDATE trails SET enabled = 0, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  return result.changes > 0;
}

export function deleteTrail(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM trails WHERE id = ?").run(id);
  return result.changes > 0;
}

export interface TrailPublicInfo {
  name: string;
  description: string;
  created_at: string;
  enabled: boolean;
}

export function getTrailPublicInfo(id: string): TrailPublicInfo | null {
  const db = getDb();
  const row = db.prepare("SELECT name, description, created_at, enabled FROM trails WHERE id = ?").get(id) as {
    name: string; description: string; created_at: string; enabled: number;
  } | undefined;
  if (!row) return null;
  return { name: row.name, description: row.description, created_at: row.created_at, enabled: row.enabled === 1 };
}

export function getTrailConfig(id: string): TrailConfig | null {
  const db = getDb();
  const row = db.prepare("SELECT t.*, tg.grantee_id FROM trails t LEFT JOIN trail_grants tg ON t.id = tg.trail_id AND tg.grantee_type = 'token' WHERE t.id = ?").get(id) as (TrailRow & { grantee_id: string | null }) | undefined;
  if (!row) return null;
  return rowToConfig(row, row.grantee_id ?? "");
}

export function resolveTrail(keyId: string): TrailConfig | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT t.* FROM trails t JOIN trail_grants tg ON t.id = tg.trail_id WHERE tg.grantee_type = 'token' AND tg.grantee_id = ? AND t.enabled = 1"
  ).get(keyId) as TrailRow | undefined;
  if (!row) return null;
  return rowToConfig(row, keyId);
}

// ── Trail filtering ───────────────────────────────────────────────

export interface NoteMetadata {
  path: string;
  tags?: string[];
  type?: string;
  private?: boolean;
}

/**
 * Check if a note is visible under a trail's scope.
 * Returns true if the note passes ALL filters.
 */
export function filterByTrail(trail: TrailConfig, note: NoteMetadata): boolean {
  // Private notes are always excluded from trails (strict boolean check)
  if (note.private === true) return false;

  // Path allow filter
  if (trail.allow_paths.length > 0) {
    const pathAllowed = trail.allow_paths.some((prefix) => note.path.startsWith(prefix));
    if (!pathAllowed) return false;
  }

  // Path deny filter
  if (trail.deny_paths.length > 0) {
    const pathDenied = trail.deny_paths.some((prefix) => note.path.startsWith(prefix));
    if (pathDenied) return false;
  }

  // Type allow filter
  if (trail.allow_types.length > 0) {
    if (!note.type || !trail.allow_types.includes(note.type)) return false;
  }

  // Type deny filter
  if (trail.deny_types.length > 0) {
    if (note.type && trail.deny_types.includes(note.type)) return false;
  }

  // Tag allow filter — note must have at least one matching tag
  if (trail.allow_tags.length > 0) {
    const noteTags = note.tags ?? [];
    const hasMatch = trail.allow_tags.some((tag) => noteTags.includes(tag));
    if (!hasMatch) return false;
  }

  // Tag deny filter
  if (trail.deny_tags.length > 0) {
    const noteTags = note.tags ?? [];
    const hasDenied = trail.deny_tags.some((tag) => noteTags.includes(tag));
    if (hasDenied) return false;
  }

  return true;
}

/**
 * Check if a trail allows writes to a given path.
 * Trail must have rate_limit_writes > 0, path must match allow_paths if
 * specified, AND path must not match deny_paths. The original shape
 * short-circuited on allow_paths and never consulted deny_paths when
 * both were set — a trail like `allow=Resources/, deny=Resources/Private/`
 * would let writes into the denied subtree.
 */
export function trailAllowsWrite(trail: TrailConfig, path: string): boolean {
  if (trail.rate_limit_writes <= 0) return false;

  const allowed =
    trail.allow_paths.length === 0 ||
    trail.allow_paths.some((prefix) => path.startsWith(prefix));
  if (!allowed) return false;

  const denied = trail.deny_paths.some((prefix) => path.startsWith(prefix));
  if (denied) return false;

  return true;
}

// ── Trail audit logging ───────────────────────────────────────────

import { structuredLog } from "./logger.js";

export function logTrailAccess(
  rid: string,
  trailId: string,
  trailName: string,
  tool: string,
  totalResults: number,
  filteredResults: number,
): void {
  structuredLog({
    ts: new Date().toISOString(),
    rid,
    level: "info",
    msg: "trail.access",
    trail_id: trailId,
    trail_name: trailName,
    tool,
    total_count: totalResults,
    filtered_count: filteredResults,
  });
}

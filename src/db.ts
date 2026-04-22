/**
 * SQLite database singleton for Grove.
 *
 * Manages schema creation, JSON→SQLite migration, and a shared connection.
 * Database lives at ~/.grove/grove.db with WAL mode and foreign keys enabled.
 */

import Database from "better-sqlite3";
import { existsSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";

const GROVE_DIR = join(homedir(), ".grove");
const KEYS_PATH = join(GROVE_DIR, "keys.json");
const TRAILS_PATH = join(GROVE_DIR, "trails.json");

function dbPath(): string {
  return process.env.GROVE_DB_PATH ?? join(GROVE_DIR, "grove.db");
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const path = dbPath();
  mkdirSync(join(path, ".."), { recursive: true });
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/** Close the database connection (for tests/cleanup). */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Reset the module-level singleton (for tests that swap DB_PATH via env). */
export function resetDb(): void {
  closeDb();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  email TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'viewer',
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  git_repo_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  storage_bytes INTEGER NOT NULL DEFAULT 0,
  storage_quota_bytes INTEGER NOT NULL DEFAULT 104857600,
  UNIQUE(owner_id, slug)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  vault_id TEXT NOT NULL,
  name TEXT NOT NULL,
  hashed_token TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT 'read,write',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at TEXT,
  session_id TEXT
);

CREATE TABLE IF NOT EXISTS trails (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trail_grants (
  id TEXT PRIMARY KEY,
  trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  grantee_type TEXT NOT NULL,
  grantee_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  last_used_at TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS magic_links (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT NOT NULL,
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  key_id TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  code_challenge TEXT,
  code_challenge_method TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shared_links (
  id TEXT PRIMARY KEY,
  note_path TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  max_views INTEGER,
  view_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  revoked_by TEXT REFERENCES users(id),
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discovery_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  trigger TEXT NOT NULL,
  queued_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'done', 'error')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_discovery_queue_status ON discovery_queue(status, queued_at);

CREATE TABLE IF NOT EXISTS discovery_results (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  target_path TEXT NOT NULL,
  similarity REAL NOT NULL,
  relationship TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  dismissed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_discovery_results_source ON discovery_results(source_path);

CREATE TABLE IF NOT EXISTS vault_keys (
  vault_id TEXT PRIMARY KEY REFERENCES vaults(id),
  encrypted_key BLOB NOT NULL,
  key_salt BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_unlocked_at TEXT
);

CREATE TABLE IF NOT EXISTS graph_health (
  id TEXT PRIMARY KEY,
  measured_at TEXT NOT NULL,
  metrics TEXT NOT NULL,
  score INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_health_date ON graph_health(measured_at);

CREATE TABLE IF NOT EXISTS graph_health_flags (
  id TEXT PRIMARY KEY,
  flag_type TEXT NOT NULL,
  source_path TEXT,
  target_path TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_health_flags_type ON graph_health_flags(flag_type, resolved_at);
CREATE INDEX IF NOT EXISTS idx_flags_unresolved ON graph_health_flags(resolved_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_health_flags_unique
  ON graph_health_flags(flag_type, coalesce(source_path, ''), coalesce(target_path, ''))
  WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS handle_history (
  handle TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  released_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_handle_history_user ON handle_history(user_id);

CREATE TABLE IF NOT EXISTS write_provenance (
  path TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  actor TEXT,
  written_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_write_provenance_written_at ON write_provenance(written_at);
`;

export function createSchema(): void {
  const database = getDb();
  database.exec(SCHEMA);
  migrateUserRoles(database);
  migrateUserDisplayName(database);
  migrateDiscoveryQueue(database);
  migrateSessionUserAgent(database);
  migrateApiKeySessionId(database);
  migrateUserBio(database);
  migrateSharedLinks(database);
}

/**
 * Ensure shared_links has the P19-1 columns (max_views nullable, last_accessed_at,
 * revoked_by, revoked_at). SQLite can't ALTER a column's nullability in place —
 * requires a transactional table rebuild. Idempotent via column inspection.
 */
function migrateSharedLinks(database: Database.Database): void {
  const cols = database
    .prepare("PRAGMA table_info(shared_links)")
    .all() as { name: string }[];
  if (cols.length === 0) return;

  const names = new Set(cols.map((c) => c.name));
  if (names.has("last_accessed_at") && names.has("revoked_by") && names.has("revoked_at")) {
    return;
  }

  const tx = database.transaction(() => {
    database.exec(`
      CREATE TABLE shared_links_new (
        id TEXT PRIMARY KEY,
        note_path TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL,
        max_views INTEGER,
        view_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        revoked_by TEXT REFERENCES users(id),
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO shared_links_new (id, note_path, created_by, expires_at, max_views, view_count, created_at)
        SELECT id, note_path, created_by, expires_at, max_views, COALESCE(view_count, 0), created_at FROM shared_links;
      DROP TABLE shared_links;
      ALTER TABLE shared_links_new RENAME TO shared_links;
    `);
  });
  tx();

  const fkCheck = database.prepare("PRAGMA foreign_key_check").all();
  if (fkCheck.length > 0) {
    throw new Error(`[db] shared_links migration left dangling FKs: ${JSON.stringify(fkCheck)}`);
  }
}

/** Add bio column to users (P16-1: resident profiles). */
function migrateUserBio(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (cols.some((c) => c.name === "bio")) return;
  database.exec("ALTER TABLE users ADD COLUMN bio TEXT");
}

/** Add user_agent column to sessions (P15-1 follow-up). */
function migrateSessionUserAgent(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (cols.some((c) => c.name === "user_agent")) return;
  database.exec("ALTER TABLE sessions ADD COLUMN user_agent TEXT");
}

/** Link api_keys to the session that created them so /v1/me can flag is_current (P15-1 follow-up). */
function migrateApiKeySessionId(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info(api_keys)").all() as { name: string }[];
  if (cols.some((c) => c.name === "session_id")) return;
  database.exec("ALTER TABLE api_keys ADD COLUMN session_id TEXT");
}

/**
 * Drop the trigger CHECK constraint and add an `attempts` column on the
 * discovery_queue. SQLite can't modify a CHECK constraint in place — we
 * detect either condition via PRAGMA + sql inspection and rebuild the
 * table when needed. Idempotent.
 */
function migrateDiscoveryQueue(database: Database.Database): void {
  const cols = database
    .prepare("PRAGMA table_info(discovery_queue)")
    .all() as { name: string }[];
  const hasAttempts = cols.some((c) => c.name === "attempts");

  const tableSql = database
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='discovery_queue'")
    .get() as { sql: string } | undefined;
  const hasTriggerCheck = tableSql?.sql.includes("CHECK(trigger IN") ?? false;

  if (hasAttempts && !hasTriggerCheck) return;

  const tx = database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS discovery_queue_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        trigger TEXT NOT NULL,
        queued_at TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'done', 'error')),
        attempts INTEGER NOT NULL DEFAULT 0,
        error_message TEXT
      );
      INSERT INTO discovery_queue_new (id, path, trigger, queued_at, processed_at, status, error_message)
        SELECT id, path, trigger, queued_at, processed_at, status, error_message FROM discovery_queue;
      DROP TABLE discovery_queue;
      ALTER TABLE discovery_queue_new RENAME TO discovery_queue;
      CREATE INDEX IF NOT EXISTS idx_discovery_queue_status ON discovery_queue(status, queued_at);
    `);
  });
  tx();
}

/** Add role column to existing users tables that lack it. */
function migrateUserRoles(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (cols.some((c) => c.name === "role")) return;
  database.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer'");
  database.exec("UPDATE users SET role = 'owner' WHERE id = 'user_00000000'");
}

/** Add display_name column to existing users tables that lack it (P15-1). */
function migrateUserDisplayName(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (cols.some((c) => c.name === "display_name")) return;
  database.exec("ALTER TABLE users ADD COLUMN display_name TEXT");
}

/**
 * Migrate from JSON files to SQLite.
 *
 * Idempotent: if grove.db already has data, this is a no-op.
 * Reads keys.json and trails.json, imports them into SQLite in a single
 * transaction, then renames the originals to .migrated.
 */
export function runMigration(): void {
  createSchema();
  const database = getDb();

  // Check if we already have data (migration already ran)
  const keyCount = database.prepare("SELECT COUNT(*) as count FROM api_keys").get() as { count: number };
  if (keyCount.count > 0) return;

  // Check if there's JSON data to migrate
  const hasKeys = existsSync(KEYS_PATH);
  const hasTrails = existsSync(TRAILS_PATH);

  if (!hasKeys && !hasTrails) {
    // No JSON files — fresh install. Create admin user and default vault.
    const adminId = "user_00000000";
    database.prepare(
      "INSERT OR IGNORE INTO users (id, username, email, role) VALUES (?, ?, ?, ?)"
    ).run(adminId, "admin", "admin@grove.local", "owner");
    database.prepare(
      "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)"
    ).run("vault_00000000", adminId, "life", "Life", join(homedir(), "life"));
    return;
  }

  // Migrate inside a transaction
  const migrate = database.transaction(() => {
    // Create admin user
    const adminId = "user_00000000";
    database.prepare(
      "INSERT OR IGNORE INTO users (id, username, email, role) VALUES (?, ?, ?, ?)"
    ).run(adminId, "admin", "admin@grove.local", "owner");

    // Create default vault
    database.prepare(
      "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)"
    ).run("vault_00000000", adminId, "life", "Life", join(homedir(), "life"));

    // Import keys
    if (hasKeys) {
      const keys = JSON.parse(readFileSync(KEYS_PATH, "utf-8")) as Array<{
        id: string;
        name: string;
        hashed_token: string;
        scopes: string[];
        vault_id: string;
        created_at: string;
        last_used_at: string | null;
        expires_at: string | null;
      }>;

      const insertKey = database.prepare(
        "INSERT INTO api_keys (id, user_id, vault_id, name, hashed_token, scopes, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );

      for (const k of keys) {
        insertKey.run(
          k.id,
          adminId,
          k.vault_id,
          k.name,
          k.hashed_token,
          k.scopes.join(","),
          k.created_at,
          k.last_used_at,
          k.expires_at,
        );
      }
    }

    // Import trails
    if (hasTrails) {
      const trails = JSON.parse(readFileSync(TRAILS_PATH, "utf-8")) as Array<{
        id: string;
        name: string;
        description: string;
        key_id: string;
        enabled: boolean;
        created_at: string;
        allow_tags: string[];
        deny_tags: string[];
        allow_types: string[];
        deny_types: string[];
        allow_paths: string[];
        deny_paths: string[];
        rate_limit_reads: number;
        rate_limit_writes: number;
      }>;

      const insertTrail = database.prepare(
        "INSERT INTO trails (id, vault_id, name, description, enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const insertGrant = database.prepare(
        "INSERT INTO trail_grants (id, trail_id, grantee_type, grantee_id, created_at) VALUES (?, ?, ?, ?, ?)"
      );

      for (const t of trails) {
        const configJson = JSON.stringify({
          allow_tags: t.allow_tags,
          deny_tags: t.deny_tags,
          allow_types: t.allow_types,
          deny_types: t.deny_types,
          allow_paths: t.allow_paths,
          deny_paths: t.deny_paths,
          rate_limit_reads: t.rate_limit_reads,
          rate_limit_writes: t.rate_limit_writes,
        });

        insertTrail.run(
          t.id,
          "life",                       // default vault
          t.name,
          t.description,
          t.enabled ? 1 : 0,
          configJson,
          t.created_at,
          t.created_at,
        );

        // Create trail_grant linking trail to its API key
        insertGrant.run(
          "grant_" + randomBytes(4).toString("hex"),
          t.id,
          "token",
          t.key_id,
          t.created_at,
        );
      }
    }
  });

  migrate();

  // Rename originals
  if (hasKeys) renameSync(KEYS_PATH, KEYS_PATH + ".migrated");
  if (hasTrails) renameSync(TRAILS_PATH, TRAILS_PATH + ".migrated");

  console.log("[db] Migration complete — JSON files renamed to .migrated");

  // Migrate OAuth clients from JSON to SQLite
  migrateOAuth(database);
}

// ── Discovery queue helpers ───────────────────────────────────────

export type DiscoveryTrigger =
  | "commit"
  | "write"
  | "ingest"
  | "embed_retry"
  | "image_enrich";

export interface DiscoveryQueueEntry {
  id: number;
  path: string;
  trigger: DiscoveryTrigger;
  queued_at: string;
  processed_at: string | null;
  status: "pending" | "processing" | "done" | "error";
  attempts: number;
  error_message: string | null;
}

/** Enqueue a path for discovery processing. */
export function enqueueDiscovery(
  path: string,
  trigger: DiscoveryTrigger,
): void {
  const database = getDb();
  database
    .prepare(
      "INSERT INTO discovery_queue (path, trigger) VALUES (?, ?)",
    )
    .run(path, trigger);
}

/** Claim the next pending entry for processing (atomic status flip). */
export function dequeueDiscovery(): DiscoveryQueueEntry | null {
  const database = getDb();
  const row = database
    .prepare(
      `UPDATE discovery_queue
         SET status = 'processing', attempts = attempts + 1
       WHERE id = (
         SELECT id FROM discovery_queue
         WHERE status = 'pending'
         ORDER BY queued_at ASC
         LIMIT 1
       )
       RETURNING *`,
    )
    .get() as DiscoveryQueueEntry | undefined;
  return row ?? null;
}

/** Mark an entry as done. */
export function markDiscoveryDone(id: number): void {
  const database = getDb();
  database
    .prepare(
      "UPDATE discovery_queue SET status = 'done', processed_at = datetime('now') WHERE id = ?",
    )
    .run(id);
}

/** Mark an entry as errored with a message. */
export function markDiscoveryError(id: number, message: string): void {
  const database = getDb();
  database
    .prepare(
      "UPDATE discovery_queue SET status = 'error', processed_at = datetime('now'), error_message = ? WHERE id = ?",
    )
    .run(message, id);
}

/**
 * Requeue an errored entry as pending again for a retry. Used by the
 * embed-retry path when a transient failure (network, Voyage API down)
 * merits another attempt. Returns true if the row was found.
 */
export function requeueDiscovery(id: number): boolean {
  const database = getDb();
  const result = database
    .prepare(
      "UPDATE discovery_queue SET status = 'pending', processed_at = NULL, error_message = NULL WHERE id = ?",
    )
    .run(id);
  return result.changes > 0;
}

/** Count pending entries in the queue. */
export function discoveryQueueDepth(): number {
  const database = getDb();
  const row = database
    .prepare("SELECT COUNT(*) as count FROM discovery_queue WHERE status = 'pending'")
    .get() as { count: number };
  return row.count;
}

// ── Discovery results helpers ────────────────────────────────────

export interface DiscoveryResultRow {
  id: string;
  source_path: string;
  target_path: string;
  similarity: number;
  relationship: string | null;
  created_at: string;
  dismissed_at: string | null;
}

/** Insert a discovery result. */
export function insertDiscoveryResult(
  id: string,
  sourcePath: string,
  targetPath: string,
  similarity: number,
  relationship: string,
): void {
  const database = getDb();
  database
    .prepare(
      "INSERT INTO discovery_results (id, source_path, target_path, similarity, relationship) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, sourcePath, targetPath, similarity, relationship);
}

/** Clear undismissed results for a source path (before re-processing). */
export function clearUndismissedResults(sourcePath: string): void {
  const database = getDb();
  database
    .prepare("DELETE FROM discovery_results WHERE source_path = ? AND dismissed_at IS NULL")
    .run(sourcePath);
}

/** Get discovery results, optionally filtered by source path. */
export function getDiscoveryResults(sourcePath?: string): DiscoveryResultRow[] {
  const database = getDb();
  if (sourcePath) {
    return database
      .prepare("SELECT * FROM discovery_results WHERE source_path = ? ORDER BY similarity DESC")
      .all(sourcePath) as DiscoveryResultRow[];
  }
  return database
    .prepare("SELECT * FROM discovery_results ORDER BY created_at DESC, similarity DESC")
    .all() as DiscoveryResultRow[];
}

/** Dismiss a discovery result (soft delete). */
export function dismissDiscoveryResult(id: string): void {
  const database = getDb();
  database
    .prepare("UPDATE discovery_results SET dismissed_at = datetime('now') WHERE id = ?")
    .run(id);
}

// ── Discovery digest helpers ────────────────────────────────────

export interface RecentExtraction {
  path: string;
  processed_at: string;
  trigger: string;
}

/** Get recently processed queue entries (most recent first). */
export function getRecentExtractions(limit = 20): RecentExtraction[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT path, processed_at, trigger
       FROM discovery_queue
       WHERE status = 'done' AND processed_at IS NOT NULL
       ORDER BY processed_at DESC
       LIMIT ?`,
    )
    .all(limit) as RecentExtraction[];
}

export interface NewConceptCreated {
  path: string;
  created_at: string;
  triggered_by: string;
}

/**
 * Get recently created concept notes from discovery results.
 *
 * Callers should pass `conceptPrefix` from the vault config (e.g.
 * `entityPath(config, "concept")`). The default "Resources/Concepts/" keeps
 * legacy behavior for PARA vaults when no prefix is provided.
 */
export function getNewConceptsCreated(
  limit = 20,
  conceptPrefix = "Resources/Concepts/",
): NewConceptCreated[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT DISTINCT target_path AS path, created_at, source_path AS triggered_by
       FROM discovery_results
       WHERE target_path LIKE ?
         AND dismissed_at IS NULL
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(`${conceptPrefix}%`, limit) as NewConceptCreated[];
}

export interface SurprisingConnection {
  source: string;
  target: string;
  similarity: number;
}

/** Get top surprising connections (highest similarity, undismissed). */
export function getSurprisingConnections(limit = 10): SurprisingConnection[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT source_path AS source, target_path AS target, similarity
       FROM discovery_results
       WHERE dismissed_at IS NULL
       ORDER BY similarity DESC
       LIMIT ?`,
    )
    .all(limit) as SurprisingConnection[];
}

// ── Graph health flags helpers ───────────────────────────────────

export type HealthFlagType =
  | "duplicate_candidate"
  | "long_orphan"
  | "cluster_island";

export interface HealthFlagRow {
  id: string;
  flag_type: HealthFlagType;
  source_path: string | null;
  target_path: string | null;
  details: string;
  created_at: string;
  resolved_at: string | null;
}

/**
 * Insert a health flag if there isn't already an unresolved one for the
 * same (flag_type, source_path, target_path) tuple. Returns the id of the
 * inserted row, or null when the flag was already present.
 */
export function insertHealthFlag(
  id: string,
  flagType: HealthFlagType,
  sourcePath: string | null,
  targetPath: string | null,
  details: Record<string, unknown>,
): string | null {
  const database = getDb();
  const result = database
    .prepare(
      `INSERT INTO graph_health_flags (id, flag_type, source_path, target_path, details)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(id, flagType, sourcePath, targetPath, JSON.stringify(details));
  return result.changes > 0 ? id : null;
}

export function getHealthFlags(opts: {
  resolved?: boolean;
  flagType?: HealthFlagType;
  limit?: number;
} = {}): HealthFlagRow[] {
  const database = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.resolved === false) clauses.push("resolved_at IS NULL");
  else if (opts.resolved === true) clauses.push("resolved_at IS NOT NULL");
  if (opts.flagType) {
    clauses.push("flag_type = ?");
    params.push(opts.flagType);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts.limit ?? 200;
  params.push(limit);
  return database
    .prepare(
      `SELECT id, flag_type, source_path, target_path, details, created_at, resolved_at
       FROM graph_health_flags
       ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(...params) as HealthFlagRow[];
}

export function resolveHealthFlag(id: string): boolean {
  const database = getDb();
  const result = database
    .prepare(
      "UPDATE graph_health_flags SET resolved_at = datetime('now') WHERE id = ? AND resolved_at IS NULL",
    )
    .run(id);
  return result.changes > 0;
}

/** Get the most recent processed_at timestamp. */
export function getLastProcessedAt(): string | null {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT processed_at FROM discovery_queue
       WHERE status = 'done' AND processed_at IS NOT NULL
       ORDER BY processed_at DESC LIMIT 1`,
    )
    .get() as { processed_at: string } | undefined;
  return row?.processed_at ?? null;
}

function hashTokenForMigration(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function migrateOAuth(database: Database.Database): void {
  const OAUTH_CLIENTS_PATH = join(GROVE_DIR, "oauth-clients.json");
  if (existsSync(OAUTH_CLIENTS_PATH)) {
    const clients = JSON.parse(readFileSync(OAUTH_CLIENTS_PATH, "utf-8")) as Array<{
      client_id: string;
      client_secret: string;
      redirect_uris: string[];
      registered_at: string;
    }>;
    for (const c of clients) {
      database.prepare(
        "INSERT OR IGNORE INTO oauth_clients (client_id, client_secret_hash, redirect_uris, created_at) VALUES (?, ?, ?, ?)"
      ).run(
        c.client_id,
        hashTokenForMigration(c.client_secret),
        JSON.stringify(c.redirect_uris),
        c.registered_at,
      );
    }
    renameSync(OAUTH_CLIENTS_PATH, OAUTH_CLIENTS_PATH + ".migrated");
    console.log("[db] OAuth clients migrated from JSON to SQLite");
  }

  // Don't migrate oauth-codes — they're short-lived (5min) and can be discarded
  const OAUTH_CODES_PATH = join(GROVE_DIR, "oauth-codes.json");
  if (existsSync(OAUTH_CODES_PATH)) {
    renameSync(OAUTH_CODES_PATH, OAUTH_CODES_PATH + ".migrated");
    console.log("[db] OAuth codes JSON file renamed to .migrated (short-lived, not migrated)");
  }
}

// ─── Write provenance (two-hash model for optimistic concurrency) ──────────
//
// The discovery worker mutates notes after write (wikilink wiring). That makes
// the on-disk content_hash unstable for the caller: by the time they issue a
// follow-up update with if_hash, the hash may have moved under them.
//
// write_provenance tracks the hash of what the CALLER last wrote ("source
// hash"), independent of any downstream enrichment. if_hash is checked against
// source_hash, so concurrent discovery work doesn't produce false conflicts.
//
// Discovery writes go through writeFileSync + gitCommit directly and do NOT
// update this table — source_hash stays pinned to the caller's intent.

/**
 * Record a caller-initiated write. Upserts, so the most recent caller write
 * wins. Called from handleWriteNote / handleMoveNote after a successful
 * commit, never from the discovery worker.
 */
export function recordWrite(
  path: string,
  sourceHash: string,
  commitSha: string,
  actor?: string,
): void {
  const database = getDb();
  database
    .prepare(
      `INSERT INTO write_provenance (path, source_hash, commit_sha, actor, written_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(path) DO UPDATE SET
         source_hash = excluded.source_hash,
         commit_sha = excluded.commit_sha,
         actor = excluded.actor,
         written_at = excluded.written_at`,
    )
    .run(path, sourceHash, commitSha, actor ?? null);
}

/**
 * Get the source hash for a path, or null if no caller write has ever been
 * recorded (discovery-only notes, pre-provenance notes). Callers fall back
 * to the on-disk content hash in that case.
 */
export function getSourceHash(path: string): string | null {
  const database = getDb();
  const row = database
    .prepare("SELECT source_hash FROM write_provenance WHERE path = ?")
    .get(path) as { source_hash: string } | undefined;
  return row?.source_hash ?? null;
}

/**
 * Full provenance row (for observability in vault_status mode=perf).
 */
export interface ProvenanceRow {
  path: string;
  source_hash: string;
  commit_sha: string;
  actor: string | null;
  written_at: string;
}

export function getProvenance(path: string): ProvenanceRow | null {
  const database = getDb();
  const row = database
    .prepare("SELECT path, source_hash, commit_sha, actor, written_at FROM write_provenance WHERE path = ?")
    .get(path) as ProvenanceRow | undefined;
  return row ?? null;
}

/**
 * Remove provenance for a path. Call on hard_delete.
 */
export function deleteProvenance(path: string): void {
  const database = getDb();
  database.prepare("DELETE FROM write_provenance WHERE path = ?").run(path);
}

/**
 * Rename provenance on move.
 */
export function renameProvenance(fromPath: string, toPath: string): void {
  const database = getDb();
  database
    .prepare("UPDATE write_provenance SET path = ? WHERE path = ?")
    .run(toPath, fromPath);
}

/**
 * Restore a provenance row verbatim (including its original written_at
 * timestamp). Used by atomic batch rollback to return the table to its
 * pre-batch state on failure. Regular writes should use recordWrite instead,
 * which uses the current wall-clock for written_at.
 */
export function setProvenanceRow(row: ProvenanceRow): void {
  const database = getDb();
  database
    .prepare(
      `INSERT INTO write_provenance (path, source_hash, commit_sha, actor, written_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         source_hash = excluded.source_hash,
         commit_sha = excluded.commit_sha,
         actor = excluded.actor,
         written_at = excluded.written_at`,
    )
    .run(row.path, row.source_hash, row.commit_sha, row.actor, row.written_at);
}

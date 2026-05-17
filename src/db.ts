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
  // Block-and-retry on writer contention instead of throwing SQLITE_BUSY.
  // Multiple grove-server-<slug> + grove-proxy + grove-discovery-<slug>
  // processes share this db file; without a busy timeout the second
  // writer to hit a schema-lock window crashes immediately, which is how
  // tonight's migration race manifested as PM2 restart loops.
  db.pragma("busy_timeout = 5000");
  // Safe with WAL — fsyncs at checkpoints rather than every commit. ~3-5×
  // faster commits, no durability change for our use case (every write
  // also goes through git, so a power-loss-only-loses-the-most-recent-tx
  // window is bounded by the next git commit anyway).
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * Close the database connection (for tests/cleanup).
 *
 * Best-effort `wal_checkpoint(TRUNCATE)` before close to keep the WAL
 * sidecar from growing unbounded across PM2 reload cycles. Other procs
 * may still be writing — TRUNCATE is allowed to fail silently in that
 * case (it just becomes a PASSIVE checkpoint).
 */
export function closeDb(): void {
  if (db) {
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // best-effort — concurrent writers can block TRUNCATE; not fatal
    }
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
  server_port INTEGER,
  discovery_port INTEGER,
  UNIQUE(owner_id, slug)
);

CREATE TABLE IF NOT EXISTS vault_members (
  user_id TEXT NOT NULL REFERENCES users(id),
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  role TEXT NOT NULL CHECK(role IN ('owner', 'member', 'viewer')),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT,
  PRIMARY KEY (user_id, vault_id)
);
CREATE INDEX IF NOT EXISTS idx_vault_members_user ON vault_members(user_id);
CREATE INDEX IF NOT EXISTS idx_vault_members_vault ON vault_members(vault_id);

CREATE TABLE IF NOT EXISTS vault_usage_daily (
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  date TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  writes INTEGER NOT NULL DEFAULT 0,
  embed_tokens INTEGER NOT NULL DEFAULT 0,
  search_queries INTEGER NOT NULL DEFAULT 0,
  bytes_stored INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vault_id, date)
);
CREATE INDEX IF NOT EXISTS idx_vault_usage_date ON vault_usage_daily(date);

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
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  max_views INTEGER,
  view_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  revoked_by TEXT REFERENCES users(id),
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
-- vault_id index is created in migrateSharedLinksVaultId so pre-P20
-- databases (without the column yet) don't fail the initial schema exec.

CREATE TABLE IF NOT EXISTS discovery_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  trigger TEXT NOT NULL,
  queued_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'batched', 'done', 'error')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  batch_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_discovery_queue_status ON discovery_queue(status, queued_at);
-- idx_discovery_queue_batch_id is created in migrateDiscoveryQueueBatch so
-- pre-P7-COST-5 databases (without the column yet) don't fail the initial
-- schema exec.

-- P7-COST-5: tracks Anthropic Message Batches submitted by the discovery
-- worker. One row per batch - many discovery_queue rows can carry the
-- same batch_id. status follows Anthropic processing_status plus
-- terminal bookkeeping values (ended, expired, canceled, errored).
-- Index supports the worker find-open-batches poll query.
CREATE TABLE IF NOT EXISTS discovery_batches (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','ended','expired','canceled','errored')),
  row_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discovery_batches_status ON discovery_batches(status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_discovery_batches_vault ON discovery_batches(vault_id, status);

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
  resolved_at TEXT,
  vault_id TEXT NOT NULL DEFAULT 'vault_00000000'
);

CREATE INDEX IF NOT EXISTS idx_health_flags_type ON graph_health_flags(flag_type, resolved_at);
CREATE INDEX IF NOT EXISTS idx_flags_unresolved ON graph_health_flags(resolved_at, created_at);
-- The unique-tuple index is created in migrateMultiVault so it can
-- include vault_id on both fresh installs and pre-P8 databases (where
-- the column doesn't exist yet at SCHEMA-exec time).

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

-- Per-note blame cache. Computed on demand by the get/query/list read paths
-- via git blame plus Provenance-* trailer parse from each blame commit.
-- Keyed by (path, source_hash); when the source_hash changes on the next
-- write, a new row is computed and the old row becomes unreachable but
-- harmless (cleaned by periodic vacuum). No active invalidation — the
-- natural source_hash rotation handles it.
CREATE TABLE IF NOT EXISTS note_blame (
  path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  blame_json TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (path, source_hash)
);
CREATE INDEX IF NOT EXISTS idx_note_blame_computed_at ON note_blame(computed_at);

CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'unknown',
  ip TEXT,
  user_agent TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_waitlist_created_at ON waitlist(created_at);

-- P7-COST-4a — daily Anthropic admin API usage_report rollup.
-- Populated by scripts/cost-ingest.sh (cron 06:00 UTC) and read by the
-- watchdog Signal 5 to alert when yesterday spend crosses a threshold.
-- estimated_cost_usd is NULL when the model is unknown to the pricing
-- table (Anthropic currently returns null for model in many responses;
-- we store the literal "unknown" so the row is still useful for token
-- accounting even when we cannot price it).
CREATE TABLE IF NOT EXISTS discovery_cost_daily (
  day TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_1h_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (day, api_key_id, model)
);
CREATE INDEX IF NOT EXISTS idx_cost_daily_day ON discovery_cost_daily(day);
CREATE INDEX IF NOT EXISTS idx_cost_daily_key ON discovery_cost_daily(api_key_id, day);

-- P7-COST-3: per-(vault, path, content_sha256, cache_version) cache of
-- discovery-extract results. Lets identical-content re-saves (typo fixes,
-- cron re-enqueues, idempotent writes) short-circuit the Anthropic call.
-- Invalidated by bumping DISCOVERY_CACHE_VERSION in src/discovery-extract.ts
-- (any change to model, tool schema, prompt prefix, or ExtractionResult shape
-- requires a bump in the same commit). Manual flush via flushDiscoveryCache().
CREATE TABLE IF NOT EXISTS discovery_cache (
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  cache_version INTEGER NOT NULL,
  model TEXT NOT NULL,
  result_json TEXT NOT NULL,
  cached_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (vault_id, path, content_sha256, cache_version)
);
CREATE INDEX IF NOT EXISTS idx_discovery_cache_cached_at ON discovery_cache(cached_at);
CREATE INDEX IF NOT EXISTS idx_discovery_cache_path ON discovery_cache(vault_id, path);
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
  migrateSharedLinksVaultId(database);
  migrateMultiVault(database);
  migrateVaultMembersBackfill(database);
  migrateApiKeyVaultId(database);
  migrateVaultProvenanceRequired(database);
  migrateDiscoveryQueueBatch(database);
  migrateVaultBootstrapPending(database);
  migrateNoteBlameVaultId(database);
}

/**
 * P8-B3 follow-up — backfill `api_keys.vault_id`.
 *
 * Historically `api_keys.vault_id` stored the legacy slug string (e.g.
 * `"life"`), and the P8-A1 multi-vault migration renamed that slug to
 * `"personal"` without updating api_keys. The column was meant to carry
 * the canonical `vaults.id` UUID (that's what `vault_members.vault_id`,
 * `vault_keys.vault_id`, and `resolveAdminVaultId` all expect) — once
 * MRU tracking landed (17f1ede), the mismatch surfaced as
 * `UPDATE vault_members WHERE vault_id = 'life'` matching zero rows and
 * `last_active_at` staying NULL forever.
 *
 * Idempotent:
 *   1. If any api_keys row has a vault_id that does NOT appear in
 *      `vaults.id`, try to resolve it via `vaults.slug` (covers both
 *      the legacy `"life"` value and keys minted with the slug form).
 *   2. If that fails, fall back to the single default vault — pre-P8
 *      installs only had one vault (`vault_00000000`) so this is the
 *      right target for any orphan.
 */
function migrateApiKeyVaultId(database: Database.Database): void {
  // Bail if api_keys doesn't exist (fresh install paths may call this
  // out of order — defense in depth).
  const exists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'")
    .get();
  if (!exists) return;

  const orphans = database
    .prepare(
      `SELECT id, vault_id
         FROM api_keys
        WHERE vault_id NOT IN (SELECT id FROM vaults)`,
    )
    .all() as Array<{ id: string; vault_id: string }>;
  if (orphans.length === 0) return;

  const fallback = database
    .prepare("SELECT id FROM vaults ORDER BY created_at ASC LIMIT 1")
    .get() as { id: string } | undefined;
  if (!fallback) return; // No vaults at all — nothing we can do.

  const resolveBySlug = database.prepare("SELECT id FROM vaults WHERE slug = ?");
  const updateKey = database.prepare("UPDATE api_keys SET vault_id = ? WHERE id = ?");

  const tx = database.transaction(() => {
    for (const k of orphans) {
      const match = resolveBySlug.get(k.vault_id) as { id: string } | undefined;
      updateKey.run(match?.id ?? fallback.id, k.id);
    }
  });
  tx();

  const stillBad = database
    .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE vault_id NOT IN (SELECT id FROM vaults)")
    .get() as { n: number };
  if (stillBad.n > 0) {
    throw new Error(
      `[db] api_keys.vault_id backfill left ${stillBad.n} orphan(s) — migration failed`,
    );
  }
}

/**
 * P8-B1 — populate `vault_members` with one row per existing user for the
 * default vault. Idempotent: skipped once the table already has rows.
 *
 * Role source is `users.role` (still present on the users table; a separate
 * later release will drop it). Admin / owner → owner; everyone else → member.
 */
function migrateVaultMembersBackfill(database: Database.Database): void {
  const tableExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vault_members'")
    .get();
  if (!tableExists) return;

  const existing = database
    .prepare("SELECT COUNT(*) as c FROM vault_members")
    .get() as { c: number };
  if (existing.c > 0) return;

  const userCols = database.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  const hasRole = userCols.some((c) => c.name === "role");
  const defaultVault = database
    .prepare("SELECT id FROM vaults WHERE slug = 'personal' OR slug = 'life' ORDER BY CASE slug WHEN 'personal' THEN 0 ELSE 1 END LIMIT 1")
    .get() as { id: string } | undefined;
  if (!defaultVault) return;

  const users = database
    .prepare(hasRole ? "SELECT id, role FROM users" : "SELECT id FROM users")
    .all() as Array<{ id: string; role?: string }>;

  const insert = database.prepare(
    "INSERT OR IGNORE INTO vault_members (user_id, vault_id, role) VALUES (?, ?, ?)",
  );
  const tx = database.transaction(() => {
    for (const u of users) {
      const role = (u.role === "owner" || u.role === "admin") ? "owner"
        : u.role === "viewer" ? "viewer"
        : "member";
      insert.run(u.id, defaultVault.id, role);
    }
  });
  tx();
}

/**
 * P8-A1 multi-vault migration. Idempotent.
 *
 * - vaults: add server_port + discovery_port (both UNIQUE via indexes)
 * - vaults: backfill the existing row with server_port=8190, discovery_port=8091
 *   and rename the default slug from "life" → "personal" so URLs match the
 *   multi-vault convention documented in PLAN.md
 * - vaults: add globally UNIQUE index on slug (replaces owner-scoped uniqueness)
 * - discovery_queue / discovery_results / graph_health / graph_health_flags:
 *   add vault_id (defaults to the personal vault)
 * - vault_members: new table (populated in P8-B1)
 * - vault_usage_daily: new table for per-vault observability counters
 *
 * SQLite doesn't enforce FKs declared via ALTER TABLE ADD COLUMN — that's
 * a known engine limitation, not a bug in this migration. For safety we
 * run PRAGMA foreign_key_check after the migration and throw on any dangling
 * reference; the NOT NULL DEFAULT 'vault_00000000' keeps existing data aligned.
 */
function migrateMultiVault(database: Database.Database): void {
  // Always idempotently ensure the unique indexes exist (works for both fresh
  // installs where the columns exist in CREATE TABLE and existing DBs where
  // we ALTER TABLE to add them below).
  const tx = database.transaction(() => {
    const vaultsCols = database.prepare("PRAGMA table_info(vaults)").all() as { name: string }[];
    const hasServerPort = vaultsCols.some((c) => c.name === "server_port");
    const hasDiscoveryPort = vaultsCols.some((c) => c.name === "discovery_port");
    if (!hasServerPort) database.exec(`ALTER TABLE vaults ADD COLUMN server_port INTEGER`);
    if (!hasDiscoveryPort) database.exec(`ALTER TABLE vaults ADD COLUMN discovery_port INTEGER`);

    database.exec(
      `UPDATE vaults
         SET server_port = 8190, discovery_port = 8091
       WHERE id = 'vault_00000000' AND server_port IS NULL`,
    );
    database.exec(
      `UPDATE vaults SET slug = 'personal' WHERE id = 'vault_00000000' AND slug = 'life'`,
    );

    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vaults_slug ON vaults(slug)`);
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vaults_server_port ON vaults(server_port) WHERE server_port IS NOT NULL`);
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vaults_discovery_port ON vaults(discovery_port) WHERE discovery_port IS NOT NULL`);

    for (const table of ["discovery_queue", "discovery_results", "graph_health", "graph_health_flags"]) {
      const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === "vault_id")) {
        // SQLite refuses ALTER TABLE ADD COLUMN with both REFERENCES and a
        // non-NULL default, and it doesn't enforce FKs declared on ADD COLUMN
        // anyway (only FKs declared in CREATE TABLE are enforced). Skip the
        // REFERENCES clause — the NOT NULL + backfill default keeps data
        // integrity via the application layer + fresh-install CREATE TABLE.
        database.exec(
          `ALTER TABLE ${table}
             ADD COLUMN vault_id TEXT NOT NULL DEFAULT 'vault_00000000'`,
        );
      }
      database.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_vault ON ${table}(vault_id)`);
    }

    // Build (or rebuild) the graph_health_flags unique-tuple index with
    // vault_id included so two vaults can each hold the same
    // (flag_type, source_path, target_path) tuple without one silently
    // losing its insert via ON CONFLICT DO NOTHING. Idempotent in both
    // directions: pre-P8 DBs without the column have just had it added
    // above; older deployments may carry the index in its non-scoped
    // form and need it dropped first.
    const flagsIdx = database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_health_flags_unique'",
      )
      .get() as { sql: string | null } | undefined;
    const indexHasVaultScope = flagsIdx?.sql ? /\bvault_id\b/.test(flagsIdx.sql) : false;
    if (flagsIdx && !indexHasVaultScope) {
      database.exec(`DROP INDEX idx_health_flags_unique`);
    }
    database.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_health_flags_unique
         ON graph_health_flags(vault_id, flag_type, coalesce(source_path, ''), coalesce(target_path, ''))
         WHERE resolved_at IS NULL`,
    );

    database.exec(`
      CREATE TABLE IF NOT EXISTS vault_members (
        user_id TEXT NOT NULL REFERENCES users(id),
        vault_id TEXT NOT NULL REFERENCES vaults(id),
        role TEXT NOT NULL CHECK(role IN ('owner', 'member', 'viewer')),
        joined_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_active_at TEXT,
        PRIMARY KEY (user_id, vault_id)
      );
      CREATE INDEX IF NOT EXISTS idx_vault_members_user ON vault_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_vault_members_vault ON vault_members(vault_id);
    `);

    database.exec(`
      CREATE TABLE IF NOT EXISTS vault_usage_daily (
        vault_id TEXT NOT NULL REFERENCES vaults(id),
        date TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        writes INTEGER NOT NULL DEFAULT 0,
        embed_tokens INTEGER NOT NULL DEFAULT 0,
        search_queries INTEGER NOT NULL DEFAULT 0,
        bytes_stored INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (vault_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_vault_usage_date ON vault_usage_daily(date);
    `);
  });
  tx();

  const fkCheck = database.prepare("PRAGMA foreign_key_check").all();
  if (fkCheck.length > 0) {
    throw new Error(`[db] multi-vault migration left dangling FKs: ${JSON.stringify(fkCheck)}`);
  }
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

/**
 * Add `vault_id` to shared_links so share resolution routes to the right
 * vault. Pre-P20 shares have no vault association at all — the resolver
 * was serving every share through the proxy's default vault context,
 * which is how a test-vault share could render a Personal note. Backfill
 * legacy rows to the creator's earliest `vault_members` entry so their
 * existing share URLs keep resolving (to whatever vault they almost
 * certainly came from, which was personal before multi-vault existed).
 */
function migrateSharedLinksVaultId(database: Database.Database): void {
  const cols = database
    .prepare("PRAGMA table_info(shared_links)")
    .all() as { name: string }[];
  if (cols.length === 0) return;
  if (cols.some((c) => c.name === "vault_id")) return;

  const tx = database.transaction(() => {
    database.exec("ALTER TABLE shared_links ADD COLUMN vault_id TEXT REFERENCES vaults(id)");
    // Backfill from the creator's earliest vault membership.
    database.exec(`
      UPDATE shared_links
         SET vault_id = (
           SELECT vm.vault_id
             FROM vault_members vm
            WHERE vm.user_id = shared_links.created_by
            ORDER BY vm.joined_at ASC
            LIMIT 1
         )
       WHERE vault_id IS NULL
    `);
    database.exec(
      "CREATE INDEX IF NOT EXISTS idx_shared_links_vault ON shared_links(vault_id)",
    );
  });
  tx();

  // Surface any rows we couldn't backfill (creator has no memberships) —
  // those shares now fail closed (404 on resolve) instead of leaking.
  const orphans = database
    .prepare("SELECT COUNT(*) AS n FROM shared_links WHERE vault_id IS NULL")
    .get() as { n: number };
  if (orphans.n > 0) {
    console.warn(
      `[db] ${orphans.n} shared_links have no backfillable vault_id — those share URLs will 404`,
    );
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
 * P7-COST-5 — add `batch_id` column to discovery_queue and rebuild the
 * status CHECK to allow `'batched'`. Also adds the `discovery_batches`
 * tracking table on existing DBs (fresh installs get it via SCHEMA).
 *
 * Idempotent. SQLite can't add a value to an in-place CHECK, so we
 * detect via SQL inspection of `sqlite_master` and rebuild only when
 * needed. Adding the column is a plain ALTER (nullable, no default).
 */
function migrateDiscoveryQueueBatch(database: Database.Database): void {
  const exists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discovery_queue'")
    .get();
  if (!exists) return;

  const cols = database
    .prepare("PRAGMA table_info(discovery_queue)")
    .all() as { name: string }[];
  const hasBatchId = cols.some((c) => c.name === "batch_id");

  const tableSql = database
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='discovery_queue'")
    .get() as { sql: string } | undefined;
  // Detect whether the CHECK constraint already includes 'batched'. The
  // CHECK is part of the CREATE TABLE SQL recorded in sqlite_master.
  const checkAllowsBatched = tableSql?.sql.includes("'batched'") ?? false;

  if (hasBatchId && checkAllowsBatched) {
    // Still ensure the table + indexes exist on every call so an older
    // deployment that ran the column-add path before this code shipped
    // still gets the discovery_batches surface.
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_discovery_queue_batch_id ON discovery_queue(batch_id)`,
    );
    ensureDiscoveryBatchesTable(database);
    return;
  }

  const tx = database.transaction(() => {
    if (!checkAllowsBatched) {
      // Rebuild discovery_queue with the wider CHECK and the batch_id
      // column in one pass. Preserve every existing row including
      // vault_id (added by migrateMultiVault) and any other columns we
      // may have picked up over time.
      const colNames = cols.map((c) => c.name);
      const hasVaultId = colNames.includes("vault_id");

      // Build the CREATE/INSERT SQL dynamically so this works whether or
      // not vault_id is present on the source table — migrateMultiVault
      // may or may not have run yet at this point.
      const newTableCols = [
        "id INTEGER PRIMARY KEY AUTOINCREMENT",
        "path TEXT NOT NULL",
        "trigger TEXT NOT NULL",
        "queued_at TEXT NOT NULL DEFAULT (datetime('now'))",
        "processed_at TEXT",
        "status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'batched', 'done', 'error'))",
        "attempts INTEGER NOT NULL DEFAULT 0",
        "error_message TEXT",
        "batch_id TEXT",
      ];
      if (hasVaultId) {
        newTableCols.push("vault_id TEXT NOT NULL DEFAULT 'vault_00000000'");
      }
      database.exec(`
        CREATE TABLE discovery_queue_new (
          ${newTableCols.join(",\n          ")}
        );
      `);
      const copyCols = ["id", "path", "trigger", "queued_at", "processed_at", "status", "attempts", "error_message"];
      if (hasVaultId) copyCols.push("vault_id");
      // batch_id is new — leave NULL on existing rows.
      database.exec(`
        INSERT INTO discovery_queue_new (${copyCols.join(", ")})
          SELECT ${copyCols.join(", ")} FROM discovery_queue;
        DROP TABLE discovery_queue;
        ALTER TABLE discovery_queue_new RENAME TO discovery_queue;
        CREATE INDEX IF NOT EXISTS idx_discovery_queue_status ON discovery_queue(status, queued_at);
        CREATE INDEX IF NOT EXISTS idx_discovery_queue_batch_id ON discovery_queue(batch_id);
      `);
      if (hasVaultId) {
        database.exec(
          `CREATE INDEX IF NOT EXISTS idx_discovery_queue_vault ON discovery_queue(vault_id)`,
        );
      }
    } else if (!hasBatchId) {
      // CHECK already allows 'batched' (unlikely but possible if a
      // sibling migration shipped first) — just add the column.
      database.exec(`ALTER TABLE discovery_queue ADD COLUMN batch_id TEXT`);
      database.exec(
        `CREATE INDEX IF NOT EXISTS idx_discovery_queue_batch_id ON discovery_queue(batch_id)`,
      );
    }

    ensureDiscoveryBatchesTable(database);
  });
  tx();
}

function ensureDiscoveryBatchesTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS discovery_batches (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','ended','expired','canceled','errored')),
      row_count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_discovery_batches_status ON discovery_batches(status, submitted_at);
    CREATE INDEX IF NOT EXISTS idx_discovery_batches_vault ON discovery_batches(vault_id, status);
  `);
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

/**
 * Phase C2: per-vault `provenance_required` column on `vaults` table.
 * When set to 1 / true, the ecosystem generator emits
 * `GROVE_REQUIRE_PROVENANCE_<slug>=true` on grove-proxy AND a global
 * `GROVE_REQUIRE_PROVENANCE=true` on the per-vault server. Default 0 —
 * tenants opt in via `grove vault set-provenance-required <slug> true`.
 *
 * Migration is idempotent and seeds the personal vault (slug=personal)
 * to true so the prior hardcoded behavior is preserved.
 */
function migrateVaultProvenanceRequired(database: Database.Database): void {
  const exists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vaults'")
    .get();
  if (!exists) return;
  const cols = database.prepare("PRAGMA table_info(vaults)").all() as { name: string }[];
  if (cols.some((c) => c.name === "provenance_required")) return;
  database.exec(
    "ALTER TABLE vaults ADD COLUMN provenance_required INTEGER NOT NULL DEFAULT 0",
  );
  // Preserve the prior hardcoded slug==="personal" behavior — the
  // ecosystem generator already enabled the flag for personal in
  // PR #136. Without seeding, regenerating with the new code path
  // would silently disable strict mode on personal until the operator
  // ran `grove vault set-provenance-required personal true`.
  database.exec("UPDATE vaults SET provenance_required = 1 WHERE slug = 'personal'");
}

/**
 * P23-1: `bootstrap_pending` column on `vaults`.
 *
 * Set to 1 by `vault-provision.ts` immediately after a vault is created;
 * the per-vault scheduler clears it after running `bootstrapFirstRun` on
 * its boot pass or the next 1-minute tick. Replaces the prior inline-LLM
 * call inside provision (Phase 23 revision note #2) — the user sees
 * `state='running'` on the first review item within ~60s of vault-create
 * instead of provisioning blocking on a synchronous Claude call.
 */
function migrateVaultBootstrapPending(database: Database.Database): void {
  const exists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vaults'")
    .get();
  if (!exists) return;
  const cols = database.prepare("PRAGMA table_info(vaults)").all() as { name: string }[];
  if (cols.some((c) => c.name === "bootstrap_pending")) return;
  database.exec(
    "ALTER TABLE vaults ADD COLUMN bootstrap_pending INTEGER NOT NULL DEFAULT 0",
  );
}

/**
 * Add `vault_id` column to `note_blame` so blame lookups can be scoped
 * to the requesting vault. Rows written before this migration have
 * `vault_id = NULL` — they act as unscoped legacy entries and are
 * returned only when no vault-scoped row matches (see `getNoteBlame` and
 * `readBlameForNote`). The cross-vault leak in readBlameForNote was that
 * `ORDER BY computed_at DESC LIMIT 1` could return Vault B's blame row
 * when Vault A had the same note path. After this migration, queries that
 * supply a vault_id prefer scoped rows, eliminating the leak.
 */
function migrateNoteBlameVaultId(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info(note_blame)").all() as { name: string }[];
  if (cols.some((c) => c.name === "vault_id")) return;
  database.exec("ALTER TABLE note_blame ADD COLUMN vault_id TEXT");
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_note_blame_vault_id ON note_blame(vault_id) WHERE vault_id IS NOT NULL",
  );
}

/** Add display_name column to existing users tables that lack it (P15-1). */
function migrateUserDisplayName(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (cols.some((c) => c.name === "display_name")) return;
  database.exec("ALTER TABLE users ADD COLUMN display_name TEXT");
}

/**
 * Schema version recorded in `_migration_state` after a successful run.
 * Bump this when adding a new migrate*() function to `createSchema()` —
 * processes that already wrote the previous version short-circuit; the
 * higher-version process will re-acquire the lock and run.
 */
const SCHEMA_VERSION = 1;

/**
 * Migrate from JSON files to SQLite, then run all schema migrations.
 *
 * Idempotent: if grove.db already has data, this is a no-op.
 * Serialized across concurrent processes via BEGIN IMMEDIATE +
 * `_migration_state` — multiple grove-server-* + grove-proxy +
 * grove-discovery-* processes all call this on startup against the
 * same db file. Without serialization the destructive DROP+RENAME
 * paths in `migrateSharedLinks` and `migrateDiscoveryQueue` race
 * with each other, and the migration as a whole hits SQLITE_BUSY
 * on the COMMIT — that's the failure mode that drove the 2026-04-28
 * orphan PM2 restart loop.
 */
export function runMigration(): void {
  const database = getDb();

  // Bootstrap the sentinel table outside the serialized region. CREATE
  // TABLE IF NOT EXISTS is idempotent and safe under contention.
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migration_state (
      id INTEGER PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Fast path — check version BEFORE acquiring the writer lock. Under
  // cold-start contention (N schedulers + N servers + N discovery +
  // proxy all calling runMigration() in parallel), the first process
  // to win the lock can take >5s through migrateMultiVault's
  // ALTER/UPDATE chain. Subsequent processes time out on busy_timeout
  // and crash with SQLITE_BUSY. Skipping the lock entirely when the
  // schema is already at target version stops the cascade.
  //
  // Race: between this check and tx.immediate() below another process
  // could finish the migration. That's harmless — the IMMEDIATE wrap
  // serializes work, and createSchema is internally idempotent. We do
  // a second check inside the transaction body for the same reason.
  const fastState = database
    .prepare("SELECT schema_version FROM _migration_state WHERE id = 1")
    .get() as { schema_version: number } | undefined;
  if (fastState && fastState.schema_version >= SCHEMA_VERSION) return;

  // BEGIN IMMEDIATE acquires the writer lock at transaction start, so
  // contending processes block on getDb's busy_timeout (5s) instead of
  // hammering each other into SQLITE_BUSY restart loops.
  const tx = database.transaction(() => runMigrationBody(database));
  tx.immediate();
}

function runMigrationBody(database: Database.Database): void {
  // Inside the IMMEDIATE lock — check whether we're already at the
  // target schema version. If so, another process already ran the
  // migration; we're done. (Each individual migrate*() is idempotent,
  // but skipping the work avoids hundreds of redundant PRAGMA reads
  // across N restart cycles.)
  const state = database
    .prepare("SELECT schema_version FROM _migration_state WHERE id = 1")
    .get() as { schema_version: number } | undefined;
  const alreadyMigrated = state !== undefined && state.schema_version >= SCHEMA_VERSION;

  createSchema();

  // Check if we already have data (JSON-to-SQLite migration already ran)
  const keyCount = database.prepare("SELECT COUNT(*) as count FROM api_keys").get() as { count: number };
  if (keyCount.count > 0) {
    recordMigrationVersion(database, alreadyMigrated);
    return;
  }

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
    ).run("vault_00000000", adminId, "personal", "Personal", join(homedir(), "life"));
    recordMigrationVersion(database, alreadyMigrated);
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
    ).run("vault_00000000", adminId, "personal", "Personal", join(homedir(), "life"));

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

  recordMigrationVersion(database, alreadyMigrated);
}

/**
 * Stamp the schema version into _migration_state. Skipped if a prior
 * process already wrote the same version — keeps `updated_at` honest
 * about who actually ran the migration.
 */
function recordMigrationVersion(database: Database.Database, alreadyMigrated: boolean): void {
  if (alreadyMigrated) return;
  database
    .prepare(
      `INSERT OR REPLACE INTO _migration_state (id, schema_version, updated_at)
         VALUES (1, ?, datetime('now'))`,
    )
    .run(SCHEMA_VERSION);
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
  status: "pending" | "processing" | "batched" | "done" | "error";
  attempts: number;
  error_message: string | null;
  batch_id: string | null;
}

/** Resolve the vault_id that discovery rows should be written under. */
function resolveVaultIdFromEnv(): string {
  return process.env.GROVE_VAULT_ID ?? "vault_00000000";
}

/**
 * Enqueue a path for discovery processing.
 *
 * `vaultId` defaults to `$GROVE_VAULT_ID` (set by PM2 for per-vault
 * discovery workers and grove-server instances) and falls back to the
 * personal vault's id for code paths that don't know any better — notably
 * the shared proxy, which still services only the personal vault for
 * REST writes until vault-scoped REST lands.
 *
 * **Dedup**: if a row for the same (vault_id, path, trigger) is already
 * `pending` or `processing`, the new enqueue is skipped and `false` is
 * returned. This prevents the back-to-back-extraction amplification we saw
 * in 2026-05 (PR #140) where a stable `HEAD~1` cron diff plus rapid
 * REST writes pushed the same path into the queue 4–7 times before the
 * worker drained it. Dedup is safe because the in-flight extraction
 * always reads the file fresh from disk — if the note changed again
 * between the two enqueues, the running extraction picks up the latest
 * content. Once an entry transitions to `done` or `error`, a subsequent
 * enqueue for the same path is allowed through.
 *
 * Returns `true` if a row was inserted, `false` if it was deduped.
 */
export function enqueueDiscovery(
  path: string,
  trigger: DiscoveryTrigger,
  vaultId: string = resolveVaultIdFromEnv(),
): boolean {
  const database = getDb();

  // P7-COST-2 cooldown: refuse to re-enqueue if same (vault_id, path) was
  // successfully processed within the last N minutes. Collapses edit storms
  // (typo-fix → save → typo-fix → save) into a single extraction. Errors
  // are NOT cooled down so transient Anthropic 5xx doesn't lock a path out.
  // Keyed on (vault_id, path) only so different triggers for the same path
  // collapse together — cooldown is content-based, not trigger-based.
  const cooldownRaw = process.env.GROVE_DISCOVERY_COOLDOWN_MIN;
  const cooldownMin = cooldownRaw === undefined ? 5 : Number.parseInt(cooldownRaw, 10);
  if (Number.isFinite(cooldownMin) && cooldownMin > 0) {
    const recent = database
      .prepare(
        `SELECT id FROM discovery_queue
          WHERE vault_id = ? AND path = ?
            AND status = 'done'
            AND processed_at > datetime('now', ?)
          LIMIT 1`,
      )
      .get(vaultId, path, `-${cooldownMin} minutes`) as { id: number } | undefined;
    if (recent) {
      return false;
    }
  }

  const existing = database
    .prepare(
      `SELECT id FROM discovery_queue
        WHERE vault_id = ? AND path = ? AND trigger = ?
          AND status IN ('pending', 'processing')
        LIMIT 1`,
    )
    .get(vaultId, path, trigger) as { id: number } | undefined;
  if (existing) {
    return false;
  }
  database
    .prepare(
      "INSERT INTO discovery_queue (path, trigger, vault_id) VALUES (?, ?, ?)",
    )
    .run(path, trigger, vaultId);
  return true;
}

/**
 * P7-COST-1: count rows for this vault that completed (`done` or `error`)
 * today (UTC). Used by the discovery worker to enforce
 * `GROVE_DISCOVERY_DAILY_CAP`.
 *
 * `date('now')` returns the current UTC date in SQLite. Counting `error`
 * alongside `done` is intentional: a failed extraction still cost Anthropic
 * tokens, so it counts against the budget. Otherwise a vault stuck in a
 * retry loop could blow through the cap without it ever firing.
 */
export function countTodayProcessed(
  vaultId: string = resolveVaultIdFromEnv(),
): number {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT COUNT(*) AS n FROM discovery_queue
        WHERE vault_id = ?
          AND processed_at >= date('now')
          AND status IN ('done', 'error')`,
    )
    .get(vaultId) as { n: number };
  return row.n;
}

/**
 * Claim the next pending entry for processing (atomic status flip).
 *
 * `vaultId` scopes the dequeue so per-vault discovery workers don't race
 * on one another's queue entries. Defaults to `$GROVE_VAULT_ID` (or the
 * personal vault id) when callers — like in-process tests — don't know
 * better. Production workers always pass their pinned vault_id.
 */
export function dequeueDiscovery(vaultId: string = resolveVaultIdFromEnv()): DiscoveryQueueEntry | null {
  const database = getDb();
  const row = database
    .prepare(
      `UPDATE discovery_queue
         SET status = 'processing', attempts = attempts + 1
       WHERE id = (
         SELECT id FROM discovery_queue
         WHERE status = 'pending' AND vault_id = ?
         ORDER BY queued_at ASC
         LIMIT 1
       )
       RETURNING *`,
    )
    .get(vaultId) as DiscoveryQueueEntry | undefined;
  return row ?? null;
}

/**
 * P7-COST-5 urgent-only dequeue. Skips `trigger='commit'` rows so that
 * cron-driven extractions stay in the batch path. Used by the discovery
 * worker's realtime drain; `dequeueDiscovery` (no filter) is kept for
 * back-compat with code paths that don't differentiate.
 */
export function dequeueDiscoveryUrgent(
  vaultId: string = resolveVaultIdFromEnv(),
): DiscoveryQueueEntry | null {
  const database = getDb();
  const row = database
    .prepare(
      `UPDATE discovery_queue
         SET status = 'processing', attempts = attempts + 1
       WHERE id = (
         SELECT id FROM discovery_queue
         WHERE status = 'pending' AND vault_id = ? AND trigger != 'commit'
         ORDER BY queued_at ASC
         LIMIT 1
       )
       RETURNING *`,
    )
    .get(vaultId) as DiscoveryQueueEntry | undefined;
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
 * Reset rows stuck in 'processing' for `vaultId` back to 'pending'.
 *
 * A row enters 'processing' via `dequeueDiscovery` and exits via
 * `markDiscoveryDone` / `markDiscoveryError`. When the worker dies
 * mid-tick (SIGINT during a deploy, OOM, host reboot), the row stays
 * 'processing' forever — the next worker only claims 'pending' rows,
 * so the entry is silently abandoned.
 *
 * Called once on `startDiscoveryLoop` startup. Safe because each vault
 * has exactly one discovery worker (pinned via PM2's per-vault
 * `GROVE_VAULT_ID`), so at startup no sibling holds a 'processing' row
 * for this vault. Returns the number of rows recovered.
 */
export function recoverOrphanedDiscoveryProcessing(
  vaultId: string = resolveVaultIdFromEnv(),
): number {
  const database = getDb();
  const result = database
    .prepare(
      "UPDATE discovery_queue SET status = 'pending' WHERE status = 'processing' AND vault_id = ?",
    )
    .run(vaultId);
  return result.changes;
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

/**
 * Count pending entries in the queue.
 *
 * Scoped to `vaultId` so per-vault status surfaces (MCP `vault_status`,
 * REST `/v1/health`) report only their own queue depth.
 */
export function discoveryQueueDepth(vaultId: string = resolveVaultIdFromEnv()): number {
  const database = getDb();
  const row = database
    .prepare(
      "SELECT COUNT(*) as count FROM discovery_queue WHERE status = 'pending' AND vault_id = ?",
    )
    .get(vaultId) as { count: number };
  return row.count;
}

// ── Discovery batch (P7-COST-5) ──────────────────────────────────────

export interface DiscoveryBatchRow {
  id: string;
  vault_id: string;
  submitted_at: string;
  completed_at: string | null;
  status: "submitted" | "ended" | "expired" | "canceled" | "errored";
  row_count: number;
}

/**
 * Claim up to `limit` batch-eligible rows: pending, trigger='commit',
 * attempts=0, scoped to `vaultId`. Returns the rows in queue order
 * (oldest first). Atomic via a single UPDATE … RETURNING so two
 * concurrent claims can't grab the same row.
 *
 * The rows are NOT flipped to 'batched' yet — that happens in
 * `markRowsBatched` once the Anthropic POST succeeds and we have a
 * `batch_id` to record. Until then the rows stay 'pending' so that a
 * failed submit doesn't strand them.
 */
export function claimBatchEligible(
  vaultId: string = resolveVaultIdFromEnv(),
  limit: number = 100,
): DiscoveryQueueEntry[] {
  const database = getDb();
  // We don't atomically flip status here — the worker holds the rows
  // by ID through the submit flow. SQLite is single-writer so a
  // sibling claim would only happen across process boundaries, and
  // each vault has exactly one discovery worker pinned via PM2.
  const rows = database
    .prepare(
      `SELECT * FROM discovery_queue
        WHERE status = 'pending'
          AND trigger = 'commit'
          AND attempts = 0
          AND vault_id = ?
        ORDER BY queued_at ASC
        LIMIT ?`,
    )
    .all(vaultId, limit) as DiscoveryQueueEntry[];
  return rows;
}

/**
 * Flip a set of rows to status='batched' and record their `batch_id`.
 * Called once the Anthropic `/v1/messages/batches` POST has returned
 * a batch id. Wrapped in a transaction so partial state can't strand
 * rows mid-flip.
 */
export function markRowsBatched(rowIds: number[], batchId: string): void {
  if (rowIds.length === 0) return;
  const database = getDb();
  const stmt = database.prepare(
    `UPDATE discovery_queue
        SET status = 'batched', batch_id = ?
      WHERE id = ?`,
  );
  const tx = database.transaction(() => {
    for (const id of rowIds) stmt.run(batchId, id);
  });
  tx();
}

/**
 * Insert a new row into `discovery_batches`. Called immediately after
 * `markRowsBatched` so the worker can track open batches across
 * restarts.
 */
export function insertDiscoveryBatch(
  id: string,
  vaultId: string,
  rowCount: number,
): void {
  const database = getDb();
  database
    .prepare(
      `INSERT INTO discovery_batches (id, vault_id, row_count)
         VALUES (?, ?, ?)`,
    )
    .run(id, vaultId, rowCount);
}

/**
 * Return all batches for `vaultId` whose `status='submitted'` — the
 * worker polls these. Older terminal-status rows are kept for audit
 * but excluded from the poll set.
 */
export function listOpenBatches(
  vaultId: string = resolveVaultIdFromEnv(),
): DiscoveryBatchRow[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT * FROM discovery_batches
        WHERE vault_id = ? AND status = 'submitted'
        ORDER BY submitted_at ASC`,
    )
    .all(vaultId) as DiscoveryBatchRow[];
}

/** Return all rows currently associated with a given batch. */
export function getBatchedRows(batchId: string): DiscoveryQueueEntry[] {
  const database = getDb();
  return database
    .prepare(`SELECT * FROM discovery_queue WHERE batch_id = ?`)
    .all(batchId) as DiscoveryQueueEntry[];
}

/**
 * Finalize a `discovery_batches` row. `completed_at` is stamped to
 * `datetime('now')` so audit queries can compute end-to-end latency.
 */
export function finalizeBatch(
  batchId: string,
  status: "ended" | "expired" | "canceled" | "errored",
): void {
  const database = getDb();
  database
    .prepare(
      `UPDATE discovery_batches
          SET status = ?, completed_at = datetime('now')
        WHERE id = ?`,
    )
    .run(status, batchId);
}

/**
 * Flip rows that have been `'batched'` for longer than `maxAgeHours`
 * back to `'pending'` with `trigger='write'` so the urgent path
 * reclaims them. Returns the number of rows recovered.
 *
 * Used by the worker tick as a backstop against Anthropic's 24h SLA
 * being violated (or a `batch_id` getting lost mid-restart). We
 * deliberately don't touch `batch_id` — if the batch later finalizes
 * and the poller sees a duplicate result for an already-reclaimed
 * row, the urgent path's `markDiscoveryDone` will have already moved
 * it to `'done'` and the poller's update silently no-ops.
 */
export function recoverStaleBatched(
  vaultId: string = resolveVaultIdFromEnv(),
  maxAgeHours: number = 26,
): number {
  const database = getDb();
  const result = database
    .prepare(
      `UPDATE discovery_queue
          SET status = 'pending', trigger = 'write'
        WHERE status = 'batched'
          AND vault_id = ?
          AND queued_at < datetime('now', ?)`,
    )
    .run(vaultId, `-${maxAgeHours} hours`);
  return result.changes;
}

// ── Discovery extraction cache (P7-COST-3) ─────────────────────────────

/**
 * Look up a cached discovery-extract result for an exact
 * (vault_id, path, content_sha256, cache_version) tuple. A hit means the
 * same vault, same path, same bytes, and the same prompt/model surface
 * already produced a result — return it and skip the Anthropic call.
 *
 * Returns `null` when no row matches. The caller is responsible for
 * `JSON.parse`ing `result_json` (we deliberately don't here so a corrupt
 * row throws a clear error in the caller's `JSON.parse`, not deep inside
 * the db helper).
 */
export function getCachedExtraction(
  vaultId: string,
  path: string,
  contentSha256: string,
  cacheVersion: number,
): { result_json: string; model: string; cached_at: string } | null {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT result_json, model, cached_at FROM discovery_cache
        WHERE vault_id = ? AND path = ? AND content_sha256 = ? AND cache_version = ?`,
    )
    .get(vaultId, path, contentSha256, cacheVersion) as
    | { result_json: string; model: string; cached_at: string }
    | undefined;
  return row ?? null;
}

/**
 * Persist a discovery-extract result. INSERT OR REPLACE so a re-extraction
 * for the same (vault_id, path, content_sha256, cache_version) tuple just
 * refreshes `cached_at` and `result_json`. Only called from the cache-miss
 * branch in `extractFromNote`, so it never overwrites a successful result
 * with a failed one (failures throw before this is reached).
 */
export function putCachedExtraction(
  vaultId: string,
  path: string,
  contentSha256: string,
  cacheVersion: number,
  model: string,
  resultJson: string,
): void {
  const database = getDb();
  database
    .prepare(
      `INSERT OR REPLACE INTO discovery_cache
         (vault_id, path, content_sha256, cache_version, model, result_json, cached_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(vaultId, path, contentSha256, cacheVersion, model, resultJson);
}

/**
 * Flush rows from `discovery_cache`. Three call shapes:
 *  - `flushDiscoveryCache()` — wipe the whole table (every vault, every path)
 *  - `flushDiscoveryCache(vaultId)` — wipe one vault's rows
 *  - `flushDiscoveryCache(vaultId, path)` — wipe one (vault, path) pair (all
 *    `content_sha256` and `cache_version` rows for it)
 *
 * Returns the number of rows deleted. No-op (returns 0) on a freshly
 * migrated table that hasn't been populated yet.
 */
export function flushDiscoveryCache(vaultId?: string, path?: string): number {
  const database = getDb();
  let result;
  if (vaultId === undefined) {
    result = database.prepare("DELETE FROM discovery_cache").run();
  } else if (path === undefined) {
    result = database
      .prepare("DELETE FROM discovery_cache WHERE vault_id = ?")
      .run(vaultId);
  } else {
    result = database
      .prepare("DELETE FROM discovery_cache WHERE vault_id = ? AND path = ?")
      .run(vaultId, path);
  }
  return result.changes;
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

/**
 * Insert a discovery result.
 *
 * `vaultId` scopes the row so two vaults' workers — both writing into the
 * shared grove.db — don't pile entries into a single global pool. Without
 * it, vault A's `vault_status mode=discovery` would surface vault B's
 * note paths.
 */
export function insertDiscoveryResult(
  id: string,
  sourcePath: string,
  targetPath: string,
  similarity: number,
  relationship: string,
  vaultId: string = resolveVaultIdFromEnv(),
): void {
  const database = getDb();
  database
    .prepare(
      "INSERT INTO discovery_results (id, source_path, target_path, similarity, relationship, vault_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, sourcePath, targetPath, similarity, relationship, vaultId);
}

/**
 * Clear undismissed results for a source path (before re-processing).
 *
 * Scoped to `vaultId` so re-processing a path in vault A doesn't wipe a
 * same-named path's results in vault B.
 */
export function clearUndismissedResults(
  sourcePath: string,
  vaultId: string = resolveVaultIdFromEnv(),
): void {
  const database = getDb();
  database
    .prepare(
      "DELETE FROM discovery_results WHERE source_path = ? AND vault_id = ? AND dismissed_at IS NULL",
    )
    .run(sourcePath, vaultId);
}

/**
 * Get discovery results, optionally filtered by source path.
 *
 * Always scoped to `vaultId` so multi-vault deployments don't leak
 * results across vaults.
 */
export function getDiscoveryResults(
  sourcePath?: string,
  vaultId: string = resolveVaultIdFromEnv(),
): DiscoveryResultRow[] {
  const database = getDb();
  if (sourcePath) {
    return database
      .prepare(
        "SELECT * FROM discovery_results WHERE source_path = ? AND vault_id = ? ORDER BY similarity DESC",
      )
      .all(sourcePath, vaultId) as DiscoveryResultRow[];
  }
  return database
    .prepare(
      "SELECT * FROM discovery_results WHERE vault_id = ? ORDER BY created_at DESC, similarity DESC",
    )
    .all(vaultId) as DiscoveryResultRow[];
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

/**
 * Get recently processed queue entries (most recent first).
 *
 * Scoped to `vaultId` so the per-vault MCP server's `vault_status
 * mode=discovery` only surfaces its own vault's processed paths.
 */
export function getRecentExtractions(
  limit = 20,
  vaultId: string = resolveVaultIdFromEnv(),
): RecentExtraction[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT path, processed_at, trigger
       FROM discovery_queue
       WHERE status = 'done' AND processed_at IS NOT NULL AND vault_id = ?
       ORDER BY processed_at DESC
       LIMIT ?`,
    )
    .all(vaultId, limit) as RecentExtraction[];
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
  vaultId: string = resolveVaultIdFromEnv(),
): NewConceptCreated[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT DISTINCT target_path AS path, created_at, source_path AS triggered_by
       FROM discovery_results
       WHERE target_path LIKE ?
         AND vault_id = ?
         AND dismissed_at IS NULL
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(`${conceptPrefix}%`, vaultId, limit) as NewConceptCreated[];
}

export interface SurprisingConnection {
  source: string;
  target: string;
  similarity: number;
}

/** Get top surprising connections (highest similarity, undismissed). */
export function getSurprisingConnections(
  limit = 10,
  vaultId: string = resolveVaultIdFromEnv(),
): SurprisingConnection[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT source_path AS source, target_path AS target, similarity
       FROM discovery_results
       WHERE vault_id = ? AND dismissed_at IS NULL
       ORDER BY similarity DESC
       LIMIT ?`,
    )
    .all(vaultId, limit) as SurprisingConnection[];
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
 *
 * `vaultId` is required so flags inserted by per-vault autoHeal land on
 * the right tenant. Without it the migration's NOT NULL DEFAULT
 * 'vault_00000000' stamps every vault's flags onto the personal vault —
 * test-vault's autoHeal output would surface in personal admin's
 * /v1/admin/health/flags and stay invisible to test-vault admin.
 */
export function insertHealthFlag(
  id: string,
  flagType: HealthFlagType,
  sourcePath: string | null,
  targetPath: string | null,
  details: Record<string, unknown>,
  vaultId: string,
): string | null {
  const database = getDb();
  const result = database
    .prepare(
      `INSERT INTO graph_health_flags (id, flag_type, source_path, target_path, details, vault_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(id, flagType, sourcePath, targetPath, JSON.stringify(details), vaultId);
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

/**
 * Get the most recent processed_at timestamp.
 *
 * Scoped to `vaultId` so per-vault health reporting reflects the right
 * worker's freshness instead of the busiest neighbor's.
 */
export function getLastProcessedAt(
  vaultId: string = resolveVaultIdFromEnv(),
): string | null {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT processed_at FROM discovery_queue
       WHERE status = 'done' AND processed_at IS NOT NULL AND vault_id = ?
       ORDER BY processed_at DESC LIMIT 1`,
    )
    .get(vaultId) as { processed_at: string } | undefined;
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

// ── note_blame cache ───────────────────────────────────────────────
// Cached output of git-blame + Provenance-trailer parsing for a single
// note version. Keyed by (path, source_hash); recomputed on miss. No
// active invalidation — the source_hash naturally rotates on every
// write, so old rows become unreachable and are cleaned by periodic
// vacuum (idx_note_blame_computed_at supports the sweep query).

/**
 * Read the cached blame for a note at a specific source_hash. Returns the
 * stored JSON string verbatim — callers parse into BlameSegment[]. Returns
 * null on cache miss (caller must compute and setNoteBlame).
 */
export function getNoteBlame(path: string, sourceHash: string): string | null {
  const database = getDb();
  const row = database
    .prepare("SELECT blame_json FROM note_blame WHERE path = ? AND source_hash = ?")
    .get(path, sourceHash) as { blame_json: string } | undefined;
  return row?.blame_json ?? null;
}

/**
 * Cache a freshly-computed blame. JSON serialization is the caller's job —
 * this function just persists the opaque string. Idempotent on (path,
 * source_hash) — re-running with identical inputs is a no-op via the PK.
 *
 * When `vaultId` is supplied the row is tagged with that vault so
 * `readNoteBlameScoped` (task-detail cross-vault fix) can filter by vault.
 */
export function setNoteBlame(path: string, sourceHash: string, blameJson: string, vaultId?: string): void {
  const database = getDb();
  database
    .prepare(
      `INSERT INTO note_blame (path, source_hash, blame_json, computed_at, vault_id)
       VALUES (?, ?, ?, datetime('now'), ?)
       ON CONFLICT(path, source_hash) DO UPDATE SET
         blame_json = excluded.blame_json,
         computed_at = excluded.computed_at,
         vault_id = COALESCE(excluded.vault_id, note_blame.vault_id)`,
    )
    .run(path, sourceHash, blameJson, vaultId ?? null);
}

/**
 * Drop ALL cached blame for a path (used on hard_delete + move). The path
 * may have multiple rows (one per historical source_hash); this clears all.
 */
export function deleteNoteBlame(path: string): void {
  const database = getDb();
  database.prepare("DELETE FROM note_blame WHERE path = ?").run(path);
}

/**
 * V3 §B + §6 — batch read note-level (voice, written_at) for many paths
 * in a single SQL invocation. Used by hybridSearch's reweight pass to
 * avoid N round-trips when oversample = 50 results.
 *
 * For each path: parses cached blame_json, derives note-level voice
 * (modal across segments) and written_at (max across segments). Paths
 * not present in note_blame are absent from the returned Map; callers
 * treat absence as "legacy-unknown without prior" and apply the §E
 * priorVoice fallback.
 *
 * Note: today's cache key includes (path, source_hash) — multiple rows
 * may exist per path for historical hashes. We pick the most-recently-
 * computed row per path (computed_at DESC). This is a temporary stance
 * until V3 §6 changes the cache key to source_hash-only and the row-per-
 * path collapses naturally. After §6 lands, the ORDER BY becomes a no-op.
 */
export function getNoteVoicesAndAges(
  paths: string[],
): Map<string, { voice: "durable" | "perishable" | "legacy-unknown"; written_at: string }> {
  const out = new Map<
    string,
    { voice: "durable" | "perishable" | "legacy-unknown"; written_at: string }
  >();
  if (paths.length === 0) return out;
  const database = getDb();

  // QMD vault_path is `resources/concepts/conviction-then-leave-pattern.md`
  // (lowercase + hyphens for spaces). note_blame stores filesystem paths
  // like `Resources/Concepts/Conviction-Then-Leave Pattern.md` (TitleCase
  // + literal spaces). Match both forms by normalizing on read: lowercase
  // the stored path and replace spaces with hyphens before comparing.
  // This is the slugify-on-read shim until the QMD index path semantics
  // converge with the filesystem (out of scope for V3).
  const querySlugs = paths.map((p) => p.toLowerCase());
  const placeholders = querySlugs.map(() => "?").join(",");

  const rows = database
    .prepare(
      `SELECT b.path, b.blame_json
       FROM note_blame b
       INNER JOIN (
         SELECT path, MAX(computed_at) AS max_at
         FROM note_blame
         WHERE LOWER(REPLACE(path, ' ', '-')) IN (${placeholders})
         GROUP BY path
       ) latest ON latest.path = b.path AND latest.max_at = b.computed_at`,
    )
    .all(...querySlugs) as { path: string; blame_json: string }[];

  // Build the inverse map: slug → original-query-path so callers can
  // index back by their input form rather than the filesystem casing.
  const slugToInput = new Map<string, string>();
  for (let i = 0; i < paths.length; i++) {
    slugToInput.set(querySlugs[i], paths[i]);
  }

  for (const row of rows) {
    let segments: Array<{ voice: string; written_at: string }>;
    try {
      segments = JSON.parse(row.blame_json) as Array<{ voice: string; written_at: string }>;
    } catch {
      continue; // corrupt cache row — skip; caller falls through to legacy-unknown
    }
    if (segments.length === 0) continue;

    // Modal voice: count line-weighted shares per voice value, pick max.
    // Lines are not on segments here — the BlameSegment shape has line_start/line_end
    // but blame_json is stored as the segment array. Use unweighted modal for the
    // batch-read fast path; the production envelope can do per-line weighting via
    // the full computeProvenanceBlame call when needed.
    const counts = new Map<string, number>();
    let maxWrittenAt = "";
    for (const seg of segments) {
      counts.set(seg.voice, (counts.get(seg.voice) ?? 0) + 1);
      if (seg.written_at > maxWrittenAt) maxWrittenAt = seg.written_at;
    }
    let modalVoice = "legacy-unknown";
    let modalCount = -1;
    for (const [v, c] of counts) {
      if (c > modalCount) {
        modalCount = c;
        modalVoice = v;
      }
    }
    if (modalVoice !== "durable" && modalVoice !== "perishable") {
      modalVoice = "legacy-unknown";
    }
    // Index by the caller's input path (lowercase + hyphens), not the
    // filesystem casing that note_blame stored. The slugToInput map
    // tells us which input path slugified to row.path.
    const rowSlug = row.path.toLowerCase().replace(/ /g, "-");
    const inputKey = slugToInput.get(rowSlug) ?? row.path;
    out.set(inputKey, {
      voice: modalVoice as "durable" | "perishable" | "legacy-unknown",
      written_at: maxWrittenAt,
    });
  }
  return out;
}

/**
 * Periodic vacuum: drop blame rows older than `olderThanDays`. Returns the
 * number of rows deleted. Safe to call from a cron — the read path will
 * recompute on next access.
 */
export function vacuumNoteBlame(olderThanDays: number): number {
  const database = getDb();
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
  const result = database
    .prepare("DELETE FROM note_blame WHERE computed_at < ?")
    .run(cutoff);
  return result.changes;
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

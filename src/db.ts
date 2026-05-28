/**
 * SQLite state database for Grove (single-user, single-vault).
 *
 * One file at `~/.grove/state.db` (override with `$GROVE_STATE_DB`) backs
 * everything that isn't the vault itself: the discovery queue + cache + cost
 * rollups, write provenance, the note-blame cache, and graph health rows.
 *
 * The vault is the source of truth; this DB is derived state. Wipe it any
 * time — discovery will recompute, blame will refill on read, the rest is
 * non-load-bearing observability.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { homedir } from "node:os";

function dbPath(): string {
  // GROVE_DB_PATH kept as a legacy alias for test fixtures that pre-date
  // the GROVE_STATE_DB rename. Both point at the same single sqlite file.
  return process.env.GROVE_STATE_DB ?? process.env.GROVE_DB_PATH ?? join(homedir(), ".grove", "state.db");
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/** Close the database connection (for tests/cleanup). */
export function closeDb(): void {
  if (db) {
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // best-effort — concurrent writers can block TRUNCATE
    }
    db.close();
    db = null;
  }
}

/** Reset the module-level singleton (for tests that swap GROVE_STATE_DB). */
export function resetDb(): void {
  closeDb();
}

const SCHEMA = `
-- Discovery queue: paths flagged for extract→link by the discovery worker.
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
CREATE INDEX IF NOT EXISTS idx_discovery_queue_batch ON discovery_queue(batch_id);

-- Batches submitted to Anthropic for asynchronous extract calls.
CREATE TABLE IF NOT EXISTS discovery_batches (
  id TEXT PRIMARY KEY,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','ended','expired','canceled','errored')),
  row_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discovery_batches_status ON discovery_batches(status, submitted_at);

-- (path, content_sha256, cache_version) → extract result. Skips the Anthropic
-- call when the same bytes are re-extracted (typo fixes, idempotent saves).
CREATE TABLE IF NOT EXISTS discovery_cache (
  path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  cache_version INTEGER NOT NULL,
  model TEXT NOT NULL,
  result_json TEXT NOT NULL,
  cached_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (path, content_sha256, cache_version)
);
CREATE INDEX IF NOT EXISTS idx_discovery_cache_cached_at ON discovery_cache(cached_at);

-- Daily Anthropic cost rollup (optional — populated by an external ingester).
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

-- Write provenance: hash of what the caller most recently wrote per path.
-- Used as the if_hash anchor so concurrent discovery work doesn't trigger
-- false conflicts on the next caller update.
CREATE TABLE IF NOT EXISTS write_provenance (
  path TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  actor TEXT,
  written_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_write_provenance_written_at ON write_provenance(written_at);

-- Per-note blame cache. Recomputed lazily on read.
CREATE TABLE IF NOT EXISTS note_blame (
  path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  blame_json TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (path, source_hash)
);
CREATE INDEX IF NOT EXISTS idx_note_blame_computed_at ON note_blame(computed_at);

-- Graph health: history rows + open flag rows.
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
  UNIQUE (flag_type, source_path, target_path)
);
CREATE INDEX IF NOT EXISTS idx_health_flags_type ON graph_health_flags(flag_type, resolved_at);
CREATE INDEX IF NOT EXISTS idx_flags_unresolved ON graph_health_flags(resolved_at, created_at);
`;

export function createSchema(): void {
  getDb().exec(SCHEMA);
}

/** Idempotent. Safe to call at startup and on every test setup. */
export function runMigration(): void {
  createSchema();
}

// ── Discovery queue helpers ───────────────────────────────────────

export type DiscoveryTrigger = "commit" | "write" | "ingest" | "embed_retry";

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

/**
 * Enqueue a path for discovery. Dedups on (path, trigger) when an in-flight
 * row already exists, and refuses re-enqueue within a cooldown window of a
 * successful processing. Returns true when a row was inserted.
 */
export function enqueueDiscovery(
  path: string,
  trigger: DiscoveryTrigger,
): boolean {
  const database = getDb();

  const cooldownRaw = process.env.GROVE_DISCOVERY_COOLDOWN_MIN;
  const cooldownMin = cooldownRaw === undefined ? 5 : Number.parseInt(cooldownRaw, 10);
  if (Number.isFinite(cooldownMin) && cooldownMin > 0) {
    const recent = database
      .prepare(
        `SELECT id FROM discovery_queue
          WHERE path = ?
            AND status = 'done'
            AND processed_at > datetime('now', ?)
          LIMIT 1`,
      )
      .get(path, `-${cooldownMin} minutes`) as { id: number } | undefined;
    if (recent) return false;
  }

  const existing = database
    .prepare(
      `SELECT id FROM discovery_queue
        WHERE path = ? AND trigger = ?
          AND status IN ('pending', 'processing')
        LIMIT 1`,
    )
    .get(path, trigger) as { id: number } | undefined;
  if (existing) return false;

  database
    .prepare("INSERT INTO discovery_queue (path, trigger) VALUES (?, ?)")
    .run(path, trigger);
  return true;
}

/** Count rows that completed today (UTC). Used by the daily cap. */
export function countTodayProcessed(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM discovery_queue
        WHERE processed_at >= date('now')
          AND status IN ('done', 'error')`,
    )
    .get() as { n: number };
  return row.n;
}

/** Claim the next pending entry. */
export function dequeueDiscovery(): DiscoveryQueueEntry | null {
  const row = getDb()
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

/** Claim the next pending non-commit (urgent) entry. */
export function dequeueDiscoveryUrgent(): DiscoveryQueueEntry | null {
  const row = getDb()
    .prepare(
      `UPDATE discovery_queue
         SET status = 'processing', attempts = attempts + 1
       WHERE id = (
         SELECT id FROM discovery_queue
         WHERE status = 'pending' AND trigger != 'commit'
         ORDER BY queued_at ASC
         LIMIT 1
       )
       RETURNING *`,
    )
    .get() as DiscoveryQueueEntry | undefined;
  return row ?? null;
}

export function markDiscoveryDone(id: number): void {
  getDb()
    .prepare(
      "UPDATE discovery_queue SET status = 'done', processed_at = datetime('now') WHERE id = ?",
    )
    .run(id);
}

export function markDiscoveryError(id: number, message: string): void {
  getDb()
    .prepare(
      "UPDATE discovery_queue SET status = 'error', processed_at = datetime('now'), error_message = ? WHERE id = ?",
    )
    .run(message, id);
}

/** Reset rows stuck in 'processing' after a worker crash. */
export function recoverOrphanedDiscoveryProcessing(): number {
  const result = getDb()
    .prepare("UPDATE discovery_queue SET status = 'pending' WHERE status = 'processing'")
    .run();
  return result.changes;
}

export function requeueDiscovery(id: number): boolean {
  const result = getDb()
    .prepare(
      "UPDATE discovery_queue SET status = 'pending', processed_at = NULL, error_message = NULL WHERE id = ?",
    )
    .run(id);
  return result.changes > 0;
}

export function discoveryQueueDepth(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM discovery_queue WHERE status = 'pending'")
    .get() as { count: number };
  return row.count;
}

// ── Discovery batch helpers ──────────────────────────────────────

export interface DiscoveryBatchRow {
  id: string;
  submitted_at: string;
  completed_at: string | null;
  status: "submitted" | "ended" | "expired" | "canceled" | "errored";
  row_count: number;
}

export function claimBatchEligible(limit: number = 100): DiscoveryQueueEntry[] {
  return getDb()
    .prepare(
      `SELECT * FROM discovery_queue
        WHERE status = 'pending'
          AND trigger = 'commit'
          AND attempts = 0
        ORDER BY queued_at ASC
        LIMIT ?`,
    )
    .all(limit) as DiscoveryQueueEntry[];
}

export function markRowsBatched(rowIds: number[], batchId: string): void {
  if (rowIds.length === 0) return;
  const database = getDb();
  const stmt = database.prepare(
    `UPDATE discovery_queue SET status = 'batched', batch_id = ? WHERE id = ?`,
  );
  const tx = database.transaction(() => {
    for (const id of rowIds) stmt.run(batchId, id);
  });
  tx();
}

export function insertDiscoveryBatch(id: string, rowCount: number): void {
  getDb()
    .prepare("INSERT INTO discovery_batches (id, row_count) VALUES (?, ?)")
    .run(id, rowCount);
}

export function listOpenBatches(): DiscoveryBatchRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM discovery_batches WHERE status = 'submitted' ORDER BY submitted_at ASC",
    )
    .all() as DiscoveryBatchRow[];
}

export function getBatchedRows(batchId: string): DiscoveryQueueEntry[] {
  return getDb()
    .prepare("SELECT * FROM discovery_queue WHERE batch_id = ?")
    .all(batchId) as DiscoveryQueueEntry[];
}

export function finalizeBatch(
  batchId: string,
  status: "ended" | "expired" | "canceled" | "errored",
): void {
  getDb()
    .prepare(
      "UPDATE discovery_batches SET status = ?, completed_at = datetime('now') WHERE id = ?",
    )
    .run(status, batchId);
}

export function recoverStaleBatched(maxAgeHours: number = 26): number {
  const result = getDb()
    .prepare(
      `UPDATE discovery_queue
          SET status = 'pending', trigger = 'write'
        WHERE status = 'batched'
          AND queued_at < datetime('now', ?)`,
    )
    .run(`-${maxAgeHours} hours`);
  return result.changes;
}

// ── Discovery extraction cache ───────────────────────────────────

export function getCachedExtraction(
  path: string,
  contentSha256: string,
  cacheVersion: number,
): { result_json: string; model: string; cached_at: string } | null {
  const row = getDb()
    .prepare(
      `SELECT result_json, model, cached_at FROM discovery_cache
        WHERE path = ? AND content_sha256 = ? AND cache_version = ?`,
    )
    .get(path, contentSha256, cacheVersion) as
    | { result_json: string; model: string; cached_at: string }
    | undefined;
  return row ?? null;
}

export function putCachedExtraction(
  path: string,
  contentSha256: string,
  cacheVersion: number,
  model: string,
  resultJson: string,
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO discovery_cache
         (path, content_sha256, cache_version, model, result_json, cached_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(path, contentSha256, cacheVersion, model, resultJson);
}

export function flushDiscoveryCache(path?: string): number {
  const database = getDb();
  if (path === undefined) {
    return database.prepare("DELETE FROM discovery_cache").run().changes;
  }
  return database.prepare("DELETE FROM discovery_cache WHERE path = ?").run(path).changes;
}

// ── Discovery digest (used by vault_status mode=discovery) ────────

export interface RecentExtraction {
  path: string;
  processed_at: string;
  trigger: string;
}

export function getRecentExtractions(limit = 20): RecentExtraction[] {
  return getDb()
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
 * Returns an empty list — the autonomous discovery_results table was retired
 * in the teardown. Kept as a stable shape so vault_status mode=discovery's
 * envelope stays unchanged. Wire to a real source if you bring concept-creation
 * provenance back.
 */
export function getNewConceptsCreated(
  _limit = 20,
  _conceptPrefix = "Resources/Concepts/",
): NewConceptCreated[] {
  return [];
}

export interface SurprisingConnection {
  source: string;
  target: string;
  similarity: number;
}

/** Always empty post-teardown — discovery_results was deleted. */
export function getSurprisingConnections(_limit = 10): SurprisingConnection[] {
  return [];
}

// ── Graph health flags ───────────────────────────────────────────

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

export function insertHealthFlag(
  id: string,
  flagType: HealthFlagType,
  sourcePath: string | null,
  targetPath: string | null,
  details: Record<string, unknown>,
): string | null {
  const result = getDb()
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
  return getDb()
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
  const result = getDb()
    .prepare(
      "UPDATE graph_health_flags SET resolved_at = datetime('now') WHERE id = ? AND resolved_at IS NULL",
    )
    .run(id);
  return result.changes > 0;
}

export function getLastProcessedAt(): string | null {
  const row = getDb()
    .prepare(
      `SELECT processed_at FROM discovery_queue
       WHERE status = 'done' AND processed_at IS NOT NULL
       ORDER BY processed_at DESC LIMIT 1`,
    )
    .get() as { processed_at: string } | undefined;
  return row?.processed_at ?? null;
}

// ── Write provenance ─────────────────────────────────────────────

export function recordWrite(
  path: string,
  sourceHash: string,
  commitSha: string,
  actor?: string,
): void {
  getDb()
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

export function getSourceHash(path: string): string | null {
  const row = getDb()
    .prepare("SELECT source_hash FROM write_provenance WHERE path = ?")
    .get(path) as { source_hash: string } | undefined;
  return row?.source_hash ?? null;
}

export interface ProvenanceRow {
  path: string;
  source_hash: string;
  commit_sha: string;
  actor: string | null;
  written_at: string;
}

export function getProvenance(path: string): ProvenanceRow | null {
  const row = getDb()
    .prepare("SELECT path, source_hash, commit_sha, actor, written_at FROM write_provenance WHERE path = ?")
    .get(path) as ProvenanceRow | undefined;
  return row ?? null;
}

export function deleteProvenance(path: string): void {
  getDb().prepare("DELETE FROM write_provenance WHERE path = ?").run(path);
}

export function renameProvenance(fromPath: string, toPath: string): void {
  getDb()
    .prepare("UPDATE write_provenance SET path = ? WHERE path = ?")
    .run(toPath, fromPath);
}

export function setProvenanceRow(row: ProvenanceRow): void {
  getDb()
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

// ── note_blame cache ─────────────────────────────────────────────

export function getNoteBlame(path: string, sourceHash: string): string | null {
  const row = getDb()
    .prepare("SELECT blame_json FROM note_blame WHERE path = ? AND source_hash = ?")
    .get(path, sourceHash) as { blame_json: string } | undefined;
  return row?.blame_json ?? null;
}

export function setNoteBlame(path: string, sourceHash: string, blameJson: string): void {
  getDb()
    .prepare(
      `INSERT INTO note_blame (path, source_hash, blame_json, computed_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(path, source_hash) DO UPDATE SET
         blame_json = excluded.blame_json,
         computed_at = excluded.computed_at`,
    )
    .run(path, sourceHash, blameJson);
}

export function deleteNoteBlame(path: string): void {
  getDb().prepare("DELETE FROM note_blame WHERE path = ?").run(path);
}

/**
 * Batch read note-level (voice, written_at) for many paths in one SQL hop.
 * Paths absent from note_blame are absent from the returned Map; callers
 * treat absence as "legacy-unknown".
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

  // The QMD index stores lowercased + hyphenated paths; the filesystem (and
  // note_blame) stores TitleCase + literal spaces. Match both forms.
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

  const slugToInput = new Map<string, string>();
  for (let i = 0; i < paths.length; i++) {
    slugToInput.set(querySlugs[i], paths[i]);
  }

  for (const row of rows) {
    let segments: Array<{ voice: string; written_at: string }>;
    try {
      segments = JSON.parse(row.blame_json) as Array<{ voice: string; written_at: string }>;
    } catch {
      continue;
    }
    if (segments.length === 0) continue;

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
    const rowSlug = row.path.toLowerCase().replace(/ /g, "-");
    const inputKey = slugToInput.get(rowSlug) ?? row.path;
    out.set(inputKey, {
      voice: modalVoice as "durable" | "perishable" | "legacy-unknown",
      written_at: maxWrittenAt,
    });
  }
  return out;
}

export function vacuumNoteBlame(olderThanDays: number): number {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
  return getDb()
    .prepare("DELETE FROM note_blame WHERE computed_at < ?")
    .run(cutoff).changes;
}

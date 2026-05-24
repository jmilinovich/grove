/**
 * Per-vault SQLite tooling.
 *
 * Each vault gets its own `state.db` at `${GROVE_VAULT_STATE_ROOT}/<slug>/state.db`
 * (default `~/.grove/vaults/<slug>/state.db`). This is the storage substrate
 * for per-tenant tables that should never be cross-queryable: tasks,
 * task_results, skill_configs (Phase 21 onward), and eventually api_keys,
 * shared_links, discovery_queue, graph_health (Phase 22+).
 *
 * The control DB (`grove.db`) stays in `src/db.ts` and holds cross-vault
 * tables: users, vaults, vault_members, sessions, oauth*, write_provenance,
 * note_blame, waitlist.
 *
 * Why split: "9 cross-vault leaks in 14 days are one mistake repeated, not
 * nine" — see `~/.claude/projects/-Users-jm-src-grove/memory/project_per_vault_sqlite_split.md`.
 * Storage-layer scoping makes `WHERE vault_id = ?` structurally impossible
 * to forget.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { getDb } from "./db.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function vaultStateRoot(): string {
  return process.env.GROVE_VAULT_STATE_ROOT ?? join(homedir(), ".grove", "vaults");
}

function vaultMigrationsDir(): string {
  return process.env.GROVE_VAULT_MIGRATIONS_DIR ?? join(HERE, "migrations", "vault");
}

export interface VaultRow {
  id: string;
  slug: string;
  /** On-disk git checkout path (vaults.git_repo_path). Needed by skill executors. */
  git_repo_path: string;
}

const pool = new Map<string, Database.Database>();

function resolveVaultSlug(vaultId: string): string {
  const row = getDb()
    .prepare("SELECT slug FROM vaults WHERE id = ?")
    .get(vaultId) as { slug: string } | undefined;
  if (!row) {
    throw new Error(`[db-per-vault] unknown vault_id: ${JSON.stringify(vaultId)}`);
  }
  return row.slug;
}

/**
 * Return the SQLite handle for a vault's state.db. Lazy-creates the
 * directory and database file on first call. Pool keyed by vaultId — the
 * second call with the same id returns the same connection.
 *
 * Throws if vaultId is not a row in the control db's `vaults` table.
 */
export function getVaultDb(vaultId: string): Database.Database {
  const existing = pool.get(vaultId);
  if (existing && existing.open) return existing;
  if (existing) pool.delete(vaultId);

  const slug = resolveVaultSlug(vaultId);
  const dir = join(vaultStateRoot(), slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "state.db");

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  runVaultMigrations(db);

  pool.set(vaultId, db);
  return db;
}

/**
 * Iterate every vault row in the control db's `vaults` table, opening
 * each per-vault state.db and invoking `fn(db, vault)`. Used by migration
 * fan-out and backup enumeration.
 */
export function forEachVaultDb(
  fn: (db: Database.Database, vault: VaultRow) => void,
): void {
  const vaults = getDb()
    .prepare("SELECT id, slug, git_repo_path FROM vaults ORDER BY created_at ASC")
    .all() as VaultRow[];
  for (const vault of vaults) {
    const db = getVaultDb(vault.id);
    fn(db, vault);
  }
}

/**
 * Close every pooled connection (tests + graceful shutdown). Best-effort
 * checkpoint before close so WAL sidecars don't grow unbounded.
 */
export function closeAllVaultDbs(): void {
  for (const db of pool.values()) {
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // concurrent writers can block TRUNCATE; not fatal
    }
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  pool.clear();
}

/**
 * Apply per-vault migrations in lexical order from `src/migrations/vault/*.sql`.
 * Each applied file is recorded in `_migration_state(name, applied_at)`.
 * Idempotent: files already in `_migration_state` are skipped.
 */
function runVaultMigrations(db: Database.Database): void {
  // Bootstrap the tracking table before reading from it. Migration 001
  // also declares this table with IF NOT EXISTS so a brand-new vault DB
  // is fully self-describing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migration_state (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const dir = vaultMigrationsDir();
  if (!existsSync(dir)) return;

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = new Set(
    (db.prepare("SELECT name FROM _migration_state").all() as { name: string }[])
      .map((r) => r.name),
  );

  const insert = db.prepare("INSERT INTO _migration_state (name) VALUES (?)");
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    const tx = db.transaction(() => {
      db.exec(sql);
      insert.run(file);
    });
    tx();
  }
}

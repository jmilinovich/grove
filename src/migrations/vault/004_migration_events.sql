-- 004_migration_events.sql
-- M-INBOX-1 — audit log for one-shot migration scripts.
--
-- Append-only record of mutations performed by `scripts/migrate-*.ts`
-- one-shots. The first writer is M-INBOX-1 (legacy review-task dismissal),
-- but the table is intentionally generic — `event` is a free string and
-- `payload_json` carries the per-event shape. Future migrations can write
-- here without a schema change.
--
-- Lives in the per-vault state.db (not the control db) so cross-tenant
-- safety per CLAUDE.md diagnostic discipline #3 is structural: a script
-- run against vault A cannot touch vault B's audit log.
--
-- This is an audit trail, not transactional state. Don't read from it to
-- gate behavior; check the underlying table (`tasks.state` for M-INBOX-1).

CREATE TABLE IF NOT EXISTS migration_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  migration    TEXT NOT NULL,
  event        TEXT NOT NULL,
  vault_slug   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_migration_events_migration
  ON migration_events(migration, created_at);

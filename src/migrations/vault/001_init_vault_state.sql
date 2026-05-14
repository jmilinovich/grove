-- 001_init_vault_state.sql
-- First per-vault state.db migration. Application tables land in 002+
-- (Phase 21 tasks/task_results/skill_configs). This file establishes
-- only the migration-tracking table itself, declared with IF NOT EXISTS
-- so the runner's bootstrap and this migration are consistent.

CREATE TABLE IF NOT EXISTS _migration_state (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

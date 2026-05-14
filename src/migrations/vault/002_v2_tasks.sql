-- 002_v2_tasks.sql
-- Phase 21 — v2 Dashboard Server Surface schema.
-- Three per-vault tables backing grove-www's v2 dashboard:
--
--   tasks         — the work queue (one row per skill-generated task)
--   task_results  — artifact + provenance, one-to-one with tasks
--   skill_configs — per-vault user state for installed skills
--
-- See PLAN.md Phase 21 for the contract and grove-www/src/lib/grove-api.v2.types.ts
-- for the canonical TS shapes these tables back.
--
-- Design notes (Phase 22 revision):
--   - task_results.provenance_json is a SINGLE JSON column (NOT 5 separate
--     columns) matching the GroveProvenance object shape end-to-end.
--   - cadence enum includes 'on-trigger' per grove-www's Cadence union.
--   - idx_tasks_state_started_at supports the scheduler's orphan recovery
--     on boot (state='running' AND started_at < now-5min → pending).

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  skill_slug TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','running','review','done','dismissed','failed')),
  title TEXT NOT NULL,
  body TEXT,
  source_note_path TEXT,
  estimated_minutes INTEGER,
  actual_minutes INTEGER,
  scheduled_for TEXT,
  started_at TEXT,
  completed_at TEXT,
  source_flag_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_state_scheduled
  ON tasks(state, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_tasks_skill_slug
  ON tasks(skill_slug);
CREATE INDEX IF NOT EXISTS idx_tasks_state_started_at
  ON tasks(state, started_at);

CREATE TABLE IF NOT EXISTS task_results (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  artifact_json TEXT NOT NULL,
  note_change_json TEXT,
  provenance_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skill_configs (
  skill_slug TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  cadence TEXT NOT NULL CHECK (cadence IN ('daily','weekly','on-trigger','on-demand')),
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

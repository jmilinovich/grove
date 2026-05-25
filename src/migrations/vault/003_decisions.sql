-- 003_decisions.sql
-- Inbox v2 (S-INBOX-1) — per-vault decision log + suppression projection.
--
-- See docs/inbox-v2-spec.md and docs/inbox-v2-plan.md for the full design.
--
-- Two tables back the new "suggestions, not reviews" inbox:
--
--   decisions     — every Grove-made graph decision, with payload + the
--                   options set that produced it, the chosen option, and
--                   forward-only compensation pointer. Source of truth
--                   for this table is `.grove/decisions.jsonl` in the
--                   vault working tree (S-INBOX-2); this projection
--                   exists for query speed. `grove rebuild-projection`
--                   (S-INBOX-4) replays the JSONL into these rows.
--
--   suppressions  — soft-dismiss memory keyed by (suggestion_type,
--                   entity_key). Inserted when the user dismisses an
--                   item; skills consult this before re-emitting the
--                   same suggestion within the suppression window.
--
-- Design notes:
--   - JSON columns (payload_json, options_json, affected_paths_json)
--     stay as TEXT — parsed at the API boundary into typed shapes from
--     src/v2-decisions.ts. Same pattern as task_results.provenance_json.
--   - CHECK constraints on `type` + `status` keep this table honest;
--     unknown values from a bad JSONL line will fail at projection time
--     rather than silently corrupting downstream queries.
--   - UNIQUE(suggestion_type, entity_key) on suppressions enforces "one
--     active suppression per (type, entity)" — re-dismissing an item
--     should update the existing row, not stack rows.

CREATE TABLE IF NOT EXISTS decisions (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('disambiguation','link','enrichment')),
  skill_run_id    TEXT NOT NULL,
  task_id         TEXT,
  created_at      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('provisional','confirmed','compensated')) DEFAULT 'provisional',
  payload_json    TEXT NOT NULL,
  options_json    TEXT NOT NULL,
  chosen_option_id TEXT NOT NULL,
  affected_paths_json TEXT NOT NULL,
  compensated_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_task ON decisions(task_id);
CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);

CREATE TABLE IF NOT EXISTS suppressions (
  id              TEXT PRIMARY KEY,
  suggestion_type TEXT NOT NULL,
  entity_key      TEXT NOT NULL,
  suppressed_at   TEXT NOT NULL,
  until           TEXT NOT NULL,
  UNIQUE(suggestion_type, entity_key)
);

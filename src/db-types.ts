/**
 * Per-vault state.db row types (Phase 21 — v2 dashboard server surface).
 *
 * These types describe rows as they live IN sqlite — snake_case column
 * names, JSON columns as raw strings. Conversion to the camelCase shapes
 * grove-www consumes (Task, TaskResult, Skill from
 * `grove-api.v2.types.ts`) happens at the API boundary using SELECT
 * column aliases — no separate mapper module. See PLAN.md Phase 21
 * Architecture Smell #3.
 */

export type TaskState =
  | "pending"
  | "running"
  | "review"
  | "done"
  | "dismissed"
  | "failed";

export type Cadence = "daily" | "weekly" | "on-trigger" | "on-demand";

/** Row shape for the per-vault `tasks` table. */
export interface TaskRow {
  id: string;
  skill_slug: string;
  state: TaskState;
  title: string;
  body: string | null;
  source_note_path: string | null;
  estimated_minutes: number | null;
  actual_minutes: number | null;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  source_flag_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Row shape for the per-vault `task_results` table. */
export interface TaskResultRow {
  task_id: string;
  artifact_json: string;
  note_change_json: string | null;
  provenance_json: string | null;
  created_at: string;
}

/** Row shape for the per-vault `skill_configs` table. */
export interface SkillConfigRow {
  skill_slug: string;
  enabled: 0 | 1;
  cadence: Cadence;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

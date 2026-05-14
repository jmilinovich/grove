/**
 * v2 dashboard tasks endpoint (Phase 21, P21-3).
 *
 * GET /v/<slug>/v1/tasks — returns the `BacklogPayload` grove-www's
 * `fetchBacklog` consumes:
 *   { reviewTasks, pendingTasks, clearedTasks, throughput, skills, planTier }
 *
 * Routing/auth: the handler runs INSIDE the existing `vaultV1Match`
 * block in `src/proxy.ts`, which already enforces directly-bound or
 * member-authorized bearer-token access to the URL's vault and sets the
 * CORS allow-origin. This handler trusts that gate — it does not
 * re-authenticate. Cross-vault access is impossible because the vault
 * context passed in is derived from the URL slug, not the token's bound
 * vault_id.
 *
 * Source of truth: per-vault `state.db` at `~/.grove/vaults/<slug>/`,
 * tables `tasks` / `task_results` / `skill_configs` (P21-2). The shared
 * control db (`grove.db`) is only consulted for `vaults.created_at`
 * (vault age, drives `throughput.showCeiling`).
 *
 * Field shapes are taken from `grove-www/src/lib/grove-api.v2.types.ts`
 * verbatim — divergence here would silently break the v2 RSC render.
 * SQL aliases (`skill_slug AS skillId`, `body AS description`, etc.)
 * carry rows straight to the typed shape; no mapper module.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "./db.js";
import { getVaultDb } from "./db-per-vault.js";
import { SKILL_REGISTRY, type SkillMetadata } from "./skills/registry.js";
import type { VaultContext } from "./vault-router.js";
import type { Cadence, TaskState } from "./db-types.js";

// ─── Shared types — mirror grove-www/src/lib/grove-api.v2.types.ts ───────

export interface GroveProvenance {
  voice: "durable" | "perishable" | "legacy-unknown";
  by?: string;
  writtenAt?: string;
  source?: string;
  basis?: string[];
  reason?: string;
}

export type TaskArtifactType =
  | "surface"
  | "note-change"
  | "note-create"
  | "note-link"
  | "concept-merge";

export interface TaskResult {
  artifact: {
    type: TaskArtifactType;
    notePath?: string;
    surfaceText?: string;
  };
  provenance: GroveProvenance;
}

export interface Task {
  id: string;
  skillId: string;
  title: string;
  description: string;
  state: TaskState;
  scheduledFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
  estimatedMinutes: number;
  actualMinutes: number | null;
  result: TaskResult | null;
  needsReviewReason?: string;
  sourceNotes?: string[];
  errorMessage?: string;
}

export interface Skill {
  id: string;
  slug: string;
  name: string;
  domain: SkillMetadata["domain"];
  author: "builtin";
  description: string;
  sampleTasks: string[];
  cadenceOptions: Cadence[];
  defaultCadence: Cadence | null;
  defaultArtifactType: TaskArtifactType;
  installState: "installed" | "available" | "disabled";
  starterPendingTasks?: string[];
}

export interface ThroughputView {
  rollingWeekVelocity: number | null;
  cleared7d: number;
  pending: number;
  estimatedClearText: string;
  planCeiling: number;
  showCeiling: boolean;
}

export interface BacklogPayload {
  reviewTasks: Task[];
  pendingTasks: Task[];
  clearedTasks: Task[];
  throughput: ThroughputView;
  skills: Skill[];
  planTier: "free" | "pro";
}

// ─── Internal: SELECT-with-aliases row shape ─────────────────────────────

interface TaskRowAliased {
  id: string;
  skillId: string;
  title: string;
  description: string | null;
  state: TaskState;
  scheduledFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  sourceNotePath: string | null;
  artifactJson: string | null;
  provenanceJson: string | null;
}

// LEFT JOIN task_results so we can shape `Task.result` in a single
// round-trip; `result` is null when no row exists. Column aliases match
// grove-www's camelCase field names exactly so rows pass through as the
// typed shape (Architecture Smell #3 in the Phase 21 review).
const TASK_SELECT_COLUMNS = `
  t.id              AS id,
  t.skill_slug      AS skillId,
  t.title           AS title,
  t.body            AS description,
  t.state           AS state,
  t.scheduled_for   AS scheduledFor,
  t.started_at      AS startedAt,
  t.completed_at    AS completedAt,
  t.estimated_minutes AS estimatedMinutes,
  t.actual_minutes  AS actualMinutes,
  t.source_note_path AS sourceNotePath,
  r.artifact_json   AS artifactJson,
  r.provenance_json AS provenanceJson
`;

function rowToTask(row: TaskRowAliased): Task {
  let result: TaskResult | null = null;
  if (row.artifactJson) {
    // Defensive: a malformed artifact_json blob shouldn't 500 the whole
    // backlog. Log and drop the result rather than crash the response.
    try {
      const artifact = JSON.parse(row.artifactJson) as TaskResult["artifact"];
      const provenance = row.provenanceJson
        ? (JSON.parse(row.provenanceJson) as GroveProvenance)
        : ({ voice: "legacy-unknown" } as GroveProvenance);
      result = { artifact, provenance };
    } catch (err) {
      console.error("[v2-tasks] failed to parse task_results JSON for task", row.id, err);
    }
  }

  const task: Task = {
    id: row.id,
    skillId: row.skillId,
    title: row.title,
    description: row.description ?? "",
    state: row.state,
    scheduledFor: row.scheduledFor,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    estimatedMinutes: row.estimatedMinutes ?? 0,
    actualMinutes: row.actualMinutes,
    result,
  };
  if (row.sourceNotePath) task.sourceNotes = [row.sourceNotePath];
  return task;
}

// ─── Throughput compute — shared with P21-4 ──────────────────────────────

/**
 * Compute the dashboard's `ThroughputView` strip for a vault.
 *
 * - `rollingWeekVelocity`: tasks completed per week, averaged over the
 *   trailing 28 days. Null when the vault hasn't completed any tasks in
 *   the window (rendering should show "—" rather than "0/week").
 * - `cleared7d`: count of tasks transitioned to `done` in the last 7
 *   days.
 * - `pending`: current count of `pending` + `running` tasks.
 * - `estimatedClearText`: human-shaped time-to-clear string per SPEC §4.
 * - `showCeiling`: hidden during the vault's first 14 days (SPEC §7) so
 *   we don't render a capacity meter against a sample of three days of
 *   activity.
 *
 * Exported for reuse by the P21-4 task-detail and standalone throughput
 * compute paths.
 */
export function computeThroughput(vaultId: string): ThroughputView {
  const vaultDb = getVaultDb(vaultId);

  const cleared7d = (
    vaultDb
      .prepare(
        `SELECT COUNT(*) AS n
           FROM tasks
          WHERE state = 'done'
            AND completed_at IS NOT NULL
            AND datetime(completed_at) >= datetime('now', '-7 days')`,
      )
      .get() as { n: number }
  ).n;

  const cleared28d = (
    vaultDb
      .prepare(
        `SELECT COUNT(*) AS n
           FROM tasks
          WHERE state = 'done'
            AND completed_at IS NOT NULL
            AND datetime(completed_at) >= datetime('now', '-28 days')`,
      )
      .get() as { n: number }
  ).n;

  const pending = (
    vaultDb
      .prepare(
        `SELECT COUNT(*) AS n
           FROM tasks
          WHERE state IN ('pending', 'running')`,
      )
      .get() as { n: number }
  ).n;

  const rollingWeekVelocity = cleared28d > 0 ? cleared28d / 4 : null;
  const estimatedClearText = formatEstimatedClearText(pending, rollingWeekVelocity);

  // Vault age — read from control db. A missing vaults row is fatal
  // (the caller passed us a vault_id that doesn't exist), but the
  // proxy's vaultV1Match gate already rejected unknown slugs upstream,
  // so this is more of a belt-and-braces guard.
  const vaultRow = getDb()
    .prepare("SELECT created_at FROM vaults WHERE id = ?")
    .get(vaultId) as { created_at: string } | undefined;
  const vaultCreatedMs = vaultRow ? new Date(vaultRow.created_at).getTime() : Date.now();
  const ageMs = Date.now() - vaultCreatedMs;
  const showCeiling = ageMs > 14 * 24 * 60 * 60 * 1000;

  return {
    rollingWeekVelocity,
    cleared7d,
    pending,
    estimatedClearText,
    planCeiling: 25,
    showCeiling,
  };
}

function formatEstimatedClearText(pending: number, velocity: number | null): string {
  if (pending === 0) return "all clear";
  if (velocity === null || velocity <= 0) return "not enough data yet";
  const weeksToClear = pending / velocity;
  if (weeksToClear < 0.5) return "under a week at your pace";
  if (weeksToClear < 1.5) return "≈1 week at your pace";
  return `≈${Math.round(weeksToClear)} weeks at your pace`;
}

// ─── Skills compose: registry + per-vault skill_configs ──────────────────

function buildSkillsForVault(vaultId: string): Skill[] {
  const vaultDb = getVaultDb(vaultId);
  const rows = vaultDb
    .prepare("SELECT skill_slug, enabled FROM skill_configs")
    .all() as { skill_slug: string; enabled: number }[];
  const configBySlug = new Map(rows.map((r) => [r.skill_slug, r]));

  return SKILL_REGISTRY.map((meta) => {
    const cfg = configBySlug.get(meta.slug);
    const installState: Skill["installState"] =
      cfg && cfg.enabled === 1 ? "installed" : "available";
    return {
      id: meta.id,
      slug: meta.slug,
      name: meta.name,
      domain: meta.domain,
      author: meta.author,
      description: meta.description,
      sampleTasks: [...meta.sampleTasks],
      cadenceOptions: [...meta.cadenceOptions],
      defaultCadence: meta.defaultCadence,
      defaultArtifactType: meta.defaultArtifactType,
      installState,
    };
  });
}

// ─── Backlog assembly ────────────────────────────────────────────────────

/**
 * Build the complete `BacklogPayload` for a vault. Exported separately
 * from the HTTP handler so tests can assert the data shape without
 * needing to stand up a server.
 */
export function buildBacklogPayload(vaultId: string): BacklogPayload {
  const vaultDb = getVaultDb(vaultId);

  // review: oldest-disposition-first would invert the user's intuition;
  // newest review items go to the top of the list (matches the mock
  // implementation, SPEC §4).
  const reviewRows = vaultDb
    .prepare(
      `SELECT ${TASK_SELECT_COLUMNS}
         FROM tasks t
         LEFT JOIN task_results r ON r.task_id = t.id
        WHERE t.state = 'review'
        ORDER BY t.created_at DESC`,
    )
    .all() as TaskRowAliased[];

  // pending+running: scheduled items first by scheduled_for ASC; unscheduled
  // fall to the bottom; ties break by most-recently-created. SQLite sorts
  // NULL first by default — `scheduled_for IS NULL` keys NULLs to the end
  // (NULLS LAST) without depending on SQLite >= 3.30 syntax.
  const pendingRows = vaultDb
    .prepare(
      `SELECT ${TASK_SELECT_COLUMNS}
         FROM tasks t
         LEFT JOIN task_results r ON r.task_id = t.id
        WHERE t.state IN ('pending', 'running')
        ORDER BY (t.scheduled_for IS NULL) ASC, t.scheduled_for ASC, t.created_at DESC`,
    )
    .all() as TaskRowAliased[];

  // cleared: 20 most-recent done tasks. SPEC §4 only shows "this week"
  // but the homepage component takes the full list and slices itself.
  const clearedRows = vaultDb
    .prepare(
      `SELECT ${TASK_SELECT_COLUMNS}
         FROM tasks t
         LEFT JOIN task_results r ON r.task_id = t.id
        WHERE t.state = 'done'
        ORDER BY t.completed_at DESC
        LIMIT 20`,
    )
    .all() as TaskRowAliased[];

  return {
    reviewTasks: reviewRows.map(rowToTask),
    pendingTasks: pendingRows.map(rowToTask),
    clearedTasks: clearedRows.map(rowToTask),
    throughput: computeThroughput(vaultId),
    skills: buildSkillsForVault(vaultId),
    planTier: "free",
  };
}

// ─── HTTP handler ────────────────────────────────────────────────────────

function corsOrigin(): string {
  return process.env.GROVE_WWW_ORIGIN ?? "https://grove.md";
}

/**
 * Handle `GET /v/<slug>/v1/tasks`. Assumes auth/role/CORS were already
 * enforced by the proxy's `vaultV1Match` block; `vault` is the URL's
 * vault context, not the token's bound vault.
 */
export function handleV2TasksList(
  _req: IncomingMessage,
  res: ServerResponse,
  vault: VaultContext,
): void {
  const payload = buildBacklogPayload(vault.vaultId);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": corsOrigin(),
  });
  res.end(JSON.stringify(payload));
}

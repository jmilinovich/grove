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
import { bridgeDecisionsToTasks } from "./decision-writer.js";
import { SKILL_REGISTRY, type SkillMetadata } from "./skills/registry.js";
import { dispatchTaskRun } from "./v2-task-run.js";
import {
  dispatchTaskReview,
  dispatchTaskReviewV2,
  isReviewAction,
  type LegacyReviewAction,
  type ReviewAction,
  type ReviewActionV2,
} from "./v2-task-review.js";
import { ensureControlAttached } from "./v2-task-detail.js";
import type { VaultContext } from "./vault-router.js";
import type { Cadence, TaskState } from "./db-types.js";
import type { ReviewOption, SuggestionType } from "./v2-decisions.js";

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
  // Inbox v2 (S-INBOX-1). Optional + additive — populated for tasks
  // emitted by a suggestion-class skill once S-INBOX-9 wires
  // buildBacklogPayload to JOIN the decisions table. Legacy tasks
  // without a linked decision leave both undefined.
  itemType?: SuggestionType;
  options?: ReviewOption[];
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

/**
 * Review-state row shape: TaskRowAliased + two columns from the JOINed
 * `decisions` table. `decisionType` and `decisionOptionsJson` are null
 * for legacy review tasks with no backing decision; the DTO mapper
 * leaves `itemType`/`options` undefined in that case (UI handles
 * gracefully).
 */
interface ReviewRowAliased extends TaskRowAliased {
  decisionType: SuggestionType | null;
  decisionOptionsJson: string | null;
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

/**
 * S-INBOX-9 — same as rowToTask but hydrates `itemType` + `options` from
 * the JOINed decisions row when present. Legacy review tasks (no
 * matching decision) leave both undefined; the UI must handle that.
 */
function reviewRowToTask(row: ReviewRowAliased): Task {
  const task = rowToTask(row);
  if (row.decisionType !== null) {
    task.itemType = row.decisionType;
    if (row.decisionOptionsJson) {
      try {
        task.options = JSON.parse(row.decisionOptionsJson) as ReviewOption[];
      } catch (err) {
        console.error(
          "[v2-tasks] failed to parse decision options_json for task",
          row.id,
          err,
        );
      }
    }
  }
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

  // Vault age — drive `showCeiling` off the EARLIEST membership join
  // for this vault (matches Phase 21 spec D-7 / SPEC §7: "capacity dial
  // hidden during the first 14 days of usage"). A vault with no
  // memberships yet (e.g., during initial provisioning) hides the
  // ceiling — safer than anchoring on creation time which may run
  // ahead of actual use.
  const memberRow = getDb()
    .prepare(
      `SELECT MIN(joined_at) AS earliest
         FROM vault_members
        WHERE vault_id = ?`,
    )
    .get(vaultId) as { earliest: string | null } | undefined;
  const earliestMs = memberRow?.earliest
    ? new Date(memberRow.earliest).getTime()
    : null;
  const showCeiling =
    earliestMs !== null &&
    Date.now() - earliestMs > 14 * 24 * 60 * 60 * 1000;

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
  if (velocity === null || velocity <= 0) return "warming up";
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

  // S-INBOX-9 — lazily bridge any provisional Decision without a
  // task_id into a review-state Task. Without this, decisions recorded
  // by the suggestion skills (S-INBOX-6/7/8) are invisible to the
  // inbox UI. Idempotent: bridged Decisions have non-null task_id and
  // are skipped on subsequent calls. Tolerates a missing decisions
  // table (returns {created: 0}) — see decision-writer.ts.
  bridgeDecisionsToTasks(vaultId);

  // Detect whether the decisions table exists in this vault's
  // state.db. Production always has it (migration 003); fixture
  // databases that copy only 001/002 don't. The presence flag picks
  // between two equivalent review queries — JOINed (with itemType/
  // options hydration) vs unjoined (legacy fallback). Avoids forcing
  // every test fixture to copy migration 003.
  const hasDecisionsTable =
    vaultDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='decisions'",
      )
      .get() !== undefined;

  // review: oldest-disposition-first would invert the user's intuition;
  // newest review items go to the top of the list (matches the mock
  // implementation, SPEC §4).
  //
  // LEFT JOIN decisions ON decisions.task_id = t.id hydrates `itemType`
  // and `options` on review-state Task DTOs (S-INBOX-9). Legacy review
  // tasks with no backing decision return null for both columns and
  // surface with itemType + options undefined.
  const reviewRows = hasDecisionsTable
    ? (vaultDb
        .prepare(
          `SELECT ${TASK_SELECT_COLUMNS},
                  d.type         AS decisionType,
                  d.options_json AS decisionOptionsJson
             FROM tasks t
             LEFT JOIN task_results r ON r.task_id = t.id
             LEFT JOIN decisions d    ON d.task_id = t.id
            WHERE t.state = 'review'
            ORDER BY t.created_at DESC`,
        )
        .all() as ReviewRowAliased[])
    : (vaultDb
        .prepare(
          `SELECT ${TASK_SELECT_COLUMNS}
             FROM tasks t
             LEFT JOIN task_results r ON r.task_id = t.id
            WHERE t.state = 'review'
            ORDER BY t.created_at DESC`,
        )
        .all() as TaskRowAliased[]
      ).map((r) => ({
        ...r,
        decisionType: null,
        decisionOptionsJson: null,
      })) as ReviewRowAliased[];

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
    reviewTasks: reviewRows.map(reviewRowToTask),
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

/**
 * Handle `POST /v/<slug>/v1/tasks/<id>/run` (P22-1).
 *
 * Thin HTTP wrapper over `dispatchTaskRun`. The state machine lives in
 * `src/v2-task-run.ts` so unit tests can drive transitions without
 * standing up a server. Auth and rate-limiting happen upstream in the
 * proxy's `vaultV1Match` + `/v1/*` blocks.
 */
export function handleV2TaskRun(
  _req: IncomingMessage,
  res: ServerResponse,
  vault: VaultContext,
  taskId: string,
): void {
  const { status, body } = dispatchTaskRun(vault, taskId);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": corsOrigin(),
  });
  res.end(JSON.stringify(body));
}

// ─── P22-2: defer + dismiss ──────────────────────────────────────────────

const MAX_DEFER_DISMISS_BODY = 64 * 1024;

function readJsonBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_DEFER_DISMISS_BODY) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": corsOrigin(),
  });
  res.end(JSON.stringify(body));
}


function fetchTaskById(vaultId: string, taskId: string): Task | null {
  const vaultDb = getVaultDb(vaultId);
  const row = vaultDb
    .prepare(
      `SELECT ${TASK_SELECT_COLUMNS}
         FROM tasks t
         LEFT JOIN task_results r ON r.task_id = t.id
        WHERE t.id = ?
        LIMIT 1`,
    )
    .get(taskId) as TaskRowAliased | undefined;
  return row ? rowToTask(row) : null;
}

/**
 * `POST /v/<slug>/v1/tasks/<id>/defer` — body `{until: ISO_8601}`.
 *
 * Sets `tasks.scheduled_for = until` when the task is in a state where
 * scheduling makes sense (`pending` or `review`). Terminal states
 * (`done`, `dismissed`, `failed`) or already-running tasks return 409
 * with the current state — defer is meaningless once the task has
 * already executed. Bad ISO returns 400.
 *
 * Auth/CORS are enforced upstream by proxy.ts's `vaultV1Match` block;
 * this handler trusts that gate.
 */
export async function handleV2TaskDefer(
  req: IncomingMessage,
  res: ServerResponse,
  vault: VaultContext,
  taskId: string,
): Promise<void> {
  let raw: string;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "read_error" });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }

  const until =
    parsed && typeof parsed === "object" && "until" in parsed
      ? (parsed as { until: unknown }).until
      : undefined;
  if (typeof until !== "string" || until.length === 0) {
    sendJson(res, 400, { error: "until_required" });
    return;
  }
  // Date.parse accepts a wide range of inputs; we only need to know
  // whether the string is parseable as a timestamp. The value is stored
  // as-is (TEXT) and compared via SQLite's `datetime()` later.
  if (Number.isNaN(Date.parse(until))) {
    sendJson(res, 400, { error: "invalid_until" });
    return;
  }

  const vaultDb = getVaultDb(vault.vaultId);
  const taskRow = vaultDb
    .prepare("SELECT state FROM tasks WHERE id = ? LIMIT 1")
    .get(taskId) as { state: TaskState } | undefined;
  if (!taskRow) {
    sendJson(res, 404, { error: "task_not_found" });
    return;
  }
  if (taskRow.state !== "pending" && taskRow.state !== "review") {
    sendJson(res, 409, { error: "invalid_state", state: taskRow.state });
    return;
  }

  vaultDb
    .prepare(
      "UPDATE tasks SET scheduled_for = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .run(until, taskId);

  const updated = fetchTaskById(vault.vaultId, taskId);
  sendJson(res, 200, updated);
}

// ─── P22-3 / S-INBOX-10: review disposition ──────────────────────────────

interface LegacyReviewBody {
  shape: "legacy";
  action: LegacyReviewAction;
  refinement?: string;
}

interface V2ReviewBody {
  shape: "v2";
  action: ReviewActionV2;
}

type ParsedReviewBody = LegacyReviewBody | V2ReviewBody;

/**
 * S-INBOX-10 — accepts BOTH the legacy ReviewAction shape (PR #71's
 * grove-www UI) AND the new V2 shape so this server can ship before
 * W-INBOX-1/2/3 cut grove-www over.
 *
 *   Legacy: `{action: "confirm-durable"|"refine"|"dismiss"|"mark-stale", refinement?}`
 *   V2:     `{kind: "apply", option_id}` |
 *           `{kind: "refine", refinement}` |
 *           `{kind: "dismiss"}`
 *
 * The discriminator is whether `kind` is a recognized V2 verb; if not,
 * we fall through to the legacy parser. An object that's neither shape
 * returns `{error: "invalid_action"}` to match the pre-S-INBOX-10 wire
 * contract.
 */
function parseReviewBody(raw: string): ParsedReviewBody | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { error: "invalid_body" };
  }
  const obj = parsed as Record<string, unknown>;

  // V2 shape — discriminated by `kind`.
  if (typeof obj.kind === "string") {
    if (obj.kind === "apply") {
      if (typeof obj.option_id !== "string" || obj.option_id.length === 0) {
        return { error: "option_id_required" };
      }
      return {
        shape: "v2",
        action: { kind: "apply", option_id: obj.option_id },
      };
    }
    if (obj.kind === "refine") {
      if (typeof obj.refinement !== "string" || obj.refinement.length === 0) {
        return { error: "refinement_required" };
      }
      return {
        shape: "v2",
        action: { kind: "refine", refinement: obj.refinement },
      };
    }
    if (obj.kind === "dismiss") {
      return { shape: "v2", action: { kind: "dismiss" } };
    }
    return { error: "invalid_action" };
  }

  // Legacy shape — `action` must be one of the four legacy verbs.
  if (!isReviewAction(obj.action)) {
    return { error: "invalid_action" };
  }
  const result: LegacyReviewBody = { shape: "legacy", action: obj.action };
  if (obj.refinement !== undefined) {
    if (typeof obj.refinement !== "string") {
      return { error: "invalid_refinement" };
    }
    result.refinement = obj.refinement;
  }
  return result;
}

/**
 * `POST /v/<slug>/v1/tasks/<id>/review` — disposition a review-state task.
 *
 * Body shape: `{action, refinement?}` where action is one of
 * `confirm-durable | refine | dismiss | mark-stale`. See
 * `v2-task-review.ts` for per-action semantics.
 *
 * `userId` comes from the proxy's auth resolution — the API key's
 * `user_id` is stamped as `Provenance-By` on confirm-durable commits.
 */
export async function handleV2TaskReview(
  req: IncomingMessage,
  res: ServerResponse,
  vault: VaultContext,
  taskId: string,
  userId: string,
): Promise<void> {
  let raw: string;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "read_error" });
    return;
  }
  const parsed = parseReviewBody(raw);
  if ("error" in parsed) {
    sendJson(res, 400, parsed);
    return;
  }

  if (parsed.shape === "v2") {
    const { status, body } = await dispatchTaskReviewV2({
      vault,
      taskId,
      userId,
      action: parsed.action,
    });
    sendJson(res, status, body);
    return;
  }

  // Legacy shape — dispatchTaskReview translates to V2 internally when
  // the task has a backing Decision, or falls through to the original
  // P22-3 path when it has a note-change artifact and no Decision.
  const { status, body } = await dispatchTaskReview({
    vault,
    taskId,
    userId,
    action: parsed.action,
    refinement: parsed.refinement,
  });
  sendJson(res, status, body);
}

/**
 * `POST /v/<slug>/v1/tasks/<id>/dismiss` — idempotent.
 *
 * Transitions the task to `state = 'dismissed'`. If the task was
 * derived from a `graph_health_flags` row (`source_flag_id` non-null),
 * also marks that flag resolved in `control.db.graph_health_flags`
 * within the same transaction — ATTACH-cross-DB write so the flag
 * doesn't re-surface as a new task on the next cron tick (Phase 22
 * locked design decision #1).
 *
 * ATTACH happens once per pooled vault connection
 * (`ensureControlAttached`); the transaction itself wraps both UPDATEs
 * via better-sqlite3's `.transaction().immediate()` so the two writes
 * either both land or neither does.
 */
export async function handleV2TaskDismiss(
  req: IncomingMessage,
  res: ServerResponse,
  vault: VaultContext,
  taskId: string,
): Promise<void> {
  // Body is optional — dismiss takes no parameters today — but drain it
  // anyway so the socket isn't left half-read on the next pipelined
  // request.
  try {
    await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "read_error" });
    return;
  }

  const vaultDb = getVaultDb(vault.vaultId);
  const taskRow = vaultDb
    .prepare(
      "SELECT state, source_flag_id FROM tasks WHERE id = ? LIMIT 1",
    )
    .get(taskId) as
    | { state: TaskState; source_flag_id: string | null }
    | undefined;
  if (!taskRow) {
    sendJson(res, 404, { error: "task_not_found" });
    return;
  }

  const sourceFlagId = taskRow.source_flag_id;
  const updateTask = vaultDb.prepare(
    "UPDATE tasks SET state = 'dismissed', updated_at = datetime('now') WHERE id = ? AND state != 'dismissed'",
  );

  if (sourceFlagId) {
    ensureControlAttached(vaultDb);
    const updateFlag = vaultDb.prepare(
      "UPDATE control.graph_health_flags SET resolved_at = datetime('now') WHERE id = ? AND resolved_at IS NULL",
    );
    const tx = vaultDb.transaction(() => {
      updateTask.run(taskId);
      updateFlag.run(sourceFlagId);
    });
    tx.immediate();
  } else {
    updateTask.run(taskId);
  }

  const updated = fetchTaskById(vault.vaultId, taskId);
  sendJson(res, 200, updated);
}

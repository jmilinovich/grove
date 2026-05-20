/**
 * P22-3 — v2 task review disposition dispatcher.
 *
 * `POST /v/<slug>/v1/tasks/<id>/review` accepts one of four LEGACY actions
 * or the new S-INBOX-10 V2 shape:
 *
 *   Legacy (PR #71 grove-www UI):  confirm-durable | refine | dismiss | mark-stale
 *   V2 (post-S-INBOX-10):          {kind: "apply", option_id} |
 *                                  {kind: "refine", refinement} |
 *                                  {kind: "dismiss"}
 *
 * Only tasks in `state = 'review'` are dispositionable. Anything else
 * returns 409 with the current state.
 *
 * Dispatch routing (S-INBOX-10):
 *   - Task linked to a Decision → V2 per-type dispatch (apply / refine /
 *     dismiss). compensateDecision handles rollback; suppression rows
 *     handle dismiss memory; refine-handler tasks carry forward the
 *     operator's refinement instruction.
 *   - Task with a note-change artifact and NO decision → legacy P22-3
 *     dispatch (note-change write + provenance trailer). Preserves the
 *     pre-Inbox-v2 daily-vault-review behavior.
 *   - Task with no decision and no note-change → V2 legacy-compat
 *     fallback: confirm → done, dismiss → dismissed, refine → spawn
 *     refine-handler.
 *
 * Writes (confirm-durable on a note-change artifact, and refine) go to the
 * vault repo via `vault-ops.ts` helpers with provenance trailers composed
 * by `provenance.ts`. The two voices differ:
 *   - confirm-durable: `by: <api_key.user_id>` — the operator confirmed the
 *     Claude-generated change as durable intent.
 *   - refine: `by: 'human'` — the operator rewrote the change; the
 *     refinement field carries the new note content verbatim.
 *
 * dismiss mirrors P22-2: state→dismissed plus a cross-DB ATTACH write
 * to `control.graph_health_flags.resolved_at` when the task was derived
 * from a flag (locked design decision #1).
 *
 * mark-stale leaves the artifact untouched, transitions to dismissed,
 * and appends a stale marker to `tasks.body` so the audit log carries
 * the operator's signal.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { getVaultDb } from "./db-per-vault.js";
import { gitCommit, qmdReindex, writeNoteFile } from "./vault-ops.js";
import {
  composeCommitMessage,
  provenanceToTrailers,
  type Provenance,
} from "./provenance.js";
import { ensureControlAttached } from "./v2-task-detail.js";
import { compensateDecision } from "./decision-compensate.js";
import type { VaultContext } from "./vault-router.js";
import type { DecisionRow, TaskState } from "./db-types.js";
import type {
  DecisionPayload,
  DisambiguationPayload,
  EnrichmentPayload,
  LinkPayload,
  ReviewOption,
  SuggestionType,
} from "./v2-decisions.js";

/**
 * Legacy ReviewAction union — the wire shape PR #71's grove-www UI ships
 * today. Kept intact so the live UI keeps working until W-INBOX-1..3 cut
 * over to the V2 shape. Exported as both `LegacyReviewAction` (the new
 * preferred name) and `ReviewAction` (the original name; preserved so
 * existing imports compile without changes).
 */
export type LegacyReviewAction =
  | "confirm-durable"
  | "refine"
  | "dismiss"
  | "mark-stale";
export type ReviewAction = LegacyReviewAction;

const REVIEW_ACTIONS: ReadonlySet<LegacyReviewAction> = new Set([
  "confirm-durable",
  "refine",
  "dismiss",
  "mark-stale",
]);

export function isReviewAction(s: unknown): s is LegacyReviewAction {
  return typeof s === "string" && REVIEW_ACTIONS.has(s as LegacyReviewAction);
}

/**
 * S-INBOX-10 — the V2 review action shape. `apply` confirms a decision
 * (matching option_id = no-op + confirm; different = compensate +
 * re-apply); `refine` rolls back and spawns a refine-handler task with
 * the operator's freeform instruction; `dismiss` rolls back and inserts
 * a 14-day suppression.
 */
export type ReviewActionV2 =
  | { kind: "apply"; option_id: string }
  | { kind: "refine"; refinement: string }
  | { kind: "dismiss" };

/** Suppression TTL for dismiss actions — 14 days per S-INBOX-10 spec. */
const SUPPRESSION_TTL_DAYS = 14;

/** Synthetic option id used when a legacy `confirm-durable` lands on a
 *  task with no backing Decision. The V2 dispatcher treats this as
 *  "no-op + confirm" — no compensation, no decision touched. */
const LEGACY_CONFIRM_OPTION_ID = "opt-confirm";

export interface DispatchReviewInput {
  vault: VaultContext;
  taskId: string;
  /**
   * API key user_id from auth resolution (proxy.ts vaultV1Match block).
   * Stamped as `Provenance-By` on confirm-durable commits.
   */
  userId: string;
  action: LegacyReviewAction;
  refinement?: string;
}

export interface DispatchReviewResponse {
  status: 200 | 400 | 404 | 409;
  body: unknown;
}

/**
 * S-INBOX-10 input for the V2 dispatcher. Same shape as the legacy
 * `DispatchReviewInput` but carries the parsed `ReviewActionV2` instead
 * of the legacy string-typed action.
 */
export interface DispatchReviewV2Input {
  vault: VaultContext;
  taskId: string;
  userId: string;
  action: ReviewActionV2;
}

interface TaskCoreRow {
  state: TaskState;
  body: string | null;
  source_flag_id: string | null;
}

interface ResultRow {
  artifact_json: string;
  note_change_json: string | null;
}

interface ArtifactSummary {
  artifactType: string;
  notePath: string | null;
  /** Parsed note-change payload — null when absent or malformed. */
  noteChange: { content: string } | null;
}

function readArtifact(
  db: Database.Database,
  taskId: string,
): ArtifactSummary | null {
  const row = db
    .prepare(
      "SELECT artifact_json, note_change_json FROM task_results WHERE task_id = ? LIMIT 1",
    )
    .get(taskId) as ResultRow | undefined;
  if (!row) return null;

  let artifactType = "surface";
  let notePath: string | null = null;
  try {
    const a = JSON.parse(row.artifact_json) as {
      type?: string;
      notePath?: string;
    };
    if (typeof a.type === "string") artifactType = a.type;
    if (typeof a.notePath === "string") notePath = a.notePath;
  } catch {
    // malformed artifact_json — surface as plain 'surface' artifact
  }

  let noteChange: { content: string } | null = null;
  if (row.note_change_json) {
    try {
      const parsed = JSON.parse(row.note_change_json) as { content?: unknown };
      if (parsed && typeof parsed.content === "string") {
        noteChange = { content: parsed.content };
      }
    } catch {
      // malformed note_change_json — treat as if no change recorded
    }
  }

  return { artifactType, notePath, noteChange };
}

async function applyNoteChange(
  vault: VaultContext,
  notePath: string,
  content: string,
  prov: Provenance,
  subject: string,
): Promise<void> {
  const absPath = join(vault.vaultPath, notePath);
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeNoteFile(absPath, content);
  const message = composeCommitMessage(subject, provenanceToTrailers(prov));
  await gitCommit(vault.vaultPath, notePath, message);
  // Fire-and-forget reindex — `qmd update` failures shouldn't fail the
  // disposition, and a search-index lag is recoverable on next sync.
  qmdReindex(vault.vaultPath).catch(() => {});
}

/**
 * Dispatch a `/review` action. Validates state, applies the action,
 * returns the response envelope for the HTTP wrapper.
 *
 * Routing (S-INBOX-10):
 *   1. If the task is linked to a Decision (`decisions.task_id = task.id`),
 *      translate the legacy action to V2 and dispatch via the V2 path
 *      (compensate / confirm / spawn-refine-handler / suppression-insert).
 *   2. Otherwise — the legacy P22-3 path runs as-is: confirm-durable
 *      writes a note-change artifact's content with a durable provenance
 *      trailer; refine writes the operator's edit; dismiss resolves any
 *      linked graph_health_flag; mark-stale appends the stale marker.
 *      This preserves the pre-Inbox-v2 daily-vault-review semantics.
 *
 * The legacy-shape parser feeds this function; the V2-shape parser
 * skips ahead to `dispatchTaskReviewV2` directly.
 */
export async function dispatchTaskReview(
  input: DispatchReviewInput,
): Promise<DispatchReviewResponse> {
  const { vault, taskId, userId, action, refinement } = input;
  if (!isReviewAction(action)) {
    return { status: 400, body: { error: "invalid_action" } };
  }

  const db = getVaultDb(vault.vaultId);
  const taskRow = db
    .prepare(
      "SELECT state, body, source_flag_id FROM tasks WHERE id = ? LIMIT 1",
    )
    .get(taskId) as TaskCoreRow | undefined;
  if (!taskRow) {
    return { status: 404, body: { error: "task_not_found" } };
  }
  if (taskRow.state !== "review") {
    return {
      status: 409,
      body: { error: "invalid_state", state: taskRow.state },
    };
  }

  const decision = loadDecisionForTask(db, taskId);

  // Route 1: Task linked to a Decision → V2 dispatch (Inbox v2 path).
  if (decision) {
    // Refine via the legacy shape still needs a non-empty refinement —
    // validate at the boundary so a missing field doesn't slip into the
    // V2 dispatcher as an empty instruction.
    if (action === "refine") {
      if (typeof refinement !== "string" || refinement.length === 0) {
        return { status: 400, body: { error: "refinement_required" } };
      }
    }
    const v2Action = translateLegacyToV2(action, refinement, decision);
    return dispatchTaskReviewV2({
      vault,
      taskId,
      userId,
      action: v2Action,
    });
  }

  // Route 2: Legacy P22-3 — no backing Decision. Keep the original
  // per-action behavior so daily-vault-review note-change writes,
  // graph_health_flag resolution, and stale-marker appends all work
  // exactly as they did pre-S-INBOX-10.
  switch (action) {
    case "confirm-durable":
      return confirmDurable(db, vault, taskId, userId);
    case "refine":
      return refine(db, vault, taskId, refinement);
    case "dismiss":
      return dismiss(db, taskId, taskRow.source_flag_id);
    case "mark-stale":
      return markStale(db, taskId, taskRow.body);
  }
}

/**
 * Translate a legacy review action to the V2 shape. The translation
 * depends on whether the task has a linked Decision:
 *   - confirm-durable + decision  → {kind: "apply", option_id: decision.chosenOptionId}
 *   - confirm-durable + no decision → {kind: "apply", option_id: "opt-confirm"}
 *   - refine                      → {kind: "refine", refinement}
 *   - dismiss / mark-stale        → {kind: "dismiss"}
 *
 * The synthetic `opt-confirm` id is recognized by the V2 dispatcher as
 * "no-op + confirm" so legacy tasks with no backing decision pass
 * through cleanly.
 */
function translateLegacyToV2(
  action: LegacyReviewAction,
  refinement: string | undefined,
  decision: LoadedDecision | null,
): ReviewActionV2 {
  switch (action) {
    case "confirm-durable":
      return {
        kind: "apply",
        option_id: decision?.chosen_option_id ?? LEGACY_CONFIRM_OPTION_ID,
      };
    case "refine":
      return {
        kind: "refine",
        refinement: refinement ?? "",
      };
    case "dismiss":
    case "mark-stale":
      return { kind: "dismiss" };
  }
}

async function confirmDurable(
  db: Database.Database,
  vault: VaultContext,
  taskId: string,
  userId: string,
): Promise<DispatchReviewResponse> {
  const artifact = readArtifact(db, taskId);
  if (artifact && artifact.artifactType === "note-change") {
    if (!artifact.notePath || !artifact.noteChange) {
      // A note-change artifact without a path or change payload can't
      // produce a deterministic write — refuse rather than guess.
      return {
        status: 409,
        body: { error: "incomplete_note_change_artifact" },
      };
    }
    const provenance: Provenance = {
      voice: "durable",
      by: userId,
      written_at: new Date().toISOString(),
    };
    const subject = `grove: confirm-durable ${artifact.notePath}`;
    await applyNoteChange(
      vault,
      artifact.notePath,
      artifact.noteChange.content,
      provenance,
      subject,
    );
  }
  db.prepare(
    "UPDATE tasks SET state = 'done', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
  ).run(taskId);
  return { status: 200, body: { id: taskId, state: "done" } };
}

async function refine(
  db: Database.Database,
  vault: VaultContext,
  taskId: string,
  refinement: string | undefined,
): Promise<DispatchReviewResponse> {
  if (typeof refinement !== "string" || refinement.length === 0) {
    return { status: 400, body: { error: "refinement_required" } };
  }
  const artifact = readArtifact(db, taskId);
  if (
    !artifact ||
    artifact.artifactType !== "note-change" ||
    !artifact.notePath
  ) {
    return { status: 409, body: { error: "not_a_note_change_artifact" } };
  }
  const provenance: Provenance = {
    voice: "durable",
    by: "human",
    written_at: new Date().toISOString(),
  };
  const subject = `grove: refine ${artifact.notePath}`;
  await applyNoteChange(
    vault,
    artifact.notePath,
    refinement,
    provenance,
    subject,
  );
  db.prepare(
    "UPDATE tasks SET state = 'done', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
  ).run(taskId);
  return { status: 200, body: { id: taskId, state: "done" } };
}

function dismiss(
  db: Database.Database,
  taskId: string,
  sourceFlagId: string | null,
): DispatchReviewResponse {
  if (sourceFlagId) {
    ensureControlAttached(db);
    const updateTask = db.prepare(
      "UPDATE tasks SET state = 'dismissed', updated_at = datetime('now') WHERE id = ? AND state != 'dismissed'",
    );
    const updateFlag = db.prepare(
      "UPDATE control.graph_health_flags SET resolved_at = datetime('now') WHERE id = ? AND resolved_at IS NULL",
    );
    const tx = db.transaction(() => {
      updateTask.run(taskId);
      updateFlag.run(sourceFlagId);
    });
    tx.immediate();
  } else {
    db.prepare(
      "UPDATE tasks SET state = 'dismissed', updated_at = datetime('now') WHERE id = ? AND state != 'dismissed'",
    ).run(taskId);
  }
  return { status: 200, body: { id: taskId, state: "dismissed" } };
}

const STALE_MARKER = "\n\n[stale: marked by user]";

function markStale(
  db: Database.Database,
  taskId: string,
  body: string | null,
): DispatchReviewResponse {
  const newBody = (body ?? "") + STALE_MARKER;
  db.prepare(
    "UPDATE tasks SET state = 'dismissed', body = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(newBody, taskId);
  return { status: 200, body: { id: taskId, state: "dismissed" } };
}

// ─── S-INBOX-10 — V2 per-type dispatch ───────────────────────────────────

/**
 * Minimal projection of the `decisions` row carrying just what the V2
 * dispatcher needs. Keeping this narrow avoids loading the full domain
 * Decision (with parsed payload + options) in the common path where
 * we only need ids + the type.
 */
interface LoadedDecision {
  id: string;
  type: SuggestionType;
  status: string;
  chosen_option_id: string;
  payload_json: string;
  options_json: string;
  affected_paths_json: string;
}

/**
 * Look up the Decision linked to a task. Returns null when the task has
 * no backing decision (legacy task) or when the per-vault decisions
 * table is missing (older fixture vaults without migration 003).
 */
function loadDecisionForTask(
  db: Database.Database,
  taskId: string,
): LoadedDecision | null {
  // Defensive: migration 003 added the decisions table; test fixtures
  // pre-S-INBOX-1 may not have it. Treat a missing table as "no
  // decision linked" rather than crashing the dispatcher.
  const exists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='decisions'",
    )
    .get() as { name: string } | undefined;
  if (!exists) return null;
  const row = db
    .prepare(
      `SELECT id, type, status, chosen_option_id,
              payload_json, options_json, affected_paths_json
         FROM decisions WHERE task_id = ? LIMIT 1`,
    )
    .get(taskId) as
    | (Pick<
        DecisionRow,
        | "id"
        | "type"
        | "status"
        | "chosen_option_id"
        | "payload_json"
        | "options_json"
        | "affected_paths_json"
      >)
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    type: row.type as SuggestionType,
    status: row.status,
    chosen_option_id: row.chosen_option_id,
    payload_json: row.payload_json,
    options_json: row.options_json,
    affected_paths_json: row.affected_paths_json,
  };
}

/**
 * S-INBOX-10 V2 dispatcher. Routes based on `action.kind` and whether
 * the task has a backing decision:
 *
 *   apply (matching option_id)   → confirm decision (no compensation)
 *   apply (different option_id)  → compensateDecision(... newChoice)
 *   apply (no decision)          → no-op + state='done'
 *   refine (decision exists)     → compensateDecision(rollback) + spawn refine-handler
 *   refine (no decision)         → spawn refine-handler (skip compensation)
 *   dismiss (decision exists)    → compensateDecision(rollback) + insert suppression
 *   dismiss (no decision)        → state='dismissed' (no suppression — nothing to suppress)
 */
export async function dispatchTaskReviewV2(
  input: DispatchReviewV2Input,
): Promise<DispatchReviewResponse> {
  const { vault, taskId, action } = input;
  const db = getVaultDb(vault.vaultId);
  const taskRow = db
    .prepare(
      "SELECT state, body, title, source_flag_id FROM tasks WHERE id = ? LIMIT 1",
    )
    .get(taskId) as
    | (TaskCoreRow & { title: string })
    | undefined;
  if (!taskRow) {
    return { status: 404, body: { error: "task_not_found" } };
  }
  if (taskRow.state !== "review") {
    return {
      status: 409,
      body: { error: "invalid_state", state: taskRow.state },
    };
  }

  const decision = loadDecisionForTask(db, taskId);

  switch (action.kind) {
    case "apply":
      return await applyV2(db, vault, taskId, action.option_id, decision);
    case "refine":
      return await refineV2(db, vault, taskId, taskRow.title, action.refinement, decision);
    case "dismiss":
      return await dismissV2(db, vault, taskId, decision);
  }
}

/**
 * V2 apply: confirm the linked decision (matching option_id), or
 * compensate-and-re-apply with a different option (refine-by-pick),
 * or — when no decision is linked — close the task with no side effects.
 */
async function applyV2(
  db: Database.Database,
  vault: VaultContext,
  taskId: string,
  optionId: string,
  decision: LoadedDecision | null,
): Promise<DispatchReviewResponse> {
  if (!decision) {
    // Legacy task with no backing decision — confirm just closes it.
    markTaskDone(db, taskId);
    return { status: 200, body: { id: taskId, state: "done" } };
  }

  if (decision.status !== "provisional") {
    // Decision already confirmed or compensated — nothing more to do.
    // Surface the conflict so the UI can refresh rather than retry.
    return {
      status: 409,
      body: { error: "decision_not_provisional", status: decision.status },
    };
  }

  if (optionId === decision.chosen_option_id) {
    // Matching option — confirm in place, no compensation needed.
    db.prepare(
      `UPDATE decisions SET status = 'confirmed' WHERE id = ?`,
    ).run(decision.id);
    markTaskDone(db, taskId);
    return { status: 200, body: { id: taskId, state: "done" } };
  }

  // Different option — locate it in the decision's options list and
  // run compensation with that as the newChoice.
  let options: ReviewOption[];
  try {
    options = JSON.parse(decision.options_json) as ReviewOption[];
  } catch {
    return { status: 400, body: { error: "decision_options_malformed" } };
  }
  const newChoice = options.find((o) => o.id === optionId);
  if (!newChoice) {
    return { status: 400, body: { error: "unknown_option_id", option_id: optionId } };
  }

  await compensateDecision(vault.vaultPath, vault.vaultId, decision.id, newChoice);
  markTaskDone(db, taskId);
  return { status: 200, body: { id: taskId, state: "done" } };
}

/**
 * V2 refine: roll back the linked decision (when one exists), then
 * spawn a `refine-handler` pending task carrying the operator's
 * instruction. Closes the original task as done.
 */
async function refineV2(
  db: Database.Database,
  vault: VaultContext,
  taskId: string,
  taskTitle: string,
  refinement: string,
  decision: LoadedDecision | null,
): Promise<DispatchReviewResponse> {
  if (typeof refinement !== "string" || refinement.length === 0) {
    return { status: 400, body: { error: "refinement_required" } };
  }

  if (decision) {
    if (decision.status !== "provisional") {
      return {
        status: 409,
        body: { error: "decision_not_provisional", status: decision.status },
      };
    }
    await compensateDecision(vault.vaultPath, vault.vaultId, decision.id);
  }

  // Spawn the follow-up refine-handler task. Body carries the original
  // decision id (when one existed) + the refinement text, JSON-encoded
  // so the executor can parse it back out.
  const refineTaskId = randomUUID();
  const refineBody = JSON.stringify({
    original_decision_id: decision?.id ?? null,
    refinement,
  });
  const refineTitle = `Refine: ${taskTitle}`;
  db.prepare(
    `INSERT INTO tasks (id, skill_slug, state, title, body, scheduled_for)
     VALUES (?, ?, 'pending', ?, ?, datetime('now'))`,
  ).run(refineTaskId, "refine-handler", refineTitle, refineBody);

  markTaskDone(db, taskId);
  return {
    status: 200,
    body: { id: taskId, state: "done", refine_task_id: refineTaskId },
  };
}

/**
 * V2 dismiss: roll back the linked decision (when one exists) and
 * insert a suppression row keyed by `(type, entity_key)` so the
 * suggesting skill won't re-emit the same suggestion within the TTL.
 * Legacy tasks (no decision) just transition to dismissed.
 */
async function dismissV2(
  db: Database.Database,
  vault: VaultContext,
  taskId: string,
  decision: LoadedDecision | null,
): Promise<DispatchReviewResponse> {
  if (!decision) {
    db.prepare(
      `UPDATE tasks SET state = 'dismissed',
                       completed_at = datetime('now'),
                       updated_at = datetime('now')
         WHERE id = ?`,
    ).run(taskId);
    return { status: 200, body: { id: taskId, state: "dismissed" } };
  }

  if (decision.status !== "provisional") {
    return {
      status: 409,
      body: { error: "decision_not_provisional", status: decision.status },
    };
  }

  await compensateDecision(vault.vaultPath, vault.vaultId, decision.id);
  const entityKey = extractEntityKey(decision);
  insertSuppression(db, decision.type, entityKey);
  db.prepare(
    `UPDATE tasks SET state = 'dismissed',
                     completed_at = datetime('now'),
                     updated_at = datetime('now')
       WHERE id = ?`,
  ).run(taskId);
  return { status: 200, body: { id: taskId, state: "dismissed" } };
}

/** Mark a task done with `completed_at = now` — used by V2 apply/refine. */
function markTaskDone(db: Database.Database, taskId: string): void {
  db.prepare(
    `UPDATE tasks SET state = 'done',
                     completed_at = datetime('now'),
                     updated_at = datetime('now')
       WHERE id = ?`,
  ).run(taskId);
}

/**
 * Derive the suppression entity_key from a decision's payload.
 * Per S-INBOX-10 spec: link/disambiguation → payload.source_path,
 * enrichment → payload.target_path. Fall back to decision.id when
 * the payload is malformed or missing the expected fields — better
 * to record a non-overlapping per-decision suppression than to crash
 * the dismiss path on a schema edge case.
 */
function extractEntityKey(decision: LoadedDecision): string {
  let payload: DecisionPayload | null = null;
  try {
    payload = JSON.parse(decision.payload_json) as DecisionPayload;
  } catch {
    return decision.id;
  }
  if (!payload) return decision.id;
  if (decision.type === "link" || decision.type === "disambiguation") {
    const p = payload as LinkPayload | DisambiguationPayload;
    return p.source_path || decision.id;
  }
  if (decision.type === "enrichment") {
    const p = payload as EnrichmentPayload;
    return p.target_path || decision.id;
  }
  return decision.id;
}

/**
 * Insert or refresh a suppression row. The UNIQUE(suggestion_type,
 * entity_key) constraint means re-dismissing extends the window for
 * the same (type, entity) rather than stacking rows — we resolve the
 * conflict by updating `suppressed_at` + `until` to the new timestamps.
 */
function insertSuppression(
  db: Database.Database,
  suggestionType: SuggestionType,
  entityKey: string,
): void {
  const now = new Date();
  const until = new Date(
    now.getTime() + SUPPRESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  const nowIso = now.toISOString();
  const untilIso = until.toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO suppressions (id, suggestion_type, entity_key, suppressed_at, until)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(suggestion_type, entity_key)
       DO UPDATE SET suppressed_at = excluded.suppressed_at,
                     until = excluded.until`,
  ).run(id, suggestionType, entityKey, nowIso, untilIso);
}

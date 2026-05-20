/**
 * S-INBOX-10 — v2 task review disposition dispatcher.
 *
 * `POST /v/<slug>/v1/tasks/<id>/review` accepts only the V2 shape
 * introduced in S-INBOX-10:
 *
 *   {kind: "apply",   option_id} |
 *   {kind: "refine",  refinement} |
 *   {kind: "dismiss"}
 *
 * The legacy string-action shape (PR #71) was retired in C-INBOX-1 once
 * `grove-www` stopped sending it. Anything that isn't the V2 shape
 * returns 400.
 *
 * Only tasks in `state = 'review'` are dispositionable. Anything else
 * returns 409 with the current state.
 *
 * Dispatch routing:
 *   - apply (matching option_id)   → confirm decision (no compensation)
 *   - apply (different option_id)  → compensateDecision(... newChoice)
 *   - apply (no decision linked)   → no-op + state='done'
 *   - refine (decision exists)     → compensateDecision(rollback) + spawn refine-handler
 *   - refine (no decision)         → spawn refine-handler (skip compensation)
 *   - dismiss (decision exists)    → compensateDecision(rollback) + insert suppression
 *   - dismiss (no decision)        → state='dismissed' (no suppression — nothing to suppress)
 *
 * Provenance: each decision class writes its provisional change with a
 * full provenance trailer at the moment it lands (see
 * `recordDecision`/`commitSkillRun` in `decision-writer.ts`). The
 * `apply` path here either confirms the existing commit in-place
 * (matching option) or runs `compensateDecision` (different option),
 * which itself emits a compensating commit with its own trailers.
 * Refine/dismiss go through `compensateDecision` for the rollback.
 * Nothing in this file writes to the vault directly — the legacy
 * note-change write path (and the `applyNoteChange` / `readArtifact`
 * helpers) was retired with C-INBOX-1.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getVaultDb } from "./db-per-vault.js";
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

export interface DispatchReviewResponse {
  status: 200 | 400 | 404 | 409;
  body: unknown;
}

/**
 * S-INBOX-10 input for the V2 dispatcher.
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

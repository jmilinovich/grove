/**
 * P22-3 — v2 task review disposition dispatcher.
 *
 * `POST /v/<slug>/v1/tasks/<id>/review` accepts one of four actions:
 *   confirm-durable | refine | dismiss | mark-stale
 *
 * Only tasks in `state = 'review'` are dispositionable. Anything else
 * returns 409 with the current state.
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
import type { VaultContext } from "./vault-router.js";
import type { TaskState } from "./db-types.js";

export type ReviewAction =
  | "confirm-durable"
  | "refine"
  | "dismiss"
  | "mark-stale";

const REVIEW_ACTIONS: ReadonlySet<ReviewAction> = new Set([
  "confirm-durable",
  "refine",
  "dismiss",
  "mark-stale",
]);

export function isReviewAction(s: unknown): s is ReviewAction {
  return typeof s === "string" && REVIEW_ACTIONS.has(s as ReviewAction);
}

export interface DispatchReviewInput {
  vault: VaultContext;
  taskId: string;
  /**
   * API key user_id from auth resolution (proxy.ts vaultV1Match block).
   * Stamped as `Provenance-By` on confirm-durable commits.
   */
  userId: string;
  action: ReviewAction;
  refinement?: string;
}

export interface DispatchReviewResponse {
  status: 200 | 400 | 404 | 409;
  body: unknown;
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

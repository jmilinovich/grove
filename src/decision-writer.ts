/**
 * S-INBOX-3 — atomic decision writer + skill-run commit wrapper.
 *
 * Two responsibilities, kept narrow on purpose:
 *
 *   1. `recordDecision(vaultPath, vaultId, decision)` — insert into the
 *      per-vault `decisions` projection AND append to the
 *      `.grove/decisions.jsonl` event log, in that order. Insert-first
 *      is load-bearing: if the SQLite insert fails, the JSONL line is
 *      never written, so the projection and the log can't disagree. If
 *      the JSONL append fails after a successful insert, we log the
 *      inconsistency and rethrow so the surrounding skill-run rolls
 *      back instead of silently committing only half the world.
 *
 *   2. `commitSkillRun(vaultPath, paths, message, decisionIds)` — thin
 *      wrapper over `gitCommitPaths` that threads `decisionIds` into
 *      the commit trailers (one `Decision-Id: <id>` line each, after
 *      the existing provenance trailers). Per the S-INBOX-3 spec, the
 *      caller is responsible for including `.grove/decisions.jsonl` in
 *      `paths` whenever decisions were recorded — we assert that here
 *      so a forgotten path can't quietly produce a commit with
 *      `Decision-Id:` trailers but no log changes.
 *
 * No SQLite transaction here. The unit of atomicity is the
 * `commitSkillRun` (one git commit containing the JSONL line + every
 * file the skill changed); `recordDecision` is one step inside that
 * unit, ordered insert-first.
 */

import type { Decision } from "./v2-decisions.js";
import { appendDecisionEvent, decisionsLogPath } from "./decisions-log.js";
import { getVaultDb } from "./db-per-vault.js";
import { gitCommitPaths } from "./vault-ops.js";

const DECISIONS_LOG_REL = ".grove/decisions.jsonl";

/**
 * Atomically record one Decision: insert state.db row first, then
 * append the JSONL event line. See file header for the ordering
 * rationale.
 */
export function recordDecision(
  vaultPath: string,
  vaultId: string,
  decision: Decision,
): void {
  const db = getVaultDb(vaultId);
  const insert = db.prepare(
    `INSERT INTO decisions
       (id, type, skill_run_id, task_id, created_at, status,
        payload_json, options_json, chosen_option_id,
        affected_paths_json, compensated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Insert first — if this throws (e.g. CHECK constraint, primary-key
  // collision), the JSONL never grows.
  insert.run(
    decision.id,
    decision.type,
    decision.skillRunId,
    decision.taskId,
    decision.createdAt,
    decision.status,
    JSON.stringify(decision.payload),
    JSON.stringify(decision.options),
    decision.chosenOptionId,
    JSON.stringify(decision.affectedPaths),
    decision.compensatedBy,
  );

  // Append second. If this throws after a successful insert we surface
  // the inconsistency loudly so the surrounding skill-run rolls back
  // (no commit) and a future projection-replay can heal the projection.
  try {
    appendDecisionEvent(vaultPath, decision);
  } catch (err) {
    console.error(
      `[decision-writer] state.db insert for ${decision.id} succeeded but ` +
        `JSONL append to ${decisionsLogPath(vaultPath)} failed: ${
          (err as Error).message
        } — skill-run MUST roll back`,
    );
    throw err;
  }
}

/**
 * Commit the working-tree changes a skill produced as one git commit,
 * with `Decision-Id: <id>` trailers appended per recorded decision.
 *
 * `paths` is the set of vault-relative paths the skill modified. When
 * `decisionIds` is non-empty, `paths` MUST include
 * `.grove/decisions.jsonl` — otherwise the commit would claim to
 * record decisions without including the corresponding log entries.
 *
 * Empty `decisionIds` preserves the existing `gitCommitPaths` behavior
 * (no Decision-Id trailers; only provenance trailers in `message`).
 *
 * Returns the resulting commit SHA.
 */
export async function commitSkillRun(
  vaultPath: string,
  paths: string[],
  message: string,
  decisionIds: readonly string[],
): Promise<string> {
  if (decisionIds.length > 0 && !paths.includes(DECISIONS_LOG_REL)) {
    throw new Error(
      `commitSkillRun: decisionIds non-empty but paths is missing ${DECISIONS_LOG_REL} ` +
        `(decisions can't be committed without their log entries) — got paths=${JSON.stringify(paths)}`,
    );
  }
  return gitCommitPaths(vaultPath, paths, message, decisionIds);
}

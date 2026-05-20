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
import {
  appendDecisionEvent,
  decisionsLogPath,
  readDecisionEvents,
} from "./decisions-log.js";
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

/**
 * S-INBOX-4 — Replay `.grove/decisions.jsonl` into the per-vault
 * `decisions` projection.
 *
 * The JSONL log is the source of truth on disk; state.db's `decisions`
 * table is a rebuildable projection (per S-INBOX-2). This function is
 * the recovery path when state.db is lost or corrupted.
 *
 * Idempotent — uses `INSERT OR REPLACE` so re-running mid-replay is
 * safe and partial state from a previous attempt is overwritten with
 * the JSONL truth.
 *
 * Does **not** clear the table first. Full rebuilds are a two-step
 * dance — the caller decides:
 *
 *   db.prepare("DELETE FROM decisions").run();
 *   replayDecisionsFromLog(vaultPath, vaultId);
 *
 * Tolerates malformed lines the same way `readDecisionEvents` does —
 * a bad JSONL line is logged via `console.warn` and counted as
 * `skipped`, never thrown. One bad write must not poison every
 * future projection-rebuild.
 *
 * Returns `{ restored, skipped }`:
 *   - `restored` — rows inserted into `decisions` (one per valid JSONL line)
 *   - `skipped`  — malformed or non-object lines that `readDecisionEvents`
 *                  warned about and dropped
 *
 * Missing `.grove/decisions.jsonl` returns `{ restored: 0, skipped: 0 }`
 * (no throw).
 */
export function replayDecisionsFromLog(
  vaultPath: string,
  vaultId: string,
): { restored: number; skipped: number } {
  // readDecisionEvents handles missing file (-> []) and skips malformed
  // lines with a warn. We re-read raw to count skipped lines, since the
  // public reader doesn't surface that count.
  const events = readDecisionEvents(vaultPath);

  // Count malformed lines by diffing raw line count vs parsed event count.
  // We deliberately re-derive the count here rather than refactoring the
  // reader to return it — keeps the reader's API stable for S-INBOX-2's
  // callers and isolates the diagnostic concern to this rebuild path.
  let skipped = 0;
  try {
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const path = decisionsLogPath(vaultPath);
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      const nonEmptyLines = raw.split("\n").filter((line) => line.length > 0);
      skipped = nonEmptyLines.length - events.length;
      if (skipped < 0) skipped = 0; // defensive — should never happen
    }
  } catch {
    // Best-effort skipped count; the restored path is what matters.
    skipped = 0;
  }

  if (events.length === 0) {
    return { restored: 0, skipped };
  }

  const db = getVaultDb(vaultId);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO decisions
       (id, type, skill_run_id, task_id, created_at, status,
        payload_json, options_json, chosen_option_id,
        affected_paths_json, compensated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Wrap the replay in a transaction so a CHECK-constraint violation
  // mid-stream rolls back the partial write rather than leaving half a
  // projection behind. Idempotent re-runs still work — the next call
  // gets the same JSONL and produces the same final state.
  const replay = db.transaction((decisions: Decision[]) => {
    let restored = 0;
    for (const decision of decisions) {
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
      restored += 1;
    }
    return restored;
  });

  const restored = replay(events);
  return { restored, skipped };
}

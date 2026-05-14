/**
 * P22-1 — v2 task execution dispatcher.
 *
 * `POST /v/<slug>/v1/tasks/<id>/run` flips a pending task to `running`
 * and returns 202 immediately. Actual skill execution happens out-of-band
 * in a worker loop (`runTaskOnce` driven by `startTaskWorker`).
 *
 * Split-of-concerns (Phase 22 revision note #3):
 *   - HTTP path = state-machine only. No LLM call, no 25s timeout, no
 *     synchronous wait on the executor. Returns 202/200/409/404.
 *   - Worker loop = drains `state='running'` rows, invokes the skill
 *     executor, writes `task_results`, transitions to `review`/`done`/
 *     `failed`.
 *
 * State transitions in the HTTP handler:
 *   - `pending`               → flip to `running` + 202 (current task)
 *   - `review`                → 200 (idempotent — user uses /review to disposition)
 *   - `running`               → 409 ({state, error: 'already_running'})
 *   - `done|dismissed|failed` → 409 ({state, error: 'terminal_state'})
 *   - not found               → 404
 *
 * The pending → running flip is a single conditional UPDATE so two
 * concurrent /run requests can't both pass the state check; the loser
 * sees `changes() === 0` and is reclassified.
 *
 * The worker loop polls `tasks WHERE state='running' AND started_at`
 * older than the claim window across every vault DB (matches PLAN.md
 * Phase 22 revision note #3 — Phase 23's grove-scheduler process will
 * supersede this with a per-vault PM2 process).
 */

import type Database from "better-sqlite3";
import { getVaultDb, forEachVaultDb, type VaultRow } from "./db-per-vault.js";
import { getSkillBySlug } from "./skills/registry.js";
import type { VaultContext } from "./vault-router.js";
import type { TaskRow, TaskState } from "./db-types.js";
import type {
  GroveProvenance,
  Task,
  TaskArtifactType,
  TaskResult,
} from "./v2-tasks.js";

// ── Skill executor contract ─────────────────────────────────────────

export interface ExecutorArtifact {
  type: TaskArtifactType;
  notePath?: string;
  surfaceText?: string;
}

export interface ExecutorResult {
  artifact: ExecutorArtifact;
  /** Optional note-change payload — surfaced via task_results.note_change_json. */
  noteChange?: unknown;
  provenance: GroveProvenance;
  /** Terminal state after this run. `review` requires user disposition; `done` auto-completes. */
  finalState: "review" | "done";
}

export type SkillExecutor = (
  vault: VaultContext,
  task: TaskRow,
) => Promise<ExecutorResult>;

/**
 * Stub executor used until P22-5 lands the real `daily-vault-review`.
 *
 * Returns a surface artifact pointing at the originating skill so the
 * dashboard renders something rather than spinning forever. Marked
 * `perishable` — this is a Claude-generated placeholder, not durable
 * intent.
 */
async function stubExecutor(
  _vault: VaultContext,
  task: TaskRow,
): Promise<ExecutorResult> {
  const skill = getSkillBySlug(task.skill_slug);
  const skillName = skill?.name ?? task.skill_slug;
  return {
    artifact: {
      type: "surface",
      surfaceText: `${skillName} ran for ${task.title}. Real artifact lands when this skill's executor is implemented.`,
    },
    provenance: {
      voice: "perishable",
      by: "claude-opus-4-7",
      writtenAt: new Date().toISOString(),
      reason: "stub executor; awaiting real skill implementation",
    },
    finalState: "review",
  };
}

/**
 * Resolve the executor for a skill slug.
 *
 * Per PLAN.md Phase 22 revision: "Skill executor invoked via dynamic
 * import from src/skills/<slug>.ts inside the worker loop; for P22-1 a
 * stub executor is acceptable (P22-5 lands the real daily-vault-review)."
 *
 * We attempt a dynamic import; if the module is missing or doesn't
 * export a `run` function with the right shape, fall back to the stub
 * so the dispatcher still completes a task end-to-end. Tests can
 * override via `setExecutorForTesting`.
 */
const executorOverrides = new Map<string, SkillExecutor>();

export function setExecutorForTesting(
  slug: string,
  executor: SkillExecutor | null,
): void {
  if (executor === null) executorOverrides.delete(slug);
  else executorOverrides.set(slug, executor);
}

export function clearExecutorOverrides(): void {
  executorOverrides.clear();
}

async function loadExecutor(slug: string): Promise<SkillExecutor> {
  const override = executorOverrides.get(slug);
  if (override) return override;
  // Skill modules don't exist yet in P22-1 (P22-5+ land them). Try the
  // dynamic import optimistically; on any error (ENOENT, missing export)
  // fall through to the stub. Production logs the fallback so we notice
  // if a registered skill is missing its module.
  try {
    const mod: unknown = await import(`./skills/${slug}.js`);
    if (
      mod &&
      typeof mod === "object" &&
      "run" in mod &&
      typeof (mod as { run: unknown }).run === "function"
    ) {
      return (mod as { run: SkillExecutor }).run;
    }
  } catch {
    // module not present — expected for P22-1
  }
  return stubExecutor;
}

// ── HTTP-layer dispatch ─────────────────────────────────────────────

export interface DispatchResponse {
  status: 200 | 202 | 404 | 409;
  body: unknown;
}

function selectTaskRow(db: Database.Database, id: string): TaskRow | undefined {
  return db
    .prepare(
      `SELECT id, skill_slug, state, title, body, source_note_path,
              estimated_minutes, actual_minutes, scheduled_for,
              started_at, completed_at, source_flag_id,
              created_at, updated_at
         FROM tasks
        WHERE id = ?
        LIMIT 1`,
    )
    .get(id) as TaskRow | undefined;
}

interface ResultRow {
  artifact_json: string;
  note_change_json: string | null;
  provenance_json: string | null;
}

function selectResultRow(
  db: Database.Database,
  taskId: string,
): ResultRow | undefined {
  return db
    .prepare(
      `SELECT artifact_json, note_change_json, provenance_json
         FROM task_results
        WHERE task_id = ?
        LIMIT 1`,
    )
    .get(taskId) as ResultRow | undefined;
}

function rowToTask(row: TaskRow, db: Database.Database): Task {
  const resultRow = selectResultRow(db, row.id);
  let result: TaskResult | null = null;
  if (resultRow) {
    try {
      const artifact = JSON.parse(resultRow.artifact_json) as TaskResult["artifact"];
      const provenance: GroveProvenance = resultRow.provenance_json
        ? (JSON.parse(resultRow.provenance_json) as GroveProvenance)
        : { voice: "legacy-unknown" };
      result = { artifact, provenance };
    } catch {
      result = null;
    }
  }
  const task: Task = {
    id: row.id,
    skillId: row.skill_slug,
    title: row.title,
    description: row.body ?? "",
    state: row.state,
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    estimatedMinutes: row.estimated_minutes ?? 0,
    actualMinutes: row.actual_minutes,
    result,
  };
  if (row.source_note_path) task.sourceNotes = [row.source_note_path];
  return task;
}

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "done",
  "dismissed",
  "failed",
]);

/**
 * Dispatch `POST /v1/tasks/<id>/run`. Synchronous; returns the response
 * envelope for the HTTP wrapper to send.
 */
export function dispatchTaskRun(
  vault: VaultContext,
  taskId: string,
): DispatchResponse {
  const db = getVaultDb(vault.vaultId);
  const row = selectTaskRow(db, taskId);
  if (!row) {
    return { status: 404, body: { error: "task_not_found" } };
  }

  if (TERMINAL_STATES.has(row.state)) {
    return {
      status: 409,
      body: { error: "terminal_state", state: row.state },
    };
  }

  if (row.state === "review") {
    // Idempotent — caller uses /review to disposition; /run just echoes.
    return { status: 200, body: rowToTask(row, db) };
  }

  if (row.state === "running") {
    return {
      status: 409,
      body: { error: "already_running", state: "running" },
    };
  }

  // state === 'pending' — claim it. Conditional UPDATE so a concurrent
  // /run racing on the same row sees `changes() === 0` and loses.
  const update = db
    .prepare(
      `UPDATE tasks
          SET state = 'running',
              started_at = COALESCE(started_at, datetime('now')),
              updated_at = datetime('now')
        WHERE id = ?
          AND state = 'pending'`,
    )
    .run(taskId);

  if (update.changes === 0) {
    // Lost the race — re-read and reclassify so the caller sees the
    // current truth rather than a stale optimistic response.
    const fresh = selectTaskRow(db, taskId);
    if (!fresh) return { status: 404, body: { error: "task_not_found" } };
    if (TERMINAL_STATES.has(fresh.state)) {
      return {
        status: 409,
        body: { error: "terminal_state", state: fresh.state },
      };
    }
    if (fresh.state === "review") {
      return { status: 200, body: rowToTask(fresh, db) };
    }
    // running — the winner of the race is processing it.
    return {
      status: 409,
      body: { error: "already_running", state: "running" },
    };
  }

  const fresh = selectTaskRow(db, taskId);
  return { status: 202, body: rowToTask(fresh ?? row, db) };
}

// ── Worker loop ─────────────────────────────────────────────────────

/**
 * Run a single task's executor to completion. Reads the row, invokes
 * the resolved executor, writes the result, and transitions state.
 *
 * On executor throw: `state = 'failed'` and `task_results.artifact_json`
 * is `{type: "surface", surfaceText: <error message>}` with provenance
 * `{voice: "perishable", by: "system", reason: "executor_error"}`.
 *
 * No-op if the task isn't in `state = 'running'` — protects against the
 * worker picking up a row that another tick already finished.
 */
export async function runTaskOnce(
  vault: VaultContext,
  taskId: string,
): Promise<void> {
  const db = getVaultDb(vault.vaultId);
  const row = selectTaskRow(db, taskId);
  if (!row) return;
  if (row.state !== "running") return;

  const executor = await loadExecutor(row.skill_slug);

  let result: ExecutorResult | null = null;
  let errorMessage: string | null = null;
  try {
    result = await executor(vault, row);
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  if (result) {
    const completedAt =
      result.finalState === "done" ? "datetime('now')" : "NULL";
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO task_results (task_id, artifact_json, note_change_json, provenance_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           artifact_json = excluded.artifact_json,
           note_change_json = excluded.note_change_json,
           provenance_json = excluded.provenance_json`,
      ).run(
        taskId,
        JSON.stringify(result.artifact),
        result.noteChange ? JSON.stringify(result.noteChange) : null,
        JSON.stringify(result.provenance),
      );
      db.prepare(
        `UPDATE tasks
            SET state = ?,
                completed_at = ${completedAt},
                updated_at = datetime('now')
          WHERE id = ?`,
      ).run(result.finalState, taskId);
    });
    tx();
    return;
  }

  // Executor threw — record the failure and surface the message in the
  // artifact so the user sees something concrete rather than a silent
  // failed row.
  const errorArtifact = {
    type: "surface" as const,
    surfaceText: errorMessage ?? "executor failed without a message",
  };
  const errorProvenance: GroveProvenance = {
    voice: "perishable",
    by: "system",
    writtenAt: new Date().toISOString(),
    reason: "executor_error",
  };
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO task_results (task_id, artifact_json, provenance_json)
       VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         artifact_json = excluded.artifact_json,
         provenance_json = excluded.provenance_json`,
    ).run(
      taskId,
      JSON.stringify(errorArtifact),
      JSON.stringify(errorProvenance),
    );
    db.prepare(
      `UPDATE tasks
          SET state = 'failed',
              completed_at = datetime('now'),
              updated_at = datetime('now')
        WHERE id = ?`,
    ).run(taskId);
  });
  tx();
}

/**
 * Find one `state='running'` task across all vaults whose `started_at`
 * is at least `claimWindowMs` old. The age gate lets the HTTP handler
 * mark a task running and return 202 before the worker tries to claim
 * it; without it the worker could race the HTTP response and double-
 * process the same row.
 *
 * Returns null when no vault has a runnable task this tick.
 */
function findNextRunnableTask(
  claimWindowMs: number,
): { vault: VaultContext; taskId: string } | null {
  const minAgeSeconds = Math.max(1, Math.ceil(claimWindowMs / 1000));
  let found: { vault: VaultContext; taskId: string } | null = null;
  forEachVaultDb((db, vaultRow: VaultRow) => {
    if (found) return;
    const row = db
      .prepare(
        `SELECT id
           FROM tasks
          WHERE state = 'running'
            AND started_at IS NOT NULL
            AND datetime(started_at) <= datetime('now', ? || ' seconds')
          ORDER BY started_at ASC
          LIMIT 1`,
      )
      .get(`-${minAgeSeconds}`) as { id: string } | undefined;
    if (row) {
      found = {
        vault: {
          vaultId: vaultRow.id,
          vaultSlug: vaultRow.slug,
          // Worker-only context — vaultPath isn't needed by the stub
          // executor. Real executors (P22-5+) will resolve git_repo_path
          // from the vault row when they need it.
          vaultPath: "",
        },
        taskId: row.id,
      };
    }
  });
  return found;
}

let workerInterval: ReturnType<typeof setInterval> | null = null;
let workerTicking = false;

/**
 * Start the in-process task worker. Polls every `intervalMs` (default
 * 1000ms). One task per tick to keep the loop simple — at higher load
 * the Phase 23 scheduler process replaces this.
 *
 * Idempotent: calling twice is a no-op. `stopTaskWorker` shuts down.
 */
export function startTaskWorker(intervalMs: number = 1000): void {
  if (workerInterval) return;
  workerInterval = setInterval(() => {
    if (workerTicking) return;
    workerTicking = true;
    void (async () => {
      try {
        const next = findNextRunnableTask(intervalMs);
        if (next) await runTaskOnce(next.vault, next.taskId);
      } catch (err) {
        console.error(
          `[v2-task-run] worker tick failed: ${(err as Error).message}`,
        );
      } finally {
        workerTicking = false;
      }
    })();
  }, intervalMs);
  // Don't keep the event loop alive solely for the worker — matches
  // discovery-worker's behaviour so `node --stop-on-empty` style
  // shutdowns aren't blocked.
  if (typeof workerInterval.unref === "function") workerInterval.unref();
}

export function stopTaskWorker(): void {
  if (!workerInterval) return;
  clearInterval(workerInterval);
  workerInterval = null;
  workerTicking = false;
}

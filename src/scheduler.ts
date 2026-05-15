/**
 * P23-1 — Grove scheduler (per-vault PM2 process).
 *
 * Two setInterval loops in one process, both pinned to a single vault
 * via `GROVE_VAULT_ID` (PM2 emits one `grove-scheduler-<slug>` per row in
 * `vaults`). Mirrors the per-vault pinning of `discovery-worker.ts`.
 *
 *   1. Cron tick (every 60s by default)
 *      SELECT skill_configs WHERE enabled=1
 *                              AND cadence IN ('daily','weekly')
 *                              AND next_run_at <= datetime('now')
 *      For each match: INSERT a pending task row, advance `next_run_at`
 *      by the cadence, update `last_run_at`. `on-demand` / `on-trigger`
 *      never auto-enqueue here — those are user-driven.
 *
 *   2. Worker drain (every 1s by default)
 *      SELECT one task WHERE state='pending' AND scheduled_for <= now()
 *      ORDER BY scheduled_for ASC LIMIT 1. Claim it via a conditional
 *      UPDATE to `state='running'`, then dispatch the executor through
 *      the existing `runTaskOnce` code path (same one P22-1 uses).
 *
 * Boot pass — runs once before the loops start:
 *   a. Orphan recovery: any row stuck in `state='running'` past the
 *      claim window flips back to `pending`. Mirrors discovery's
 *      `recoverOrphanedDiscoveryProcessing` (fix #151). The per-vault
 *      pinning guarantees no sibling holds a running row for us at boot.
 *   b. Bootstrap check: if `vaults.bootstrap_pending=1`, invoke
 *      `bootstrapFirstRun()` (P23-2) and clear the flag. Also checked
 *      on every cron tick so a flag set after boot still gets picked up.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import { getVaultDb } from "./db-per-vault.js";
import { getSkillBySlug } from "./skills/registry.js";
import { runTaskOnce } from "./v2-task-run.js";
import type { Cadence } from "./db-types.js";
import type { VaultContext } from "./vault-router.js";

// ── Tunables ─────────────────────────────────────────────────────────

/** 1-minute cron tick (matches the locked decision in PLAN.md §P23-1). */
export const DEFAULT_TICK_MS = 60_000;
/** 1-second worker drain (matches existing `startTaskWorker` cadence). */
export const DEFAULT_WORKER_MS = 1_000;
/** Orphan recovery threshold — `running` rows older than this flip back. */
export const ORPHAN_RECOVERY_AGE_SECONDS = 300;

// ── Cadence → SQL helpers ────────────────────────────────────────────

/**
 * Return the SQL expression that advances `next_run_at` from `now()` by
 * the configured cadence. `on-demand` / `on-trigger` return null — those
 * cadences NEVER auto-enqueue, so they don't get an advance step (their
 * `next_run_at` stays NULL forever and the tick query won't match).
 */
function nextRunSqlForCadence(cadence: Cadence): string | null {
  switch (cadence) {
    case "daily":
      return "datetime('now', '+1 day')";
    case "weekly":
      return "datetime('now', '+7 days')";
    case "on-demand":
    case "on-trigger":
      return null;
  }
}

// ── Vault context lookup ─────────────────────────────────────────────

interface VaultRow {
  id: string;
  slug: string;
  git_repo_path: string;
  bootstrap_pending: number;
}

/**
 * Read the pinned vault row from the control db. Throws if the row is
 * missing — a missing vault for a pinned scheduler is fatal: the PM2
 * process should crash and let the operator notice rather than silently
 * processing the wrong vault.
 */
function readVault(vaultId: string): VaultRow {
  const row = getDb()
    .prepare(
      `SELECT id, slug, git_repo_path,
              COALESCE(bootstrap_pending, 0) AS bootstrap_pending
         FROM vaults
        WHERE id = ?`,
    )
    .get(vaultId) as VaultRow | undefined;
  if (!row) {
    throw new Error(`[scheduler] unknown vault_id: ${JSON.stringify(vaultId)}`);
  }
  return row;
}

function buildVaultContext(row: VaultRow): VaultContext {
  return {
    vaultId: row.id,
    vaultSlug: row.slug,
    vaultPath: row.git_repo_path,
  };
}

// ── Orphan recovery ──────────────────────────────────────────────────

/**
 * Flip `state='running'` rows whose `started_at` is older than the
 * recovery threshold back to `pending`. Returns the row count touched.
 *
 * Safe at process boot because each vault has exactly one scheduler
 * pinned via PM2's `GROVE_VAULT_ID` — no sibling can be midway through
 * one of these rows at the moment we read them.
 */
export function recoverOrphanedTasks(
  vaultId: string,
  ageSeconds: number = ORPHAN_RECOVERY_AGE_SECONDS,
): number {
  const db = getVaultDb(vaultId);
  const result = db
    .prepare(
      `UPDATE tasks
          SET state = 'pending',
              started_at = NULL,
              updated_at = datetime('now')
        WHERE state = 'running'
          AND started_at IS NOT NULL
          AND datetime(started_at) <= datetime('now', ? || ' seconds')`,
    )
    .run(`-${ageSeconds}`);
  return result.changes;
}

// ── Bootstrap dispatch (P23-2 lives in src/skills/first-run.ts) ──────

interface FirstRunModule {
  bootstrapFirstRun: (vault: VaultContext) => Promise<void> | void;
}

/**
 * Best-effort dynamic load of `src/skills/first-run.ts`. P23-2 ships the
 * real module; until then a missing module is treated as a no-op so
 * scheduler boots cleanly during the P23-1 PR window.
 */
async function loadBootstrapper(): Promise<FirstRunModule | null> {
  try {
    // String-concat the specifier so TS can't statically resolve it —
    // P23-2 ships `src/skills/first-run.ts`; until then the import fails
    // at runtime and we treat it as a no-op via the catch.
    const specifier = "./skills/" + "first-run.js";
    const mod: unknown = await import(specifier);
    if (
      mod &&
      typeof mod === "object" &&
      "bootstrapFirstRun" in mod &&
      typeof (mod as { bootstrapFirstRun: unknown }).bootstrapFirstRun ===
        "function"
    ) {
      return mod as FirstRunModule;
    }
  } catch {
    // P23-2 hasn't shipped — treat as no-op.
  }
  return null;
}

/**
 * If `vaults.bootstrap_pending=1`, run `bootstrapFirstRun(vault)` and
 * clear the flag. Idempotent: a vault that bootstraps successfully ends
 * up with `bootstrap_pending=0` and is skipped on the next tick.
 *
 * The flag is cleared regardless of bootstrap outcome — failures are
 * logged and surfaced via the dashboard's normal task error path
 * (bootstrap inserts a task row that lands in `state='failed'`); leaving
 * the flag set would re-trigger the bootstrap every minute.
 */
export async function checkAndRunBootstrap(
  vaultId: string,
): Promise<boolean> {
  const row = readVault(vaultId);
  if (row.bootstrap_pending !== 1) return false;

  const bootstrapper = await loadBootstrapper();
  if (!bootstrapper) {
    // P23-2 not loaded yet — clear the flag so we don't burn a tick on
    // it every minute. P23-2's ship will reset the flag for any vaults
    // provisioned after that migration runs.
    getDb()
      .prepare("UPDATE vaults SET bootstrap_pending = 0 WHERE id = ?")
      .run(vaultId);
    return false;
  }

  try {
    await bootstrapper.bootstrapFirstRun(buildVaultContext(row));
  } catch (err) {
    console.error(
      `[scheduler] bootstrap failed for vault_id=${vaultId}: ${(err as Error).message}`,
    );
  }
  getDb()
    .prepare("UPDATE vaults SET bootstrap_pending = 0 WHERE id = ?")
    .run(vaultId);
  return true;
}

// ── Cron tick ────────────────────────────────────────────────────────

interface SkillConfigDue {
  skill_slug: string;
  cadence: Cadence;
}

/**
 * One cron tick. Returns the number of tasks enqueued.
 *
 * Tasks land with:
 *   - `state='pending'`
 *   - `scheduled_for=now()` so the worker drain picks them up immediately
 *   - `title` populated from the registry's display name (worker
 *     executor overwrites `task_results` once it runs)
 *
 * `next_run_at` advances by cadence BEFORE the task INSERT inside a
 * single transaction. If the INSERT throws, the cadence advance rolls
 * back too — no chance of a "ran but lost" silent-skip.
 */
export function runCronTick(vaultId: string): number {
  const db = getVaultDb(vaultId);
  const due = db
    .prepare(
      `SELECT skill_slug, cadence
         FROM skill_configs
        WHERE enabled = 1
          AND cadence IN ('daily', 'weekly')
          AND next_run_at IS NOT NULL
          AND datetime(next_run_at) <= datetime('now')`,
    )
    .all() as SkillConfigDue[];

  if (due.length === 0) return 0;

  let enqueued = 0;
  for (const cfg of due) {
    const advance = nextRunSqlForCadence(cfg.cadence);
    if (!advance) continue; // defensive — daily/weekly always return non-null
    const skill = getSkillBySlug(cfg.skill_slug);
    const title = skill?.name ?? cfg.skill_slug;

    const tx = db.transaction(() => {
      const taskId = newTaskId();
      db.prepare(
        `INSERT INTO tasks (id, skill_slug, state, title, scheduled_for)
         VALUES (?, ?, 'pending', ?, datetime('now'))`,
      ).run(taskId, cfg.skill_slug, title);
      db.prepare(
        `UPDATE skill_configs
            SET last_run_at = datetime('now'),
                next_run_at = ${advance},
                updated_at = datetime('now')
          WHERE skill_slug = ?`,
      ).run(cfg.skill_slug);
    });
    tx();
    enqueued++;
  }
  return enqueued;
}

function newTaskId(): string {
  return `task_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

// ── Worker drain ─────────────────────────────────────────────────────

/**
 * Claim and dispatch one pending task. Returns true if a task was
 * processed (drainTick can loop on the return value to drain a burst),
 * false when nothing is runnable.
 *
 * The claim is a conditional UPDATE so a second drain racing the same
 * row sees `changes() === 0` and skips. `runTaskOnce` is the same path
 * `v2-task-run.ts` uses, so executor contract + result-write semantics
 * are identical to manual `/run` invocations.
 */
export async function drainOnePendingTask(
  vault: VaultContext,
): Promise<boolean> {
  const db = getVaultDb(vault.vaultId);
  const row = selectNextPendingTask(db);
  if (!row) return false;

  const claim = db
    .prepare(
      `UPDATE tasks
          SET state = 'running',
              started_at = datetime('now'),
              updated_at = datetime('now')
        WHERE id = ?
          AND state = 'pending'`,
    )
    .run(row.id);
  if (claim.changes === 0) return false;

  await runTaskOnce(vault, row.id);
  return true;
}

function selectNextPendingTask(
  db: Database.Database,
): { id: string } | undefined {
  return db
    .prepare(
      `SELECT id
         FROM tasks
        WHERE state = 'pending'
          AND (scheduled_for IS NULL OR datetime(scheduled_for) <= datetime('now'))
        ORDER BY COALESCE(scheduled_for, created_at) ASC
        LIMIT 1`,
    )
    .get() as { id: string } | undefined;
}

// ── Loop orchestration ───────────────────────────────────────────────

export interface SchedulerOptions {
  tickMs?: number;
  workerMs?: number;
}

interface SchedulerHandle {
  tickTimer: ReturnType<typeof setInterval>;
  workerTimer: ReturnType<typeof setInterval>;
}

let handle: SchedulerHandle | null = null;
let tickInFlight = false;
let workerInFlight = false;

/**
 * Start the scheduler for the pinned vault. Runs the boot pass (orphan
 * recovery + bootstrap check) synchronously before scheduling the loops.
 *
 * Idempotent: calling twice is a no-op. `stopScheduler` cleans up timers
 * for graceful PM2 shutdown.
 */
export async function startScheduler(
  vaultId: string,
  opts: SchedulerOptions = {},
): Promise<void> {
  if (handle) return;
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const workerMs = opts.workerMs ?? DEFAULT_WORKER_MS;

  const row = readVault(vaultId);
  const vault = buildVaultContext(row);

  const recovered = recoverOrphanedTasks(vaultId);
  if (recovered > 0) {
    console.log(
      `[scheduler] recovered ${recovered} orphaned 'running' row(s) (vault_id=${vaultId})`,
    );
  }

  // Boot bootstrap. Async, but we don't await it here so a slow first
  // bootstrap can't block the cron from running for other skills.
  void checkAndRunBootstrap(vaultId).catch((err) => {
    console.error(
      `[scheduler] boot bootstrap error (vault_id=${vaultId}): ${(err as Error).message}`,
    );
  });

  console.log(
    `[scheduler] starting (vault_id=${vaultId}, slug=${row.slug}, tick=${tickMs}ms, worker=${workerMs}ms)`,
  );

  const tickTimer = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    void (async () => {
      try {
        await checkAndRunBootstrap(vaultId);
        const n = runCronTick(vaultId);
        if (n > 0) {
          console.log(
            `[scheduler] cron enqueued ${n} task(s) for vault_id=${vaultId}`,
          );
        }
      } catch (err) {
        console.error(
          `[scheduler] cron tick failed (vault_id=${vaultId}): ${(err as Error).message}`,
        );
      } finally {
        tickInFlight = false;
      }
    })();
  }, tickMs);

  const workerTimer = setInterval(() => {
    if (workerInFlight) return;
    workerInFlight = true;
    void (async () => {
      try {
        await drainOnePendingTask(vault);
      } catch (err) {
        console.error(
          `[scheduler] worker drain failed (vault_id=${vaultId}): ${(err as Error).message}`,
        );
      } finally {
        workerInFlight = false;
      }
    })();
  }, workerMs);

  // Don't keep the event loop alive solely for the timers — matches the
  // discovery worker so `node --stop-on-empty` style shutdowns aren't
  // blocked.
  if (typeof tickTimer.unref === "function") tickTimer.unref();
  if (typeof workerTimer.unref === "function") workerTimer.unref();

  handle = { tickTimer, workerTimer };
}

export function stopScheduler(): void {
  if (!handle) return;
  clearInterval(handle.tickTimer);
  clearInterval(handle.workerTimer);
  handle = null;
  tickInFlight = false;
  workerInFlight = false;
  console.log("[scheduler] stopped");
}

/** Test-only: assert no scheduler is currently running. */
export function isSchedulerRunning(): boolean {
  return handle !== null;
}

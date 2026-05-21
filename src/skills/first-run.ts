/**
 * P23-2 — First-run bootstrap.
 *
 * Called out-of-band by the per-vault grove-scheduler when it sees
 * `vaults.bootstrap_pending = 1` (set by `vault-provision.ts` at the end
 * of provisioning). The scheduler's worker drain then processes the
 * immediate review tasks this function enqueues, so the user sees real
 * `state='running'`/`state='review'` tasks within ~60s of vault create.
 *
 * Per the Phase 23 revision (PLAN.md §P23 revision note #2), this
 * function MUST NOT make a synchronous LLM call. The earlier inline
 * approach in `vault-provision.ts` was Architecture Smell #5: it tied
 * vault provisioning latency to Claude API latency. The new contract:
 * we enqueue rows, the scheduler's worker loop drains them.
 *
 * Idempotency: if `skill_configs` already has any of the default
 * suggestion-skill rows for this vault, the function is a no-op (still
 * clears the flag). That handles the case where the scheduler boot pass
 * and the next tick both observe `bootstrap_pending=1` before the boot
 * pass clears it — only the winner inserts; the loser short-circuits.
 *
 * Slow-vault UX: there is NO inline timeout here. The worker may take
 * longer than 25s to drain the immediate task. The dashboard renders
 * a "still working — refresh in a minute" state when it sees
 * `state='running' AND started_at > 25s ago`.
 *
 * Token ceiling for the first run is intentionally larger than the
 * steady-state daily cap — see `FIRST_RUN_TOKEN_CEILING`. The
 * executor's read site (env) is unchanged; this constant captures the
 * intent for the first-run task and seeds the spec for the per-task
 * ceiling plumbing in a future phase (mirror P7 cost pattern).
 *
 * Inbox v2 follow-up: enabling Grove already implies consent for
 * autonomous work, so first-run seeds ALL THREE default suggestion
 * skills — `enrichment`, `disambiguation`, `links-suggestion` — each
 * with one immediate task. On vaults with existing content this gives
 * the inbox concrete, varied work to show within ~60s. On empty/sparse
 * vaults the immediate tasks find nothing to do and the inbox stays
 * near-empty (which is V2's spec'd default). Cadences are read from
 * `SKILL_REGISTRY` so registry tweaks don't need a touch here.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import { getVaultDb } from "../db-per-vault.js";
import { SKILL_REGISTRY } from "./registry.js";
import type { VaultContext } from "../vault-router.js";

/**
 * Hard cap on input tokens for the first-run enrichment task. Larger
 * than the steady-state default (12k) because the first run faces a
 * fresh vault with no decision history — the prompt stays small but
 * we want headroom for the surface output that acclimates the user.
 */
export const FIRST_RUN_TOKEN_CEILING = 50_000;

/**
 * Slugs of the default suggestion skills seeded on first-run. All three
 * are enabled together — the user opted into Grove (= consent for
 * autonomous work) when they provisioned the vault, and showing concrete
 * varied work in the inbox on first open is the V2 default.
 *
 * Cadences are read from `SKILL_REGISTRY` at bootstrap time so we don't
 * drift if a registry default changes.
 */
export const FIRST_RUN_SKILL_SLUGS = [
  "enrichment",
  "disambiguation",
  "links-suggestion",
] as const;

/**
 * Per-skill title for the immediate `state='pending'` task spawned
 * alongside the skill_config row. Picked up by the worker drain on
 * the next 1s tick so the user sees real review items within ~60s of
 * vault create.
 */
const FIRST_RUN_TASK_TITLES: Record<(typeof FIRST_RUN_SKILL_SLUGS)[number], string> = {
  enrichment: "Enrichment first-run",
  disambiguation: "Disambiguation first-run",
  "links-suggestion": "Links first-run",
};

/**
 * Per-skill body for the immediate `state='pending'` task. Short prose
 * that names what the worker will look for, mirroring the registry
 * description so the dashboard can render context before the executor
 * lands.
 */
const FIRST_RUN_TASK_BODIES: Record<(typeof FIRST_RUN_SKILL_SLUGS)[number], string> = {
  enrichment:
    "First-run enrichment — surfaces thin Concept notes worth expanding.",
  disambiguation:
    "First-run disambiguation — surfaces Journal mentions matching multiple People notes.",
  "links-suggestion":
    "First-run links suggestion — surfaces raw mentions of entities whose notes exist but aren't wikilinked.",
};

function newTaskId(): string {
  return `task_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Compute the next 6am America/Los_Angeles instant in UTC.
 *
 * The grove-scheduler tick runs against UTC `datetime('now')` and SQLite
 * stores naive UTC strings; we feed it a UTC ISO string the SQLite
 * comparator can read.
 *
 * Behaviour:
 *   - If the current LA wall clock is before 06:00, return today 06:00 LA.
 *   - Otherwise, return tomorrow 06:00 LA.
 *
 * DST: we use the LA offset at the current instant and apply it to the
 * target wall clock. The result is correct on non-transition days and
 * off by at most one hour on the two annual DST switches — which the
 * scheduler self-heals on the next daily tick.
 */
export function nextSixAmPacificUtcIso(now: Date = new Date()): string {
  const TZ = "America/Los_Angeles";
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value] as const),
  );
  const laYear = Number(parts.year);
  const laMonth = Number(parts.month);
  const laDay = Number(parts.day);
  const laHour = Number(parts.hour);
  const laMin = Number(parts.minute);
  const laSec = Number(parts.second);

  // LA offset (signed ms) relative to UTC at `now`.
  // For LA (UTC-7 in PDT, UTC-8 in PST) this is negative.
  const laAsIfUtc = Date.UTC(laYear, laMonth - 1, laDay, laHour, laMin, laSec);
  const offsetMs = laAsIfUtc - now.getTime();

  // Target LA wall clock: today 06:00 if before 06:00, else tomorrow 06:00.
  const dayBump = laHour >= 6 ? 1 : 0;
  const targetWallAsIfUtc = Date.UTC(
    laYear,
    laMonth - 1,
    laDay + dayBump,
    6,
    0,
    0,
  );

  // True UTC = wall-as-if-UTC - LA offset (subtracting a negative adds hours).
  return new Date(targetWallAsIfUtc - offsetMs).toISOString();
}

/**
 * Bootstrap a freshly-provisioned vault's v2 dashboard state.
 *
 * Idempotent on the presence of ANY first-run skill_configs row. The
 * function always clears `vaults.bootstrap_pending=0` before returning
 * so the scheduler doesn't re-enter on the next tick.
 *
 * Steps (all wrapped in a single transaction on the per-vault state.db
 * so a crash mid-bootstrap doesn't leave half the rows in place):
 *   1. For each slug in `FIRST_RUN_SKILL_SLUGS`, INSERT a skill_configs
 *      row: enabled=1, cadence=<registry default>, next_run_at = next
 *      6am LA in UTC. Cadences come from `SKILL_REGISTRY`, not hardcoded.
 *   2. INSERT starter pending tasks for each enabled skill (any from its
 *      `starterPendingTasks` registry field). scheduled_for=NULL so they
 *      don't stampede the worker.
 *   3. INSERT one immediate pending task per enabled skill with
 *      `scheduled_for=now()` so the worker drain claims them on the
 *      next 1s tick.
 *
 * On no-op (already bootstrapped), only the flag clear runs.
 */
export async function bootstrapFirstRun(vault: VaultContext): Promise<void> {
  const db = getVaultDb(vault.vaultId);

  const slugPlaceholders = FIRST_RUN_SKILL_SLUGS.map(() => "?").join(",");
  const existing = db
    .prepare(
      `SELECT 1 FROM skill_configs WHERE skill_slug IN (${slugPlaceholders}) LIMIT 1`,
    )
    .get(...FIRST_RUN_SKILL_SLUGS);

  if (existing) {
    clearBootstrapFlag(vault.vaultId);
    return;
  }

  // Resolve each slug to its registry entry up front so a drift surfaces
  // before we open the transaction.
  const skills = FIRST_RUN_SKILL_SLUGS.map((slug) => {
    const entry = SKILL_REGISTRY.find((s) => s.slug === slug);
    if (!entry) {
      clearBootstrapFlag(vault.vaultId);
      throw new Error(
        `bootstrapFirstRun: skill '${slug}' not in SKILL_REGISTRY`,
      );
    }
    return entry;
  });

  const nextRunAt = nextSixAmPacificUtcIso();
  const scheduledFor = new Date().toISOString();

  const insertSkillConfig = db.prepare(
    `INSERT INTO skill_configs (skill_slug, enabled, cadence, next_run_at)
     VALUES (?, 1, ?, ?)`,
  );

  const insertTask = db.prepare(
    `INSERT INTO tasks (id, skill_slug, state, title, body, scheduled_for)
     VALUES (?, ?, 'pending', ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const skill of skills) {
      // Cadence comes from the registry default; fall back to 'weekly'
      // only if the entry was registered with a null default (which
      // shouldn't happen for any suggestion skill, but keeps us safe).
      const cadence = skill.defaultCadence ?? "weekly";
      insertSkillConfig.run(skill.slug, cadence, nextRunAt);

      // Starter pending tasks — one row per `starterPendingTasks` entry
      // on the enabled skill. scheduled_for=NULL so these don't all
      // stampede the worker on the next 1s tick — the user kicks them
      // with /run.
      const starters = skill.starterPendingTasks ?? [];
      for (const title of starters) {
        insertTask.run(newTaskId(), skill.slug, title, null, null);
      }

      // Immediate first-run task — the worker drains this on its next
      // 1s tick and the user sees a real review item per skill within
      // ~60s of vault create.
      const slugKey = skill.slug as (typeof FIRST_RUN_SKILL_SLUGS)[number];
      insertTask.run(
        newTaskId(),
        skill.slug,
        FIRST_RUN_TASK_TITLES[slugKey],
        FIRST_RUN_TASK_BODIES[slugKey],
        scheduledFor,
      );
    }
  });
  tx();

  clearBootstrapFlag(vault.vaultId);
}

function clearBootstrapFlag(vaultId: string): void {
  getDb()
    .prepare("UPDATE vaults SET bootstrap_pending = 0 WHERE id = ?")
    .run(vaultId);
}

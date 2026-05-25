#!/usr/bin/env tsx
/**
 * M-INBOX-1 — one-shot migration: dismiss legacy review-state tasks.
 *
 * Target rows: tasks in state='review' emitted by the old
 * `daily-vault-review` skill with no backing Decision. These were created
 * before the Inbox v2 model (Decisions + per-type dispatch) and surface
 * via the legacy-compat fallback in v2-task-review.ts but are noise — they
 * have no `options`, no `decision`, and nothing to act on. Mass-dismiss.
 *
 * Three layers of opt-in by design (per CLAUDE.md diagnostic discipline
 * #1, falsifier-first before destructive ops):
 *
 *   default        : --dry-run (no writes; prints SELECT summary)
 *   --apply        : intent to mutate (still no writes without --i-mean-it)
 *   --i-mean-it    : explicit confirmation that --apply is intentional
 *   --force        : required if legacy-row count > 200 (sanity ceiling)
 *
 * The flag stack feels excessive on a 25-row migration. It exists because
 * prod data is at stake and M-1 was explicitly listed as needing this
 * treatment. Future one-shots that write to tasks.state should follow the
 * same pattern.
 *
 * Vault scoping: choose exactly one of `--vault <slug>` or `--all-vaults`.
 * `--all-vaults` enumerates every vault in the control db and iterates the
 * per-vault migration over each. Per-vault failures are isolated — one
 * vault's broken state.db will not prevent the others from completing —
 * and an aggregate summary is printed at the end. All safety rails
 * (`--apply --i-mean-it`, `--force`) are evaluated per vault. We added
 * `--all-vaults` after the M-INBOX-1 prod run was scoped to `personal` and
 * the remaining 36 unmigrated rows in `echo` rendered with no UI affordance
 * (looked broken). Single-vault scoping is the failure mode.
 *
 * Idempotent: re-running after a successful --apply finds 0 legacy rows
 * and exits 0 with no writes.
 *
 * Usage:
 *   node --import tsx scripts/migrate-inbox-v2.ts (--vault <slug> | --all-vaults) \
 *     [--dry-run | --apply [--i-mean-it] [--force]] [--verbose]
 *
 * Examples:
 *   # safe summary (default), one vault:
 *   node --import tsx scripts/migrate-inbox-v2.ts --vault personal
 *   # safe summary (default), every vault:
 *   node --import tsx scripts/migrate-inbox-v2.ts --all-vaults
 *   # actual write, every vault:
 *   node --import tsx scripts/migrate-inbox-v2.ts --all-vaults --apply --i-mean-it
 */

import { getDb } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";

const LEGACY_SKILL_SLUG = "daily-vault-review";
const SANITY_CEILING = 200;
const MIGRATION_ID = "M-INBOX-1";

interface CliArgs {
  vault: string;
  allVaults: boolean;
  dryRun: boolean;
  apply: boolean;
  iMeanIt: boolean;
  force: boolean;
  verbose: boolean;
}

interface LegacyTask {
  id: string;
  title: string;
  skill_slug: string;
  created_at: string;
}

interface RunResult {
  vaultSlug: string;
  legacyCount: number;
  oldest: string | null;
  newest: string | null;
  distinctTitles: string[];
  applied: boolean;
  dismissedIds: string[];
  exitCode: number;
}

interface AggregateResult {
  vaults: number;
  totalLegacy: number;
  totalDismissed: number;
  failures: Array<{ vaultSlug: string; error: string }>;
  exitCode: number;
  perVault: RunResult[];
}

class UsageError extends Error {}

/**
 * Parse argv. Throws UsageError on conflicting/missing flags so the caller
 * (main) can print the message + exit 2 (usage error) consistently.
 *
 * `--vault <slug>` and `--all-vaults` are mutually exclusive; exactly one
 * is required. We do not auto-default to `--all-vaults` when neither is
 * given — explicit beats implicit. The cost of asking the operator to
 * spell out the scope is one flag; the cost of guessing wrong is a partial
 * production migration.
 */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    vault: "",
    allVaults: false,
    dryRun: false,
    apply: false,
    iMeanIt: false,
    force: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--vault") {
      args.vault = argv[++i] ?? "";
    } else if (a.startsWith("--vault=")) {
      args.vault = a.slice("--vault=".length);
    } else if (a === "--all-vaults") {
      args.allVaults = true;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--apply") {
      args.apply = true;
    } else if (a === "--i-mean-it") {
      args.iMeanIt = true;
    } else if (a === "--force") {
      args.force = true;
    } else if (a === "--verbose" || a === "-v") {
      args.verbose = true;
    } else if (a === "--help" || a === "-h") {
      throw new UsageError("help");
    } else {
      throw new UsageError(`unknown flag: ${a}`);
    }
  }
  if (args.vault && args.allVaults) {
    throw new UsageError(
      "--vault and --all-vaults are mutually exclusive (pick one)",
    );
  }
  if (!args.vault && !args.allVaults) {
    throw new UsageError(
      "one of --vault <slug> or --all-vaults is required",
    );
  }
  if (args.dryRun && args.apply) {
    throw new UsageError("--dry-run and --apply are mutually exclusive");
  }
  if (!args.dryRun && !args.apply) {
    // Default to dry-run when neither is specified. Safer than erroring —
    // most invocations should be the safe one.
    args.dryRun = true;
  }
  return args;
}

/**
 * Enumerate vault slugs from the control db. Mirrors the read pattern in
 * `cmdRebuildProjection` (src/cli.ts): a `SELECT ... FROM vaults` against
 * the shared control db at `GROVE_DB_PATH` (or `~/.grove/grove.db`).
 *
 * Returned in deterministic alphabetical order so per-vault log output is
 * stable across runs — easier to diff a dry-run vs an apply.
 */
export function enumerateVaults(): string[] {
  const rows = getDb()
    .prepare("SELECT slug FROM vaults ORDER BY slug ASC")
    .all() as Array<{ slug: string }>;
  return rows.map((r) => r.slug);
}

/**
 * Resolve a vault slug to its control-db vault row. Exits with a clear
 * message if the slug isn't registered — better than letting better-sqlite3
 * surface a vague error.
 */
function resolveVaultIdBySlug(slug: string): { id: string; slug: string } {
  const row = getDb()
    .prepare("SELECT id, slug FROM vaults WHERE slug = ?")
    .get(slug) as { id: string; slug: string } | undefined;
  if (!row) {
    throw new Error(
      `[migrate-inbox-v2] vault slug not found in control db: ${JSON.stringify(slug)}`,
    );
  }
  return row;
}

/**
 * Select the legacy review-task rows. Definition (from docs/inbox-v2-plan.md
 * § M-INBOX-1):
 *
 *   state='review' AND no row in `decisions` references the task
 *   AND skill_slug = 'daily-vault-review'
 */
function selectLegacyTasks(db: ReturnType<typeof getVaultDb>): LegacyTask[] {
  return db
    .prepare(
      `SELECT t.id, t.title, t.skill_slug, t.created_at
         FROM tasks t
         LEFT JOIN decisions d ON d.task_id = t.id
        WHERE t.state = 'review'
          AND d.id IS NULL
          AND t.skill_slug = ?
        ORDER BY t.created_at ASC`,
    )
    .all(LEGACY_SKILL_SLUG) as LegacyTask[];
}

function summarize(tasks: LegacyTask[]): {
  oldest: string | null;
  newest: string | null;
  distinctTitles: string[];
} {
  if (tasks.length === 0) {
    return { oldest: null, newest: null, distinctTitles: [] };
  }
  const sorted = [...tasks].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  const titles = Array.from(new Set(tasks.map((t) => t.title)));
  return {
    oldest: sorted[0]!.created_at,
    newest: sorted[sorted.length - 1]!.created_at,
    distinctTitles: titles.slice(0, 5),
  };
}

function printSummary(
  vaultSlug: string,
  tasks: LegacyTask[],
  verbose: boolean,
): void {
  const { oldest, newest, distinctTitles } = summarize(tasks);
  console.log(`[${MIGRATION_ID}] vault: ${vaultSlug}`);
  console.log(`[${MIGRATION_ID}] ${tasks.length} legacy review tasks`);
  if (tasks.length === 0) return;
  console.log(`[${MIGRATION_ID}] oldest: ${oldest}`);
  console.log(`[${MIGRATION_ID}] newest: ${newest}`);
  console.log(
    `[${MIGRATION_ID}] distinct titles (first 5):`,
  );
  for (const t of distinctTitles) console.log(`  - ${t}`);
  if (verbose) {
    console.log(`[${MIGRATION_ID}] all rows:`);
    for (const t of tasks) {
      console.log(`  ${t.id}  ${t.created_at}  ${t.title}`);
    }
  }
}

/**
 * Run the migration against a single vault. The same per-vault logic is
 * used whether the caller passed `--vault <slug>` (one call) or
 * `--all-vaults` (one call per enumerated slug). Returns RunResult
 * including exitCode so the caller can `process.exit(result.exitCode)`.
 * Throws only on programmer error (unresolved vault slug, DB open
 * failure) — flag-shape problems exit with a clear message via UsageError
 * handled in main().
 */
export function run(args: CliArgs): RunResult {
  if (!args.vault) {
    throw new Error(
      "[migrate-inbox-v2] run() requires a single vault slug — call runAll() for --all-vaults",
    );
  }
  return runOneVault(args, args.vault);
}

/**
 * Per-vault migration body. Extracted from `run()` so `runAll()` can call
 * it once per enumerated slug without re-parsing argv. The CliArgs.vault
 * field is overridden by the explicit `vaultSlug` argument.
 */
function runOneVault(args: CliArgs, vaultSlug: string): RunResult {
  const vault = resolveVaultIdBySlug(vaultSlug);
  const db = getVaultDb(vault.id);

  // Sanity-check the table exists (covers a freshly-created vault that
  // somehow skipped migration 004). Falls back to a no-op if missing —
  // we never want this script to alter schema.
  const hasMigrationEvents = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='migration_events'`,
    )
    .get() as { name: string } | undefined;

  const legacy = selectLegacyTasks(db);
  printSummary(vault.slug, legacy, args.verbose);

  const baseResult: RunResult = {
    vaultSlug: vault.slug,
    legacyCount: legacy.length,
    ...summarize(legacy),
    applied: false,
    dismissedIds: [],
    exitCode: 0,
  };

  if (legacy.length === 0) {
    console.log(`[${MIGRATION_ID}] nothing to do.`);
    return baseResult;
  }

  if (args.dryRun) {
    console.log(
      `[${MIGRATION_ID}] dry-run: would dismiss ${legacy.length} row(s). ` +
        `Re-run with: --apply --i-mean-it`,
    );
    return baseResult;
  }

  // --apply path from here.
  if (!args.iMeanIt) {
    console.log(
      `[${MIGRATION_ID}] --apply requires --i-mean-it as an extra explicit ` +
        `confirmation. Proceeding to dismiss ${legacy.length} rows. ` +
        `Confirm by re-running with --apply --i-mean-it.`,
    );
    return { ...baseResult, exitCode: 0 };
  }

  if (legacy.length > SANITY_CEILING && !args.force) {
    console.error(
      `[${MIGRATION_ID}] REFUSE: ${legacy.length} legacy rows exceeds sanity ` +
        `ceiling of ${SANITY_CEILING}. If this is expected, re-run with --force. ` +
        `If not, something is wrong — investigate before forcing.`,
    );
    return { ...baseResult, exitCode: 2 };
  }

  // Transactional apply. better-sqlite3 transactions are synchronous;
  // any throw inside rolls back. We capture the dismissed ids first so
  // an audit-log failure still rolls back the UPDATEs.
  const update = db.prepare(
    `UPDATE tasks
        SET state = 'dismissed',
            completed_at = datetime('now'),
            updated_at = datetime('now')
      WHERE id = ?
        AND state = 'review'`,
  );
  const insertEvent = hasMigrationEvents
    ? db.prepare(
        `INSERT INTO migration_events (migration, event, vault_slug, payload_json)
         VALUES (?, ?, ?, ?)`,
      )
    : null;

  const dismissedIds: string[] = [];
  const tx = db.transaction(() => {
    for (const t of legacy) {
      const res = update.run(t.id);
      if (res.changes !== 1) {
        throw new Error(
          `[${MIGRATION_ID}] expected 1 row updated for task ${t.id}, got ${res.changes}. ` +
            `Aborting — concurrent writer?`,
        );
      }
      const payload = {
        task_id: t.id,
        title: t.title,
        skill_slug: t.skill_slug,
        original_created_at: t.created_at,
        dismissed_at: new Date().toISOString(),
      };
      if (insertEvent) {
        insertEvent.run(
          MIGRATION_ID,
          "legacy_review_dismissed",
          vault.slug,
          JSON.stringify(payload),
        );
      } else {
        // Stdout fallback when migration_events doesn't exist (e.g., a
        // vault whose state.db predates migration 004).
        console.log(
          `[${MIGRATION_ID}] event: ${JSON.stringify({
            event: "legacy_review_dismissed",
            vault: vault.slug,
            ...payload,
          })}`,
        );
      }
      dismissedIds.push(t.id);
    }
  });

  try {
    tx();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${MIGRATION_ID}] FAILED, transaction rolled back: ${msg}`);
    return { ...baseResult, exitCode: 1 };
  }

  console.log(
    `[${MIGRATION_ID}] applied: dismissed ${dismissedIds.length} legacy review task(s).`,
  );
  return { ...baseResult, applied: true, dismissedIds, exitCode: 0 };
}

/**
 * Run the migration against every vault enumerated from the control db.
 * Per-vault failures are caught and recorded — they do NOT abort the
 * remaining vaults. Safety rails (`--apply --i-mean-it`, `--force`) are
 * evaluated per vault: each vault's row count is independently compared
 * against `SANITY_CEILING`. An aggregate summary is printed at the end.
 *
 * Exit code: 0 if every vault succeeded (including legitimate REFUSE on
 * ceiling), 1 if any vault failed with an exception. A REFUSE that
 * propagates per-vault `exitCode === 2` is treated as a per-vault non-zero
 * and reflected in `aggregate.exitCode`.
 */
export function runAll(args: CliArgs): AggregateResult {
  const slugs = enumerateVaults();
  const perVault: RunResult[] = [];
  const failures: AggregateResult["failures"] = [];

  for (const slug of slugs) {
    console.log("");
    console.log(`=== ${slug} ===`);
    try {
      const result = runOneVault(args, slug);
      perVault.push(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${MIGRATION_ID}] vault ${slug} failed: ${msg}`);
      failures.push({ vaultSlug: slug, error: msg });
      perVault.push({
        vaultSlug: slug,
        legacyCount: 0,
        oldest: null,
        newest: null,
        distinctTitles: [],
        applied: false,
        dismissedIds: [],
        exitCode: 1,
      });
    }
  }

  const totalLegacy = perVault.reduce((sum, r) => sum + r.legacyCount, 0);
  const totalDismissed = perVault.reduce(
    (sum, r) => sum + r.dismissedIds.length,
    0,
  );
  const aggregateExit =
    failures.length > 0 || perVault.some((r) => r.exitCode !== 0) ? 1 : 0;

  console.log("");
  console.log(`=== aggregate ===`);
  console.log(
    `[${MIGRATION_ID}] total: ${totalLegacy} legacy tasks across ${slugs.length} vaults; ` +
      `dismissed ${totalDismissed} (in --apply mode); failed ${failures.length}`,
  );
  if (failures.length > 0) {
    console.log(`[${MIGRATION_ID}] failures:`);
    for (const f of failures) {
      console.log(`  - ${f.vaultSlug}: ${f.error}`);
    }
  }

  return {
    vaults: slugs.length,
    totalLegacy,
    totalDismissed,
    failures,
    exitCode: aggregateExit,
    perVault,
  };
}

const USAGE = `
M-INBOX-1 — one-shot migration: dismiss legacy review-state tasks.

Usage:
  node --import tsx scripts/migrate-inbox-v2.ts (--vault <slug> | --all-vaults) [flags]

Scope (exactly one required):
  --vault <slug>   Vault slug from control db
  --all-vaults     Iterate every vault enumerated from control db

Flags:
  --dry-run        Print summary, no writes (DEFAULT)
  --apply          Intent to mutate (requires --i-mean-it)
  --i-mean-it      Explicit confirmation of --apply
  --force          Required per-vault when legacy-row count > ${SANITY_CEILING}
  --verbose, -v    Print every legacy row
  --help, -h       Print this message
`.trim();

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "help") {
      console.log(USAGE);
      return 0;
    }
    console.error(`[${MIGRATION_ID}] usage: ${msg}`);
    console.error(USAGE);
    return 2;
  }

  try {
    if (args.allVaults) {
      const aggregate = runAll(args);
      return aggregate.exitCode;
    }
    const result = run(args);
    return result.exitCode;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${MIGRATION_ID}] error: ${msg}`);
    return 1;
  } finally {
    closeAllVaultDbs();
  }
}

// Only execute when invoked directly (not when imported by tests).
// tsx normalizes argv[1] to the script path; compare to import.meta.url.
const isDirectInvocation = (() => {
  try {
    const invoked = process.argv[1];
    if (!invoked) return false;
    const here = new URL(import.meta.url).pathname;
    return invoked === here || here.endsWith(invoked);
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().then((code) => process.exit(code));
}

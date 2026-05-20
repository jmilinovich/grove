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
 * Idempotent: re-running after a successful --apply finds 0 legacy rows
 * and exits 0 with no writes.
 *
 * Usage:
 *   node --import tsx scripts/migrate-inbox-v2.ts --vault <slug> [--dry-run | --apply [--i-mean-it] [--force]] [--verbose]
 *
 * Examples:
 *   # safe summary (default):
 *   node --import tsx scripts/migrate-inbox-v2.ts --vault personal
 *   # safe summary (explicit):
 *   node --import tsx scripts/migrate-inbox-v2.ts --vault personal --dry-run
 *   # actual write:
 *   node --import tsx scripts/migrate-inbox-v2.ts --vault personal --apply --i-mean-it
 */

import { getDb } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";

const LEGACY_SKILL_SLUG = "daily-vault-review";
const SANITY_CEILING = 200;
const MIGRATION_ID = "M-INBOX-1";

interface CliArgs {
  vault: string;
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

class UsageError extends Error {}

/**
 * Parse argv. Throws UsageError on conflicting/missing flags so the caller
 * (main) can print the message + exit 2 (usage error) consistently.
 */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    vault: "",
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
  if (!args.vault) {
    throw new UsageError("--vault <slug> is required");
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
 * Run the migration. Returns RunResult including exitCode so the caller can
 * `process.exit(result.exitCode)`. Throws only on programmer error
 * (unresolved vault slug, DB open failure) — flag-shape problems exit with
 * a clear message via UsageError handled in main().
 */
export function run(args: CliArgs): RunResult {
  const vault = resolveVaultIdBySlug(args.vault);
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

const USAGE = `
M-INBOX-1 — one-shot migration: dismiss legacy review-state tasks.

Usage:
  node --import tsx scripts/migrate-inbox-v2.ts --vault <slug> [flags]

Flags:
  --vault <slug>   Vault slug from control db (REQUIRED)
  --dry-run        Print summary, no writes (DEFAULT)
  --apply          Intent to mutate (requires --i-mean-it)
  --i-mean-it      Explicit confirmation of --apply
  --force          Required when legacy-row count > ${SANITY_CEILING}
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

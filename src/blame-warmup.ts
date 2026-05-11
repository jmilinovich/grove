// V3 §C — post-sync warm-up worker.
//
// After every cron sync, the union of (a) file-changed paths and (b)
// stamp-touched paths in the new commit range is recomputed via
// `recomputeProvenanceBlame`, so the next read on those paths hits a
// warm `note_blame` cache row instead of paying the cold git-blame
// cost on the user-facing latency path.
//
// Why both signals? Stamp commits are `--allow-empty`, so file-diff
// alone misses them (V3 §B2). And belt-and-suspenders covers any
// future mutator that bypasses the discovery worker's
// `clearNoteBlame` (V3 §B3). Dedup happens before the work loop.
//
// Bounded along three axes (V3 §C):
//   1. Concurrency cap — env PROV_WARMUP_CONCURRENCY (default 4) —
//      bounds parallel git fork-execs so warm-up doesn't saturate the
//      4-vCPU box during the cron tick and collapse request-handler
//      p99.
//   2. Wall-time budget — env PROV_WARMUP_BUDGET_MS (default 90s) —
//      caps total work per sync so the warmer never runs longer than
//      ~30% of the 5-min cron interval. Remaining paths are picked up
//      next sync (cold-tail acceptable for low-traffic notes).
//   3. Priority order — optional `requestsPerPath` map sorts hottest
//      paths first, so high-traffic cache rows warm before the budget
//      runs out.
//
// Best-effort: errors per-path are caught + logged + counted; the
// worker never throws. Dropping a path on budget overflow is normal
// behavior, not an error.
//
// Wiring: this function is intended to be called from the post-sync
// hook (TODO — see file footer; right now `post-sync-discover.sh` is
// a shell script that POSTs to /internal/discovery-trigger; calling
// this from there requires either a new HTTP endpoint or a Node
// entry-point invocation. Not blocking V3 §C ship — the function is
// implemented + tested, and the next person can wire either route.)

import { stampPathsInRange, recomputeProvenanceBlame } from "./blame.js";
import { warmupMetrics } from "./metrics.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface PostSyncWarmupArgs {
  vaultPath: string;
  fromSha: string;
  toSha: string;
  /**
   * Optional: path → request count for prioritization. Higher counts
   * warm first. When omitted, paths are processed in dedup order
   * (file-diff first, then stamp-discovered).
   */
  requestsPerPath?: Map<string, number>;
  /**
   * Test-only seam — substitute the per-path recompute. Defaults to
   * `recomputeProvenanceBlame`. Production never passes this.
   */
  recompute?: (vaultPath: string, path: string) => Promise<unknown>;
}

export interface PostSyncWarmupResult {
  pathsTotal: number;
  pathsCompleted: number;
  pathsDropped: number;
  pathsErrored: number;
  durationMs: number;
}

/**
 * Resolve the concurrency cap. `runtime_config.warmup_concurrency`
 * (V3 §C rollout step 12) is the eventual source of truth, but until
 * the staging benchmark is run + persisted, env is the dial.
 */
function getConcurrency(): number {
  const raw = process.env.PROV_WARMUP_CONCURRENCY;
  if (!raw) return 4;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

function getBudgetMs(): number {
  const raw = process.env.PROV_WARMUP_BUDGET_MS;
  if (!raw) return 90_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 90_000;
}

/**
 * Tiny inline concurrency cap. Keeping `p-limit` out of deps per
 * CLAUDE.md "dependencies are intentionally minimal." Workers pull
 * from a shared cursor; the function returns when all items are
 * exhausted. No bells, no events, no AbortSignal — the budget guard
 * inside each task does the early-stop.
 */
async function pLimit<T>(
  n: number,
  items: Array<() => Promise<T>>,
): Promise<T[]> {
  const out: T[] = new Array(items.length);
  if (items.length === 0) return out;
  let i = 0;
  const cap = Math.min(Math.max(1, n), items.length);
  const workers = Array.from({ length: cap }, async () => {
    while (i < items.length) {
      const myI = i++;
      out[myI] = await items[myI]();
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Run `git diff --name-only fromSha..toSha` and return the file paths
 * that changed in the range. Returns [] on git error — warm-up is
 * best-effort.
 */
async function diffNameOnly(
  vaultPath: string,
  fromSha: string,
  toSha: string,
): Promise<string[]> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["diff", "--name-only", `${fromSha}..${toSha}`],
      { cwd: vaultPath, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err: any) {
    console.error(
      `[grove] warmup diffNameOnly(${fromSha}..${toSha}) failed: ${err.message}`,
    );
    return [];
  }
}

/**
 * V3 §C entry — pre-warm the note_blame cache for paths affected by
 * the sync range. Best-effort: never throws; reports counts.
 */
export async function postSyncWarmup(
  args: PostSyncWarmupArgs,
): Promise<PostSyncWarmupResult> {
  const startTime = Date.now();
  const concurrency = getConcurrency();
  const budgetMs = getBudgetMs();
  const recompute = args.recompute ?? recomputeProvenanceBlame;

  // Union of file-diff + stamp-body paths. Both helpers return [] on
  // git error — never throw.
  const [filePaths, stampPaths] = await Promise.all([
    diffNameOnly(args.vaultPath, args.fromSha, args.toSha),
    stampPathsInRange(args.vaultPath, args.fromSha, args.toSha),
  ]);

  // Dedup. Preserve insertion order (file-diff first, then stamps not
  // already seen) so the no-priority case is deterministic.
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const p of [...filePaths, ...stampPaths]) {
    if (!seen.has(p)) {
      seen.add(p);
      ordered.push(p);
    }
  }

  // Priority sort if a request map is provided. Higher counts first;
  // ties preserve dedup order (stable sort in V8).
  if (args.requestsPerPath) {
    const counts = args.requestsPerPath;
    ordered.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  }

  let completed = 0;
  let dropped = 0;
  let errored = 0;

  const tasks = ordered.map((path) => async () => {
    if (Date.now() - startTime > budgetMs) {
      dropped++;
      warmupMetrics.recordDropped();
      return;
    }
    try {
      await recompute(args.vaultPath, path);
      completed++;
      warmupMetrics.recordCompleted();
    } catch (err: any) {
      errored++;
      warmupMetrics.recordErrored();
      console.error(
        `[grove] warmup recompute(${path}) failed: ${err?.message ?? err}`,
      );
    }
  });

  await pLimit(concurrency, tasks);

  const durationMs = Date.now() - startTime;
  return {
    pathsTotal: ordered.length,
    pathsCompleted: completed,
    pathsDropped: dropped,
    pathsErrored: errored,
    durationMs,
  };
}

// TODO(wiring): the post-sync flow today is `sync-all-vaults.sh` →
// `git pull --ff-only` → `post-sync-discover.sh` → POST
// /internal/discovery-trigger per changed path. To wire this warmer
// in, options are:
//
//   (a) Add a new internal endpoint `/internal/post-sync-warmup` that
//       takes fromSha + toSha and invokes `postSyncWarmup` server-side
//       (so it shares the running grove-server's git access + DB
//       handle). post-sync-discover.sh would curl it once per sync
//       *after* the per-path discovery loop finishes.
//
//   (b) Add a Node entry-point script (scripts/post-sync-warmup.ts)
//       that takes vault-path/from-sha/to-sha as args and calls this
//       function in-process. sync-all-vaults.sh invokes it via
//       `tsx`. Heavier startup cost than (a) but no new HTTP surface.
//
// (a) is preferred — it reuses the existing localhost-only
// `/internal/*` trust boundary and the warmer can read the vault path
// from the bound GROVE_VAULT env var. Left as a follow-up so this
// commit is purely the function + tests + metrics; deploy wiring is
// a one-line shell change + a small handler add.

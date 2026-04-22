#!/usr/bin/env tsx
/**
 * ship.ts — PR-based autonomous batch orchestrator for grove.
 *
 * Replaces scripts/run-batch.sh + the three ship-*.sh driver scripts. Uses
 * @anthropic-ai/claude-agent-sdk to spawn agents in parallel worktrees,
 * merges their commits into a `ship/<batch-id>` branch, opens a PR, waits
 * for required checks to pass, and triggers auto-merge.
 *
 * Why PR-based: branch protection on main now requires `test`, `plan-drift`,
 * `audit`, `secrets` to pass (no admin bypass). Direct `git push origin
 * main` fails. Going through PRs inherits those gates for free.
 *
 * Usage:
 *   ./scripts/ship.ts --list                  # show batches + status
 *   ./scripts/ship.ts --dry-run               # plan, don't execute
 *   ./scripts/ship.ts --dry-run --from p8a-2  # plan from this batch onwards
 *   ./scripts/ship.ts --only p8a-1            # just this batch
 *   ./scripts/ship.ts --from p8a-1            # run from p8a-1 to end
 *   ./scripts/ship.ts                         # run next pending batch onwards
 *
 * Cross-repo: grove-www is a sibling checkout at ../grove-www with NO branch
 * protection. We push directly to its main. If that changes, update
 * groveWwwSyncAfter() to go PR-based there too.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

import { BATCHES, findBatch, type Batch, type BatchEntry } from "./ship/batches.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const GROVE_WWW = resolve(REPO_ROOT, "../grove-www");
const PROGRESS_LOG = resolve(REPO_ROOT, ".agents/progress.jsonl");

// Hard cap per agent. Kills the p18-style 2-hour hang.
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
// Stale heartbeat cap: if no tool use or message in this window, consider agent stuck.
const STALE_HEARTBEAT_MS = 5 * 60 * 1000;
// Poll interval while waiting for PR merge.
const PR_POLL_INTERVAL_MS = 15_000;
// Max time to wait for PR merge (CI + auto-merge queue).
const PR_MERGE_TIMEOUT_MS = 30 * 60 * 1000;

// ── CLI parsing ────────────────────────────────────────────────────

interface Args {
  dryRun: boolean;
  list: boolean;
  from?: string;
  only?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--list") args.list = true;
    else if (a === "--from") args.from = argv[++i];
    else if (a === "--only") args.only = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log(HELP);
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      console.error(HELP);
      process.exit(1);
    }
  }
  return args;
}

const HELP = `Usage: ./scripts/ship.ts [options]

  --list                Show all batches and their status.
  --dry-run             Plan what would happen, don't execute.
  --from <batch-id>     Start at this batch (skip anything before it).
  --only <batch-id>     Run only this batch, then stop.
  -h, --help            This message.
`;

// ── Shell helpers ──────────────────────────────────────────────────

function sh(cmd: string, opts: { cwd?: string; quiet?: boolean } = {}): string {
  if (!opts.quiet) log(`$ ${cmd}${opts.cwd ? `  (in ${opts.cwd})` : ""}`);
  return execSync(cmd, { cwd: opts.cwd ?? REPO_ROOT, encoding: "utf8" }).trim();
}

function shTry(cmd: string, opts: { cwd?: string } = {}): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execSync(cmd, { cwd: opts.cwd ?? REPO_ROOT, encoding: "utf8" }).trim() };
  } catch (e: any) {
    return { ok: false, out: e.stdout?.toString() ?? e.message };
  }
}

function log(msg: string): void {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] ${msg}`);
}

function appendProgress(entry: Record<string, unknown>): void {
  mkdirSync(dirname(PROGRESS_LOG), { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFileSync(PROGRESS_LOG, line + "\n", "utf8");
}

// ── Resume resolution ──────────────────────────────────────────────

async function mergedShipPRs(): Promise<Set<string>> {
  // Authoritative source for "what shipped" — query GitHub directly.
  const out = shTry(
    `gh pr list --state merged --search "ship/ in:head" --json headRefName,title --limit 200`,
  );
  if (!out.ok) return new Set();
  try {
    const prs = JSON.parse(out.out) as Array<{ headRefName: string; title: string }>;
    const ids = new Set<string>();
    for (const pr of prs) {
      // headRefName looks like "ship/p8a-1"
      const m = pr.headRefName.match(/^ship\/(.+)$/);
      if (m) ids.add(m[1]);
    }
    return ids;
  } catch {
    return new Set();
  }
}

async function resolvePendingBatches(args: Args): Promise<Batch[]> {
  const done = await mergedShipPRs();
  const pending: Batch[] = [];

  let started = !args.from; // if no --from, start from the first pending
  for (const batch of BATCHES) {
    if (args.only) {
      if (batch.id === args.only) return [batch];
      continue;
    }
    if (!started) {
      if (batch.id === args.from) started = true;
      else continue;
    }
    if (done.has(batch.id)) {
      log(`skip ${batch.id} — already merged`);
      continue;
    }
    pending.push(batch);
  }

  if (args.only) {
    throw new Error(`--only ${args.only}: batch not found in registry`);
  }

  return pending;
}

// ── Preflight ──────────────────────────────────────────────────────

function assertCleanAndOnMain(dir: string, label: string): void {
  const branch = sh(`git rev-parse --abbrev-ref HEAD`, { cwd: dir, quiet: true });
  if (branch !== "main") {
    throw new Error(`${label}: not on main (on ${branch}). Fix before shipping.`);
  }
  const status = sh(`git status --porcelain`, { cwd: dir, quiet: true });
  if (status) {
    throw new Error(`${label}: working tree has uncommitted changes:\n${status}`);
  }
  sh(`git fetch origin main --quiet`, { cwd: dir, quiet: true });
  const local = sh(`git rev-parse main`, { cwd: dir, quiet: true });
  const remote = sh(`git rev-parse origin/main`, { cwd: dir, quiet: true });
  if (local !== remote) {
    throw new Error(
      `${label}: local main (${local.slice(0, 7)}) out of sync with origin/main (${remote.slice(0, 7)}). Pull first.`,
    );
  }
}

// ── grove-www sync ─────────────────────────────────────────────────

function groveWwwBranch(): string {
  return sh(`git rev-parse --abbrev-ref HEAD`, { cwd: GROVE_WWW, quiet: true });
}

function groveWwwSyncBefore(): void {
  log("grove-www: sync before batch");
  const branch = groveWwwBranch();
  if (branch !== "main") {
    // Fold anything ahead on a stray branch onto main first
    groveWwwSyncAfter(branch);
  }
  sh(`git fetch origin main --quiet`, { cwd: GROVE_WWW });
  sh(`git checkout main --quiet`, { cwd: GROVE_WWW });
  sh(`git merge origin/main --ff-only`, { cwd: GROVE_WWW });
  const status = sh(`git status --porcelain`, { cwd: GROVE_WWW, quiet: true });
  if (status) {
    throw new Error(`grove-www dirty pre-batch:\n${status}`);
  }
  const head = sh(`git rev-parse --short main`, { cwd: GROVE_WWW, quiet: true });
  log(`  grove-www on main @ ${head}`);
}

function groveWwwSyncAfter(overrideBranch?: string): void {
  const branch = overrideBranch ?? groveWwwBranch();
  if (branch === "main") {
    sh(`git fetch origin main --quiet`, { cwd: GROVE_WWW });
    const toPush = sh(`git log origin/main..main --oneline | wc -l`, { cwd: GROVE_WWW, quiet: true }).trim();
    if (Number(toPush) > 0) {
      log(`grove-www: pushing ${toPush} commit(s) from main`);
      sh(`git push origin main`, { cwd: GROVE_WWW });
    } else {
      log("grove-www: no new commits on main");
    }
    return;
  }
  const ahead = sh(`git log main..${branch} --oneline | wc -l`, { cwd: GROVE_WWW, quiet: true }).trim();
  if (Number(ahead) === 0) {
    log(`grove-www: on ${branch}, no commits ahead of main — checkout main`);
    sh(`git checkout main --quiet`, { cwd: GROVE_WWW });
    return;
  }
  log(`grove-www: ${branch} has ${ahead} commit(s) ahead of main — consolidating onto main`);
  sh(`git checkout main --quiet`, { cwd: GROVE_WWW });
  sh(`git fetch origin main --quiet`, { cwd: GROVE_WWW });
  sh(`git merge origin/main --ff-only`, { cwd: GROVE_WWW });

  const commits = sh(`git log main..${branch} --format=%H --reverse`, { cwd: GROVE_WWW, quiet: true })
    .split("\n")
    .filter(Boolean);
  for (const sha of commits) {
    log(`  cherry-pick ${sha.slice(0, 7)}`);
    sh(`git cherry-pick ${sha}`, { cwd: GROVE_WWW });
  }
  sh(`git push origin main`, { cwd: GROVE_WWW });
  log(`grove-www: pushed ${ahead} commit(s) to origin/main`);
}

// ── Worktree management ────────────────────────────────────────────

function worktreePath(branch: string): string {
  return resolve(REPO_ROOT, ".claude/worktrees", branch);
}

function setupWorktree(entry: BatchEntry): string {
  const wtPath = worktreePath(entry.branch);
  const wtBranch = `worktree-${entry.branch}`;
  // Clean up any stale worktree from a prior run
  shTry(`git worktree remove ${wtPath} --force`, {});
  shTry(`git branch -D ${wtBranch}`, {});
  sh(`git worktree prune`, {});
  sh(`git worktree add ${wtPath} -b ${wtBranch} origin/main`);
  return wtPath;
}

function cleanupWorktree(entry: BatchEntry): void {
  const wtPath = worktreePath(entry.branch);
  if (existsSync(wtPath)) {
    shTry(`git worktree remove ${wtPath} --force`, {});
  }
}

// ── Agent spawn ────────────────────────────────────────────────────

async function runAgent(entry: BatchEntry, wtPath: string): Promise<{ ok: boolean; msg?: string }> {
  const abort = new AbortController();
  const hardTimeout = setTimeout(() => {
    log(`⚠ ${entry.branch}: 30-minute hard timeout — aborting`);
    abort.abort();
  }, AGENT_TIMEOUT_MS);

  let lastActivity = Date.now();
  const heartbeatCheck = setInterval(() => {
    if (Date.now() - lastActivity > STALE_HEARTBEAT_MS) {
      log(`⚠ ${entry.branch}: no activity for 5 min — aborting (suspected hang)`);
      abort.abort();
      clearInterval(heartbeatCheck);
    }
  }, 30_000);

  try {
    const stream = query({
      prompt: entry.prompt,
      options: {
        abortController: abort,
        cwd: wtPath,
        permissionMode: "bypassPermissions",
        maxTurns: 200,
      },
    });

    let toolCount = 0;
    for await (const msg of stream) {
      lastActivity = Date.now();
      // Tight log — one line per meaningful event. The agent's own stdout is
      // irrelevant to us; we care about forward progress + final state.
      if (msg.type === "assistant") {
        toolCount++;
      } else if (msg.type === "result") {
        // Terminal message from the SDK. Break the loop.
        break;
      }
    }

    log(`  ${entry.branch}: ${toolCount} agent messages, exiting`);
    return { ok: true };
  } catch (e: any) {
    if (abort.signal.aborted) {
      return { ok: false, msg: "aborted (timeout or heartbeat)" };
    }
    return { ok: false, msg: e?.message ?? String(e) };
  } finally {
    clearTimeout(hardTimeout);
    clearInterval(heartbeatCheck);
  }
}

// ── Ship branch + PR ───────────────────────────────────────────────

function buildShipBranch(batch: Batch): { sha: string; shipBranch: string } {
  const shipBranch = `ship/${batch.id}`;
  // Start from latest origin/main
  shTry(`git branch -D ${shipBranch}`, {}); // nuke any stale local
  sh(`git checkout -B ${shipBranch} origin/main`);

  for (const entry of batch.entries) {
    const wtBranch = `worktree-${entry.branch}`;
    // Does the worktree branch have commits ahead of origin/main?
    const ahead = sh(`git log origin/main..${wtBranch} --oneline 2>/dev/null | wc -l || echo 0`, {
      quiet: true,
    }).trim();
    if (Number(ahead) === 0) {
      log(`  ⚠ ${wtBranch}: no commits ahead of origin/main — skip merge`);
      continue;
    }
    log(`  merge ${wtBranch} (${ahead} commits)`);
    sh(`git merge ${wtBranch} --no-edit`);
  }

  const sha = sh(`git rev-parse HEAD`, { quiet: true });
  if (sha === sh(`git rev-parse origin/main`, { quiet: true })) {
    throw new Error(`ship/${batch.id}: no code merged (all worktree branches were empty)`);
  }
  return { sha, shipBranch };
}

async function openPR(batch: Batch, shipBranch: string): Promise<number> {
  sh(`git push -u origin ${shipBranch}`);

  const body = [
    `Batch \`${batch.id}\` — ${batch.title}.`,
    "",
    "## Entries",
    ...batch.entries.map((e) => `- \`worktree-${e.branch}\` → first line of prompt: _${e.prompt.split("\n")[0].slice(0, 180)}_`),
    "",
    "Shipped by `scripts/ship.ts`. Auto-merge is enabled — merges when required checks pass.",
  ].join("\n");

  const out = sh(
    `gh pr create --title ${JSON.stringify(batch.title)} --body ${JSON.stringify(body)} --base main --head ${shipBranch}`,
    { quiet: true },
  );
  const prMatch = out.match(/\/pull\/(\d+)/);
  if (!prMatch) throw new Error(`couldn't parse PR number from: ${out}`);
  return Number(prMatch[1]);
}

async function enableAutoMergeAndWait(prNumber: number): Promise<string> {
  sh(`gh pr merge ${prNumber} --auto --squash --delete-branch`);

  const deadline = Date.now() + PR_MERGE_TIMEOUT_MS;
  let lastState = "";
  while (Date.now() < deadline) {
    const out = sh(
      `gh pr view ${prNumber} --json state,mergedAt,mergeCommit,mergeStateStatus`,
      { quiet: true },
    );
    const data = JSON.parse(out) as {
      state: string;
      mergedAt: string | null;
      mergeCommit: { oid: string } | null;
      mergeStateStatus: string;
    };

    if (data.state === "MERGED") {
      return data.mergeCommit?.oid ?? "";
    }

    // Dependabot cutting in line can leave us BEHIND. Kick it.
    if (data.mergeStateStatus === "BEHIND") {
      log(`  PR #${prNumber} is BEHIND main — updating branch`);
      shTry(`gh pr update-branch ${prNumber}`, {});
    }

    if (data.mergeStateStatus !== lastState) {
      log(`  PR #${prNumber} state: ${data.mergeStateStatus}`);
      lastState = data.mergeStateStatus;
    }

    await new Promise((r) => setTimeout(r, PR_POLL_INTERVAL_MS));
  }

  throw new Error(`PR #${prNumber} did not merge within ${PR_MERGE_TIMEOUT_MS / 60000}m`);
}

// ── Main wave runner ───────────────────────────────────────────────

async function runBatch(batch: Batch, dryRun: boolean): Promise<void> {
  log("");
  log("═════════════════════════════════════════════════════════");
  log(` Batch: ${batch.id}`);
  log(` Title: ${batch.title}`);
  log(` Agents: ${batch.entries.length}`);
  log("═════════════════════════════════════════════════════════");

  if (dryRun) {
    log(`  DRY-RUN — would spawn ${batch.entries.length} agent(s), open PR, auto-merge`);
    for (const e of batch.entries) {
      log(`  └─ worktree-${e.branch}`);
    }
    return;
  }

  // Preflight (after any previous batch's sync completed)
  assertCleanAndOnMain(REPO_ROOT, "grove");
  groveWwwSyncBefore();

  // Set up worktrees
  log(`setting up ${batch.entries.length} worktree(s)`);
  for (const e of batch.entries) {
    setupWorktree(e);
    log(`  ✓ worktree-${e.branch} @ ${worktreePath(e.branch)}`);
  }

  // Run agents in parallel
  log(`launching ${batch.entries.length} agent(s)`);
  const started = Date.now();
  const results = await Promise.all(
    batch.entries.map(async (entry) => {
      const wtPath = worktreePath(entry.branch);
      const res = await runAgent(entry, wtPath);
      return { entry, res };
    }),
  );
  const elapsed = Math.round((Date.now() - started) / 1000);
  log(`all agents settled in ${elapsed}s`);

  const failures = results.filter((r) => !r.res.ok);
  if (failures.length > 0) {
    for (const f of failures) log(`  ✗ ${f.entry.branch}: ${f.res.msg}`);
    appendProgress({
      batch: batch.id,
      status: "agent_failed",
      failures: failures.map((f) => ({ branch: f.entry.branch, msg: f.res.msg })),
    });
    throw new Error(`${failures.length} agent(s) failed — halting. Worktrees preserved for inspection.`);
  }

  // Fold grove-www work (cherry-pick from any branch onto main, push)
  groveWwwSyncAfter();

  // Merge worktree branches into ship/<batch>
  log("building ship branch");
  const { sha, shipBranch } = buildShipBranch(batch);
  log(`  ship branch ${shipBranch} @ ${sha.slice(0, 7)}`);

  // Open PR + auto-merge
  log("opening PR");
  const prNumber = await openPR(batch, shipBranch);
  log(`  PR #${prNumber}: https://github.com/jmilinovich/grove/pull/${prNumber}`);

  log("waiting for checks + merge");
  const mergeSha = await enableAutoMergeAndWait(prNumber);
  log(`  ✓ PR #${prNumber} merged at ${mergeSha.slice(0, 7)}`);

  appendProgress({
    batch: batch.id,
    status: "merged",
    pr: prNumber,
    sha: mergeSha,
  });

  // Sync local main with the new merge commit + clean up worktrees
  sh(`git checkout main`);
  sh(`git pull origin main --ff-only`);
  for (const e of batch.entries) cleanupWorktree(e);
  shTry(`git branch -D worktree-${batch.entries.map((e) => e.branch).join(" worktree-")}`, {});

  log(`batch ${batch.id} complete`);
}

// ── Entry point ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    const done = await mergedShipPRs();
    console.log("Batches:");
    for (const b of BATCHES) {
      const status = done.has(b.id) ? "✓ merged" : "· pending";
      const prereq = b.requires?.length ? ` (requires: ${b.requires.join(", ")})` : "";
      console.log(`  ${status}  ${b.id.padEnd(8)}  ${b.title}${prereq}`);
    }
    return;
  }

  const pending = await resolvePendingBatches(args);
  if (pending.length === 0) {
    log("Nothing to ship. All batches either merged or filtered out.");
    return;
  }

  log(`Shipping ${pending.length} batch(es): ${pending.map((b) => b.id).join(" → ")}`);
  if (args.dryRun) log("(DRY-RUN — no agents will spawn, no PRs will open)");

  for (const batch of pending) {
    await runBatch(batch, args.dryRun);
  }

  log("");
  log("✅ DONE");
}

main().catch((err) => {
  console.error("\nFATAL:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});

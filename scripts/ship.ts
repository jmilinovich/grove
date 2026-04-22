#!/usr/bin/env tsx
/**
 * ship.ts — PR-based autonomous batch orchestrator for grove.
 *
 * Replaces scripts/run-batch.sh + the three ship-*.sh driver scripts. Spawns
 * `claude --worktree <branch> --print --dangerously-skip-permissions <prompt>`
 * processes in parallel, waits for them to exit with hard + stall timeouts,
 * merges their resulting branches into a `ship/<batch-id>` branch, opens a
 * PR, and triggers GitHub's auto-merge.
 *
 * Why shell out instead of using the Agent SDK: the SDK's platform-specific
 * optional deps don't resolve cleanly across macOS/Linux lockfiles (npm ci
 * fails in CI). Shelling out is the same pattern run-batch.sh used, has no
 * cross-platform dep footprint, and costs us only the loss of structured
 * events — we get stall detection via stdio watchdog instead.
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
import { createWriteStream, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { BATCHES, type Batch, type BatchEntry } from "./ship/batches.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const GROVE_WWW = resolve(REPO_ROOT, "../grove-www");
const PROGRESS_LOG = resolve(REPO_ROOT, ".agents/progress.jsonl");

// Hard cap per agent. Kills the p18-style 2-hour hang.
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
// Stale-stdout cap: if no output for this long, consider the agent stuck.
const STALE_STDOUT_MS = 5 * 60 * 1000;
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

// ── Worktree lifecycle (claude --worktree creates the worktree) ────

function worktreePath(entry: BatchEntry): string {
  return resolve(REPO_ROOT, ".claude/worktrees", entry.branch);
}

function cleanupWorktree(entry: BatchEntry): void {
  const wtPath = worktreePath(entry);
  if (existsSync(wtPath)) {
    shTry(`git worktree remove ${wtPath} --force`, {});
  }
  shTry(`git branch -D worktree-${entry.branch}`, {});
}

// ── Agent spawn (shells out to `claude --worktree`) ────────────────

interface AgentResult {
  branch: string;
  ok: boolean;
  msg?: string;
  logPath: string;
}

function runAgent(entry: BatchEntry, logDir: string): Promise<AgentResult> {
  return new Promise((resolvePromise) => {
    const logPath = resolve(logDir, `${entry.branch}.log`);
    const out = createWriteStream(logPath, { flags: "a" });

    const child = spawn(
      "claude",
      [
        "--worktree",
        entry.branch,
        "--print",
        "--dangerously-skip-permissions",
        entry.prompt,
      ],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );

    let lastOutput = Date.now();
    let aborted = false;

    const hardKill = setTimeout(() => {
      if (!aborted) {
        aborted = true;
        log(`  ⚠ ${entry.branch}: 30-min hard timeout — killing`);
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
      }
    }, AGENT_TIMEOUT_MS);

    const stallCheck = setInterval(() => {
      if (!aborted && Date.now() - lastOutput > STALE_STDOUT_MS) {
        aborted = true;
        log(`  ⚠ ${entry.branch}: no output for 5 min — killing`);
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
        clearInterval(stallCheck);
      }
    }, 30_000);

    child.stdout?.on("data", (chunk: Buffer) => { lastOutput = Date.now(); out.write(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { lastOutput = Date.now(); out.write(chunk); });

    child.on("exit", (code, signal) => {
      clearTimeout(hardKill);
      clearInterval(stallCheck);
      out.end();
      if (aborted) {
        resolvePromise({ branch: entry.branch, ok: false, msg: "killed (timeout or stall)", logPath });
      } else if (signal) {
        resolvePromise({ branch: entry.branch, ok: false, msg: `signal ${signal}`, logPath });
      } else if (code === 0) {
        resolvePromise({ branch: entry.branch, ok: true, logPath });
      } else {
        resolvePromise({ branch: entry.branch, ok: false, msg: `exit ${code}`, logPath });
      }
    });

    child.on("error", (err) => {
      clearTimeout(hardKill);
      clearInterval(stallCheck);
      out.end();
      resolvePromise({ branch: entry.branch, ok: false, msg: err.message, logPath });
    });
  });
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

  assertCleanAndOnMain(REPO_ROOT, "grove");
  groveWwwSyncBefore();

  // Per-batch log directory — each agent gets its own file under here
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logDir = resolve(REPO_ROOT, `.agents/${batch.id}_${stamp}`);
  mkdirSync(logDir, { recursive: true });
  log(`agent logs → ${logDir}`);

  // Run agents in parallel. `claude --worktree` creates the worktree itself;
  // we don't pre-create it. Each process writes to logDir/<branch>.log.
  log(`launching ${batch.entries.length} agent(s) via claude --worktree`);
  const started = Date.now();
  const results = await Promise.all(batch.entries.map((e) => runAgent(e, logDir)));
  const elapsed = Math.round((Date.now() - started) / 1000);
  log(`all agents settled in ${elapsed}s`);

  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    for (const f of failures) log(`  ✗ ${f.branch}: ${f.msg} (log: ${f.logPath})`);
    appendProgress({
      batch: batch.id,
      status: "agent_failed",
      failures: failures.map((f) => ({ branch: f.branch, msg: f.msg, log: f.logPath })),
    });
    throw new Error(`${failures.length} agent(s) failed — halting. Worktrees preserved for inspection.`);
  }

  // Fold grove-www work (cherry-pick from any branch onto main, push).
  // grove-www has no branch protection — direct push to main is fine.
  groveWwwSyncAfter();

  log("building ship branch");
  const { sha, shipBranch } = buildShipBranch(batch);
  log(`  ship branch ${shipBranch} @ ${sha.slice(0, 7)}`);

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

  // Sync local main with the merge + clean up worktrees
  sh(`git checkout main`);
  sh(`git pull origin main --ff-only`);
  for (const e of batch.entries) cleanupWorktree(e);

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

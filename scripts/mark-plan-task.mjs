#!/usr/bin/env node
/**
 * mark-plan-task.mjs — idempotently marks a PLAN.md task heading as shipped.
 *
 * Invoked by .claude/hooks/post-commit-mark-plan.sh after a successful
 * git commit whose subject references a task ID (e.g. feat(P8-A1): …).
 *
 * Usage: node scripts/mark-plan-task.mjs <task-id> [short-sha]
 *   task-id   — P8-A1, P4-API-2, CLI-A3, REST-2, etc.
 *   short-sha — optional. Defaults to `git log -1 --format=%h HEAD`.
 *
 * Behavior:
 *   1. Reads PLAN.md from the repo root.
 *   2. Finds `#### <task-id>:` heading line. If not present (the task
 *      might live in docs/phases-shipped.md), exits 0 silently —
 *      the CI drift check is belt-and-suspenders.
 *   3. If the heading already has `✅ COMPLETE`, exits 0 (idempotent).
 *   4. Otherwise appends ` ✅ COMPLETE <YYYY-MM-DD> (<short-sha>)` to
 *      the heading line, writes PLAN.md, and stages it with `git add`.
 *      The next commit (from the agent, or the next one on this branch)
 *      will include the PLAN.md update.
 *
 * Design notes:
 *   - Idempotent by design. Re-running is a no-op.
 *   - Never rewrites beyond the single heading line — no risk of
 *     mangling the rest of PLAN.md.
 *   - Does NOT make its own commit. Staging is enough; the commit
 *     flow belongs to whoever invoked the hook.
 *   - No dependencies outside Node builtins.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, cwd, exit, stderr } from "node:process";

const taskId = argv[2];
const shortShaArg = argv[3];

if (!taskId || !/^(P\d+(-[A-Z]+)*-[A-Z0-9]+|CLI-[A-Z]\d+|REST-\d+)$/i.test(taskId)) {
  stderr.write(`mark-plan-task: invalid or missing task id: ${JSON.stringify(taskId)}\n`);
  exit(1);
}

const normalizedId = taskId.toUpperCase();

// Resolve project root: env var from Claude Code, else git toplevel, else cwd.
const projectDir =
  process.env.CLAUDE_PROJECT_DIR ??
  (() => {
    try {
      return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
    } catch {
      return cwd();
    }
  })();

const planPath = resolve(projectDir, "PLAN.md");
let src;
try {
  src = readFileSync(planPath, "utf8");
} catch (err) {
  stderr.write(`mark-plan-task: PLAN.md not readable at ${planPath}: ${err.message}\n`);
  exit(1);
}

// Escape task id for use in a regex
const esc = normalizedId.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
const headingRe = new RegExp(`^(#### ${esc}:.*?)(?:\\s*✅\\s*COMPLETE.*)?$`, "mi");

const match = src.match(headingRe);
if (!match) {
  // Not in PLAN.md. Might already be archived to docs/phases-shipped.md.
  // Either way, nothing for us to do.
  exit(0);
}

// Idempotent: already marked?
if (/✅\s*COMPLETE/.test(match[0])) {
  exit(0);
}

const shortSha = shortShaArg ?? (() => {
  try {
    return execSync("git log -1 --format=%h HEAD", { encoding: "utf8", cwd: projectDir }).trim();
  } catch {
    return "unknown";
  }
})();

const date = new Date().toISOString().slice(0, 10);
const newHeading = `${match[1]} ✅ COMPLETE ${date} (${shortSha})`;
const updated = src.replace(headingRe, newHeading);

if (updated === src) {
  // Regex match but no replacement — shouldn't happen, but be defensive.
  exit(0);
}

writeFileSync(planPath, updated, "utf8");

// Stage the change so the next commit picks it up.
try {
  execSync("git add PLAN.md", { cwd: projectDir, stdio: "ignore" });
} catch (err) {
  stderr.write(`mark-plan-task: git add PLAN.md failed: ${err.message}\n`);
  // Non-fatal: the file is updated, the agent or next commit will stage it.
}

stderr.write(`mark-plan-task: marked ${normalizedId} ✅ COMPLETE (${shortSha})\n`);
exit(0);

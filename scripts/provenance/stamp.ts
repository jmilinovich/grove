// Stamp — write a provenance override commit for an existing note.
//
// Use cases:
//   1. Manual override of a known-contaminated note (the A7 use case
//      from the rollout — Conviction-Then-Leave Pattern, Reading
//      Recruiter Signals, etc.). Caller specifies path + voice + by +
//      written_at + reason.
//   2. Bulk apply of a confirmed classifier manifest (B1.3). The CLI
//      iterates a manifest and calls stampOne() per entry.
//
// What an "override commit" looks like: the file's content is rewritten
// AS-IS (no body changes) but the commit carries fresh Provenance-*
// trailers declaring "as of this commit, treat the entire file as
// `voice` from `by` on `written_at` with `reason`". Future blame will
// attribute the file's lines to THIS commit, surfacing the new voice.
//
// This is an authored decision: if John says "the whole Conviction-
// Then-Leave file is perishable from claude-opus-4-6 on 2026-04-30",
// we record that as a fact in git history. Future evidence to the
// contrary (e.g., a paragraph John wrote himself) is captured by his
// next commit which blame attributes to him.
//
// Safety: stamp NEVER deletes content, never modifies frontmatter,
// never moves the file. It is purely a metadata-rewrite via a
// no-op-content commit. Per-note rollback is `git revert <sha>`.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  composeCommitMessage,
  provenanceToTrailers,
  validateCallerProvenance,
  type Provenance,
} from "../../src/provenance.js";
import { recomputeProvenanceBlame } from "../../src/blame.js";
import { deleteNoteBlame } from "../../src/db.js";

const execFileP = promisify(execFile);

export interface StampInput {
  /** Vault root (absolute path). */
  vaultPath: string;
  /** Note path relative to vault root (e.g., "Resources/Concepts/foo.md"). */
  notePath: string;
  /** Provenance to attach to the override commit. */
  provenance: Provenance;
  /**
   * Subject line for the commit. Defaults to "stamp-provenance: <path>".
   * The trailers (set from provenance) are appended in the body.
   */
  subject?: string;
  /**
   * Whether to allow stamp on a file with uncommitted changes. Default
   * false — stamp creates an isolated commit, so any pending changes
   * would be silently absorbed.
   */
  allowDirty?: boolean;
}

export interface StampResult {
  notePath: string;
  commit_sha: string;
  /** The actual subject line written to git. */
  subject: string;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Write a single override commit. Throws on:
 *   - vault is not a git repo
 *   - file does not exist at notePath
 *   - working tree is dirty for this file (unless allowDirty)
 *   - provenance fails validateCallerProvenance
 *   - the resulting commit would be empty (no content change to record)
 *
 * The "no content change" case is intentional — stamp REWRITES the file
 * content to itself (identical bytes). To force a commit anyway we use
 * `git commit --allow-empty` after staging. The commit is empty in
 * content but carries Provenance-* trailers in the message body, which
 * is the whole point.
 *
 * Invalidation ordering (V3 §B1 — closes the crash-mid-stamp stale-cache bug):
 *   1. deleteNoteBlame(notePath)         — mark cache cold (idempotent)
 *   2. git commit --allow-empty -m ...   — write the stamp
 *   3. recomputeProvenanceBlame(...)     — fire-and-forget warm-up
 *
 * Crash between 1 and 2: cache is cold, next read recomputes — correct.
 * Crash between 2 and 3: cache is cold (step 1 ran), next read recomputes
 * via computeProvenanceBlame using the new HEAD — correct. Step 3 is
 * fire-and-forget per V3 §B1's explicit note: failure here leaves the
 * cache cold, which is the same state as the step-2-crash path that the
 * design already handles correctly. There is nothing to roll back —
 * setNoteBlame uses INSERT … ON CONFLICT DO UPDATE (db.ts:1530-1540).
 */
export async function stampOne(input: StampInput): Promise<StampResult> {
  validateCallerProvenance(input.provenance);

  // Sanity: file must exist.
  const fullPath = join(input.vaultPath, input.notePath);
  let original: string;
  try {
    original = readFileSync(fullPath, "utf8");
  } catch (err: any) {
    throw new Error(`stamp: cannot read ${input.notePath}: ${err.message}`);
  }

  // Sanity: vault must be a git repo.
  try {
    await git(["rev-parse", "--git-dir"], input.vaultPath);
  } catch {
    throw new Error(`stamp: ${input.vaultPath} is not a git repository`);
  }

  // Optionally enforce a clean working tree for this path.
  if (!input.allowDirty) {
    const status = await git(["status", "--porcelain", "--", input.notePath], input.vaultPath);
    if (status.length > 0) {
      throw new Error(
        `stamp: ${input.notePath} has uncommitted changes (${status}); pass allowDirty=true to override`,
      );
    }
  }

  // Rewrite the file with identical bytes. Then `git add` notices nothing
  // to stage — that's why we use --allow-empty below.
  writeFileSync(fullPath, original);
  await git(["add", "--", input.notePath], input.vaultPath);

  const subject = input.subject ?? `stamp-provenance: ${input.notePath}`;

  // Stamp commits are empty (no content change), so git blame won't
  // attribute lines to them. Instead, we emit a Provenance-Stamp-Path
  // trailer that the blame walker uses to find override commits keyed
  // to a specific file path. Without this trailer the read path can't
  // know which file the empty commit is overriding.
  const trailers = provenanceToTrailers(input.provenance);
  trailers["Provenance-Stamp-Path"] = [input.notePath];
  const message = composeCommitMessage(subject, trailers);

  // V3 §B1 step 1 — invalidate the cache BEFORE writing the stamp.
  // Crash window between this and the commit below is safe: an empty
  // cache row triggers recompute on the next read (which will see the
  // new HEAD if the commit landed, the old HEAD if it didn't — either
  // way the read is correct).
  try {
    deleteNoteBlame(input.notePath);
  } catch (err: any) {
    // Non-fatal — the cache key includes HEAD sha, so a missed delete
    // here will rotate naturally on next commit. Log and proceed.
    console.error(`stamp: deleteNoteBlame(${input.notePath}) failed: ${err.message}`);
  }

  // V3 §B1 step 2 — --allow-empty so the trailer-bearing commit is
  // recorded even though disk content is unchanged. This is the
  // canonical override pattern.
  await git(["commit", "--allow-empty", "-m", message], input.vaultPath);
  const sha = await git(["rev-parse", "HEAD"], input.vaultPath);

  // V3 §B1 step 3 — recompute fresh blame so the next read is warm
  // rather than cold. Fire-and-forget: if recompute fails (git timeout,
  // OOM, malformed trailer), the cache stays empty and the next read
  // will recompute via computeProvenanceBlame. Same correct end-state
  // as the step-2-crash path; no try/catch with rollback needed.
  try {
    await recomputeProvenanceBlame(input.vaultPath, input.notePath);
  } catch (err: any) {
    console.error(
      `stamp: recomputeProvenanceBlame(${input.notePath}) failed: ${err.message} ` +
        `(non-fatal — cache left cold, next read will recompute)`,
    );
  }

  return {
    notePath: input.notePath,
    commit_sha: sha,
    subject,
  };
}

/**
 * Bulk apply: iterate an array of stamp inputs in order. On error, stops
 * and returns the partial results (any commits already made are durable
 * — caller can `git revert` if needed).
 */
export async function stampMany(
  inputs: StampInput[],
): Promise<{ results: StampResult[]; error?: { index: number; message: string } }> {
  const results: StampResult[] = [];
  for (const [i, input] of inputs.entries()) {
    try {
      const r = await stampOne(input);
      results.push(r);
    } catch (err: any) {
      return { results, error: { index: i, message: err.message } };
    }
  }
  return { results };
}

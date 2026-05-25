/**
 * S-INBOX-2 — `.grove/decisions.jsonl` writer.
 *
 * Durable, append-only event log living in the vault working tree.
 * Each line is a single `Decision` (from src/v2-decisions.ts) serialized
 * as one JSON object. The file sits at `<vaultPath>/.grove/decisions.jsonl`
 * so it's committed alongside the vault changes the decision describes
 * (see S-INBOX-3 for the commit-trailer wiring).
 *
 * Design notes:
 *
 *   - The log is the source of truth on disk; `decisions` in state.db is
 *     a projection (rebuildable from this file — see S-INBOX-4). That
 *     constraint is why we tolerate corrupted lines on read: a single
 *     bad write must not poison every subsequent projection-rebuild.
 *
 *   - `appendDecisionEvent` opens the file with O_APPEND and closes it
 *     before returning, so the line is flushed to the kernel's page
 *     cache before callers move on to `git add` / `git commit`. We do
 *     not fsync — the surrounding skill-run commit is what makes this
 *     line durable (the commit lands in the working tree's reflog, and
 *     the server-side push is the actual durability boundary).
 *
 *   - `ensureDecisionsLogDir` is idempotent (mkdir recursive) so callers
 *     can run it as part of any vault-write code path without checking
 *     state first.
 *
 *   - Reads are line-by-line via `readFileSync` + split-on-newline. The
 *     spec allows this fallback path; line-stream via readline is only
 *     necessary if logs grow to the point where the whole file pressures
 *     memory, which is far off (one line per decision, ~1KB each).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

import type { Decision } from "./v2-decisions.js";

const DECISIONS_DIR = ".grove";
const DECISIONS_FILE = "decisions.jsonl";

/** Resolve absolute path to `<vaultPath>/.grove/decisions.jsonl`. Idempotent. */
export function decisionsLogPath(vaultPath: string): string {
  return join(vaultPath, DECISIONS_DIR, DECISIONS_FILE);
}

/** Create `<vaultPath>/.grove/` if missing. Idempotent. */
export function ensureDecisionsLogDir(vaultPath: string): void {
  mkdirSync(join(vaultPath, DECISIONS_DIR), { recursive: true });
}

/**
 * Append a single Decision as one JSON line. Flushes synchronously
 * (close-on-return) so callers can `git add` the file immediately.
 *
 * Lazily creates `<vaultPath>/.grove/` if it doesn't exist — the dir
 * itself is tracked by git once the first decision lands.
 */
export function appendDecisionEvent(
  vaultPath: string,
  decision: Decision,
): void {
  ensureDecisionsLogDir(vaultPath);
  const line = `${JSON.stringify(decision)}\n`;
  appendFileSync(decisionsLogPath(vaultPath), line, { encoding: "utf8" });
}

/**
 * Read all decision events from the log. When `predicate` is omitted,
 * returns every event in append order; otherwise filters by predicate.
 *
 * Tolerates:
 *   - missing file → returns `[]`
 *   - trailing newlines / blank lines → skipped silently
 *   - corrupted lines (un-parseable JSON or non-object) → skipped with a
 *     `console.warn` so the read still produces every valid decision
 *     after the bad line. This is load-bearing for projection rebuilds:
 *     one bad write must not break every future read.
 */
export function readDecisionEvents(
  vaultPath: string,
  predicate?: (d: Decision) => boolean,
): Decision[] {
  const path = decisionsLogPath(vaultPath);
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, "utf8");
  const out: Decision[] = [];
  let lineNo = 0;
  for (const line of raw.split("\n")) {
    lineNo += 1;
    if (line.length === 0) continue; // trailing newline / blank
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      console.warn(
        `decisions-log: skipping corrupted line ${lineNo} in ${path}: ${(err as Error).message}`,
      );
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(
        `decisions-log: skipping non-object line ${lineNo} in ${path}`,
      );
      continue;
    }
    const decision = parsed as Decision;
    if (predicate && !predicate(decision)) continue;
    out.push(decision);
  }
  return out;
}

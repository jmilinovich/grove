/**
 * Git operations, QMD reindex, and file listing for the vault.
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, basename, resolve as resolvePath } from "node:path";
import { parse as yamlParse } from "yaml";
import {
  decryptContent,
  encryptContent,
  getVaultKey,
  isEncrypted,
} from "./crypto.js";

// ── Types ────────────────────────────────────────────────────────────

export interface HistoryEntry {
  sha: string;
  date: string;
  message: string;
  author: string;
  files: string[];
}

export interface NoteEntry {
  path: string;
  name: string;
  type: string | null;
  tags?: string[];
  aliases?: string[];
  private?: boolean;
  modified_at: string;
}

// ── Transparent encryption ──────────────────────────────────────────
//
// When a vault has an unlocked key in the crypto registry, all reads go
// through `readNoteFile` (which decrypts) and all writes go through
// `writeNoteFile` (which encrypts). Files with no matching key, or files on
// disk that don't carry the encryption header, pass through as plaintext so
// mixed vaults migrate one write at a time.

/** Resolve the vault key for an arbitrary path inside the vault. */
function vaultKeyForPath(absPath: string): Buffer | null {
  const canonical = resolvePath(absPath);
  for (const candidate of keyLookupCandidates(canonical)) {
    const key = getVaultKey(candidate);
    if (key) return key;
  }
  return null;
}

function* keyLookupCandidates(absPath: string): Generator<string> {
  // Walk up the path; match the deepest registered vault root.
  let current = absPath;
  while (current && current !== "/" && current !== ".") {
    yield current;
    const next = current.slice(0, current.lastIndexOf("/"));
    if (next === current) break;
    current = next || "/";
  }
}

/** Read a vault file, decrypting transparently if the file is encrypted. */
export function readNoteFile(absPath: string): string {
  const raw = readFileSync(absPath, "utf-8");
  if (!isEncrypted(raw)) return raw;
  const key = vaultKeyForPath(absPath);
  if (!key) {
    throw new Error(
      `[vault-ops] cannot read ${absPath}: file is encrypted but vault is locked`,
    );
  }
  return decryptContent(raw, key);
}

/** Write a vault file, encrypting transparently when a vault key is set. */
export function writeNoteFile(absPath: string, content: string): void {
  const key = vaultKeyForPath(absPath);
  const payload = key ? encryptContent(content, key) : content;
  writeFileSync(absPath, payload, "utf-8");
}

// ── Frontmatter cache ────────────────────────────────────────────────
// Parsing frontmatter out of encrypted files means decrypting each file on
// every `listNotes` call — expensive on large vaults. Cache the parsed
// frontmatter keyed by absolute path + mtime, so listNotes only pays the
// decryption cost for notes that changed since the last listing.

interface CachedFm {
  mtimeMs: number;
  size: number;
  fm: ParsedFrontmatter;
}

const frontmatterCache = new Map<string, CachedFm>();

/** Drop a specific path from the cache (after a write). */
export function invalidateFrontmatterCache(absPath: string): void {
  frontmatterCache.delete(absPath);
}

/** Clear the whole cache (e.g. on vault lock). */
export function clearFrontmatterCache(): void {
  frontmatterCache.clear();
}

// ── Helper ───────────────────────────────────────────────────────────

/** Detect the upstream remote and default branch for a repo. Cached per vault path. */
const gitRemoteCache = new Map<string, { remote: string; branch: string }>();

export async function getRemoteAndBranch(
  vaultPath: string,
): Promise<{ remote: string; branch: string }> {
  const cached = gitRemoteCache.get(vaultPath);
  if (cached) return cached;

  let remote = "origin";
  let branch = "main";

  try {
    // Detect remote from the current branch's tracking config
    const currentBranch = (
      await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], vaultPath)
    ).trim();
    const trackingRemote = (
      await exec("git", ["config", "--get", `branch.${currentBranch}.remote`], vaultPath)
    ).trim();
    if (trackingRemote) remote = trackingRemote;
  } catch {
    // No tracking config for current branch — try listing remotes
    try {
      // Fall back: first remote listed
      const remotes = (await exec("git", ["remote"], vaultPath)).trim();
      const first = remotes.split("\n")[0]?.trim();
      if (first) remote = first;
    } catch {
      // keep default "origin"
    }
  }

  try {
    // Detect default branch via symbolic-ref of remote HEAD
    const ref = (
      await exec(
        "git",
        ["symbolic-ref", `refs/remotes/${remote}/HEAD`],
        vaultPath,
      )
    ).trim();
    // ref looks like "refs/remotes/origin/main"
    const last = ref.split("/").pop();
    if (last) branch = last;
  } catch {
    // keep default "main"
  }

  const result = { remote, branch };
  gitRemoteCache.set(vaultPath, result);
  return result;
}

export function exec(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/usr/bin:/usr/local/bin` } }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        reject(new Error(`${cmd} ${args.join(" ")}: ${msg}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

// ── Git operations ───────────────────────────────────────────────────

export async function gitCommit(
  vaultPath: string,
  filePath: string,
  message: string,
): Promise<string> {
  await exec("git", ["add", filePath], vaultPath);
  await exec("git", ["commit", "-m", message], vaultPath);
  const sha = await exec("git", ["rev-parse", "HEAD"], vaultPath);
  return sha.trim();
}

/** Commit a set of already-staged-or-to-be-added paths in a single commit. */
export async function gitCommitPaths(
  vaultPath: string,
  paths: string[],
  message: string,
): Promise<string> {
  if (paths.length > 0) {
    // `git add` handles both new/modified files and deletions (via -A on the path).
    await exec("git", ["add", "-A", "--", ...paths], vaultPath);
  }
  await exec("git", ["commit", "-m", message], vaultPath);
  const sha = await exec("git", ["rev-parse", "HEAD"], vaultPath);
  return sha.trim();
}

/** Remove a file from the working tree and the index. Does not commit. */
export async function gitRm(vaultPath: string, filePath: string): Promise<void> {
  await exec("git", ["rm", "-f", "--", filePath], vaultPath);
}

/** Return the current HEAD commit SHA. */
export async function gitRevParseHead(vaultPath: string): Promise<string> {
  const sha = await exec("git", ["rev-parse", "HEAD"], vaultPath);
  return sha.trim();
}

/** Hard-reset HEAD to a prior commit, discarding working-tree changes. */
export async function gitResetHard(vaultPath: string, sha: string): Promise<void> {
  await exec("git", ["reset", "--hard", sha], vaultPath);
}

/** Move/rename a tracked file via git. Does not commit. */
export async function gitMv(
  vaultPath: string,
  from: string,
  to: string,
): Promise<void> {
  await exec("git", ["mv", "--", from, to], vaultPath);
}

// ── Wikilink rewrite ─────────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|\n]+)(\|[^\]\n]+)?\]\]/g;

/**
 * Rewrite wikilinks across the vault that point to `oldPath` or its aliases,
 * replacing them with links to `newPath`. Modifies files in place (decrypting
 * and re-encrypting as needed) and returns the relative paths of modified
 * files. Does not stage or commit.
 *
 * Matches these link shapes (case-insensitive on the target):
 *   [[old-base]]           [[old-base|display]]
 *   [[old/path]]           [[old/path|display]]
 *   [[alias]]              [[alias|display]]   (if `aliases` is provided)
 * Basename/alias links rewrite to the new basename; path links rewrite to the new path.
 */
export function updateWikilinks(
  vaultPath: string,
  oldPath: string,
  newPath: string,
  aliases: string[] = [],
): string[] {
  const oldNoExt = oldPath.replace(/\.md$/, "");
  const newNoExt = newPath.replace(/\.md$/, "");
  const oldBase = oldNoExt.split("/").pop() ?? oldNoExt;
  const newBase = newNoExt.split("/").pop() ?? newNoExt;

  // Map lowercased match target → replacement (preserves its own casing)
  const rewrites = new Map<string, string>();
  rewrites.set(oldNoExt.toLowerCase(), newNoExt);
  rewrites.set(oldBase.toLowerCase(), newBase);
  for (const alias of aliases) {
    if (alias && typeof alias === "string") rewrites.set(alias.toLowerCase(), newBase);
  }

  const modified: string[] = [];
  const files = walkMd(vaultPath);
  for (const abs of files) {
    let raw: string;
    try { raw = readNoteFile(abs); } catch { continue; }

    let changed = false;
    const updated = raw.replace(WIKILINK_RE, (match, target: string, pipe = "") => {
      const key = target.trim().toLowerCase();
      const replacement = rewrites.get(key);
      if (!replacement || replacement === target) return match;
      changed = true;
      return `[[${replacement}${pipe}]]`;
    });

    if (changed) {
      writeNoteFile(abs, updated);
      invalidateFrontmatterCache(abs);
      modified.push(relative(vaultPath, abs));
    }
  }

  return modified;
}

export async function gitPush(vaultPath: string): Promise<void> {
  const { remote, branch } = await getRemoteAndBranch(vaultPath);
  await exec("git", ["fetch", remote], vaultPath);
  try {
    await exec("git", ["rebase", `${remote}/${branch}`], vaultPath);
  } catch (err) {
    await exec("git", ["rebase", "--abort"], vaultPath).catch(() => {
      // Abort may fail if rebase already unwound — safe to ignore
    });
    console.error("[vault-ops] rebase conflict — aborted, caller should retry");
    throw err;
  }
  await exec("git", ["push", remote, branch], vaultPath);
}

export async function gitLog(
  vaultPath: string,
  opts?: { since?: string; pathPrefix?: string; limit?: number },
): Promise<HistoryEntry[]> {
  const limit = opts?.limit ?? 50;
  const args = [
    "log",
    `--max-count=${limit}`,
    "--format=%H%n%aI%n%s%n%an",
    "--name-only",
  ];
  if (opts?.since) args.push(`--since=${opts.since}`);
  args.push("--");
  if (opts?.pathPrefix) args.push(opts.pathPrefix);

  const raw = await exec("git", args, vaultPath);
  const entries: HistoryEntry[] = [];
  const blocks = raw.split("\n\n");

  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length < 4) continue;
    entries.push({
      sha: lines[0],
      date: lines[1],
      message: lines[2],
      author: lines[3],
      files: lines.slice(4),
    });
  }

  return entries;
}

export async function startupRecovery(vaultPath: string): Promise<void> {
  const status = await exec("git", ["status", "--porcelain"], vaultPath);
  if (status.trim()) {
    console.log("[vault-ops] recovering uncommitted changes");
    await exec("git", ["add", "-A"], vaultPath);
    try {
      await exec(
        "git",
        ["commit", "-m", "grove (recovery): uncommitted changes from crash"],
        vaultPath,
      );
    } catch {
      // Nothing to commit (e.g., only gitignored files changed)
    }
  }

  const { remote, branch } = await getRemoteAndBranch(vaultPath);
  const unpushed = await exec(
    "git",
    ["log", `${remote}/${branch}..HEAD`, "--oneline"],
    vaultPath,
  );
  if (unpushed.trim()) {
    console.log("[vault-ops] pushing unpushed commits");
    await gitPush(vaultPath);
  }
}

// ── QMD reindex ──────────────────────────────────────────────────────

// `qmd update` reindexes the entire vault (the filePath arg is unused
// by the qmd CLI today), so a per-write call is a ~10s full rebuild.
//
// Under burst writes this would dominate latency, so we dedup + coalesce:
//   - If an update is already in flight, every new call awaits that run.
//   - At most one follow-up run is queued to pick up writes that arrived
//     mid-flight. Further calls during that tail run collapse into it.
//
// Callers typically run qmdReindex inside the write queue, so their own
// completion blocks on the shared promise. To keep write response latency
// snappy the caller should treat this as fire-and-forget when possible.
let activeReindex: Promise<void> | null = null;
let tailReindexPending = false;

async function runReindexOnce(): Promise<void> {
  try {
    await exec("qmd", ["update"], "/tmp", 10_000);
  } catch (err) {
    console.warn(
      "[vault-ops] qmd reindex failed (search may be stale):",
      (err as Error).message,
    );
  }
}

export async function qmdReindex(_filePath: string): Promise<void> {
  if (activeReindex) {
    if (!tailReindexPending) {
      tailReindexPending = true;
      activeReindex = activeReindex
        .catch(() => {})
        .then(async () => {
          tailReindexPending = false;
          await runReindexOnce();
        });
    }
    return activeReindex;
  }
  activeReindex = runReindexOnce().finally(() => {
    if (!tailReindexPending) activeReindex = null;
  });
  return activeReindex;
}

// ── File listing ─────────────────────────────────────────────────────

function walkMd(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMd(full, acc);
    } else if (entry.name.endsWith(".md")) {
      acc.push(full);
    }
  }
  return acc;
}

interface ParsedFrontmatter {
  type: string | null;
  tags?: string[];
  aliases?: string[];
  private?: boolean;
}

function parseFrontmatter(head: string): ParsedFrontmatter {
  if (!head.startsWith("---")) return { type: null };
  const end = head.indexOf("\n---", 3);
  if (end === -1) return { type: null };
  const raw = head.slice(4, end);

  let parsed: Record<string, unknown>;
  try {
    parsed = yamlParse(raw) ?? {};
  } catch {
    // Invalid YAML frontmatter — treat as no metadata
    return { type: null };
  }

  const type =
    typeof parsed.type === "string" ? parsed.type : null;
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((t): t is string => typeof t === "string")
    : typeof parsed.tags === "string" ? [parsed.tags]
    : undefined;
  const aliases = Array.isArray(parsed.aliases)
    ? parsed.aliases.filter((a): a is string => typeof a === "string")
    : undefined;
  const isPrivate = parsed.private === true ? true : undefined;

  return { type, tags, aliases, ...(isPrivate && { private: isPrivate }) };
}

function getFrontmatter(absPath: string, stat: { mtimeMs: number; size: number }): ParsedFrontmatter {
  const cached = frontmatterCache.get(absPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.fm;
  }

  // Encrypted files have no reliable "head slice" — base64-decode first.
  const raw = readFileSync(absPath, "utf-8");
  let head: string;
  // 16 KB is generous for frontmatter (even long ocr_text blocks fit) while
  // staying well short of the body so a stray `\n---` horizontal rule can't
  // be mistaken for the closing delimiter. Older limit of 500 truncated
  // frontmatters of image notes that include multi-line ocr_text fields.
  const HEAD_LIMIT = 16_384;
  if (isEncrypted(raw)) {
    const key = vaultKeyForPath(absPath);
    if (!key) {
      // Locked — can't parse frontmatter. Return empty so listing still works.
      const fm: ParsedFrontmatter = { type: null };
      frontmatterCache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, fm });
      return fm;
    }
    try {
      head = decryptContent(raw, key).slice(0, HEAD_LIMIT);
    } catch {
      // Wrong key (e.g. mixed-key test fixtures, or a file left over from a
      // previous vault key). Don't fail the whole listing — just skip this
      // note's metadata.
      const fm: ParsedFrontmatter = { type: null };
      frontmatterCache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, fm });
      return fm;
    }
  } else {
    head = raw.slice(0, HEAD_LIMIT);
  }
  const fm = parseFrontmatter(head);
  frontmatterCache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, fm });
  return fm;
}

export function listNotes(
  vaultPath: string,
  pattern: string,
  opts?: { includeAliases?: boolean },
): NoteEntry[] {
  const allFiles = walkMd(vaultPath);
  const re = new RegExp(
    "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
  );

  const results: NoteEntry[] = [];
  for (const abs of allFiles) {
    const rel = relative(vaultPath, abs);
    if (!re.test(rel)) continue;

    const stat = statSync(abs);
    const fm = getFrontmatter(abs, { mtimeMs: stat.mtimeMs, size: stat.size });

    const entry: NoteEntry = {
      path: rel,
      name: basename(abs, ".md"),
      type: fm.type,
      tags: fm.tags,
      modified_at: stat.mtime.toISOString(),
    };
    if (fm.private) entry.private = true;
    if (opts?.includeAliases && fm.aliases) {
      entry.aliases = fm.aliases;
    }
    results.push(entry);
  }

  return results;
}

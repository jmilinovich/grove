// Blame-derived provenance — computes per-segment authorship for a note by
// running `git blame -p --follow -M -C` and parsing Provenance-* trailers
// from each blame commit. Cached via `note_blame` (db.ts).
//
// This is the read-side counterpart to provenance.ts (which owns the
// write-side trailer composition + parse).
//
// Design rationale (locked 2026-05-07): provenance is per-commit, not
// per-file. A single note evolves across many commits, each authored by
// a different agent with different intent. File-level voice would lie
// about the durable segments John has typed since the last Claude
// synthesis. Commit-level voice tells the truth: blame attributes each
// line to the commit that introduced it, and the trailers on that commit
// declare the voice.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  parseTrailers,
  trailersToProvenance,
  type Voice,
} from "./provenance.js";
import { getNoteBlame, setNoteBlame } from "./db.js";

const execFileP = promisify(execFile);

/**
 * One contiguous run of lines attributed to the same commit.
 *
 * `voice` defaults to "legacy-unknown" when a commit lacks Provenance-*
 * trailers (pre-rollout commits, discovery-worker frontmatter mutations,
 * external manual writes). The read-site directive treats legacy-unknown
 * segments as transparent — no special handling, no warning.
 */
export interface BlameSegment {
  line_start: number;   // 1-indexed, inclusive
  line_end: number;     // 1-indexed, inclusive
  commit_sha: string;
  voice: Voice;
  by: string;
  written_at: string;
  basis?: string[];
  source?: string;
  reason?: string;
}

/**
 * Compute per-segment provenance blame for a note. Reads from the
 * note_blame cache when (path, source_hash) hits; otherwise runs git
 * blame, parses Provenance-* trailers from each unique commit, groups
 * adjacent same-commit lines into segments, and writes back to cache.
 *
 * Returns an empty array for notes that don't exist or have zero lines.
 * Throws on unexpected git errors (missing repo, unreadable file, etc.) —
 * callers in the read path should catch and downgrade to "no provenance
 * available" rather than failing the read.
 */
export async function computeProvenanceBlame(
  vaultPath: string,
  filePath: string,
  sourceHash: string,
): Promise<BlameSegment[]> {
  // Cache key combines source_hash with current HEAD sha. Stamp commits
  // are --allow-empty, so source_hash alone doesn't rotate when a stamp
  // lands; without the HEAD component the cache returns stale blame
  // forever after a stamp. Including HEAD invalidates the cache on any
  // new commit (stamp or content) reachable from the working tree.
  const headSha = await getHeadSha(vaultPath);
  const cacheKey = `${sourceHash}|${headSha}`;
  const cached = getNoteBlame(filePath, cacheKey);
  if (cached !== null) {
    try {
      return JSON.parse(cached) as BlameSegment[];
    } catch {
      // Corrupt cache row — fall through to recompute.
    }
  }

  const segments = await computeFresh(vaultPath, filePath);
  setNoteBlame(filePath, cacheKey, JSON.stringify(segments));
  return segments;
}

async function getHeadSha(vaultPath: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], {
      cwd: vaultPath,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim();
  } catch {
    return "no-head";
  }
}

/** Force recomputation, bypassing cache. Tests + admin tooling. */
export async function recomputeProvenanceBlame(
  vaultPath: string,
  filePath: string,
): Promise<BlameSegment[]> {
  return computeFresh(vaultPath, filePath);
}

/**
 * The bundle of fields a read response surfaces when provenance is
 * enabled. Lifted to a shared helper so the get/multi_get/list/REST
 * handlers all enrich identically.
 */
export interface ProvenanceFields {
  provenance_blame?: BlameSegment[];
  has_perishable_segments?: boolean;
  usage_directive?: string;
}

/**
 * Compute the response-envelope fields for a single note. Blame failures
 * downgrade silently to empty fields — never fail a read on blame error.
 */
export async function computeProvenanceFields(
  vaultPath: string,
  filePath: string,
  sourceHash: string,
): Promise<ProvenanceFields> {
  if (!provenanceEnabled()) return {};

  let blame: BlameSegment[];
  try {
    blame = await computeProvenanceBlame(vaultPath, filePath, sourceHash);
  } catch (err) {
    console.error(`[grove] blame failed for ${filePath}:`, (err as Error).message);
    return {};
  }

  const out: ProvenanceFields = { provenance_blame: blame };
  if (blame.some((s) => s.voice === "perishable")) {
    out.has_perishable_segments = true;
    out.usage_directive = PERISHABLE_READ_DIRECTIVE;
  }
  return out;
}

// ── Read-site directive (also embedded in MCP tool descriptions) ────
//
// This text is emitted on every NoteResponse with a perishable segment
// AND embedded in the get/query/multi_get/list_notes MCP tool
// descriptions. Belt + suspenders: tool descriptions reach Claude at
// conversation start; this in-response field reaches Claude at every
// individual read.
//
// The "name it explicitly" clause is what makes compliance eval-able —
// a verbal acknowledgment either occurred in the response or it didn't.
//
// Wording locked 2026-05-07.
export const PERISHABLE_READ_DIRECTIVE =
  "This note contains perishable segments — moment-in-time synthesis or prediction by an AI agent that may now be stale. You MUST: (1) before using or quoting any perishable segment, name it explicitly to the user (e.g., \"lines 5-12 were synthesis on 2026-04-30; this may be stale\"); (2) not extend, refine, or build on perishable segments without first asking the user to confirm the framing still holds; (3) prefer durable segments when there's a conflict; (4) treat perishable content as a quoted historical artifact, not a standing claim.";

// ── Feature flag ────────────────────────────────────────────────────
//
// GROVE_PROVENANCE_ENABLED gates the read-side surfacing of provenance
// metadata. When off, the response shape is unchanged from before
// Phase A — guarantees zero behavior change on legacy clients while we
// test the mechanism. Default ON; set env var to "false" or "0" to
// disable.
export function provenanceEnabled(): boolean {
  const v = process.env.GROVE_PROVENANCE_ENABLED;
  if (v === undefined) return true;
  return v !== "false" && v !== "0";
}

// ── Internals ───────────────────────────────────────────────────────

interface BlameLine {
  line_number: number;     // 1-indexed final-line in the current file
  commit_sha: string;
  author_time: number;     // unix epoch (seconds)
  author_name: string;
}

async function computeFresh(
  vaultPath: string,
  filePath: string,
): Promise<BlameSegment[]> {
  // -p porcelain format: machine-parseable; -M intra-file rename detection;
  // -C cross-file copy detection; --follow follows the file across renames.
  let stdout: string;
  try {
    const result = await execFileP(
      "git",
      ["blame", "-p", "--follow", "-M", "-C", "--", filePath],
      { cwd: vaultPath, maxBuffer: 32 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (err: any) {
    // File doesn't exist in the working tree, or no commits touch it yet.
    // Either way, no blame to surface — return empty rather than throwing.
    if (
      typeof err?.stderr === "string" &&
      (err.stderr.includes("no such path") ||
        err.stderr.includes("does not exist") ||
        err.stderr.includes("no such ref"))
    ) {
      return [];
    }
    throw err;
  }

  const lines = parseBlamePorcelain(stdout);
  if (lines.length === 0) return [];

  // Fetch commit messages for each unique sha (de-duped).
  const uniqueShas = [...new Set(lines.map((l) => l.commit_sha))];
  const provByShaEntries = await Promise.all(
    uniqueShas.map(async (sha) => [sha, await fetchCommitProvenance(vaultPath, sha)] as const),
  );
  const provBySha = new Map(provByShaEntries);

  // Find override stamps for this path. A stamp is an empty commit whose
  // message body contains a `Provenance-Stamp-Path: <filePath>` trailer.
  // The most recent stamp (by topological order on HEAD — NOT by
  // Provenance.written_at, which is backdated for backfills, NOR by
  // git author-time, which can collide within a second) overrides any
  // segment whose introducing commit has voice="legacy-unknown" AND
  // is an ancestor of the stamp.
  //
  // Stamps DON'T override commits that already declared explicit voice —
  // those are immutable per the design (callers can re-stamp with a new
  // voice if they want; "most recent stamp wins" applies to legacy only).
  const stamp = await findLatestStampForPath(vaultPath, filePath);
  const headRanks = stamp ? await getHeadCommitRanks(vaultPath) : null;

  // Group consecutive same-sha lines into segments, applying stamp
  // override where applicable.
  return groupIntoSegments(lines, provBySha, stamp, headRanks);
}

/**
 * Build a rank map of every commit reachable from HEAD: sha → index in
 * `git log HEAD --format=%H` output (0 = HEAD itself, N = oldest
 * ancestor). Used by groupIntoSegments to decide "is the stamp commit
 * topologically more recent than the segment's introducing commit?"
 *
 * Single subprocess call, O(1) lookups. Returns an empty map on error.
 */
async function getHeadCommitRanks(vaultPath: string): Promise<Map<string, number>> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["log", "HEAD", "--format=%H"],
      { cwd: vaultPath, maxBuffer: 16 * 1024 * 1024 },
    );
    const map = new Map<string, number>();
    let i = 0;
    for (const line of stdout.split("\n")) {
      const sha = line.trim();
      if (sha) {
        map.set(sha, i);
        i++;
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Stamp commit metadata. Carries both the parsed Provenance (for voice
 * + by + written_at + basis + source + reason) AND the commit's git
 * author-time (the wall-clock moment of the stamp, used for "is this
 * stamp newer than the legacy line's commit" comparisons).
 *
 * Distinct from Provenance.written_at — that field is backdated to
 * record the original drafting time of the content, which for legacy
 * backfill is in the PAST (e.g., 2026-04-30 even though the stamp
 * commit is happening today). For "stamp overrides legacy" semantics
 * we need git-author-time, not written_at.
 */
interface StampCommit {
  prov: CachedCommitProvenance;
  /** Stamp commit's git author-time (unix seconds). */
  author_time: number;
}

async function findLatestStampForPath(
  vaultPath: string,
  filePath: string,
): Promise<StampCommit | null> {
  // %H = commit sha; %at = author-time (unix epoch). %B = full commit body.
  // We use null-byte separators so multi-line bodies don't tangle with
  // line-based parsing.
  let stdout: string;
  try {
    const result = await execFileP(
      "git",
      [
        "log",
        "HEAD",
        "--format=%H%x00%at%x00%B%x00END%x00",
      ],
      { cwd: vaultPath, maxBuffer: 16 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch {
    return null;
  }

  // Split on the END marker.
  const records = stdout.split("\x00END\x00");
  let best: { sha: string; author_time: number; message: string } | null = null;

  for (const record of records) {
    if (!record.trim()) continue;
    const parts = record.split("\x00");
    if (parts.length < 3) continue;
    const sha = parts[0].trim();
    const at = Number(parts[1]);
    const message = parts.slice(2).join("\x00").replace(/^\n+/, "");
    if (!sha || !Number.isFinite(at)) continue;

    // Cheap filter — skip commits without the marker before parsing trailers.
    if (!message.includes("Provenance-Stamp-Path:")) continue;

    const trailers = parseTrailers(message);
    const stampPaths = trailers["Provenance-Stamp-Path"] ?? [];
    if (!stampPaths.includes(filePath)) continue;
    if (!trailers["Provenance-Voice"]) continue;

    if (!best || at > best.author_time) {
      best = { sha, author_time: at, message };
    }
  }

  if (!best) return null;
  const prov = await fetchCommitProvenance(vaultPath, best.sha);
  return { prov, author_time: best.author_time };
}

/**
 * Parse `git blame -p` porcelain output into per-line records. Each blame
 * "header" block is followed by zero-or-more metadata lines and one
 * tab-prefixed content line. We only need the sha + final-line and the
 * author-time (used as a written_at fallback when no trailer is present).
 *
 * Porcelain shape:
 *   <sha> <orig> <final> <count>     (header — count present only on first line of run)
 *   author Name
 *   author-mail <email>
 *   author-time 1234567890
 *   author-tz +0000
 *   committer ...
 *   summary <subject>
 *   filename <path>
 *   \t<source line>
 *   <sha> <orig> <final>             (subsequent line in same run — no count, no metadata block)
 *   \t<source line>
 */
function parseBlamePorcelain(stdout: string): BlameLine[] {
  const out: BlameLine[] = [];
  // Per-sha metadata cache: porcelain emits the metadata block only once
  // per sha per run; subsequent runs in the same blame output skip it.
  const meta = new Map<string, { author_time: number; author_name: string }>();

  let currentSha: string | null = null;
  let currentFinalLine: number | null = null;
  let pendingAuthorName = "";
  let pendingAuthorTime = 0;

  const rows = stdout.split("\n");
  for (const row of rows) {
    if (row.length === 0) continue;

    if (row.startsWith("\t")) {
      // Content line — emit a record using the most recent header + cached or pending metadata.
      if (currentSha === null || currentFinalLine === null) continue;
      const cachedMeta = meta.get(currentSha);
      const author_time = cachedMeta?.author_time ?? pendingAuthorTime;
      const author_name = cachedMeta?.author_name ?? pendingAuthorName;
      out.push({
        line_number: currentFinalLine,
        commit_sha: currentSha,
        author_time,
        author_name,
      });
      currentSha = null;
      currentFinalLine = null;
      pendingAuthorTime = 0;
      pendingAuthorName = "";
      continue;
    }

    // Header line: <sha> <orig> <final> [<count>]
    const headerMatch = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(row);
    if (headerMatch) {
      currentSha = headerMatch[1];
      currentFinalLine = Number(headerMatch[3]);
      continue;
    }

    // Metadata line within the current header block.
    if (row.startsWith("author ")) {
      pendingAuthorName = row.slice("author ".length);
    } else if (row.startsWith("author-time ")) {
      pendingAuthorTime = Number(row.slice("author-time ".length));
      // Cache for subsequent runs of the same sha within this blame output.
      if (currentSha !== null) {
        meta.set(currentSha, {
          author_time: pendingAuthorTime,
          author_name: pendingAuthorName || (meta.get(currentSha)?.author_name ?? ""),
        });
      }
    }
  }

  return out;
}

interface CachedCommitProvenance {
  sha: string;
  voice: Voice;
  by: string;
  written_at: string;
  basis?: string[];
  source?: string;
  reason?: string;
}

async function fetchCommitProvenance(
  vaultPath: string,
  sha: string,
): Promise<CachedCommitProvenance> {
  let message = "";
  try {
    const { stdout } = await execFileP(
      "git",
      ["show", "-s", "--format=%B", sha],
      { cwd: vaultPath, maxBuffer: 1 * 1024 * 1024 },
    );
    message = stdout;
  } catch {
    // Commit unreachable (shallow clone, garbage-collected boundary, etc.).
    return {
      sha,
      voice: "legacy-unknown",
      by: "legacy",
      written_at: new Date(0).toISOString(),
    };
  }

  const trailers = parseTrailers(message);
  const prov = trailersToProvenance(trailers);

  if (prov) {
    return {
      sha,
      voice: prov.voice,
      by: prov.by,
      written_at: prov.written_at,
      basis: prov.basis,
      source: prov.source,
      reason: prov.reason,
    };
  }

  // No trailers — pull the commit's own author-date as the written_at
  // fallback so the segment still reports a meaningful timestamp.
  let isoDate = new Date(0).toISOString();
  try {
    const { stdout } = await execFileP(
      "git",
      ["show", "-s", "--format=%aI", sha],
      { cwd: vaultPath, maxBuffer: 64 * 1024 },
    );
    const trimmed = stdout.trim();
    if (trimmed) isoDate = trimmed;
  } catch {
    // Keep epoch-zero fallback.
  }

  return {
    sha,
    voice: "legacy-unknown",
    by: "legacy",
    written_at: isoDate,
  };
}

function groupIntoSegments(
  lines: BlameLine[],
  provBySha: Map<string, CachedCommitProvenance>,
  stamp: StampCommit | null,
  headRanks: Map<string, number> | null,
): BlameSegment[] {
  // Sort by line_number — git blame doesn't always emit in file order
  // when -M / -C / --follow are active.
  const sorted = [...lines].sort((a, b) => a.line_number - b.line_number);

  const stampRank = stamp && headRanks ? headRanks.get(stamp.prov.sha) : undefined;

  // Decide effective provenance per (line, original commit). A stamp
  // overrides ONLY when the segment's voice is legacy-unknown AND the
  // stamp is topologically more recent on HEAD than the segment's
  // introducing commit (rank < segment-rank — lower rank = closer to
  // HEAD). Commits with explicit voice are immutable.
  const effectiveBySha = new Map<string, CachedCommitProvenance>();
  for (const [sha, prov] of provBySha) {
    const segRank = headRanks?.get(sha);
    const stampOverrides =
      stamp &&
      stampRank !== undefined &&
      segRank !== undefined &&
      stampRank < segRank &&
      prov.voice === "legacy-unknown";

    if (stampOverrides) {
      // Use the stamp commit's sha so the segment metadata is
      // self-consistent: voice + by + written_at + commit_sha all
      // describe the SAME authority (the stamp). The introducing
      // commit's sha remains recoverable via direct `git blame` if
      // needed.
      effectiveBySha.set(sha, {
        sha: stamp.prov.sha,
        voice: stamp.prov.voice,
        by: stamp.prov.by,
        written_at: stamp.prov.written_at,
        basis: stamp.prov.basis,
        source: stamp.prov.source,
        reason: stamp.prov.reason,
      });
    } else {
      effectiveBySha.set(sha, prov);
    }
  }

  const out: BlameSegment[] = [];
  let current: BlameSegment | null = null;

  for (const ln of sorted) {
    const prov = effectiveBySha.get(ln.commit_sha);
    if (!prov) continue;

    // Use the EFFECTIVE provenance for grouping — adjacent segments that
    // got overridden by the same stamp now coalesce into one segment.
    // (prov.sha is the EFFECTIVE sha — after override it's the stamp's,
    // not the introducing commit's.)
    const segKey = `${prov.voice}|${prov.by}|${prov.written_at}|${prov.sha}`;
    const currentKey =
      current &&
      `${current.voice}|${current.by}|${current.written_at}|${current.commit_sha}`;

    if (current && segKey === currentKey && current.line_end + 1 === ln.line_number) {
      current.line_end = ln.line_number;
      continue;
    }

    if (current) out.push(current);

    current = {
      line_start: ln.line_number,
      line_end: ln.line_number,
      commit_sha: prov.sha,
      voice: prov.voice,
      by: prov.by,
      written_at: prov.written_at,
    };
    if (prov.basis) current.basis = prov.basis;
    if (prov.source) current.source = prov.source;
    if (prov.reason) current.reason = prov.reason;
  }

  if (current) out.push(current);
  return out;
}

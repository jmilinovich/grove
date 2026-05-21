/**
 * S-INBOX-6 — Disambiguation suggestion skill.
 *
 * Scans `Journal/**\/*.md` entries for ambiguous Person mentions —
 * non-wikilinked surface forms that match the title or an alias of two or
 * more `Resources/People/*.md` notes. For each ambiguity:
 *
 *   1. Score every candidate Person deterministically:
 *        score = backlink_count * 1.0 + (1 / max(recency_days, 1)) * 0.5
 *      (backlinks = literal `[[<title>]]` occurrences across the vault;
 *       recency = days since the People note's mtime.)
 *   2. Build a `Decision` whose `options` array is one `ReviewOption`
 *      per candidate (`source: "schema"`), ordered by score descending.
 *      `chosenOptionId = "opt-1"` — the top candidate, also the
 *      provisional link target.
 *   3. In `writes-allowed` mode, replace the FIRST occurrence of the
 *      ambiguous surface form in the Journal entry with a wikilink to
 *      the top candidate. If the source casing differs from the
 *      candidate's title we preserve it via `[[Anna Chen|Anna]]`.
 *      Writes go through `writeNoteFile` (encryption-aware).
 *   4. Call `recordDecision` for each emitted decision; collect ids.
 *   5. After the loop, if there were any decisions AND mode is
 *      `writes-allowed`, emit ONE `commitSkillRun` containing
 *      `.grove/decisions.jsonl` + every Journal entry the run modified.
 *      Commit subject: `disambiguation: N provisional link(s)`.
 *
 * Deterministic + no LLM: scoring and tie-breaking are pure functions of
 * the vault on disk; this skill never calls Anthropic. The cost-ceiling
 * machinery used by the enrichment class is therefore not wired in here.
 *
 * Per-run cap (`maxDecisions`, default 10) — prevents an inbox flood the
 * first time the skill runs on a large vault. The cap is a hard stop, not
 * a sampler: once N decisions have been emitted the scan exits without
 * looking at the remaining Journal entries (deterministic walk order so
 * the next run picks up where this one left off).
 *
 * Two exports mirror the suggestion-skill shape:
 *   - `runDisambiguation(vault, options)` — high-level runner, returns
 *     decisions + scan stats. Used directly by tests.
 *   - `run(vault, task)` — `SkillExecutor` adapter (worker contract).
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";

import { recordDecision, commitSkillRun } from "../decision-writer.js";
import { composeCommitMessage, provenanceToTrailers } from "../provenance.js";
import type { TaskRow } from "../db-types.js";
import type { ExecutorResult } from "../v2-task-run.js";
import type { GroveProvenance } from "../v2-tasks.js";
import type { VaultContext } from "../vault-router.js";
import type {
  Decision,
  DisambiguationPayload,
  ReviewOption,
} from "../v2-decisions.js";
import { readNoteFile, writeNoteFile } from "../vault-ops.js";
import { parseNote } from "../notes-validate.js";

// ── Tunable constants ─────────────────────────────────────────────────

const PEOPLE_DIR = "Resources/People";
const JOURNAL_DIR = "Journal";
const DEFAULT_MAX_DECISIONS = 10;
const SKILL_SLUG = "disambiguation";
const BACKLINK_WEIGHT = 1.0;
const RECENCY_WEIGHT = 0.5;
/** Min surface-form length — single letters / two-letter aliases are noisy. */
const MIN_SURFACE_LENGTH = 3;
const DECISIONS_LOG_REL = ".grove/decisions.jsonl";

// ── Types ─────────────────────────────────────────────────────────────

export type DisambiguationMode = "surface-only" | "writes-allowed";

export interface DisambiguationRunOptions {
  /** "surface-only" generates decisions but doesn't write/commit. "writes-allowed" applies provisional links. Default: writes-allowed. */
  mode?: DisambiguationMode;
  /** Cap per-run. Default 10. Prevents inbox flood on the first scan. */
  maxDecisions?: number;
}

export interface DisambiguationRunResult {
  decisions: Decision[];
  scanned: { journals: number; mentions: number };
}

interface PersonCandidate {
  title: string;
  /** Vault-relative path of the Person note (e.g. `Resources/People/Anna Chen.md`). */
  path: string;
  /** Every surface form that resolves to this Person: title + aliases. */
  surfaceForms: string[];
  /** Backlink count across the vault (literal `[[<title>]]` matches). */
  backlinks: number;
  /** Days since the People note was last modified (floor, min 1). */
  recencyDays: number;
  /** Cached deterministic score. */
  score: number;
}

interface JournalScan {
  /** Vault-relative path of the Journal entry. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Raw file contents (post-decrypt). */
  content: string;
}

// ── Person index ──────────────────────────────────────────────────────

/**
 * Build a Person index from `Resources/People/*.md`. Returns one
 * `PersonCandidate` per Person note, with all surface forms (title +
 * aliases) folded in.
 *
 * Backlink counts are computed via a single vault-wide grep — we read
 * every `.md` file under `vaultPath` once and count occurrences of
 * `[[<title>]]` for each Person. This is `O(notes * people)` but the
 * People set is small (a few hundred at most) and the alternative —
 * per-Person `findUp` — re-reads the vault N times.
 */
function buildPersonIndex(vaultPath: string): PersonCandidate[] {
  const dir = join(vaultPath, PEOPLE_DIR);
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
  const now = Date.now();
  const candidates: PersonCandidate[] = [];

  for (const file of entries) {
    const abs = join(dir, file);
    let raw: string;
    try {
      raw = readNoteFile(abs);
    } catch {
      continue;
    }
    // Defensive parse — one note with malformed YAML frontmatter must
    // not crash the whole scan (see prod incident 2026-05-19). Skill is
    // a read-scan; write paths still fail loudly on bad YAML elsewhere.
    let frontmatter: Record<string, unknown>;
    try {
      ({ frontmatter } = parseNote(raw));
    } catch (err) {
      console.warn(
        `[${SKILL_SLUG}] skipping ${PEOPLE_DIR}/${file}: ${
          (err as Error).message.split("\n")[0]
        }`,
      );
      continue;
    }
    const title = file.replace(/\.md$/, "");
    const aliases = Array.isArray(frontmatter.aliases)
      ? (frontmatter.aliases as unknown[]).filter(
          (a): a is string => typeof a === "string" && a.length > 0,
        )
      : [];

    // Derive a first-name surface form for multi-word titles. The whole
    // point of the disambiguation skill is to catch raw "Anna" mentions
    // that match both "Anna Chen" and "Anna Kim" — without this, an
    // ambiguity is only detected when an alias is explicitly listed in
    // frontmatter, which is rare. Single-word titles contribute no
    // derived form (they ARE the form). Anything shorter than
    // `MIN_SURFACE_LENGTH` is filtered as noisy.
    const titleParts = title.split(/\s+/);
    const derived: string[] = [];
    if (titleParts.length > 1 && titleParts[0]) {
      derived.push(titleParts[0]);
    }

    // Dedup surface forms (case-insensitive) — title is always first so
    // ties favor the title form.
    const seen = new Set<string>();
    const surfaceForms: string[] = [];
    for (const s of [title, ...aliases, ...derived]) {
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      if (s.length < MIN_SURFACE_LENGTH) continue;
      seen.add(key);
      surfaceForms.push(s);
    }
    if (surfaceForms.length === 0) continue;

    let mtimeMs: number;
    try {
      mtimeMs = statSync(abs).mtimeMs;
    } catch {
      mtimeMs = now;
    }
    const recencyDays = Math.max(
      1,
      Math.floor((now - mtimeMs) / (24 * 60 * 60 * 1000)),
    );

    candidates.push({
      title,
      path: `${PEOPLE_DIR}/${file}`,
      surfaceForms,
      backlinks: 0, // filled below in the vault-wide pass
      recencyDays,
      score: 0,
    });
  }

  if (candidates.length === 0) return [];

  // Vault-wide backlink count — one read pass per file, all candidates
  // scanned per file.
  const allFiles = walkMarkdown(vaultPath);
  const titleByLower = new Map<string, PersonCandidate>();
  for (const c of candidates) titleByLower.set(c.title.toLowerCase(), c);

  for (const abs of allFiles) {
    let raw: string;
    try {
      raw = readNoteFile(abs);
    } catch {
      continue;
    }
    // Walk every wikilink target in this file.
    const matches = raw.matchAll(/\[\[([^\]|\n]+)(?:\|[^\]\n]+)?\]\]/g);
    for (const m of matches) {
      const target = (m[1] ?? "").trim();
      if (!target) continue;
      // Wikilink may be a bare title or a path; the bare form is the
      // common case for People (the People notes live under a deep
      // folder but most authors write `[[Anna Chen]]`, not
      // `[[Resources/People/Anna Chen]]`). Both shapes count.
      const lowerTarget = target.toLowerCase();
      const byTitle = titleByLower.get(lowerTarget);
      if (byTitle) {
        byTitle.backlinks += 1;
        continue;
      }
      // Path form — `Resources/People/<title>` (no .md).
      const baseName = lowerTarget.split("/").pop() ?? "";
      const byBase = titleByLower.get(baseName);
      if (byBase) byBase.backlinks += 1;
    }
  }

  // Finalize deterministic score.
  for (const c of candidates) {
    c.score = c.backlinks * BACKLINK_WEIGHT + (1 / c.recencyDays) * RECENCY_WEIGHT;
  }

  return candidates;
}

// ── Filesystem walk ──────────────────────────────────────────────────

/**
 * Walk every `.md` file under `vaultPath`. Skips dot-directories so
 * `.grove/` and `.git/` stay out of scope.
 */
function walkMarkdown(vaultPath: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const abs = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(abs);
      } else if (name.endsWith(".md")) {
        out.push(abs);
      }
    }
  }
  walk(vaultPath);
  return out;
}

/** Walk `Journal/**\/*.md`, sorted for deterministic scan order. */
function readJournalEntries(vaultPath: string): JournalScan[] {
  const dir = join(vaultPath, JOURNAL_DIR);
  if (!existsSync(dir)) return [];
  const out: JournalScan[] = [];
  function walk(d: string): void {
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const abs = join(d, name);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(abs);
        continue;
      }
      if (!name.endsWith(".md")) continue;
      let content: string;
      try {
        content = readNoteFile(abs);
      } catch {
        continue;
      }
      out.push({
        relPath: relative(vaultPath, abs).split("\\").join("/"),
        absPath: abs,
        content,
      });
    }
  }
  walk(dir);
  return out;
}

// ── Surface-form matching ─────────────────────────────────────────────

/**
 * Escape regex special characters in a literal surface form. People
 * notes can have titles like `Anna O'Brien` or `Cyrus (Cy) Smith`.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Given a Journal entry body, return the set of distinct surface forms
 * mentioned in it that match at least one Person's `surfaceForms`, and
 * that are NOT already inside a `[[...]]` wikilink.
 *
 * The returned list is ordered by the first non-linked occurrence in
 * the file (so the disambiguation we record reflects the earliest
 * ambiguity in the entry). Per-surface-form dedup — we only emit one
 * decision per (Journal, surface-form) regardless of how many raw
 * occurrences exist.
 */
function findAmbiguousMentions(
  content: string,
  index: PersonCandidate[],
): Array<{ surfaceForm: string; candidates: PersonCandidate[] }> {
  // Build surface-form → candidates map (case-insensitive).
  const surfaceToCandidates = new Map<string, Set<PersonCandidate>>();
  for (const c of index) {
    for (const s of c.surfaceForms) {
      const key = s.toLowerCase();
      let bucket = surfaceToCandidates.get(key);
      if (!bucket) {
        bucket = new Set();
        surfaceToCandidates.set(key, bucket);
      }
      bucket.add(c);
    }
  }

  // Mask out wikilink spans so an `[[Anna Chen]]` link doesn't count as
  // an unlinked `Anna` mention. We replace the link span with spaces of
  // identical length so character offsets in the original body stay
  // valid for the post-mask scan.
  const masked = content.replace(/\[\[[^\]\n]+\]\]/g, (m) => " ".repeat(m.length));

  // Find earliest occurrence of each surface form in the masked body.
  // Word boundaries — `\b` doesn't play nicely with non-ASCII names, so
  // we wrap the match with explicit non-word-character lookarounds that
  // treat letters/digits/underscore as continuation and everything else
  // as a boundary. Case-insensitive.
  const found = new Map<
    string,
    { firstIndex: number; candidates: PersonCandidate[]; surfaceForm: string }
  >();
  for (const [key, bucket] of surfaceToCandidates) {
    const re = new RegExp(
      `(^|[^A-Za-z0-9_])(${escapeRegex(key)})(?=$|[^A-Za-z0-9_])`,
      "gi",
    );
    const m = re.exec(masked);
    if (!m) continue;
    const matchStart = m.index + m[1].length;
    const surfaceFormAsWritten = masked.slice(
      matchStart,
      matchStart + m[2].length,
    );
    // ^^ this is whitespace if the match was inside a masked span; the
    // search-space already excludes those, so we can also pull from the
    // original `content` here.
    const rawSurface = content.slice(matchStart, matchStart + m[2].length);
    found.set(key, {
      firstIndex: matchStart,
      candidates: [...bucket],
      surfaceForm: rawSurface || surfaceFormAsWritten,
    });
  }

  const out = [...found.values()]
    .filter((v) => v.candidates.length >= 2)
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .map((v) => ({ surfaceForm: v.surfaceForm, candidates: v.candidates }));
  return out;
}

// ── Provisional link writing ──────────────────────────────────────────

/**
 * Replace the FIRST non-linked occurrence of `surfaceForm` in `content`
 * with `[[<topTitle>]]` (or `[[<topTitle>|<surfaceForm>]]` when casing
 * differs from the title). Returns the rewritten content, or null when
 * no replaceable occurrence was found (the file was modified between
 * scan and write, or the surface was only inside an existing wikilink).
 */
function applyProvisionalLink(
  content: string,
  surfaceForm: string,
  topTitle: string,
): string | null {
  // Walk the content, skip any `[[...]]` span. Replace the first match
  // that lands outside a wikilink.
  const re = new RegExp(
    `(^|[^A-Za-z0-9_])(${escapeRegex(surfaceForm)})(?=$|[^A-Za-z0-9_])`,
    "i",
  );
  // Mask wikilink spans so the `re.exec` lands on a free occurrence.
  let outIdx = 0;
  let result = "";
  const linkSpan = /\[\[[^\]\n]+\]\]/g;
  let cursor = 0;
  while (cursor < content.length) {
    linkSpan.lastIndex = cursor;
    const lm = linkSpan.exec(content);
    const free = content.slice(cursor, lm ? lm.index : undefined);
    const m = re.exec(free);
    if (m) {
      // Found a free match — splice in the wikilink.
      const matchStart = m.index + m[1].length;
      const matched = m[2];
      const replacement =
        matched === topTitle ? `[[${topTitle}]]` : `[[${topTitle}|${matched}]]`;
      result += free.slice(0, matchStart) + replacement + free.slice(matchStart + matched.length);
      // Append the rest of the file (link span + tail) untouched.
      if (lm) result += content.slice(lm.index);
      else result += "";
      // We already appended everything past matchStart in `free`, then
      // (if there was a link span ahead) the rest. Done.
      outIdx = -1;
      return result;
    }
    // No free match in this chunk — keep it and the following link span.
    result += free;
    if (lm) {
      result += lm[0];
      cursor = lm.index + lm[0].length;
    } else {
      cursor = content.length;
    }
  }
  // No replacement happened.
  return null;
}

// ── Decision construction ─────────────────────────────────────────────

function buildDecision(
  skillRunId: string,
  date: string,
  surfaceForm: string,
  ranked: PersonCandidate[],
  journalRelPath: string,
): Decision {
  const payload: DisambiguationPayload = {
    source_path: journalRelPath,
    surface_form: surfaceForm,
    candidates: ranked.map((c) => ({
      note_path: c.path,
      signals: [
        `backlinks=${c.backlinks}`,
        `recency=${c.recencyDays}d`,
        `score=${c.score.toFixed(3)}`,
      ],
    })),
  };

  const options: ReviewOption[] = ranked.map((c, i) => ({
    id: `opt-${i + 1}`,
    label: `link to ${c.title}`,
    description: payload.candidates[i].signals?.join(", "),
    source: "schema",
  }));

  return {
    id: `D-${date}-${randomUUID().slice(0, 8)}`,
    type: "disambiguation",
    skillRunId,
    taskId: null,
    createdAt: new Date().toISOString(),
    status: "provisional",
    payload,
    options,
    chosenOptionId: "opt-1",
    affectedPaths: [journalRelPath],
    compensatedBy: null,
  };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Scan the vault for ambiguous Person mentions and record one
 * Disambiguation decision per (Journal entry, surface form) ambiguity.
 *
 * Returns the recorded decisions plus scan stats. In `writes-allowed`
 * mode (the default), provisional `[[link]]`s are applied in-place via
 * `writeNoteFile`, and the run emits ONE git commit at the end that
 * includes `.grove/decisions.jsonl` and every modified Journal entry. In
 * `surface-only` mode no file is written and no commit is emitted (used
 * by tests + by ops who want to dry-run the skill).
 */
export async function runDisambiguation(
  vault: VaultContext,
  options?: DisambiguationRunOptions,
): Promise<DisambiguationRunResult> {
  const mode: DisambiguationMode = options?.mode ?? "writes-allowed";
  const maxDecisions =
    options?.maxDecisions !== undefined && options.maxDecisions >= 0
      ? options.maxDecisions
      : DEFAULT_MAX_DECISIONS;

  const index = buildPersonIndex(vault.vaultPath);
  const journals = readJournalEntries(vault.vaultPath);
  let mentionCount = 0;

  if (index.length === 0 || journals.length === 0) {
    return {
      decisions: [],
      scanned: { journals: journals.length, mentions: 0 },
    };
  }

  const skillRunId = `SR-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const date = new Date().toISOString().slice(0, 10);

  const decisions: Decision[] = [];
  const writtenPaths = new Set<string>();

  outer: for (const j of journals) {
    const ambiguities = findAmbiguousMentions(j.content, index);
    mentionCount += ambiguities.length;

    let runningContent = j.content;
    let mutated = false;
    for (const { surfaceForm, candidates } of ambiguities) {
      if (decisions.length >= maxDecisions) break outer;

      // Score-sort candidates (stable tiebreak by title to keep tests
      // deterministic across vaults with identical scores).
      const ranked = [...candidates].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.title.localeCompare(b.title);
      });

      const topCandidate = ranked[0];
      const decision = buildDecision(
        skillRunId,
        date,
        surfaceForm,
        ranked,
        j.relPath,
      );

      if (mode === "writes-allowed") {
        const rewritten = applyProvisionalLink(
          runningContent,
          surfaceForm,
          topCandidate.title,
        );
        if (rewritten === null) {
          // Couldn't find a free occurrence — skip this ambiguity, don't
          // record a decision we can't realize.
          continue;
        }
        runningContent = rewritten;
        mutated = true;
      }

      recordDecision(vault.vaultPath, vault.vaultId, decision);
      decisions.push(decision);
    }

    if (mode === "writes-allowed" && mutated && runningContent !== j.content) {
      writeNoteFile(j.absPath, runningContent);
      writtenPaths.add(j.relPath);
    }
  }

  if (mode === "writes-allowed" && decisions.length > 0) {
    const subject =
      `disambiguation: ${decisions.length} provisional link` +
      `${decisions.length === 1 ? "" : "s"}`;
    const message = composeCommitMessage(
      subject,
      provenanceToTrailers({
        voice: "perishable",
        by: "grove-skill/disambiguation",
        written_at: new Date().toISOString(),
        reason: "S-INBOX-6 disambiguation provisional links",
      }),
    );
    const paths = [DECISIONS_LOG_REL, ...writtenPaths];
    await commitSkillRun(
      vault.vaultPath,
      paths,
      message,
      decisions.map((d) => d.id),
    );
  }

  return {
    decisions,
    scanned: { journals: journals.length, mentions: mentionCount },
  };
}

// ── SkillExecutor adapter (worker contract) ───────────────────────────

function readModeFromEnv(): DisambiguationMode {
  const raw = process.env.GROVE_DISAMBIGUATION_MODE;
  return raw === "surface-only" ? "surface-only" : "writes-allowed";
}

function readMaxDecisionsFromEnv(): number {
  const raw = process.env.GROVE_DISAMBIGUATION_MAX_DECISIONS;
  if (!raw) return DEFAULT_MAX_DECISIONS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_DECISIONS;
}

/**
 * Worker-side entry point. The v2-task-run worker loop loads this
 * symbol via `loadSkillModule('disambiguation')` and calls it with the
 * originating tick task. Returns an `ExecutorResult` describing the
 * scan's outcome as a surface artifact (the actual decisions live in
 * the per-vault `decisions` projection + JSONL log, not in the task
 * result body).
 */
export async function run(
  vault: VaultContext,
  _task: TaskRow,
): Promise<ExecutorResult> {
  const result = await runDisambiguation(vault, {
    mode: readModeFromEnv(),
    maxDecisions: readMaxDecisionsFromEnv(),
  });

  const surfaceText =
    result.decisions.length === 0
      ? `Disambiguation scan: ${result.scanned.journals} Journal entries, ` +
        `${result.scanned.mentions} ambiguous mention` +
        `${result.scanned.mentions === 1 ? "" : "s"} — no decisions recorded.`
      : `Disambiguation scan: recorded ${result.decisions.length} provisional ` +
        `link decision${result.decisions.length === 1 ? "" : "s"} across ` +
        `${result.scanned.journals} Journal entries. Disposition each from ` +
        `the inbox.`;

  const provenance: GroveProvenance = {
    voice: "perishable",
    by: "grove-skill/disambiguation",
    writtenAt: new Date().toISOString(),
    reason: "disambiguation skill summary",
  };

  return {
    artifact: { type: "surface", surfaceText },
    provenance,
    finalState: "review",
  };
}


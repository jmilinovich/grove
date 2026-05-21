/**
 * S-INBOX-7 — Links suggestion skill.
 *
 * Sweeps `Resources/**\/*.md` AND `Journal/**\/*.md` for raw surface
 * mentions of entities that have a single matching note in the vault
 * but aren't wikilinked. Complement to S-INBOX-6 (Disambiguation):
 *
 *   - S-6 fires when 2+ candidates match an ambiguous surface form
 *     (e.g. "Anna" matching both "Anna Chen" and "Anna Kim").
 *   - S-7 fires when EXACTLY ONE candidate matches a surface form.
 *
 * High volume, low stakes per item. Deterministic: zero LLM calls.
 *
 * Scope of "entities":
 *   - Person notes  (Resources/People/*.md, type: person)
 *   - Concept notes (Resources/Concepts/*.md, type: concept)
 *   - Company notes (Resources/Companies/*.md, type: company)
 *
 * Behavior:
 *   1. Build an entity index — title + frontmatter aliases for every
 *      Person/Concept/Company note. For multi-word Person titles, also
 *      derive the first-name surface form (matches `Anna Chen` → `Anna`).
 *      Multi-word Concepts/Companies use only the title + aliases
 *      verbatim — splitting "Design Reviews" into "Design" would
 *      produce too many spurious mentions.
 *   2. Walk Resources + Journal entries in deterministic order.
 *   3. For each note, find non-wikilinked occurrences of any surface
 *      form. A surface form is "linkable" iff EXACTLY ONE entity matches
 *      (2+ matches → that's S-INBOX-6's territory, skip).
 *   4. For each linkable mention, replace the FIRST occurrence with
 *      `[[<target-title>]]` (or `[[<target-title>|<surface>]]` when the
 *      source casing differs from the title). Writes go through
 *      `writeNoteFile` (encryption-aware).
 *   5. Record a `Decision` of type `"link"` with two options:
 *      `opt-1 = link to <target>`, `opt-2 = do not link`. The user can
 *      dismiss without compensation surprise — by definition the link
 *      is unambiguous, so the choice is binary.
 *   6. After the loop, if there were any decisions AND mode is
 *      `writes-allowed`, emit ONE `commitSkillRun` containing
 *      `.grove/decisions.jsonl` + every note the run modified.
 *      Commit subject: `links-suggestion: N provisional link(s)`.
 *
 * Per-run cap (`maxDecisions`, default 20) — higher than S-6's default
 * 10 because the unambiguous case is higher-volume per spec, but still
 * a hard stop to prevent inbox flood on the first scan of a fresh vault.
 *
 * Two exports mirror `disambiguation`:
 *   - `runLinksSuggestion(vault, options)` — high-level runner, returns
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
  LinkPayload,
  ReviewOption,
} from "../v2-decisions.js";
import { readNoteFile, writeNoteFile } from "../vault-ops.js";
import { parseNote } from "../notes-validate.js";

// ── Tunable constants ─────────────────────────────────────────────────

const PEOPLE_DIR = "Resources/People";
const CONCEPTS_DIR = "Resources/Concepts";
const COMPANIES_DIR = "Resources/Companies";
const RESOURCES_DIR = "Resources";
const JOURNAL_DIR = "Journal";
const DEFAULT_MAX_DECISIONS = 20;
const SKILL_SLUG = "links-suggestion";
/** Min surface-form length — single letters / two-letter aliases are noisy. */
const MIN_SURFACE_LENGTH = 3;
const DECISIONS_LOG_REL = ".grove/decisions.jsonl";

// ── Types ─────────────────────────────────────────────────────────────

export type LinksMode = "surface-only" | "writes-allowed";

export interface LinksRunOptions {
  /** "surface-only" generates decisions but doesn't write/commit. "writes-allowed" applies provisional links. Default: writes-allowed. */
  mode?: LinksMode;
  /** Cap per-run. Default 20. Prevents inbox flood on the first scan. */
  maxDecisions?: number;
}

export interface LinksRunResult {
  decisions: Decision[];
  scanned: { notes: number; mentions: number };
}

type EntityKind = "person" | "concept" | "company";

interface EntityCandidate {
  kind: EntityKind;
  title: string;
  /** Vault-relative path of the entity note. */
  notePath: string;
  /** Surface forms that resolve to this entity (title + aliases [+ derived]). */
  surfaceForms: string[];
}

interface NoteScan {
  /** Vault-relative path of the note. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Raw file contents (post-decrypt). */
  content: string;
}

// ── Entity index ──────────────────────────────────────────────────────

/**
 * Build an index of Person/Concept/Company entities for surface-form
 * matching. One `EntityCandidate` per note, with all surface forms
 * (title + aliases [+ derived first-name for Person]) folded in.
 *
 * Unlike disambiguation, we don't need backlink counts here — by
 * construction, "linkable" surface forms map to exactly one candidate.
 */
function buildEntityIndex(vaultPath: string): EntityCandidate[] {
  const out: EntityCandidate[] = [];
  for (const { dir, kind } of [
    { dir: PEOPLE_DIR, kind: "person" as EntityKind },
    { dir: CONCEPTS_DIR, kind: "concept" as EntityKind },
    { dir: COMPANIES_DIR, kind: "company" as EntityKind },
  ]) {
    const abs = join(vaultPath, dir);
    if (!existsSync(abs)) continue;
    let entries: string[];
    try {
      entries = readdirSync(abs).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of entries) {
      const filePath = join(abs, file);
      let raw: string;
      try {
        raw = readNoteFile(filePath);
      } catch {
        continue;
      }
      // Defensive parse — one note with malformed YAML frontmatter must
      // not crash the whole scan (see prod incident 2026-05-19). Skill
      // is a read-scan; write paths still fail loudly on bad YAML.
      let frontmatter: Record<string, unknown>;
      try {
        ({ frontmatter } = parseNote(raw));
      } catch (err) {
        console.warn(
          `[${SKILL_SLUG}] skipping ${dir}/${file}: ${
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

      // Only Person notes contribute a derived first-name surface form.
      // For Concepts/Companies, multi-word titles like "Design Reviews"
      // or "Anthropic AI" must NOT split — the first word in isolation
      // would match too aggressively in arbitrary prose.
      const derived: string[] = [];
      if (kind === "person") {
        const titleParts = title.split(/\s+/);
        if (titleParts.length > 1 && titleParts[0]) {
          derived.push(titleParts[0]);
        }
      }

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

      out.push({
        kind,
        title,
        notePath: `${dir}/${file}`,
        surfaceForms,
      });
    }
  }
  return out;
}

// ── Filesystem walk ──────────────────────────────────────────────────

/**
 * Walk `Resources/**\/*.md` + `Journal/**\/*.md`, sorted for
 * deterministic scan order. Returns notes in canonical order: first
 * Resources (alpha), then Journal (alpha). Within Resources, the entity
 * notes themselves are excluded (we don't want to link `Anna Chen.md`
 * to itself when it mentions "Anna Chen" in its own body).
 *
 * Skip rationale for entity self-mentions:
 *   The People/Concepts/Companies notes are the LINK TARGETS; their
 *   own body legitimately contains their own title (it's the page
 *   header). Linking it to itself would be noise.
 *
 *   We don't skip OTHER entity notes — `Anna Chen.md` may mention
 *   `Anthropic` in the body and that's a real link opportunity. The
 *   index is keyed by notePath, so we just check if the current
 *   candidate's notePath equals the scan's notePath, not the directory.
 */
function readScanTargets(vaultPath: string): NoteScan[] {
  const out: NoteScan[] = [];
  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
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
  const resourcesAbs = join(vaultPath, RESOURCES_DIR);
  if (existsSync(resourcesAbs)) walk(resourcesAbs);
  const journalAbs = join(vaultPath, JOURNAL_DIR);
  if (existsSync(journalAbs)) walk(journalAbs);
  return out;
}

// ── Surface-form matching ─────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find non-wikilinked occurrences of any surface form in `content`.
 * Returns one entry per distinct surface form mentioned (deduped
 * case-insensitively), tagged with the list of candidates that
 * surface form maps to.
 *
 * The returned list is sorted by first non-linked occurrence offset so
 * the per-source decision order is deterministic.
 *
 * Self-mention filter: if the scan's own notePath appears among a
 * surface form's candidates, that candidate is dropped — a note never
 * links to itself.
 */
function findLinkableMentions(
  content: string,
  index: EntityCandidate[],
  selfPath: string,
): Array<{ surfaceForm: string; candidate: EntityCandidate; firstIndex: number }> {
  // Build surface-form → candidates map (case-insensitive).
  const surfaceToCandidates = new Map<string, EntityCandidate[]>();
  for (const c of index) {
    for (const s of c.surfaceForms) {
      const key = s.toLowerCase();
      let bucket = surfaceToCandidates.get(key);
      if (!bucket) {
        bucket = [];
        surfaceToCandidates.set(key, bucket);
      }
      bucket.push(c);
    }
  }

  // Mask wikilink spans so `[[Anna Chen]]` doesn't count as an unlinked
  // `Anna` mention. Replace with spaces of identical length so offsets
  // line up with the original content.
  const masked = content.replace(/\[\[[^\]\n]+\]\]/g, (m) => " ".repeat(m.length));

  interface Hit {
    key: string;
    firstIndex: number;
    matchLen: number;
    candidates: EntityCandidate[];
    surfaceForm: string;
  }
  const hits: Hit[] = [];
  for (const [key, bucketRaw] of surfaceToCandidates) {
    // Drop self-mentions before checking ambiguity.
    const bucket = bucketRaw.filter((c) => c.notePath !== selfPath);
    if (bucket.length === 0) continue;
    const re = new RegExp(
      `(^|[^A-Za-z0-9_])(${escapeRegex(key)})(?=$|[^A-Za-z0-9_])`,
      "gi",
    );
    const m = re.exec(masked);
    if (!m) continue;
    const matchStart = m.index + m[1].length;
    const rawSurface = content.slice(matchStart, matchStart + m[2].length);
    hits.push({
      key,
      firstIndex: matchStart,
      matchLen: m[2].length,
      candidates: bucket,
      surfaceForm: rawSurface,
    });
  }

  // Longest-match-wins at each character position. When two surface
  // forms overlap (e.g. "Anna" and "Anna Chen" at the same position),
  // the longer form shadows the shorter — otherwise we'd emit redundant
  // decisions for the same span, AND the writes-allowed/surface-only
  // paths would disagree on count (writes-allowed dedupes implicitly
  // via wikilink masking after the first replacement; surface-only
  // would not).
  hits.sort((a, b) => {
    if (a.firstIndex !== b.firstIndex) return a.firstIndex - b.firstIndex;
    return b.matchLen - a.matchLen;
  });

  const claimed: Array<{ start: number; end: number }> = [];
  const filtered: Hit[] = [];
  for (const h of hits) {
    const start = h.firstIndex;
    const end = h.firstIndex + h.matchLen;
    const overlap = claimed.some((c) => start < c.end && end > c.start);
    if (overlap) continue;
    claimed.push({ start, end });
    filtered.push(h);
  }

  // Linkable = exactly one candidate. The 2+ case belongs to S-INBOX-6
  // (disambiguation).
  const out: Array<{
    surfaceForm: string;
    candidate: EntityCandidate;
    firstIndex: number;
  }> = [];
  for (const v of filtered) {
    if (v.candidates.length !== 1) continue;
    out.push({
      surfaceForm: v.surfaceForm,
      candidate: v.candidates[0]!,
      firstIndex: v.firstIndex,
    });
  }
  out.sort((a, b) => a.firstIndex - b.firstIndex);
  return out;
}

// ── Provisional link writing ──────────────────────────────────────────

/**
 * Replace the FIRST non-linked occurrence of `surfaceForm` in `content`
 * with `[[<topTitle>]]` (or `[[<topTitle>|<surfaceForm>]]` when casing
 * differs from the title). Returns the rewritten content, or null when
 * no replaceable occurrence was found.
 *
 * Identical to disambiguation's writer, by design — same shape of
 * splice (skip wikilink spans, splice into the first free hit).
 */
function applyProvisionalLink(
  content: string,
  surfaceForm: string,
  topTitle: string,
): string | null {
  const re = new RegExp(
    `(^|[^A-Za-z0-9_])(${escapeRegex(surfaceForm)})(?=$|[^A-Za-z0-9_])`,
    "i",
  );
  let result = "";
  const linkSpan = /\[\[[^\]\n]+\]\]/g;
  let cursor = 0;
  while (cursor < content.length) {
    linkSpan.lastIndex = cursor;
    const lm = linkSpan.exec(content);
    const free = content.slice(cursor, lm ? lm.index : undefined);
    const m = re.exec(free);
    if (m) {
      const matchStart = m.index + m[1].length;
      const matched = m[2];
      const replacement =
        matched === topTitle ? `[[${topTitle}]]` : `[[${topTitle}|${matched}]]`;
      result +=
        free.slice(0, matchStart) +
        replacement +
        free.slice(matchStart + matched.length);
      if (lm) result += content.slice(lm.index);
      return result;
    }
    result += free;
    if (lm) {
      result += lm[0];
      cursor = lm.index + lm[0].length;
    } else {
      cursor = content.length;
    }
  }
  return null;
}

// ── Decision construction ─────────────────────────────────────────────

function buildDecision(
  skillRunId: string,
  date: string,
  surfaceForm: string,
  candidate: EntityCandidate,
  sourceRelPath: string,
): Decision {
  const payload: LinkPayload = {
    source_path: sourceRelPath,
    surface_form: surfaceForm,
    target_path: candidate.notePath,
    candidates: [{ note_path: candidate.notePath }],
  };

  const options: ReviewOption[] = [
    {
      id: "opt-1",
      label: `link to ${candidate.title}`,
      description: "confidence: single match",
      source: "schema",
    },
    {
      id: "opt-2",
      label: "do not link",
      description: "skip this surface form",
      source: "schema",
    },
  ];

  return {
    id: `D-${date}-${randomUUID().slice(0, 8)}`,
    type: "link",
    skillRunId,
    taskId: null,
    createdAt: new Date().toISOString(),
    status: "provisional",
    payload,
    options,
    chosenOptionId: "opt-1",
    affectedPaths: [sourceRelPath],
    compensatedBy: null,
  };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Scan the vault for unlinked single-candidate surface mentions and
 * record one Link decision per (note, surface form) match.
 *
 * In `writes-allowed` mode (default), provisional `[[link]]`s are
 * applied in-place via `writeNoteFile` and the run emits ONE git commit
 * at the end. In `surface-only` mode no file is written and no commit
 * is emitted.
 */
export async function runLinksSuggestion(
  vault: VaultContext,
  options?: LinksRunOptions,
): Promise<LinksRunResult> {
  const mode: LinksMode = options?.mode ?? "writes-allowed";
  const maxDecisions =
    options?.maxDecisions !== undefined && options.maxDecisions >= 0
      ? options.maxDecisions
      : DEFAULT_MAX_DECISIONS;

  const index = buildEntityIndex(vault.vaultPath);
  const notes = readScanTargets(vault.vaultPath);
  let mentionCount = 0;

  if (index.length === 0 || notes.length === 0) {
    return {
      decisions: [],
      scanned: { notes: notes.length, mentions: 0 },
    };
  }

  const skillRunId = `SR-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const date = new Date().toISOString().slice(0, 10);

  const decisions: Decision[] = [];
  const writtenPaths = new Set<string>();

  let capped = false;
  for (const note of notes) {
    if (capped) break;
    const mentions = findLinkableMentions(note.content, index, note.relPath);
    mentionCount += mentions.length;

    let runningContent = note.content;
    let mutated = false;
    for (const { surfaceForm, candidate } of mentions) {
      if (decisions.length >= maxDecisions) {
        capped = true;
        break;
      }

      const decision = buildDecision(
        skillRunId,
        date,
        surfaceForm,
        candidate,
        note.relPath,
      );

      if (mode === "writes-allowed") {
        const rewritten = applyProvisionalLink(
          runningContent,
          surfaceForm,
          candidate.title,
        );
        if (rewritten === null) {
          // No free occurrence in current buffer — skip; we won't record
          // a decision we can't realize.
          continue;
        }
        runningContent = rewritten;
        mutated = true;
      }

      recordDecision(vault.vaultPath, vault.vaultId, decision);
      decisions.push(decision);
    }

    // Flush per-note mutations BEFORE bailing on the outer loop. This is
    // load-bearing for the maxDecisions cap: the cap can fire after we
    // already recorded a decision for this note, and the recorded
    // decision must be backed by a real wikilink on disk.
    if (mode === "writes-allowed" && mutated && runningContent !== note.content) {
      writeNoteFile(note.absPath, runningContent);
      writtenPaths.add(note.relPath);
    }
  }

  if (mode === "writes-allowed" && decisions.length > 0) {
    const subject =
      `${SKILL_SLUG}: ${decisions.length} provisional link` +
      `${decisions.length === 1 ? "" : "s"}`;
    const message = composeCommitMessage(
      subject,
      provenanceToTrailers({
        voice: "perishable",
        by: `grove-skill/${SKILL_SLUG}`,
        written_at: new Date().toISOString(),
        reason: "S-INBOX-7 links-suggestion provisional links",
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
    scanned: { notes: notes.length, mentions: mentionCount },
  };
}

// ── SkillExecutor adapter (worker contract) ───────────────────────────

function readModeFromEnv(): LinksMode {
  const raw = process.env.GROVE_LINKS_SUGGESTION_MODE;
  return raw === "surface-only" ? "surface-only" : "writes-allowed";
}

function readMaxDecisionsFromEnv(): number {
  const raw = process.env.GROVE_LINKS_SUGGESTION_MAX_DECISIONS;
  if (!raw) return DEFAULT_MAX_DECISIONS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_DECISIONS;
}

/**
 * Worker-side entry point. Loaded via `loadSkillModule('links-suggestion')`.
 * Returns an `ExecutorResult` describing the scan's outcome as a surface
 * artifact (decisions live in the per-vault `decisions` projection +
 * JSONL log, not the task result body).
 */
export async function run(
  vault: VaultContext,
  _task: TaskRow,
): Promise<ExecutorResult> {
  const result = await runLinksSuggestion(vault, {
    mode: readModeFromEnv(),
    maxDecisions: readMaxDecisionsFromEnv(),
  });

  const surfaceText =
    result.decisions.length === 0
      ? `Links-suggestion scan: ${result.scanned.notes} note${
          result.scanned.notes === 1 ? "" : "s"
        }, ${result.scanned.mentions} unlinked single-candidate mention${
          result.scanned.mentions === 1 ? "" : "s"
        } — no decisions recorded.`
      : `Links-suggestion scan: recorded ${result.decisions.length} provisional ` +
        `link decision${result.decisions.length === 1 ? "" : "s"} across ` +
        `${result.scanned.notes} note${result.scanned.notes === 1 ? "" : "s"}. ` +
        `Disposition each from the inbox.`;

  const provenance: GroveProvenance = {
    voice: "perishable",
    by: `grove-skill/${SKILL_SLUG}`,
    writtenAt: new Date().toISOString(),
    reason: "links-suggestion skill summary",
  };

  return {
    artifact: { type: "surface", surfaceText },
    provenance,
    finalState: "review",
  };
}

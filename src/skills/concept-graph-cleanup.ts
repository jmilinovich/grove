/**
 * P23-3 — `concept-graph-cleanup` skill executor.
 *
 * Walks `Resources/Concepts/*.md`, ranks candidate notes by cleanup
 * value (orphan > near-duplicate > thin), and asks `claude-haiku-4-5`
 * to propose one of three actions per candidate: `merge` (two notes
 * collapse into one + a redirect), `prune` (an orphan note disappears),
 * or `expand` (a thin note gets a writing prompt surfaced to the user).
 * Each accepted proposal is inserted as a child task with
 * `state='review'`; the `/v1/tasks/<id>/review` endpoint applies the
 * payload on confirm.
 *
 * Pipeline:
 *   1. Enumerate `Resources/Concepts/*.md` under the vault root.
 *   2. Bucket each note as `orphan`, `near-dup`, or `thin` (a note can
 *      qualify for multiple buckets but appears once in the candidate
 *      set — see scoring rule below).
 *   3. Score & cap at MAX_CANDIDATES_PER_RUN = 3.
 *   4. For each surviving candidate, ask claude-haiku-4-5 (prompt-
 *      cached) for a `merge` / `prune` / `expand` proposal via the
 *      `propose_concept_cleanup` tool.
 *   5. Insert one child task per accepted proposal.
 *
 * ── Scoring rule (load-bearing — document on the file) ────────────────
 *
 *   Tier priority:  orphan > near-duplicate > thin
 *
 *   Rationale: an orphan note costs the most navigation effort per
 *   read — it can't be reached by following any link, so the vault
 *   owner only finds it by direct search. A near-duplicate splits
 *   incoming links across two stems, which fragments the graph but
 *   still surfaces from either side. A thin note is the cheapest
 *   pathology to live with — it's reachable, just underdeveloped.
 *
 *   Within each tier, oldest-last-modified wins (a note that's been
 *   sitting stale for a year is a stronger cleanup target than one
 *   the user touched yesterday and may still be drafting).
 *
 *   The cap is **3 per run**, identical to dup-people-detection, to
 *   keep the prompt cost predictable. The cost ceiling is gated
 *   BEFORE any Anthropic calls; an oversized vault returns a
 *   `surface` artifact with `reason: "cost_ceiling_exceeded"` and
 *   makes zero API calls (Scope Cop SHRINK #1, same shape as the
 *   enrichment class and dup-people-detection).
 *
 * ── Embeddings ────────────────────────────────────────────────────────
 *
 * Concept-graph-cleanup intentionally does NOT use Voyage embeddings.
 * The candidate signal is purely structural (word count + inbound/
 * outbound wikilink counts + Levenshtein on slugified filenames), so
 * the embedding step that dup-people-detection needs to disambiguate
 * "Jon Smith" vs "Jonathon Smith" by content is unnecessary here:
 * concept titles are already short, structured, and the failure mode
 * for thin/orphan detection is bag-of-words. Skipping embeddings also
 * eliminates a Voyage round-trip and the partial-result failure mode
 * (`embeddings.length !== notes.length`) that the other executor has
 * to handle. We expose `setClientForTesting` but no embedder hook —
 * see the "embedder injection — intentionally omitted" note below.
 *
 * Two exports:
 *   - `runConceptGraphCleanup(vault, options): Promise<TaskResult>` —
 *     high-level skill API. Returns the SUMMARY artifact for the
 *     originating tick task; child tasks are inserted as a side effect.
 *   - `run(vault, task): Promise<ExecutorResult>` — the SkillExecutor
 *     adapter the v2-task-run worker loop loads via
 *     `loadSkillModule("concept-graph-cleanup")`. Reads `tokenCeiling`
 *     from env (`GROVE_CONCEPT_CLEANUP_TOKEN_CEILING`).
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { getVaultDb } from "../db-per-vault.js";
import type { VaultContext } from "../vault-router.js";
import type { TaskRow } from "../db-types.js";
import type { ExecutorResult } from "../v2-task-run.js";
import type { GroveProvenance, TaskResult } from "../v2-tasks.js";
import { exceededCeiling, recordRunCost } from "./cost-ceiling.js";

// ── Tunable constants ─────────────────────────────────────────────────

const MODEL = "claude-haiku-4-5-20251001";
const MAX_CANDIDATES_PER_RUN = 3;
const MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_TOKEN_CEILING = 24_000;
const TOKENS_PER_CONCEPT_NOTE = 600;
const TOKENS_PROMPT_OVERHEAD = 900;
const TOKENS_PER_PROPOSAL_OUTPUT = 900;
const THIN_WORD_COUNT_THRESHOLD = 100;
const MAX_TITLE_DISTANCE = 3;
const CONCEPTS_DIR = "Resources/Concepts";
const SKILL_SLUG = "concept-graph-cleanup";

// ── Types ─────────────────────────────────────────────────────────────

export interface ConceptGraphCleanupOptions {
  /** Per-run token cap. Exceeded → surface artifact, no API calls. */
  tokenCeiling?: number;
}

interface ConceptNote {
  /** Vault-relative path (e.g. `Resources/Concepts/Foo.md`). */
  path: string;
  /** Filename stem (sans `.md`). */
  name: string;
  /** Lowercased / non-alphanum-stripped stem for near-duplicate matching. */
  slug: string;
  /** Raw file content (frontmatter + body), passed through to the prompt. */
  content: string;
  /** Body word count (frontmatter stripped) — drives thin-note detection. */
  wordCount: number;
  /** Outbound wikilink stems found in the body. */
  outbound: Set<string>;
  /** Inbound wikilink stems (notes from this directory that link IN). */
  inbound: Set<string>;
  /** Last-modified epoch ms (drives oldest-first tiebreak). */
  mtimeMs: number;
}

export type CandidateKind = "orphan" | "near-dup" | "thin";

/**
 * A scored candidate. `partner` is non-null for `near-dup` candidates
 * (the duplicate sibling we'd propose merging into). For `orphan`
 * and `thin`, the action is a one-note operation.
 */
export interface Candidate {
  kind: CandidateKind;
  note: ConceptNote;
  partner: ConceptNote | null;
  /** Lower is better — tier number, then mtime ms. Stable. */
  score: { tier: number; mtimeMs: number };
}

/** Shape the model emits via the `propose_concept_cleanup` tool call. */
type ProposedAction =
  | {
      action: "merge";
      targetPath: string;
      redirectPath: string;
      targetContent: string;
      redirectContent: string;
      rationale: string;
    }
  | {
      action: "prune";
      path: string;
      rationale: string;
    }
  | {
      action: "expand";
      path: string;
      rationale: string;
      promptForUser: string;
    };

// ── Anthropic client (testable) ───────────────────────────────────────
//
// Embedder injection — intentionally omitted. See the file header for
// the rationale: this skill ranks candidates structurally (word counts,
// inbound/outbound link sets, Levenshtein on slugified filenames), so
// no embeddings round-trip happens. Mirroring dup-people-detection's
// `setEmbedderForTesting` would be dead code.

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export function setClientForTesting(c: Anthropic | null): void {
  client = c;
}

// ── Vault enumeration ─────────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---\n")) return raw;
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return raw;
  return raw.slice(end + 5);
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Extract wikilink targets (just the stem, not the pipe label). */
function extractLinkStems(text: string): Set<string> {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(WIKILINK_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    // Strip any path prefix (`Resources/Concepts/Foo` → `Foo`).
    const parts = raw.split("/");
    const stem = parts[parts.length - 1];
    if (stem.length > 0) out.add(stem);
  }
  return out;
}

/**
 * Read every `Resources/Concepts/*.md` note under the vault root and
 * compute the structural signal we need for candidate selection.
 * Inbound counts are scoped to peers in the same directory — a
 * concept linked-to from a Journal entry still counts as "linked"
 * from the navigation perspective. Returns `[]` when the directory
 * doesn't exist (a fresh vault may have no concepts yet).
 */
export function readConceptNotes(vaultPath: string): ConceptNote[] {
  const dir = join(vaultPath, CONCEPTS_DIR);
  if (!vaultPath || !existsSync(dir)) return [];
  const entries = readdirSync(dir).filter((f) => f.endsWith(".md"));

  // First pass — populate the notes without inbound counts.
  const notes: ConceptNote[] = [];
  for (const file of entries) {
    const abs = join(dir, file);
    let raw: string;
    let mtimeMs: number;
    try {
      raw = readFileSync(abs, "utf8");
      mtimeMs = statSync(abs).mtimeMs;
    } catch {
      continue;
    }
    const body = stripFrontmatter(raw);
    const name = basename(file, ".md");
    const outbound = extractLinkStems(body);
    notes.push({
      path: `${CONCEPTS_DIR}/${file}`,
      name,
      slug: slugify(name),
      content: raw,
      wordCount: countWords(body),
      outbound,
      inbound: new Set(),
      mtimeMs,
    });
  }

  // Second pass — wire inbound links from every concept's outbound
  // set onto every peer's `inbound`. We intentionally only consider
  // peer concepts here; cross-folder inbounds would require a vault-
  // wide walk which `vault-graph.ts` already does, but for this
  // skill's purposes "is this concept findable by following any
  // concept link?" is the load-bearing signal.
  const byName = new Map<string, ConceptNote>();
  for (const n of notes) byName.set(n.name, n);
  for (const src of notes) {
    for (const tgt of src.outbound) {
      const peer = byName.get(tgt);
      if (peer && peer !== src) peer.inbound.add(src.name);
    }
  }
  return notes;
}

// ── Similarity primitives ─────────────────────────────────────────────

/**
 * Wagner-Fischer Levenshtein distance. We could pull the
 * `levenshtein` export from `dup-people-detection.ts` and share it,
 * but importing a sibling skill module ties their lifecycles together
 * (a refactor in one breaks the test fixture of the other). The
 * dup-people version normalizes to lowercase before computing; this
 * one takes pre-slugified inputs and compares them as-is. Same
 * underlying algorithm, different invariant on the caller.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = new Array(n + 1);
  let curr: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// ── Candidate selection ───────────────────────────────────────────────

/**
 * Score concept notes into a tier-ranked candidate list and cap at
 * `maxCandidates`. See the file header for the scoring rationale.
 *
 * Tiers:
 *   tier 1 = orphan (zero inbound AND zero outbound)
 *   tier 2 = near-dup (Levenshtein ≤ MAX_TITLE_DISTANCE on slugs)
 *   tier 3 = thin (word count < THIN_WORD_COUNT_THRESHOLD AND zero
 *            outbound)
 *
 * Within each tier, oldest-last-modified wins.
 *
 * A note can satisfy multiple buckets (an orphan is also thin), but
 * appears in the candidate list only once at its best tier — orphans
 * dominate thins so we don't double-spend the LLM call on the same
 * path.
 */
export function selectCandidates(
  notes: ConceptNote[],
  options: { maxCandidates?: number } = {},
): Candidate[] {
  const maxCandidates = options.maxCandidates ?? MAX_CANDIDATES_PER_RUN;

  const claimed = new Set<string>(); // paths already added at a higher tier
  const candidates: Candidate[] = [];

  // Tier 1 — orphans.
  for (const n of notes) {
    if (n.inbound.size === 0 && n.outbound.size === 0) {
      candidates.push({
        kind: "orphan",
        note: n,
        partner: null,
        score: { tier: 1, mtimeMs: n.mtimeMs },
      });
      claimed.add(n.path);
    }
  }

  // Tier 2 — near-duplicate title pairs. For each unordered pair,
  // record the OLDER of the two as the candidate (its mtime drives the
  // tiebreak); the partner is the other note in the pair. If either
  // side is already an orphan candidate, skip the pair — orphan-tier
  // wins.
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const a = notes[i];
      const b = notes[j];
      if (a.slug === "" || b.slug === "") continue;
      if (a.slug === b.slug) continue; // same slug = case-only collision; skip
      const d = levenshtein(a.slug, b.slug);
      if (d > MAX_TITLE_DISTANCE) continue;
      if (claimed.has(a.path) || claimed.has(b.path)) continue;
      const [older, newer] = a.mtimeMs <= b.mtimeMs ? [a, b] : [b, a];
      candidates.push({
        kind: "near-dup",
        note: older,
        partner: newer,
        score: { tier: 2, mtimeMs: older.mtimeMs },
      });
      claimed.add(a.path);
      claimed.add(b.path);
    }
  }

  // Tier 3 — thin notes (small body AND zero outbound). A thin note
  // with outbound links is still doing graph work — leave it alone.
  for (const n of notes) {
    if (claimed.has(n.path)) continue;
    if (n.wordCount >= THIN_WORD_COUNT_THRESHOLD) continue;
    if (n.outbound.size > 0) continue;
    candidates.push({
      kind: "thin",
      note: n,
      partner: null,
      score: { tier: 3, mtimeMs: n.mtimeMs },
    });
    claimed.add(n.path);
  }

  // Sort: tier ASC, then mtime ASC (oldest first within each tier).
  candidates.sort((x, y) => {
    if (x.score.tier !== y.score.tier) return x.score.tier - y.score.tier;
    return x.score.mtimeMs - y.score.mtimeMs;
  });

  return candidates.slice(0, maxCandidates);
}

// ── Prompt construction (cache-friendly static prefix) ────────────────

const STATIC_PROMPT_PREFIX = `You are the Grove concept-graph-cleanup skill.

You receive one concept note (or a pair of near-duplicate concept notes) from a personal knowledge vault. Your job: propose exactly ONE cleanup action by calling the \`propose_concept_cleanup\` tool.

Action choices:
- "merge"  — two notes are the same concept. Emit targetPath/redirectPath/targetContent/redirectContent. Pick the more canonical title as the target. Merge bodies, dedupe facts, preserve every wikilink from either source. The redirect is a one-line note pointing at the target via a [[Target Name]] wikilink.
- "prune"  — the note is an orphan (no inbound, no outbound) and has no salvageable content. Emit path + rationale. The user dispositions before any delete actually happens.
- "expand" — the note is thin but worth keeping. Emit path + rationale + promptForUser (a one-sentence writing prompt that surfaces in the dashboard — this skill never auto-writes expanded content).

Rules:
- Pick the action that matches the candidate kind passed in the input block (orphan → prune, near-dup → merge, thin → expand). Diverge only if the note's content clearly contradicts the bucket (e.g., a "thin" note that's actually a meaningful stub for an active research topic should still get expand, not prune).
- Do NOT invent biography or facts that weren't in the source note(s).
- For merge: if the two notes are clearly NOT the same concept (different topics, conflicting definitions), call propose_concept_cleanup with action="prune" path="" — the caller treats empty path as "skip this candidate".`;

function buildInputBlock(candidate: Candidate): string {
  const lines: string[] = [];
  lines.push(`Candidate kind: ${candidate.kind}`);
  lines.push(`Primary path: ${candidate.note.path}`);
  lines.push(`Primary word count: ${candidate.note.wordCount}`);
  lines.push(
    `Inbound peer count: ${candidate.note.inbound.size}  Outbound count: ${candidate.note.outbound.size}`,
  );
  if (candidate.partner) {
    lines.push(`Partner path: ${candidate.partner.path}`);
    lines.push(`Partner word count: ${candidate.partner.wordCount}`);
  }
  lines.push("");
  lines.push(`# Note A — ${candidate.note.path}`);
  lines.push(candidate.note.content);
  if (candidate.partner) {
    lines.push("");
    lines.push(`# Note B — ${candidate.partner.path}`);
    lines.push(candidate.partner.content);
  }
  return lines.join("\n");
}

const CLEANUP_TOOL: Anthropic.Tool = {
  name: "propose_concept_cleanup",
  description:
    "Propose one cleanup action for a concept note (or pair of near-duplicate concept notes). Exactly one of merge/prune/expand.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["merge", "prune", "expand"],
        description: "Cleanup action to take on the candidate.",
      },
      targetPath: {
        type: "string",
        description: "merge only: vault-relative path of the surviving note.",
      },
      redirectPath: {
        type: "string",
        description:
          "merge only: vault-relative path of the duplicate that becomes a redirect.",
      },
      targetContent: {
        type: "string",
        description:
          "merge only: full merged body for the target path, including frontmatter.",
      },
      redirectContent: {
        type: "string",
        description:
          "merge only: short body for the redirect path — typically a [[Target Name]] wikilink.",
      },
      path: {
        type: "string",
        description:
          "prune/expand: vault-relative path of the concept the action targets. Empty string means 'skip this candidate'.",
      },
      rationale: {
        type: "string",
        description: "One-sentence justification for the action.",
      },
      promptForUser: {
        type: "string",
        description:
          "expand only: a one-sentence writing prompt surfaced in the dashboard.",
      },
    },
    required: ["action", "rationale"],
  },
};

function buildRequest(
  candidate: Candidate,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    tools: [{ ...CLEANUP_TOOL, cache_control: { type: "ephemeral" } }],
    tool_choice: { type: "tool", name: CLEANUP_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: STATIC_PROMPT_PREFIX,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: buildInputBlock(candidate) },
        ],
      },
    ],
  };
}

function parseProposedAction(
  response: Anthropic.Message,
): ProposedAction | null {
  const toolUse = response.content.find(
    (block): block is Extract<typeof block, { type: "tool_use" }> =>
      block.type === "tool_use" && block.name === CLEANUP_TOOL.name,
  );
  if (!toolUse) return null;
  const input = (toolUse.input ?? {}) as Record<string, unknown>;
  const action = input.action;
  const rationale = input.rationale;
  if (typeof action !== "string" || typeof rationale !== "string") return null;

  if (action === "merge") {
    if (
      typeof input.targetPath !== "string" ||
      typeof input.redirectPath !== "string" ||
      typeof input.targetContent !== "string" ||
      typeof input.redirectContent !== "string"
    ) {
      return null;
    }
    return {
      action: "merge",
      targetPath: input.targetPath,
      redirectPath: input.redirectPath,
      targetContent: input.targetContent,
      redirectContent: input.redirectContent,
      rationale,
    };
  }
  if (action === "prune") {
    if (typeof input.path !== "string") return null;
    return { action: "prune", path: input.path, rationale };
  }
  if (action === "expand") {
    if (
      typeof input.path !== "string" ||
      typeof input.promptForUser !== "string"
    ) {
      return null;
    }
    return {
      action: "expand",
      path: input.path,
      rationale,
      promptForUser: input.promptForUser,
    };
  }
  return null;
}

// ── Cost estimate (skill-specific shape) ──────────────────────────────

function estimateCost(candidateCount: number): number {
  // Worst case: every candidate is a near-dup (two notes per prompt).
  // Single-note candidates (orphan/thin) are cheaper but the ceiling
  // has to be an upper bound or the gate is meaningless.
  const inputTokens =
    TOKENS_PROMPT_OVERHEAD + candidateCount * 2 * TOKENS_PER_CONCEPT_NOTE;
  const outputTokens = candidateCount * TOKENS_PER_PROPOSAL_OUTPUT;
  return inputTokens + outputTokens;
}

// ── Child task insertion ──────────────────────────────────────────────

interface CleanupArtifact {
  candidate: Candidate;
  proposal: ProposedAction;
}

function insertChildTask(
  vault: VaultContext,
  artifact: CleanupArtifact,
  provenance: GroveProvenance,
): string {
  const db = getVaultDb(vault.vaultId);
  const id = `task_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const { candidate, proposal } = artifact;

  let title: string;
  let body: string;
  let taskArtifact: TaskResult["artifact"];
  let noteChange: unknown;
  let sourceNotePath: string;

  if (proposal.action === "merge") {
    title = `Merge ${candidate.note.name} ↔ ${candidate.partner?.name ?? "?"}`;
    body =
      `Two concept notes look like the same idea ` +
      `(title distance ${levenshtein(
        candidate.note.slug,
        candidate.partner?.slug ?? "",
      )}). Confirm the merge or dismiss. ${proposal.rationale}`;
    taskArtifact = { type: "note-change", notePath: proposal.targetPath };
    noteChange = {
      action: "merge",
      target: { path: proposal.targetPath, content: proposal.targetContent },
      redirect: {
        path: proposal.redirectPath,
        content: proposal.redirectContent,
      },
      sourcePaths: [
        candidate.note.path,
        candidate.partner?.path ?? "",
      ].filter(Boolean),
      rationale: proposal.rationale,
    };
    sourceNotePath = proposal.targetPath;
  } else if (proposal.action === "prune") {
    title = `Prune orphan: ${candidate.note.name}`;
    body =
      `This concept has zero inbound and zero outbound wikilinks — it's ` +
      `unreachable by navigation. Confirm to archive or dismiss. ` +
      proposal.rationale;
    taskArtifact = { type: "note-change", notePath: proposal.path };
    noteChange = {
      action: "prune",
      path: proposal.path,
      rationale: proposal.rationale,
    };
    sourceNotePath = proposal.path;
  } else {
    title = `Expand thin concept: ${candidate.note.name}`;
    body =
      `${proposal.rationale} ` +
      `Writing prompt: ${proposal.promptForUser}`;
    taskArtifact = { type: "surface", notePath: proposal.path };
    // Expand never carries a note_change_json payload — it's surface
    // only. Keep the column null so the /review pipeline doesn't
    // misread an "expand" task as an auto-applicable change.
    noteChange = null;
    sourceNotePath = proposal.path;
  }

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (id, skill_slug, state, title, body, source_note_path)
       VALUES (?, ?, 'review', ?, ?, ?)`,
    ).run(id, SKILL_SLUG, title, body, sourceNotePath);
    db.prepare(
      `INSERT INTO task_results (task_id, artifact_json, note_change_json, provenance_json)
       VALUES (?, ?, ?, ?)`,
    ).run(
      id,
      JSON.stringify(taskArtifact),
      noteChange === null ? null : JSON.stringify(noteChange),
      JSON.stringify(provenance),
    );
  });
  tx();
  return id;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Run the concept-graph-cleanup skill once. Returns the SUMMARY
 * artifact for the originating tick task; per-candidate cleanup
 * proposals are inserted into the per-vault state.db as child tasks
 * with `state='review'`.
 *
 * Hard-fails on cost ceiling exceeded — surface artifact, no API
 * calls.
 */
export async function runConceptGraphCleanup(
  vault: VaultContext,
  options: ConceptGraphCleanupOptions = {},
): Promise<TaskResult> {
  const tokenCeiling = options.tokenCeiling ?? DEFAULT_TOKEN_CEILING;

  const notes = readConceptNotes(vault.vaultPath);
  if (notes.length === 0) {
    return {
      artifact: {
        type: "surface",
        surfaceText:
          `concept-graph-cleanup found no concept notes under ` +
          `${CONCEPTS_DIR}. Nothing to clean this tick.`,
      },
      provenance: {
        voice: "perishable",
        by: "system",
        writtenAt: new Date().toISOString(),
        reason: "no_concept_notes",
      },
    };
  }

  // The ceiling is the worst case (full top-K candidate fan-out).
  // Gate BEFORE selection so a vault with 10,000 concepts can't
  // burn time computing pairwise distances just to discover it can't
  // afford the LLM step.
  const worstCaseEstimate = estimateCost(MAX_CANDIDATES_PER_RUN);
  if (exceededCeiling(worstCaseEstimate, tokenCeiling)) {
    return {
      artifact: {
        type: "surface",
        surfaceText:
          `concept-graph-cleanup skipped this tick — estimated cost ` +
          `(${worstCaseEstimate} tokens) exceeds the ceiling ` +
          `(${tokenCeiling}). ${notes.length} concept note` +
          `${notes.length === 1 ? "" : "s"} would have been scanned. ` +
          `No API calls were made. Raise the ceiling or narrow the ` +
          `candidate set to retry.`,
      },
      provenance: {
        voice: "perishable",
        by: "system",
        writtenAt: new Date().toISOString(),
        reason: "cost_ceiling_exceeded",
      },
    };
  }

  const candidates = selectCandidates(notes);
  if (candidates.length === 0) {
    return {
      artifact: {
        type: "surface",
        surfaceText:
          `concept-graph-cleanup scanned ${notes.length} concept note` +
          `${notes.length === 1 ? "" : "s"} and found no thin, orphan, ` +
          `or near-duplicate candidates. Nothing to review this tick.`,
      },
      provenance: {
        voice: "perishable",
        by: MODEL,
        writtenAt: new Date().toISOString(),
        reason: "no_candidates",
      },
    };
  }

  let totalTokens = 0;
  const childIds: string[] = [];
  for (const candidate of candidates) {
    let response: Anthropic.Message;
    try {
      response = await getClient().messages.create(buildRequest(candidate));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // One candidate's LLM failure shouldn't poison the others —
      // record the skip in the summary and keep going.
      console.error(
        `[concept-graph-cleanup] LLM failed for ${candidate.note.path}: ${message}`,
      );
      continue;
    }

    const usage = (response.usage ?? {}) as {
      input_tokens?: number;
      output_tokens?: number;
    };
    totalTokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);

    const proposal = parseProposedAction(response);
    if (!proposal) continue;

    // Model's escape hatch: a "prune" with empty path means "skip
    // this candidate". Matches dup-people-detection's empty-redirect
    // semantics.
    if (proposal.action === "prune" && proposal.path.trim() === "") continue;

    const childProvenance: GroveProvenance = {
      voice: "perishable",
      by: MODEL,
      writtenAt: new Date().toISOString(),
      reason: `concept-graph-cleanup ${proposal.action} proposal`,
      basis:
        candidate.partner !== null
          ? [candidate.note.path, candidate.partner.path]
          : [candidate.note.path],
    };
    childIds.push(insertChildTask(vault, { candidate, proposal }, childProvenance));
  }

  if (totalTokens > 0) recordRunCost(SKILL_SLUG, totalTokens);

  const summarySurface =
    childIds.length === 0
      ? `concept-graph-cleanup considered ${candidates.length} candidate` +
        `${candidates.length === 1 ? "" : "s"} but produced no cleanup ` +
        `proposals (model declined every candidate).`
      : `Generated ${childIds.length} cleanup proposal` +
        `${childIds.length === 1 ? "" : "s"} from ${candidates.length} ` +
        `candidate${candidates.length === 1 ? "" : "s"} across ${notes.length} ` +
        `concept note${notes.length === 1 ? "" : "s"}. Disposition them from ` +
        `the dashboard's review pane.`;

  return {
    artifact: { type: "surface", surfaceText: summarySurface },
    provenance: {
      voice: "perishable",
      by: MODEL,
      writtenAt: new Date().toISOString(),
      reason: "concept-graph-cleanup summary",
    },
  };
}

// ── SkillExecutor adapter (worker contract) ───────────────────────────

function readCeilingFromEnv(): number {
  const raw = process.env.GROVE_CONCEPT_CLEANUP_TOKEN_CEILING;
  if (!raw) return DEFAULT_TOKEN_CEILING;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOKEN_CEILING;
}

/**
 * Worker-side entry point. The v2-task-run worker loop loads this
 * symbol via `loadSkillModule('concept-graph-cleanup')` and invokes
 * it on the originating tick task. Returns an `ExecutorResult` so
 * the worker writes the summary to `task_results` and transitions
 * the originating task to `review` for the user to acknowledge.
 */
export async function run(
  vault: VaultContext,
  _task: TaskRow,
): Promise<ExecutorResult> {
  const result = await runConceptGraphCleanup(vault, {
    tokenCeiling: readCeilingFromEnv(),
  });
  return {
    artifact: result.artifact,
    provenance: result.provenance,
    finalState: "review",
  };
}

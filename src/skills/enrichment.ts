/**
 * S-INBOX-8 — Enrichment suggestion skill (the first review-emitting skill in Inbox v2).
 *
 * Identifies thin Concept notes — `Resources/Concepts/*.md` whose body
 * (sans frontmatter) is shorter than `THIN_BODY_THRESHOLD` AND that have
 * at least `MIN_BACKLINKS` backlinks elsewhere in the vault — and asks
 * Claude Haiku to draft a four-paragraph expansion grounded in the
 * surrounding context of those backlinks. The drafted paragraphs are
 * APPENDED to the existing body (preserving the original sentences and
 * frontmatter) and a `Decision` of type `"enrichment"` is recorded with
 * `payload.prior_content` set to the COMPLETE pre-enrichment file
 * contents (frontmatter + body) so compensation can restore it
 * byte-for-byte.
 *
 * This is the only suggestion class in Inbox v2 that calls the LLM. The
 * cost-ceiling integration is the prototypical hard-fail shape used by
 * other skill classes:
 *   - `estimateRunCost` is called BEFORE any LLM call
 *   - on `exceededCeiling`, the skill returns ZERO decisions and a
 *     `ceilingHit: true` summary — no LLM call is attempted
 *   - per-call usage is recorded via `recordRunCost`
 *
 * Structural shape mirrors disambiguation/links-suggestion:
 *   - `recordDecision` per applied enrichment
 *   - `commitSkillRun` once at the end, including `.grove/decisions.jsonl`
 *     and every Concept file the run modified
 *   - per-run cap (`maxDecisions`, default 5 — tightest of the three
 *     classes because each call costs real tokens)
 *   - `mode='surface-only'` records decisions but does NOT mutate files
 *     and does NOT emit a skill-run commit
 *
 * Two exports:
 *   - `runEnrichment(vault, options)` — high-level runner, used by tests
 *   - `run(vault, task)` — `SkillExecutor` adapter (worker contract)
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";

import { recordDecision, commitSkillRun } from "../decision-writer.js";
import { composeCommitMessage, provenanceToTrailers } from "../provenance.js";
import { parseNote } from "../notes-validate.js";
import { readNoteFile, writeNoteFile } from "../vault-ops.js";
import type { TaskRow } from "../db-types.js";
import type { ExecutorResult } from "../v2-task-run.js";
import type { GroveProvenance } from "../v2-tasks.js";
import type { VaultContext } from "../vault-router.js";
import type {
  Decision,
  EnrichmentPayload,
  ReviewOption,
} from "../v2-decisions.js";
import {
  estimateRunCost,
  exceededCeiling,
  recordRunCost,
} from "./cost-ceiling.js";

// ── Tunable constants ─────────────────────────────────────────────────

const MODEL = "claude-haiku-4-5-20251001";
const SKILL_SLUG = "enrichment";
const CONCEPTS_DIR = "Resources/Concepts";
const DECISIONS_LOG_REL = ".grove/decisions.jsonl";
/** Body length (post-frontmatter, post-trim) below which a Concept is "thin". */
const THIN_BODY_THRESHOLD = 200;
/** Min backlink count needed for there to be enough source material to draft from. */
const MIN_BACKLINKS = 3;
/** Per-run cap. Enrichment is the most expensive class — keep volume tight. */
const DEFAULT_MAX_DECISIONS = 5;
/** Default token ceiling per run — same default used by other LLM-touching skills. */
const DEFAULT_TOKEN_CEILING = 12_000;
/** Slice of backlinking-note prose fed to the model per source. */
const BACKLINK_CONTEXT_CHARS = 200;
const MAX_OUTPUT_TOKENS = 1024;

// ── Types ─────────────────────────────────────────────────────────────

export type EnrichmentMode = "surface-only" | "writes-allowed";

export interface EnrichmentRunOptions {
  /** "surface-only" generates decisions but doesn't write/commit. Default: writes-allowed. */
  mode?: EnrichmentMode;
  /** Cap per-run. Default 5. Tightest of the three classes — each call is real tokens. */
  maxDecisions?: number;
  /** Per-run token ceiling. Default 12_000. */
  tokenCeiling?: number;
}

export interface EnrichmentRunResult {
  decisions: Decision[];
  scanned: { concepts: number; thin: number };
  ceilingHit: boolean;
}

interface ConceptCandidate {
  /** Vault-relative path of the Concept note. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Title (filename without .md). */
  title: string;
  /** Full pre-enrichment file content (frontmatter + body) — captured for prior_content. */
  fullContent: string;
  /** Backlink context snippets (first BACKLINK_CONTEXT_CHARS of each backlinking note). */
  backlinks: BacklinkContext[];
}

interface BacklinkContext {
  /** Vault-relative path of the backlinking note. */
  sourcePath: string;
  /** First BACKLINK_CONTEXT_CHARS of the backlinking note's body. */
  context: string;
}

// ── Anthropic client (testable) ───────────────────────────────────────

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

/** Inject a mock client for tests. Pass `null` to reset to a fresh real client. */
export function setClientForTesting(c: Anthropic | null): void {
  client = c;
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
      } else if (name.endsWith(".md")) {
        out.push(abs);
      }
    }
  }
  walk(vaultPath);
  return out;
}

// ── Thin-Concept selection + backlink harvesting ─────────────────────

/**
 * Scan `Resources/Concepts/` for notes whose body (sans frontmatter) is
 * thinner than `THIN_BODY_THRESHOLD` and that have at least
 * `MIN_BACKLINKS` backlinks elsewhere in the vault. Returns one
 * candidate per qualifying Concept, with backlink-context snippets
 * captured for prompting.
 *
 * Walk order is sorted-by-filename for deterministic test behaviour.
 */
function findThinConcepts(vaultPath: string): {
  candidates: ConceptCandidate[];
  conceptsScanned: number;
} {
  const conceptsAbs = join(vaultPath, CONCEPTS_DIR);
  if (!existsSync(conceptsAbs)) {
    return { candidates: [], conceptsScanned: 0 };
  }

  let entries: string[];
  try {
    entries = readdirSync(conceptsAbs)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return { candidates: [], conceptsScanned: 0 };
  }

  // First pass: identify thin candidates (no backlink scan yet).
  interface Pending {
    relPath: string;
    absPath: string;
    title: string;
    fullContent: string;
  }
  const pending: Pending[] = [];
  for (const file of entries) {
    const absPath = join(conceptsAbs, file);
    let fullContent: string;
    try {
      fullContent = readNoteFile(absPath);
    } catch {
      continue;
    }
    const { content } = parseNote(fullContent);
    if (content.trim().length >= THIN_BODY_THRESHOLD) continue;

    const title = file.replace(/\.md$/, "");
    pending.push({
      relPath: `${CONCEPTS_DIR}/${file}`,
      absPath,
      title,
      fullContent,
    });
  }

  if (pending.length === 0) {
    return { candidates: [], conceptsScanned: entries.length };
  }

  // Second pass: single vault-wide walk to harvest backlink contexts for
  // every pending candidate at once. Same shape as disambiguation's
  // backlink scan — O(notes * candidates) but the candidate set is small.
  const titleToCandidate = new Map<string, BacklinkContext[]>();
  for (const p of pending) {
    titleToCandidate.set(p.title.toLowerCase(), []);
  }

  const allFiles = walkMarkdown(vaultPath);
  for (const abs of allFiles) {
    // Skip the Concept notes themselves — a Concept's own body legitimately
    // mentions its own title; that's not a backlink in any useful sense.
    if (pending.some((p) => p.absPath === abs)) continue;
    let raw: string;
    try {
      raw = readNoteFile(abs);
    } catch {
      continue;
    }
    const matches = raw.matchAll(/\[\[([^\]|\n]+)(?:\|[^\]\n]+)?\]\]/g);
    let recorded = false;
    for (const m of matches) {
      const target = (m[1] ?? "").trim();
      if (!target) continue;
      // Wikilink may be a bare title or a path. Both forms count.
      const lowerTarget = target.toLowerCase();
      const baseName = lowerTarget.split("/").pop() ?? "";
      const candidates =
        titleToCandidate.get(lowerTarget) ?? titleToCandidate.get(baseName);
      if (!candidates) continue;
      // Capture the backlinking note's context ONCE per (source, target)
      // pair — multiple wikilinks to the same target from one file still
      // surface one snippet (otherwise long notes inflate the prompt).
      if (recorded) continue;
      const { content } = parseNote(raw);
      const trimmed = content.trim();
      const snippet = trimmed.slice(0, BACKLINK_CONTEXT_CHARS);
      candidates.push({
        sourcePath: relative(vaultPath, abs).split("\\").join("/"),
        context: snippet,
      });
      recorded = true;
    }
  }

  const candidates: ConceptCandidate[] = [];
  for (const p of pending) {
    const backlinks = titleToCandidate.get(p.title.toLowerCase()) ?? [];
    if (backlinks.length < MIN_BACKLINKS) continue;
    candidates.push({
      relPath: p.relPath,
      absPath: p.absPath,
      title: p.title,
      fullContent: p.fullContent,
      backlinks,
    });
  }

  return { candidates, conceptsScanned: entries.length };
}

// ── Prompt construction (cache-friendly static prefix) ────────────────

const STATIC_PROMPT_PREFIX = `You are the Grove enrichment skill.

Your job: read the thin Concept note below and the context from notes that link to it, then draft a four-paragraph expansion to APPEND to the existing body.

Voice anchors (vault style):
- Calm and precise.
- Warm, editorial, dry.
- No exclamation marks. No emoji.
- Write in the same first/third-person register the existing body uses.
- Do not invent facts beyond what the backlink context grounds.

Output rules:
- Exactly four paragraphs.
- Plain prose. No headings, no lists, no frontmatter.
- Do not repeat the existing body verbatim — extend it.
- Separate paragraphs with a single blank line.

Respond by calling the \`draft_enrichment\` tool with the rendered paragraphs as a single string.`;

interface DraftedEnrichment {
  paragraphs: string;
}

function buildInputBlock(candidate: ConceptCandidate): string {
  const lines: string[] = [];
  lines.push(`# Concept: ${candidate.title}`);
  lines.push("");
  lines.push("## Current body");
  lines.push("");
  const { content } = parseNote(candidate.fullContent);
  lines.push(content.trim() || "(empty)");
  lines.push("");
  lines.push("## Backlink context");
  for (const b of candidate.backlinks) {
    lines.push("");
    lines.push(`### From ${b.sourcePath}`);
    lines.push("");
    lines.push(b.context);
  }
  return lines.join("\n");
}

const DRAFT_TOOL: Anthropic.Tool = {
  name: "draft_enrichment",
  description:
    "Draft a four-paragraph expansion of the thin Concept note, grounded in the backlink context.",
  input_schema: {
    type: "object",
    properties: {
      paragraphs: {
        type: "string",
        description:
          "Exactly four paragraphs separated by a single blank line. Plain prose, no headings or frontmatter.",
      },
    },
    required: ["paragraphs"],
  },
};

function buildRequest(
  candidate: ConceptCandidate,
): Anthropic.MessageCreateParamsNonStreaming {
  const dynamicBlock = buildInputBlock(candidate);
  return {
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    tools: [{ ...DRAFT_TOOL, cache_control: { type: "ephemeral" } }],
    tool_choice: { type: "tool", name: DRAFT_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: STATIC_PROMPT_PREFIX,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: dynamicBlock },
        ],
      },
    ],
  };
}

function parseDraftedEnrichment(
  response: Anthropic.Message,
): DraftedEnrichment | null {
  const toolUse = response.content.find(
    (block): block is Extract<typeof block, { type: "tool_use" }> =>
      block.type === "tool_use" && block.name === DRAFT_TOOL.name,
  );
  if (!toolUse) return null;
  const input = (toolUse.input ?? {}) as { paragraphs?: unknown };
  if (typeof input.paragraphs !== "string") return null;
  const paragraphs = input.paragraphs.trim();
  if (paragraphs.length === 0) return null;
  return { paragraphs };
}

// ── Appending the drafted enrichment ─────────────────────────────────

/**
 * Append `paragraphs` to the body of `original`, preserving frontmatter
 * verbatim. Returns the full new file content (frontmatter + body) ready
 * to write to disk and to record as `new_content` in the decision payload.
 *
 * Ensures exactly one blank line between the existing body and the
 * appended paragraphs so the diff is clean.
 */
function appendEnrichment(original: string, paragraphs: string): string {
  const { frontmatter, content } = parseNote(original);
  const hasFrontmatter = Object.keys(frontmatter).length > 0;

  // Reconstruct the frontmatter block byte-for-byte from the original
  // (re-serializing via serializeNote could re-order keys / re-emit YAML
  // in a different shape, which would corrupt prior_content's promise of
  // byte-for-byte restoration on rollback).
  let frontmatterBlock = "";
  if (hasFrontmatter) {
    const fenceMatch = original.match(/^---\n[\s\S]*?\n---\n?/);
    if (fenceMatch) frontmatterBlock = fenceMatch[0];
  }

  const trimmedBody = content.replace(/\s+$/, "");
  const separator = trimmedBody.length > 0 ? "\n\n" : "";
  const newBody = `${trimmedBody}${separator}${paragraphs.trim()}\n`;
  return `${frontmatterBlock}${newBody}`;
}

// ── Decision construction ─────────────────────────────────────────────

function buildDecision(
  skillRunId: string,
  date: string,
  candidate: ConceptCandidate,
  priorContent: string,
  newContent: string,
): Decision {
  const payload: EnrichmentPayload = {
    target_path: candidate.relPath,
    prior_content: priorContent,
    new_content: newContent,
  };

  const options: ReviewOption[] = [
    {
      id: "opt-1",
      label: "apply enrichment",
      description: `append 4-paragraph draft to ${candidate.title}`,
      source: "schema",
    },
    {
      id: "opt-2",
      label: "dismiss",
      description: "leave the Concept as-is",
      source: "schema",
    },
  ];

  return {
    id: `D-${date}-${randomUUID().slice(0, 8)}`,
    type: "enrichment",
    skillRunId,
    taskId: null,
    createdAt: new Date().toISOString(),
    status: "provisional",
    payload,
    options,
    chosenOptionId: "opt-1",
    affectedPaths: [candidate.relPath],
    compensatedBy: null,
  };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Identify thin Concept notes and draft enrichments for each via Haiku.
 *
 * In `writes-allowed` mode (default), drafted paragraphs are appended in
 * place via `writeNoteFile` and the run emits ONE git commit at the end
 * containing `.grove/decisions.jsonl` + every Concept modified. In
 * `surface-only` mode the LLM is still called and decisions are still
 * recorded into the projection + JSONL, but no file is written and no
 * commit is emitted.
 *
 * When the per-run token-cost estimate exceeds `tokenCeiling`, the skill
 * returns ZERO decisions with `ceilingHit: true` and never calls the
 * LLM — the standard hard-fail-on-ceiling shape used across the
 * LLM-touching skill classes.
 */
export async function runEnrichment(
  vault: VaultContext,
  options?: EnrichmentRunOptions,
): Promise<EnrichmentRunResult> {
  const mode: EnrichmentMode = options?.mode ?? "writes-allowed";
  const maxDecisions =
    options?.maxDecisions !== undefined && options.maxDecisions >= 0
      ? options.maxDecisions
      : DEFAULT_MAX_DECISIONS;
  const tokenCeiling = options?.tokenCeiling ?? DEFAULT_TOKEN_CEILING;

  const { candidates: allCandidates, conceptsScanned } = findThinConcepts(
    vault.vaultPath,
  );
  const candidates = allCandidates.slice(0, maxDecisions);

  if (candidates.length === 0) {
    return {
      decisions: [],
      scanned: { concepts: conceptsScanned, thin: allCandidates.length },
      ceilingHit: false,
    };
  }

  // Estimate cost before any LLM call. Each candidate is one Haiku call,
  // fed the Concept body + backlink snippets. We re-use the shared
  // cost-ceiling helper by mapping concept count to flagsCount and total
  // backlink count to discoveryCount — same per-row weights apply.
  const totalBacklinks = candidates.reduce(
    (acc, c) => acc + c.backlinks.length,
    0,
  );
  const estimate = estimateRunCost({
    flagsCount: candidates.length,
    discoveryCount: totalBacklinks,
    outputTasks: candidates.length,
  });

  if (exceededCeiling(estimate, tokenCeiling)) {
    // Hard fail. No LLM call, no decisions, no file writes. Same shape
    // as other skills' ceiling paths.
    return {
      decisions: [],
      scanned: { concepts: conceptsScanned, thin: allCandidates.length },
      ceilingHit: true,
    };
  }

  const skillRunId = `SR-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const date = new Date().toISOString().slice(0, 10);
  const decisions: Decision[] = [];
  const writtenPaths = new Set<string>();

  for (const candidate of candidates) {
    let response: Anthropic.Message;
    try {
      response = await getClient().messages.create(buildRequest(candidate));
    } catch (err) {
      // Per-candidate LLM failure — skip and move on. Daily-vault-review
      // converts the failure to a surface; this skill is one-decision-
      // per-candidate so we just drop the offender silently and continue.
      console.error(
        `[enrichment] LLM call failed for ${candidate.relPath}: ${
          (err as Error).message
        }`,
      );
      continue;
    }

    const usage = (response.usage ?? {}) as {
      input_tokens?: number;
      output_tokens?: number;
    };
    recordRunCost(
      SKILL_SLUG,
      (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    );

    const drafted = parseDraftedEnrichment(response);
    if (!drafted) continue;

    // CAPTURE prior_content BEFORE any mutation. This is the non-
    // negotiable contract from S-INBOX-8: compensation must restore the
    // file byte-for-byte, so prior_content is the complete pre-enrichment
    // file (frontmatter + body) — read from disk, not reconstructed.
    const priorContent = candidate.fullContent;
    const newContent = appendEnrichment(priorContent, drafted.paragraphs);

    if (mode === "writes-allowed") {
      writeNoteFile(candidate.absPath, newContent);
      writtenPaths.add(candidate.relPath);
    }

    const decision = buildDecision(
      skillRunId,
      date,
      candidate,
      priorContent,
      newContent,
    );
    recordDecision(vault.vaultPath, vault.vaultId, decision);
    decisions.push(decision);
  }

  if (mode === "writes-allowed" && decisions.length > 0) {
    const subject =
      `${SKILL_SLUG}: ${decisions.length} provisional enrichment` +
      `${decisions.length === 1 ? "" : "s"}`;
    const message = composeCommitMessage(
      subject,
      provenanceToTrailers({
        voice: "perishable",
        by: `grove-skill/${SKILL_SLUG}`,
        written_at: new Date().toISOString(),
        reason: "S-INBOX-8 enrichment provisional drafts",
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
    scanned: { concepts: conceptsScanned, thin: allCandidates.length },
    ceilingHit: false,
  };
}

// ── SkillExecutor adapter (worker contract) ───────────────────────────

function readModeFromEnv(): EnrichmentMode {
  const raw = process.env.GROVE_ENRICHMENT_MODE;
  return raw === "surface-only" ? "surface-only" : "writes-allowed";
}

function readMaxDecisionsFromEnv(): number {
  const raw = process.env.GROVE_ENRICHMENT_MAX_DECISIONS;
  if (!raw) return DEFAULT_MAX_DECISIONS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_MAX_DECISIONS;
}

function readCeilingFromEnv(): number {
  const raw = process.env.GROVE_ENRICHMENT_TOKEN_CEILING;
  if (!raw) return DEFAULT_TOKEN_CEILING;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOKEN_CEILING;
}

/**
 * Worker-side entry point. Loaded via `loadSkillModule('enrichment')`.
 * Returns an `ExecutorResult` describing the scan's outcome as a surface
 * artifact (decisions live in the per-vault `decisions` projection +
 * JSONL log, not in the task result body).
 */
export async function run(
  vault: VaultContext,
  _task: TaskRow,
): Promise<ExecutorResult> {
  const result = await runEnrichment(vault, {
    mode: readModeFromEnv(),
    maxDecisions: readMaxDecisionsFromEnv(),
    tokenCeiling: readCeilingFromEnv(),
  });

  let surfaceText: string;
  if (result.ceilingHit) {
    surfaceText =
      `Enrichment skipped this tick — estimated cost exceeded the ` +
      `token ceiling. ${result.scanned.thin} thin Concept` +
      `${result.scanned.thin === 1 ? "" : "s"} would have been processed. ` +
      `No LLM call was made.`;
  } else if (result.decisions.length === 0) {
    surfaceText =
      `Enrichment scan: ${result.scanned.concepts} Concept` +
      `${result.scanned.concepts === 1 ? "" : "s"}, ` +
      `${result.scanned.thin} thin candidate` +
      `${result.scanned.thin === 1 ? "" : "s"} — no decisions recorded.`;
  } else {
    surfaceText =
      `Enrichment scan: recorded ${result.decisions.length} provisional ` +
      `enrichment${result.decisions.length === 1 ? "" : "s"} across ` +
      `${result.scanned.thin} thin Concept` +
      `${result.scanned.thin === 1 ? "" : "s"}. Disposition each from the inbox.`;
  }

  const provenance: GroveProvenance = {
    voice: "perishable",
    by: `grove-skill/${SKILL_SLUG}`,
    writtenAt: new Date().toISOString(),
    reason: "enrichment skill summary",
  };

  return {
    artifact: { type: "surface", surfaceText },
    provenance,
    finalState: "review",
  };
}

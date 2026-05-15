/**
 * P23-4 — `dup-people-detection` skill executor.
 *
 * Finds near-duplicate People notes in a vault and produces merge
 * proposals as `note-change` artifacts the user dispositions via
 * `/v1/tasks/<id>/review`.
 *
 * Pipeline:
 *   1. Enumerate `Resources/People/*.md` files under the vault root.
 *   2. Compute per-note Voyage embeddings (`voyage-4-large`).
 *   3. For each unordered pair, combine cosine similarity (≥ 0.85) with
 *      Levenshtein name distance (≤ 4). Top candidates are capped at
 *      ~3 per run so we don't fan out a 400-person vault into hundreds
 *      of Anthropic calls.
 *   4. For each candidate ask `claude-haiku-4-5` (prompt-cached) to draft
 *      a unified target note + a redirect note for the duplicate.
 *   5. Insert one child task per candidate with `state='review'`; the
 *      `note_change_json` payload carries the merge plan for the
 *      `/review` endpoint to apply when the user confirms.
 *
 * Cost ceiling: `estimateRunCost` lives in `cost-ceiling.ts`. Exceeded →
 * surface artifact, no embeddings call, no LLM call. Same hard-fail
 * shape as `daily-vault-review` per Scope Cop SHRINK #1.
 *
 * Two exports:
 *   - `runDupPeopleDetection(vault, options): Promise<TaskResult>` — high-
 *     level skill API. Returns the SUMMARY artifact for the originating
 *     tick task; child tasks are inserted as a side effect.
 *   - `run(vault, task): Promise<ExecutorResult>` — the SkillExecutor
 *     adapter the v2-task-run worker loop loads. Reads `tokenCeiling`
 *     from env (`GROVE_DUP_PEOPLE_TOKEN_CEILING`).
 *
 * Testability: both the Voyage embedder and the Anthropic client are
 * injectable via `setEmbedderForTesting` / `setClientForTesting` so the
 * test fixture never touches a real API.
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { getVaultDb } from "../db-per-vault.js";
import type { VaultContext } from "../vault-router.js";
import type { TaskRow } from "../db-types.js";
import type { ExecutorResult } from "../v2-task-run.js";
import type { GroveProvenance, TaskResult } from "../v2-tasks.js";
import { exceededCeiling, recordRunCost } from "./cost-ceiling.js";

// ── Tunable constants ─────────────────────────────────────────────────

const MODEL = "claude-haiku-4-5-20251001";
const VOYAGE_MODEL = "voyage-4-large";
const MIN_COSINE = 0.85;
const MAX_NAME_DISTANCE = 4;
const MAX_CANDIDATES_PER_RUN = 3;
const MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_TOKEN_CEILING = 24_000;
const TOKENS_PER_PERSON_NOTE = 600;
const TOKENS_PROMPT_OVERHEAD = 900;
const TOKENS_PER_MERGE_OUTPUT = 900;
const PEOPLE_DIR = "Resources/People";
const SKILL_SLUG = "dup-people-detection";

// ── Types ─────────────────────────────────────────────────────────────

export interface DupPeopleDetectionOptions {
  /** Per-run token cap. Exceeded → surface artifact, no API calls. */
  tokenCeiling?: number;
}

interface PersonNote {
  path: string;
  name: string;
  content: string;
  embedText: string;
}

interface PairCandidate {
  a: PersonNote;
  b: PersonNote;
  cosine: number;
  nameDistance: number;
}

/** Shape the model emits via the `propose_person_merge` tool call. */
interface ProposedMerge {
  targetPath: string;
  redirectPath: string;
  targetContent: string;
  redirectContent: string;
  rationale: string;
}

// ── Anthropic client (testable) ───────────────────────────────────────

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export function setClientForTesting(c: Anthropic | null): void {
  client = c;
}

// ── Embedder (testable) ───────────────────────────────────────────────

export type Embedder = (texts: string[]) => Promise<number[][]>;

let embedder: Embedder | null = null;

export function setEmbedderForTesting(e: Embedder | null): void {
  embedder = e;
}

async function voyageEmbed(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY ?? "";
  if (!apiKey) throw new Error("VOYAGE_API_KEY not set");
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: texts,
      model: VOYAGE_MODEL,
      input_type: "document",
    }),
  });
  if (!res.ok) {
    throw new Error(`Voyage API error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    data: { embedding: number[]; index: number }[];
  };
  const out: number[][] = new Array(texts.length);
  for (const item of data.data) out[item.index] = item.embedding;
  return out;
}

function getEmbedder(): Embedder {
  return embedder ?? voyageEmbed;
}

// ── Vault enumeration ─────────────────────────────────────────────────

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---\n")) return raw;
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return raw;
  return raw.slice(end + 5);
}

/**
 * Read every `Resources/People/*.md` note under the vault root. Returns
 * an empty array when the directory doesn't exist (a vault might not
 * have any People notes yet).
 */
export function readPeopleNotes(vaultPath: string): PersonNote[] {
  const dir = join(vaultPath, PEOPLE_DIR);
  if (!vaultPath || !existsSync(dir)) return [];
  const entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
  const notes: PersonNote[] = [];
  for (const file of entries) {
    const abs = join(dir, file);
    let raw: string;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const body = stripFrontmatter(raw).trim();
    const name = basename(file, ".md");
    notes.push({
      path: `${PEOPLE_DIR}/${file}`,
      name,
      content: raw,
      // The Voyage embedding sees `name + body` so name-only ties (an
      // empty stub note for an existing person) still produce a useful
      // similarity signal.
      embedText: `${name}\n\n${body}`,
    });
  }
  return notes;
}

// ── Similarity primitives ─────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Wagner-Fischer Levenshtein distance over normalized names. Lowercased
 * so "Jon Smith" vs "jon smith" is distance 0, not 2.
 */
export function levenshtein(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const m = x.length;
  const n = y.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = new Array(n + 1);
  let curr: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
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

export function selectCandidates(
  notes: PersonNote[],
  embeddings: number[][],
  options: {
    minCosine?: number;
    maxNameDistance?: number;
    maxCandidates?: number;
  } = {},
): PairCandidate[] {
  const minCosine = options.minCosine ?? MIN_COSINE;
  const maxNameDistance = options.maxNameDistance ?? MAX_NAME_DISTANCE;
  const maxCandidates = options.maxCandidates ?? MAX_CANDIDATES_PER_RUN;

  const out: PairCandidate[] = [];
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const cosine = cosineSimilarity(embeddings[i], embeddings[j]);
      if (cosine < minCosine) continue;
      const nameDistance = levenshtein(notes[i].name, notes[j].name);
      if (nameDistance > maxNameDistance) continue;
      out.push({ a: notes[i], b: notes[j], cosine, nameDistance });
    }
  }
  // Strongest matches first: higher cosine wins; ties broken by shorter
  // name distance (the closer the names, the more likely a true dupe).
  out.sort((x, y) => {
    if (y.cosine !== x.cosine) return y.cosine - x.cosine;
    return x.nameDistance - y.nameDistance;
  });
  return out.slice(0, maxCandidates);
}

// ── Prompt construction (cache-friendly static prefix) ────────────────

const STATIC_PROMPT_PREFIX = `You are the Grove dup-people-detection skill.

You receive a pair of People notes from a personal knowledge vault that look like near-duplicates of the same person. Your job: draft a single merged note (the TARGET) and a short redirect note (the REDIRECT) that the user can confirm in one click.

Rules:
- Pick the path that is most canonical (e.g. full legal name over a handle) as the TARGET. The other path becomes the REDIRECT.
- TARGET content: keep the better frontmatter, merge the bodies, dedupe duplicated facts, preserve every wikilink that appeared in either source.
- REDIRECT content: a one-line note pointing at the target via a [[Full Name]] wikilink so the duplicate file becomes an alias stub rather than dead weight.
- Do NOT invent biography that wasn't in one of the two source notes.
- If the two notes are clearly NOT the same person (different employers, conflicting bios), respond by calling propose_person_merge with redirectContent="" — the caller treats empty content as "skip this pair".

Respond by calling the \`propose_person_merge\` tool with the unified note + the redirect.`;

function buildInputBlock(pair: PairCandidate): string {
  const lines: string[] = [];
  lines.push(`Pair similarity: cosine=${pair.cosine.toFixed(4)}, name_distance=${pair.nameDistance}`);
  lines.push("");
  lines.push(`# Note A — path: ${pair.a.path}`);
  lines.push(pair.a.content);
  lines.push("");
  lines.push(`# Note B — path: ${pair.b.path}`);
  lines.push(pair.b.content);
  return lines.join("\n");
}

const MERGE_TOOL: Anthropic.Tool = {
  name: "propose_person_merge",
  description:
    "Propose a single merge of two People notes into one unified target plus a redirect stub.",
  input_schema: {
    type: "object",
    properties: {
      targetPath: {
        type: "string",
        description: "Vault-relative path of the surviving (merged) note.",
      },
      redirectPath: {
        type: "string",
        description: "Vault-relative path of the duplicate note that becomes a redirect.",
      },
      targetContent: {
        type: "string",
        description: "Full merged note body for the target path, including frontmatter.",
      },
      redirectContent: {
        type: "string",
        description:
          "Short body for the redirect path — typically a [[Target Name]] wikilink. Empty string means 'these are not the same person; skip'.",
      },
      rationale: {
        type: "string",
        description: "One-sentence justification for the merge.",
      },
    },
    required: [
      "targetPath",
      "redirectPath",
      "targetContent",
      "redirectContent",
      "rationale",
    ],
  },
};

function buildRequest(
  pair: PairCandidate,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    tools: [{ ...MERGE_TOOL, cache_control: { type: "ephemeral" } }],
    tool_choice: { type: "tool", name: MERGE_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: STATIC_PROMPT_PREFIX,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: buildInputBlock(pair) },
        ],
      },
    ],
  };
}

function parseProposedMerge(response: Anthropic.Message): ProposedMerge | null {
  const toolUse = response.content.find(
    (block): block is Extract<typeof block, { type: "tool_use" }> =>
      block.type === "tool_use" && block.name === MERGE_TOOL.name,
  );
  if (!toolUse) return null;
  const input = (toolUse.input ?? {}) as Record<string, unknown>;
  if (
    typeof input.targetPath !== "string" ||
    typeof input.redirectPath !== "string" ||
    typeof input.targetContent !== "string" ||
    typeof input.redirectContent !== "string" ||
    typeof input.rationale !== "string"
  ) {
    return null;
  }
  return {
    targetPath: input.targetPath,
    redirectPath: input.redirectPath,
    targetContent: input.targetContent,
    redirectContent: input.redirectContent,
    rationale: input.rationale,
  };
}

// ── Cost estimate (skill-specific shape) ──────────────────────────────

function estimateCost(candidateCount: number): number {
  const inputTokens =
    TOKENS_PROMPT_OVERHEAD +
    candidateCount * 2 * TOKENS_PER_PERSON_NOTE;
  const outputTokens = candidateCount * TOKENS_PER_MERGE_OUTPUT;
  return inputTokens + outputTokens;
}

// ── Child task insertion ──────────────────────────────────────────────

interface MergeArtifact {
  pair: PairCandidate;
  merge: ProposedMerge;
}

function insertChildTask(
  vault: VaultContext,
  artifact: MergeArtifact,
  provenance: GroveProvenance,
): string {
  const db = getVaultDb(vault.vaultId);
  const id = `task_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const { pair, merge } = artifact;

  const title = `Merge ${pair.a.name} ↔ ${pair.b.name}`;
  const body =
    `These two People notes look like the same person ` +
    `(cosine ${pair.cosine.toFixed(3)}, name distance ${pair.nameDistance}). ` +
    `Confirm the merge or dismiss. ${merge.rationale}`;

  const taskArtifact: TaskResult["artifact"] = {
    type: "note-change",
    notePath: merge.targetPath,
  };
  const noteChange = {
    target: { path: merge.targetPath, content: merge.targetContent },
    redirect: { path: merge.redirectPath, content: merge.redirectContent },
    sourcePaths: [pair.a.path, pair.b.path],
    similarity: {
      cosine: pair.cosine,
      nameDistance: pair.nameDistance,
    },
    rationale: merge.rationale,
  };

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (id, skill_slug, state, title, body, source_note_path)
       VALUES (?, ?, 'review', ?, ?, ?)`,
    ).run(id, SKILL_SLUG, title, body, merge.targetPath);
    db.prepare(
      `INSERT INTO task_results (task_id, artifact_json, note_change_json, provenance_json)
       VALUES (?, ?, ?, ?)`,
    ).run(
      id,
      JSON.stringify(taskArtifact),
      JSON.stringify(noteChange),
      JSON.stringify(provenance),
    );
  });
  tx();
  return id;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Run the dup-people-detection skill once. Returns the SUMMARY artifact
 * for the originating tick task; per-candidate merge proposals are
 * inserted into the per-vault state.db as child tasks with
 * `state='review'`.
 *
 * Hard-fails on cost ceiling exceeded — surface artifact, no API calls.
 */
export async function runDupPeopleDetection(
  vault: VaultContext,
  options: DupPeopleDetectionOptions = {},
): Promise<TaskResult> {
  const tokenCeiling = options.tokenCeiling ?? DEFAULT_TOKEN_CEILING;

  const notes = readPeopleNotes(vault.vaultPath);
  if (notes.length < 2) {
    return {
      artifact: {
        type: "surface",
        surfaceText:
          `dup-people-detection found ${notes.length} People note` +
          `${notes.length === 1 ? "" : "s"} — need at least 2 to look for ` +
          `duplicates. No action taken.`,
      },
      provenance: {
        voice: "perishable",
        by: "system",
        writtenAt: new Date().toISOString(),
        reason: "insufficient_people_notes",
      },
    };
  }

  // The ceiling is the worst case (full top-K candidate fan-out). We
  // gate BEFORE embedding so a vault with thousands of People notes
  // doesn't burn Voyage spend just to discover it can't afford the
  // LLM step. The embedding cost is folded into the prompt overhead
  // bucket.
  const worstCaseEstimate = estimateCost(MAX_CANDIDATES_PER_RUN);
  if (exceededCeiling(worstCaseEstimate, tokenCeiling)) {
    return {
      artifact: {
        type: "surface",
        surfaceText:
          `dup-people-detection skipped this tick — estimated cost ` +
          `(${worstCaseEstimate} tokens) exceeds the ceiling (${tokenCeiling}). ` +
          `${notes.length} People notes would have been scanned. No API calls ` +
          `were made. Raise the ceiling or narrow the candidate set to retry.`,
      },
      provenance: {
        voice: "perishable",
        by: "system",
        writtenAt: new Date().toISOString(),
        reason: "cost_ceiling_exceeded",
      },
    };
  }

  let embeddings: number[][];
  try {
    embeddings = await getEmbedder()(notes.map((n) => n.embedText));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      artifact: {
        type: "surface",
        surfaceText: `dup-people-detection failed to embed People notes: ${message}`,
      },
      provenance: {
        voice: "perishable",
        by: "system",
        writtenAt: new Date().toISOString(),
        reason: "embedding_error",
      },
    };
  }

  if (embeddings.length !== notes.length) {
    return {
      artifact: {
        type: "surface",
        surfaceText:
          `dup-people-detection embedder returned ${embeddings.length} vectors ` +
          `for ${notes.length} notes — refusing to pair on a partial result.`,
      },
      provenance: {
        voice: "perishable",
        by: "system",
        writtenAt: new Date().toISOString(),
        reason: "embedding_count_mismatch",
      },
    };
  }

  const candidates = selectCandidates(notes, embeddings);
  if (candidates.length === 0) {
    return {
      artifact: {
        type: "surface",
        surfaceText:
          `dup-people-detection scanned ${notes.length} People notes and found ` +
          `no near-duplicate pairs (cosine ≥ ${MIN_COSINE}, name distance ≤ ` +
          `${MAX_NAME_DISTANCE}). Nothing to review this tick.`,
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
  for (const pair of candidates) {
    let response: Anthropic.Message;
    try {
      response = await getClient().messages.create(buildRequest(pair));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // One pair's LLM failure shouldn't poison the others — record the
      // skip in the summary and keep going.
      console.error(
        `[dup-people-detection] LLM failed for ${pair.a.path} ↔ ${pair.b.path}: ${message}`,
      );
      continue;
    }

    const usage = (response.usage ?? {}) as {
      input_tokens?: number;
      output_tokens?: number;
    };
    totalTokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);

    const merge = parseProposedMerge(response);
    if (!merge) continue;
    // Model explicitly declined the pair — its escape hatch.
    if (merge.redirectContent.trim() === "") continue;

    const childProvenance: GroveProvenance = {
      voice: "perishable",
      by: MODEL,
      writtenAt: new Date().toISOString(),
      reason: "dup-people-detection merge proposal",
      basis: [pair.a.path, pair.b.path],
    };
    childIds.push(insertChildTask(vault, { pair, merge }, childProvenance));
  }

  if (totalTokens > 0) recordRunCost(SKILL_SLUG, totalTokens);

  const summarySurface =
    childIds.length === 0
      ? `dup-people-detection considered ${candidates.length} candidate pair` +
        `${candidates.length === 1 ? "" : "s"} but produced no merge proposals ` +
        `(model declined every pair).`
      : `Generated ${childIds.length} merge proposal` +
        `${childIds.length === 1 ? "" : "s"} from ${candidates.length} candidate ` +
        `pair${candidates.length === 1 ? "" : "s"} across ${notes.length} People ` +
        `notes. Disposition them from the dashboard's review pane.`;

  return {
    artifact: { type: "surface", surfaceText: summarySurface },
    provenance: {
      voice: "perishable",
      by: MODEL,
      writtenAt: new Date().toISOString(),
      reason: "dup-people-detection summary",
    },
  };
}

// ── SkillExecutor adapter (worker contract) ───────────────────────────

function readCeilingFromEnv(): number {
  const raw = process.env.GROVE_DUP_PEOPLE_TOKEN_CEILING;
  if (!raw) return DEFAULT_TOKEN_CEILING;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOKEN_CEILING;
}

/**
 * Worker-side entry point. The v2-task-run worker loop loads this symbol
 * via `loadSkillModule('dup-people-detection')` and invokes it on the
 * originating tick task. Returns an `ExecutorResult` so the worker
 * writes the summary to `task_results` and transitions the originating
 * task to `review` for the user to acknowledge.
 */
export async function run(
  vault: VaultContext,
  _task: TaskRow,
): Promise<ExecutorResult> {
  const result = await runDupPeopleDetection(vault, {
    tokenCeiling: readCeilingFromEnv(),
  });
  return {
    artifact: result.artifact,
    provenance: result.provenance,
    finalState: "review",
  };
}

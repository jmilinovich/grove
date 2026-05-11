/**
 * Concept extraction via Claude API.
 *
 * For each changed note, calls Claude (haiku for cost efficiency) with:
 * - The note's full content
 * - The vault's entity vocabulary (existing notes with aliases)
 * - A structured output schema
 *
 * Returns extracted entities, suggested wikilinks, and new concept notes to create.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { getCachedExtraction, putCachedExtraction } from "./db.js";
import { listNotes } from "./vault-ops.js";
import {
  entityFolders,
  entityPath,
  getDefaultConfig,
  loadVaultConfig,
  type VaultConfig,
} from "./vault-config.js";

/**
 * Cache-key version for the per-(vault, path, content) extraction cache.
 *
 * Bumped manually in any commit that changes the cache's behavioral
 * surface — i.e. anything whose change would make a previously-cached
 * `ExtractionResult` wrong for the same input bytes:
 *   - `EXTRACTION_MODEL` (different model id)
 *   - `EXTRACT_TOOL` (input/output schema)
 *   - `buildPrompt` static prefix (instructions, entity folder hints)
 *   - `ExtractionResult` shape
 *
 * Old rows persist in the table but stop matching, and the worker
 * transparently treats them as misses on the next call. Periodic vacuum
 * cleans them up. There's a TODO to wire a `scripts/check-cache-version.ts`
 * lint into CI; for now the discipline is purely social.
 */
export const DISCOVERY_CACHE_VERSION = 1;

// ── Types ────────────────────────────────────────────────────────────

export interface ExtractedEntity {
  name: string;
  type: "person" | "concept" | "project" | "company";
  confidence: number;
  existing_path?: string;
}

export interface SuggestedLink {
  from_text: string;
  to_path: string;
}

export interface NewNote {
  path: string;
  type: string;
  tags: string[];
  content: string;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  suggested_links: SuggestedLink[];
  new_notes: NewNote[];
}

// ── Entity vocabulary ────────────────────────────────────────────────

export interface VocabEntry {
  path: string;
  name: string;
  type: string | null;
  aliases: string[];
}

/**
 * Build a lookup of existing vault entities (name/alias → path).
 *
 * Scans every folder declared in `config.structure.entities` (the "default"
 * fallback is excluded — it's where unmatched entities LAND, not where we
 * expect to FIND them). If no config is passed, loads the vault's config.
 */
export function buildVocabulary(
  vaultPath: string,
  config?: VaultConfig,
): VocabEntry[] {
  const cfg = config ?? loadVaultConfig(vaultPath);
  const folders = entityFolders(cfg);
  if (folders.length === 0) return [];

  const all = listNotes(vaultPath, "*", { includeAliases: true });
  return all
    .filter((n) => folders.some((f) => n.path.startsWith(f)))
    .map((n) => ({
      path: n.path,
      name: n.name,
      type: n.type,
      aliases: n.aliases ?? [],
    }));
}

// ── Vocab cache (P7-COST-7) ──────────────────────────────────────────
//
// Discovery extraction caches the static prefix (vocab dump + instructions)
// via Anthropic's ephemeral `cache_control`. Prefix-byte-equality is the
// cache key — and `wireLinks()` writes new concept notes to the vault
// between calls, so rebuilding vocab from disk on every `extractFromNote`
// invocation drifts the prefix by one entry per call and bypasses the
// cache entirely (`cache_read_input_tokens=0` in admin telemetry across
// all of May 2026). Freezing vocab for a short TTL stabilizes the prefix
// across the drain window, restoring the ~10× cache-read cost ratio.

function readVocabTtlMs(): number {
  // Read each call so tests / runtime tuning can change the env var
  // without restarting the worker. parseInt of an invalid string returns
  // NaN; fall back to the default in that case so a typo doesn't disable
  // caching entirely.
  const raw = process.env.GROVE_DISCOVERY_VOCAB_TTL_MS;
  if (!raw) return 60000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 60000;
}

let cachedVocab: VocabEntry[] | null = null;
let cachedVocabAt = 0;
let cachedVocabPath = "";
let vocabTtlLogged = false;

// Indirection so tests can spy on the vocab build without colliding with
// the public `buildVocabulary` export. ESM bindings prevent monkey-patching
// the exported function from outside, so the cache must go through this
// object instead of calling `buildVocabulary` directly.
export const _vocabInternals = {
  buildVocabulary,
};

function getVocab(vaultPath: string, config?: VaultConfig): VocabEntry[] {
  const ttl = readVocabTtlMs();
  if (!vocabTtlLogged) {
    console.log(`[discovery] vocab cache TTL: ${ttl}ms`);
    vocabTtlLogged = true;
  }
  const now = Date.now();
  // Invalidate when vault path changes (test harness / multi-vault) or
  // when the TTL window expires.
  if (
    cachedVocab &&
    cachedVocabPath === vaultPath &&
    now - cachedVocabAt < ttl
  ) {
    return cachedVocab;
  }
  cachedVocab = _vocabInternals.buildVocabulary(vaultPath, config);
  cachedVocabAt = now;
  cachedVocabPath = vaultPath;
  return cachedVocab;
}

/** Test-only: clear the vocab cache between tests. */
export function _resetVocabCacheForTests(): void {
  cachedVocab = null;
  cachedVocabAt = 0;
  cachedVocabPath = "";
  vocabTtlLogged = false;
}

// ── Entity matching ──────────────────────────────────────────────────

/**
 * Match an extracted entity name against existing vault notes.
 * Case-insensitive match against note name and aliases.
 * Returns the matching path or undefined.
 */
export function matchEntity(
  name: string,
  vocab: VocabEntry[],
): string | undefined {
  const lower = name.toLowerCase();
  for (const entry of vocab) {
    if (entry.name.toLowerCase() === lower) return entry.path;
    for (const alias of entry.aliases) {
      if (alias.toLowerCase() === lower) return entry.path;
    }
  }
  return undefined;
}

// ── Prompt construction ──────────────────────────────────────────────

function newNotePathExample(config: VaultConfig): string {
  const concept = entityPath(config, "concept");
  return `${concept}Name.md`;
}

function entityFolderHint(config: VaultConfig): string {
  const lines: string[] = [];
  for (const type of ["concept", "person", "project", "company"]) {
    const p = entityPath(config, type);
    lines.push(`- ${type} → ${p}Name.md`);
  }
  return lines.join("\n");
}

/**
 * Build the prompt as two separate strings: a static prefix (vocab,
 * entity folders, instructions — stable across calls within a drain)
 * and the note content (changes every call). The caller wires a cache
 * breakpoint between them so the prefix is read from cache on subsequent
 * calls within the 5-min ephemeral TTL.
 */
function buildPrompt(
  noteContent: string,
  vocab: VocabEntry[],
  config: VaultConfig,
): { staticPrefix: string; noteBlock: string } {
  const vocabSummary = vocab
    .map((v) => {
      const aliases = v.aliases.length > 0 ? ` (aliases: ${v.aliases.join(", ")})` : "";
      return `- ${v.name}${aliases} → ${v.path}`;
    })
    .join("\n");

  const staticPrefix = `You are a knowledge graph extraction engine. Given a note from an Obsidian vault, extract entities and suggest wikilinks. Call the \`extract_entities\` tool exactly once with your structured result.

## Existing vault entities
${vocabSummary || "(none)"}

## Entity folders in this vault
${entityFolderHint(config)}

## Instructions

1. Extract all notable entities (people, concepts, projects, companies) mentioned in the note.
2. For each entity, assess confidence (0.0–1.0) that it's a meaningful, linkable entity (not just a passing mention).
3. If an entity matches an existing vault note (by name or alias, case-insensitive), include the existing_path.
4. For entities with confidence > 0.8 that do NOT match any existing note, suggest creating a new concept note at the configured folder for its type (see "Entity folders" above). New-note paths follow the pattern: \`${newNotePathExample(config)}\`.
5. For each entity found in the text, suggest a wikilink: identify the exact text span (from_text) and the target path (to_path).`;

  const noteBlock = `## Note content
${noteContent}`;

  return { staticPrefix, noteBlock };
}

/**
 * Tool schema for entity extraction. Forcing the model to emit results
 * via a tool call (rather than free-form JSON in a text block) eliminates
 * the truncation/JSON-parse-failure class entirely on large notes —
 * Anthropic's tool-use path enforces the input_schema and handles long
 * structured payloads cleanly. See `extractEntities` below for the call
 * site (model = haiku-4-5; tool_choice forces this single tool).
 */
const EXTRACT_TOOL: Anthropic.Tool = {
  name: "extract_entities",
  description:
    "Return the entities, suggested wikilinks, and new concept notes extracted from the supplied note.",
  input_schema: {
    type: "object",
    properties: {
      entities: {
        type: "array",
        description: "Notable entities mentioned in the note.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: {
              type: "string",
              enum: ["person", "concept", "project", "company"],
            },
            confidence: {
              type: "number",
              description: "0.0–1.0 — how meaningful/linkable the entity is.",
            },
            existing_path: {
              type: "string",
              description:
                "Vault path to the existing note for this entity, if one matches by name or alias. Omit if none.",
            },
          },
          required: ["name", "type", "confidence"],
        },
      },
      suggested_links: {
        type: "array",
        description:
          "Wikilinks to wire into the note: from_text is the exact text span, to_path is the target note path.",
        items: {
          type: "object",
          properties: {
            from_text: { type: "string" },
            to_path: { type: "string" },
          },
          required: ["from_text", "to_path"],
        },
      },
      new_notes: {
        type: "array",
        description:
          "High-confidence entities (>0.8) that do not match any existing vault note — proposed new notes.",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            type: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            content: {
              type: "string",
              description: "Frontmatter + body for the new note.",
            },
          },
          required: ["path", "type", "tags", "content"],
        },
      },
    },
    required: ["entities", "suggested_links", "new_notes"],
  },
};

/** Rewrite a new-note path to the folder configured for its type. */
function normalizeNewNotePath(note: NewNote, config: VaultConfig): NewNote {
  const folder = entityPath(config, note.type);
  const filename = basename(note.path);
  const normalized = folder + filename;
  if (normalized === note.path) return note;
  return { ...note, path: normalized };
}

// ── Claude API extraction ────────────────────────────────────────────

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

/** Allow tests to inject a mock client. */
export function setClient(mock: Anthropic): void {
  client = mock;
}

/** Reset client (for tests). */
export function resetClient(): void {
  client = null;
}

const EXTRACTION_MODEL = "claude-haiku-4-5-20251001";

/**
 * Output token ceiling for one extraction call. Bumped from 4096 after
 * notes with ~40 entities + ~40 wikilinks chronically truncated mid-JSON
 * on the previous text-output path. Haiku 4.5 supports up to 64K output;
 * 8K is a comfortable headroom for the largest real notes without
 * overpaying on typical ones (a typical extraction is well under 1K
 * output tokens).
 */
const EXTRACTION_MAX_TOKENS = 8192;

/**
 * Re-export the extraction model id so callers (P7-COST-5 batch path)
 * can build batch payloads without duplicating the constant. Kept as a
 * named export rather than mutated state so the cache-version invariant
 * (DISCOVERY_CACHE_VERSION) is preserved.
 */
export { EXTRACTION_MODEL };

/**
 * Build a `messages.create` request body for entity extraction without
 * actually calling Anthropic. The realtime path (`extractEntities`)
 * passes the result directly to `anthropic.messages.create`; the batch
 * path (P7-COST-5) collects N of these into a single
 * `/v1/messages/batches` POST.
 *
 * Crucially this preserves cache_control markers — even though the
 * batch endpoint does not currently share cache breakpoints across
 * batched requests, keeping them in the body means a future batch-cache
 * feature lights up without a refactor, and the realtime path stays
 * byte-for-byte identical to what it sent before this refactor.
 */
export function buildMessageRequest(
  noteContent: string,
  vocab: VocabEntry[],
  config?: VaultConfig,
): Anthropic.MessageCreateParamsNonStreaming {
  const cfg = config ?? getDefaultConfig();
  const { staticPrefix, noteBlock } = buildPrompt(noteContent, vocab, cfg);
  return {
    model: EXTRACTION_MODEL,
    max_tokens: EXTRACTION_MAX_TOKENS,
    tools: [{ ...EXTRACT_TOOL, cache_control: { type: "ephemeral" } }],
    tool_choice: { type: "tool", name: EXTRACT_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: staticPrefix, cache_control: { type: "ephemeral" } },
          { type: "text", text: noteBlock },
        ],
      },
    ],
  };
}

/**
 * Parse + post-process a tool_use response into an ExtractionResult.
 * Factored out of `extractEntities` so the batch poller (P7-COST-5)
 * can reuse the exact same logic when it reads results from the
 * batch's JSONL stream — different transport, identical normalization.
 *
 * Expects an Anthropic `messages.create` (or batch result) response
 * shape: `{ content: [{type, ...}, ...], stop_reason }`.
 */
export function parseExtractionResponse(
  response: Anthropic.Message,
  vocab: VocabEntry[],
  config?: VaultConfig,
): ExtractionResult {
  const cfg = config ?? getDefaultConfig();
  const toolUse = response.content.find(
    (block): block is Extract<typeof block, { type: "tool_use" }> =>
      block.type === "tool_use" && block.name === EXTRACT_TOOL.name,
  );
  if (!toolUse) {
    throw new Error(
      `extraction failed: no ${EXTRACT_TOOL.name} tool_use block in response (stop_reason=${response.stop_reason})`,
    );
  }

  const parsed = (toolUse.input ?? {}) as Partial<ExtractionResult>;
  const entities = parsed.entities ?? [];
  const suggestedLinks = parsed.suggested_links ?? [];
  const newNotes = parsed.new_notes ?? [];

  const result: ExtractionResult = {
    entities: [],
    suggested_links: [],
    new_notes: [],
  };

  for (const entity of entities) {
    const existingPath = entity.existing_path ?? matchEntity(entity.name, vocab);
    result.entities.push({ ...entity, existing_path: existingPath });
  }

  for (const link of suggestedLinks) {
    if (link.from_text && link.to_path) {
      result.suggested_links.push(link);
    }
  }

  for (const note of newNotes) {
    const entityName = basename(note.path, ".md");
    const alreadyExists = matchEntity(entityName, vocab);
    if (!alreadyExists) {
      result.new_notes.push(normalizeNewNotePath(note, cfg));
    }
  }

  return result;
}

/**
 * Call Claude API to extract entities from note content.
 *
 * Uses the Anthropic tool-use API: the model is forced to emit a single
 * `extract_entities` tool call whose `input` matches `EXTRACT_TOOL`'s
 * input_schema. This replaces an earlier free-form JSON-in-text path
 * that produced truncated/unterminated JSON on large notes (~40+
 * entities) and burned Haiku calls on retry.
 *
 * @param noteContent  Full text of the note (including frontmatter)
 * @param vocab        Existing vault entity vocabulary
 * @param config       Vault config (optional — defaults to PARA-style config)
 * @param notePath     Optional vault-relative path for the cache_usage log line
 * @returns            Extraction result with entities, links, and new notes
 */
export async function extractEntities(
  noteContent: string,
  vocab: VocabEntry[],
  config?: VaultConfig,
  notePath?: string,
): Promise<ExtractionResult> {
  const cfg = config ?? getDefaultConfig();
  const request = buildMessageRequest(noteContent, vocab, cfg);
  const anthropic = getClient();

  // Cache breakpoints on the tool schema and the static prefix (vocab +
  // instructions). The static prefix is the bulk of input tokens — for
  // a vault with thousands of entities it dominates the prompt by 10×+.
  // Within a drain cycle, vocab is stable and successive calls hit
  // cache at 0.1× input cost. Cache busts on vocab change (new entity
  // notes created), which is intended — the next call reseeds.
  const response = await anthropic.messages.create(request);

  // Falsifier for the prompt-caching pipeline. Admin-API usage telemetry
  // aggregates by key/day, which masks per-call cache behavior; this
  // line is the only place we can confirm cache_read_input_tokens > 0
  // mid-drain without a backfill query.
  const usage = (response.usage ?? {}) as {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    input_tokens?: number;
  };
  const created = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const input = usage.input_tokens ?? 0;
  console.log(
    `[discovery] cache usage: created=${created} read=${read} input=${input} note=${notePath ?? ""}`,
  );

  return parseExtractionResponse(response, vocab, cfg);
}

// ── High-level processor ─────────────────────────────────────────────

/**
 * Extract entities from a vault note file.
 *
 * Reads the note from disk, builds vocabulary, calls Claude, and returns results.
 * Low-confidence entities (< 0.5) are logged but included in the result
 * for the caller to decide what to do with.
 *
 * **P7-COST-3 content-hash cache.** Before calling Anthropic we look up
 * `discovery_cache` keyed on (vaultId, notePath, sha256(content),
 * DISCOVERY_CACHE_VERSION). On hit, the previous extraction is returned
 * verbatim and no LLM tokens are spent. On miss we extract, then INSERT OR
 * REPLACE the row so the next identical-content call short-circuits.
 * Failures throw before the put, so the cache never stores bad results.
 *
 * `vaultId` is required for cache scoping. Cross-vault entries with the
 * same path + content cache independently — without this, a second vault
 * could read a stale extraction made under a different vault's vocabulary.
 */
export async function extractFromNote(
  vaultPath: string,
  notePath: string,
  vaultId: string,
  config?: VaultConfig,
): Promise<ExtractionResult> {
  const cfg = config ?? loadVaultConfig(vaultPath);
  const fullPath = join(vaultPath, notePath);
  const content = readFileSync(fullPath, "utf-8");

  const contentSha256 = createHash("sha256").update(content).digest("hex");
  const cached = getCachedExtraction(
    vaultId,
    notePath,
    contentSha256,
    DISCOVERY_CACHE_VERSION,
  );
  if (cached) {
    console.log(
      `[discovery] cache hit ${contentSha256.slice(0, 12)} for ${notePath} ` +
        `(cached_at=${cached.cached_at})`,
    );
    return JSON.parse(cached.result_json) as ExtractionResult;
  }

  // Vocab is cached for VOCAB_TTL_MS (P7-COST-7) so the static prefix sent
  // to Anthropic stays byte-identical across calls and the cache_control
  // breakpoint actually engages. Content-hash cache above (P7-COST-3) is
  // the first short-circuit; this is the second.
  const vocab = getVocab(vaultPath, cfg);
  const result = await extractEntities(content, vocab, cfg, notePath);

  // Only cache on success — failed extractions throw above this point,
  // so a half-baked result never lands in the cache.
  putCachedExtraction(
    vaultId,
    notePath,
    contentSha256,
    DISCOVERY_CACHE_VERSION,
    EXTRACTION_MODEL,
    JSON.stringify(result),
  );

  // Log low-confidence entities
  for (const entity of result.entities) {
    if (entity.confidence < 0.5) {
      console.log(
        `[extract] low confidence (${entity.confidence}): ${entity.name} in ${notePath}`,
      );
    }
  }

  return result;
}

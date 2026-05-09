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
import { listNotes } from "./vault-ops.js";
import {
  entityFolders,
  entityPath,
  getDefaultConfig,
  loadVaultConfig,
  type VaultConfig,
} from "./vault-config.js";

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

function buildPrompt(
  noteContent: string,
  vocab: VocabEntry[],
  config: VaultConfig,
): string {
  const vocabSummary = vocab
    .map((v) => {
      const aliases = v.aliases.length > 0 ? ` (aliases: ${v.aliases.join(", ")})` : "";
      return `- ${v.name}${aliases} → ${v.path}`;
    })
    .join("\n");

  return `You are a knowledge graph extraction engine. Given a note from an Obsidian vault, extract entities and suggest wikilinks. Call the \`extract_entities\` tool exactly once with your structured result.

## Existing vault entities
${vocabSummary || "(none)"}

## Entity folders in this vault
${entityFolderHint(config)}

## Instructions

1. Extract all notable entities (people, concepts, projects, companies) mentioned in the note.
2. For each entity, assess confidence (0.0–1.0) that it's a meaningful, linkable entity (not just a passing mention).
3. If an entity matches an existing vault note (by name or alias, case-insensitive), include the existing_path.
4. For entities with confidence > 0.8 that do NOT match any existing note, suggest creating a new concept note at the configured folder for its type (see "Entity folders" above). New-note paths follow the pattern: \`${newNotePathExample(config)}\`.
5. For each entity found in the text, suggest a wikilink: identify the exact text span (from_text) and the target path (to_path).

## Note content
${noteContent}`;
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
 * @returns            Extraction result with entities, links, and new notes
 */
export async function extractEntities(
  noteContent: string,
  vocab: VocabEntry[],
  config?: VaultConfig,
): Promise<ExtractionResult> {
  const cfg = config ?? getDefaultConfig();
  const prompt = buildPrompt(noteContent, vocab, cfg);
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: EXTRACTION_MAX_TOKENS,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: EXTRACT_TOOL.name },
    messages: [{ role: "user", content: prompt }],
  });

  // The forced tool_choice guarantees a tool_use block in the response
  // (modulo refusal/overload, which throw earlier). Walk the content
  // blocks to find it — its index is not always 0 (the model may emit
  // a leading text block).
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
  // Schema marks all three arrays required, but defensively normalize —
  // a malformed tool call shouldn't crash the worker.
  const entities = parsed.entities ?? [];
  const suggestedLinks = parsed.suggested_links ?? [];
  const newNotes = parsed.new_notes ?? [];

  // Post-process: resolve entities against vocab and filter
  const result: ExtractionResult = {
    entities: [],
    suggested_links: [],
    new_notes: [],
  };

  for (const entity of entities) {
    const existingPath = entity.existing_path ?? matchEntity(entity.name, vocab);
    result.entities.push({
      ...entity,
      existing_path: existingPath,
    });
  }

  // Only keep suggested links where we have a valid target
  for (const link of suggestedLinks) {
    if (link.from_text && link.to_path) {
      result.suggested_links.push(link);
    }
  }

  // Only create new notes for high-confidence entities that don't match
  // existing notes. Rewrite paths to the configured folder for each type —
  // Claude occasionally echoes stale defaults from its training data.
  for (const note of newNotes) {
    const entityName = basename(note.path, ".md");
    const alreadyExists = matchEntity(entityName, vocab);
    if (!alreadyExists) {
      result.new_notes.push(normalizeNewNotePath(note, cfg));
    }
  }

  return result;
}

// ── High-level processor ─────────────────────────────────────────────

/**
 * Extract entities from a vault note file.
 *
 * Reads the note from disk, builds vocabulary, calls Claude, and returns results.
 * Low-confidence entities (< 0.5) are logged but included in the result
 * for the caller to decide what to do with.
 */
export async function extractFromNote(
  vaultPath: string,
  notePath: string,
  config?: VaultConfig,
): Promise<ExtractionResult> {
  const cfg = config ?? loadVaultConfig(vaultPath);
  const fullPath = join(vaultPath, notePath);
  const content = readFileSync(fullPath, "utf-8");
  const vocab = buildVocabulary(vaultPath, cfg);
  const result = await extractEntities(content, vocab, cfg);

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

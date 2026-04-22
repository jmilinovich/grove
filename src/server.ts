#!/usr/bin/env tsx
/**
 * Grove MCP Server — registers 6 tools for the knowledge API.
 *
 * Tools: query, get, multi_get, write_note, list_notes, vault_status
 * Proxy forwards authenticated MCP requests here.
 *
 * Usage:
 *   GROVE_VAULT=/path/to/vault GROVE_SERVER_PORT=8190 npx tsx src/server.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { hybridSearch, formatResults, bm25Search } from "./hybrid-search.js";
import { VaultLockedError } from "./index-crypto.js";

/** Encode a vault path as a valid URL (encode each segment, preserve slashes) */
function noteUrl(vaultPath: string): string {
  const stripped = vaultPath.replace(/\.md$/, "");
  const encoded = stripped.split("/").map(encodeURIComponent).join("/");
  return `https://grove.md/${encoded}`;
}

import { gitLog, startupRecovery, listNotes } from "./vault-ops.js";
import { parseNote, contentHash, inferTags } from "./notes-validate.js";
import {
  handleWriteNote,
  handleDeleteNote,
  handleMoveNote,
  handleWriteBatch,
  handleStatusPerf,
  flushWriteQueue,
  type BatchOperation,
} from "./rest.js";
import { analyzeGraph, computeDigest } from "./vault-graph.js";
import { getStats, startStatsTimer } from "./vault-stats.js";
import { RateLimiter, IdempotencyCache } from "./rate-limit.js";
import { log as structuredLog, auditRead } from "./logger.js";
import { installCrashHandlers } from "./crash-handlers.js";
import { filterByTrail, logTrailAccess, type TrailConfig, type NoteMetadata } from "./trails.js";
import {
  loadVaultConfig,
  entityPath,
  entityFolders,
  type VaultConfig,
} from "./vault-config.js";
import {
  runMigration,
  enqueueDiscovery,
  discoveryQueueDepth,
  getRecentExtractions,
  getNewConceptsCreated,
  getSurprisingConnections,
  getLastProcessedAt,
  getSourceHash,
} from "./db.js";

installCrashHandlers("grove-server");

// ── Path traversal guard ─────────────────────────────────────────
// Resolves a relative path against the vault and rejects any attempt
// to escape outside the vault via ".." or symlinks.
function sanitizePath(vaultRoot: string, filePath: string): string | null {
  const root = resolve(vaultRoot);
  const normalized = resolve(root, filePath);
  if (!normalized.startsWith(root + "/") && normalized !== root) return null;
  if (filePath.includes("..")) return null;
  try {
    const stat = lstatSync(normalized);
    if (stat.isSymbolicLink()) return null;
  } catch {
    // File doesn't exist yet — that's fine for reads (will get "not found")
  }
  return normalized;
}

const VAULT_PATH = process.env.GROVE_VAULT ?? join(homedir(), "life");
const PORT = Number(process.env.GROVE_SERVER_PORT ?? 8190);
const VAULT_CONFIG: VaultConfig = loadVaultConfig(VAULT_PATH);

const rateLimiter = new RateLimiter({ reads: 120, writes: 20, windowMs: 60_000 });
const idempotencyCache = new IdempotencyCache(1000, 3_600_000);

// ── write_note dispatch (tested in server.test.ts) ─────────────────
// Routes the action parameter to the right rest.ts handler. Exported
// separately so tests can exercise the routing without spinning up
// an MCP server + transport.

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface WriteNoteInput {
  action?: "write" | "delete" | "hard_delete" | "move";
  path?: string;
  frontmatter?: string;
  content?: string;
  if_hash?: string;
  move_to?: string;
  /**
   * Batch mode: an array of write ops executed in one mutex acquisition.
   * When present, this shape takes precedence over the single-op fields.
   * Each entry passes its own path, frontmatter, content, and optionally
   * if_hash or if_hash_from_op (reference an earlier op's source_hash).
   */
  operations?: Array<{
    path: string;
    /** YAML frontmatter as a JSON string (matching the single-op shape). */
    frontmatter: string;
    content: string;
    if_hash?: string;
    if_hash_from_op?: number;
  }>;
  /**
   * With operations[] present: atomic=true rolls back all ops if any fail
   * (git reset to the pre-batch SHA + provenance restored). Default false.
   */
  atomic?: boolean;
}

export interface WriteNoteDeps {
  handleWriteNote: typeof handleWriteNote;
  handleDeleteNote: typeof handleDeleteNote;
  handleMoveNote: typeof handleMoveNote;
  handleWriteBatch: typeof handleWriteBatch;
  trail?: TrailConfig | null;
}

export async function dispatchWriteNote(input: WriteNoteInput, deps: WriteNoteDeps): Promise<ToolResult> {
  const act = input.action ?? "write";
  const trail = deps.trail ?? null;

  // Batch path: operations[] present takes precedence over single-op fields.
  if (input.operations && input.operations.length > 0) {
    const parsedOps: BatchOperation[] = [];
    for (const [i, op] of input.operations.entries()) {
      if (!op || typeof op.frontmatter !== "string" || typeof op.content !== "string") {
        return {
          content: [{ type: "text", text: `op ${i}: frontmatter and content are required (frontmatter as JSON string)` }],
          isError: true,
        };
      }
      let fm: Record<string, unknown>;
      try {
        fm = JSON.parse(op.frontmatter);
      } catch {
        return { content: [{ type: "text", text: `op ${i}: invalid frontmatter JSON` }], isError: true };
      }
      parsedOps.push({
        path: op.path,
        frontmatter: fm,
        content: op.content,
        if_hash: op.if_hash,
        if_hash_from_op: op.if_hash_from_op,
      });
    }
    try {
      const result = await deps.handleWriteBatch(parsedOps, { atomic: input.atomic, trail });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
  }

  // Single-op path: `path` is required once operations[] is absent.
  if (!input.path) {
    return { content: [{ type: "text", text: "path is required (or use operations[] for batch)" }], isError: true };
  }
  const notePath = input.path;

  if (act === "delete" || act === "hard_delete") {
    try {
      const result = await deps.handleDeleteNote(notePath, {
        hard: act === "hard_delete",
        ifHash: input.if_hash,
        trail,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
  }

  if (act === "move") {
    if (!input.move_to) {
      return { content: [{ type: "text", text: "move_to is required when action is 'move'" }], isError: true };
    }
    try {
      const result = await deps.handleMoveNote(notePath, input.move_to, {
        ifHash: input.if_hash,
        trail,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
  }

  if (input.frontmatter === undefined || input.content === undefined) {
    return { content: [{ type: "text", text: "frontmatter and content are required for write" }], isError: true };
  }
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = JSON.parse(input.frontmatter);
  } catch {
    return { content: [{ type: "text", text: "Invalid frontmatter JSON" }], isError: true };
  }

  try {
    const result = await deps.handleWriteNote(notePath, frontmatter, input.content, {
      ifHash: input.if_hash,
      trail,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: err.message }], isError: true };
  }
}

// ── Server instructions (what Claude.ai sees) ─────────────────────

function formatVaultStructure(config: VaultConfig): string {
  const lines: string[] = [];
  const typePaths = config.structure.type_paths;
  const entities = config.structure.entities;

  // Type → path mapping (from type_paths, or fallback to entities)
  const pairs = new Map<string, string>();
  for (const [type, path] of Object.entries(typePaths)) pairs.set(type, path);
  for (const [type, path] of Object.entries(entities)) {
    if (type === "default") continue;
    if (!pairs.has(type)) pairs.set(type, path);
  }

  const width = Math.max(0, ...[...pairs.values()].map((p) => p.length));
  for (const [type, path] of pairs)
    lines.push(`  ${path.padEnd(width)}  (type: ${type})`);

  const defaultPath = entities.default;
  if (defaultPath && ![...pairs.values()].includes(defaultPath))
    lines.push(`  ${defaultPath.padEnd(width)}  (unsorted captures)`);

  return lines.join("\n");
}

function buildInstructions(config: VaultConfig): string {
  return `Grove is your knowledge API over an Obsidian vault.

Vault structure:
${formatVaultStructure(config)}

Linking: Use [[wikilinks]] aggressively. Pipe for readability: [[Full Name|display text]].
Red links (to notes that don't exist yet) are fine — they're a backlog.

Searching: Use query with lex (keyword) and vec (semantic) sub-queries. Provide intent for better snippets.

Writing: Use write_note with proper frontmatter (type + tags required). Use if_hash for safe updates to existing notes.

URLs: Every tool response includes a url field. ALWAYS show it to the user as a clickable link — especially after writes. This is the primary way the user accesses their notes.`;
}

const INSTRUCTIONS = buildInstructions(VAULT_CONFIG);

function formatWriteStructure(config: VaultConfig): string {
  const lines: string[] = [];
  const entities = config.structure.entities;
  const journal = config.structure.journal_path;
  const picks: Array<[string, string]> = [];
  for (const t of ["concept", "person", "recipe", "project"]) {
    if (entities[t]) picks.push([t, `${entities[t]}Name.md`]);
  }
  for (let i = 0; i < picks.length; i += 2) {
    const a = picks[i][1];
    const b = picks[i + 1]?.[1] ?? "";
    lines.push(b ? `  ${a.padEnd(44)}${b}` : `  ${a}`);
  }
  if (journal) lines.push(`  ${journal}YYYY/YYYY-MM-DD.md`);
  lines.push(`  ${entities.default}Name.md`);
  return lines.join("\n");
}

// ── Create MCP server with all 6 tools ────────────────────────────

function createGroveServer(): McpServer {
  // Trail capabilities in initialize handshake — serverInfo includes trail context
  const trailInitialize = activeTrail
    ? `\n\nThis connection is scoped to trail "${activeTrail.name}" (${activeTrail.id}). Only notes matching the trail's topic boundaries are visible.`
    : "";
  const serverInfo = activeTrail ? { name: "grove", version: "1.0.0", trail: { id: activeTrail.id, name: activeTrail.name } } : { name: "grove", version: "1.0.0" };
  const server = new McpServer(
    serverInfo as { name: string; version: string },
    { instructions: INSTRUCTIONS + trailInitialize },
  );

  // ── Tool 1: query ───────────────────────────────────────────────
  server.registerTool(
    "query",
    {
      title: "Search notes",
      description: `Search notes by keyword or meaning. Returns ranked results with snippets.

Sub-query types:
  lex — BM25 keyword search (exact terms, fast)
  vec — semantic vector search (meaning-based)

Always provide intent to disambiguate. Combine lex + vec for best results.
Example: searches=[{type:'lex', query:'salary'}, {type:'vec', query:'how much do I make'}], intent='compensation details'`,
      inputSchema: {
        searches: z.array(z.object({
          type: z.enum(["lex", "vec", "hyde"]),
          query: z.string(),
        })).describe("Search sub-queries"),
        intent: z.string().optional().describe("What you're looking for — improves snippet selection"),
        limit: z.number().optional().default(10).describe("Max results"),
      },
    },
    async ({ searches, limit }) => {
      const queryText = searches.map((s) => s.query).join(" ");
      // Fetch more results if trail filtering is active (pre-filter reduction)
      const fetchLimit = activeTrail ? (limit ?? 10) * 3 : (limit ?? 10);
      let results;
      try {
        results = await hybridSearch(queryText, fetchLimit);
      } catch (err) {
        if (err instanceof VaultLockedError) {
          return { content: [{ type: "text" as const, text: err.message }], isError: true };
        }
        throw err;
      }
      const totalFound = results.length;

      // Resolve QMD lowercase-kebab paths to real filesystem paths.
      // QMD index stores e.g. "resources/concepts/meditation-mindfulness.md"
      // but the filesystem has "Resources/Concepts/Meditation & Mindfulness.md".
      const allNotes = listNotes(VAULT_PATH, "*");
      const resolveRealPath = (vaultPath: string, title: string): string => {
        const vp = vaultPath.toLowerCase();
        const note = allNotes.find((n: { path: string; name: string }) => n.path.toLowerCase() === vp || n.name === title);
        return note?.path ?? vaultPath;
      };

      // Trail prefilter
      let filtered = results;
      if (activeTrail) {
        filtered = results.filter((r) => {
          const vp = r.vault_path.toLowerCase();
          const note = allNotes.find((n: { path: string; name: string }) => n.path.toLowerCase() === vp || n.name === r.title);
          if (!note) return false;
          const absPath = join(VAULT_PATH, note.path);
          try {
            const raw = readFileSync(absPath, "utf-8");
            const { frontmatter } = parseNote(raw);
            const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags as string[] :
              typeof frontmatter.tags === "string" ? [frontmatter.tags] : [];
            const meta: NoteMetadata = { path: note.path, type: frontmatter.type as string, tags, private: frontmatter.private === true };
            return filterByTrail(activeTrail!, meta);
          } catch {
            return filterByTrail(activeTrail!, { path: note.path });
          }
        }).slice(0, limit ?? 10);
        logTrailAccess("query", activeTrail.id, activeTrail.name, "query", totalFound, filtered.length);
      }

      // Enrich image notes with thumbnail_url from frontmatter (P14-3)
      for (const r of filtered) {
        const vp = r.vault_path.toLowerCase();
        const note = allNotes.find((n: { path: string; name: string }) => n.path.toLowerCase() === vp || n.name === r.title);
        if (!note) continue;
        try {
          const raw = readFileSync(join(VAULT_PATH, note.path), "utf-8");
          const { frontmatter } = parseNote(raw);
          if (frontmatter.type === "image" && typeof frontmatter.thumbnail_url === "string") {
            r.thumbnail_url = frontmatter.thumbnail_url;
          }
        } catch {
          // note unreadable — skip enrichment
        }
      }

      const formatted = formatResults(filtered, resolveRealPath);
      const filteredCount = activeTrail ? `\n\n[filtered_count: ${filtered.length}/${totalFound}]` : "";
      return { content: [{ type: "text" as const, text: (formatted || "No results found.") + filteredCount }] };
    },
  );

  // ── Tool 2: get ─────────────────────────────────────────────────
  server.registerTool(
    "get",
    {
      title: "Read a note",
      description: `Read a note by path. Returns frontmatter + content + content_hash.

Paths are relative to vault root: e.g. "${entityPath(VAULT_CONFIG, "concept")}Taste Graph.md"
If not found, tries fuzzy matching by title via search.
Use the content_hash as if_hash when updating the note.`,
      inputSchema: {
        file: z.string().describe("File path relative to vault root, or note title"),
      },
    },
    async ({ file }) => {
      // Helper: read and return a note given absolute + relative paths
      const readNote = (abs: string, rel: string, resolvedFrom?: string) => {
        const raw = readFileSync(abs, "utf-8");
        const { frontmatter, content } = parseNote(raw);

        // Trail filter: if note not visible under trail, return 404 (not 403 — don't leak existence)
        if (activeTrail) {
          const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags as string[] :
            typeof frontmatter.tags === "string" ? [frontmatter.tags] : [];
          const meta: NoteMetadata = { path: rel, type: frontmatter.type as string, tags, private: frontmatter.private === true };
          if (!filterByTrail(activeTrail, meta)) {
            return { content: [{ type: "text" as const, text: `Note not found: ${file}` }] };
          }
        }

        const hash = contentHash(raw);
        const url = noteUrl(rel);
        const result: Record<string, unknown> = { path: rel, url, frontmatter, content, content_hash: hash };
        if (resolvedFrom) result.resolved_from = resolvedFrom;
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      };

      // 1. Normalize the input path — strip common prefixes
      let filePath = file.replace(/^(life\/|qmd:\/\/life\/)/, "");
      if (!filePath.endsWith(".md")) filePath += ".md";

      // 2. Try direct read at the given path (with traversal guard)
      const abs = sanitizePath(VAULT_PATH, filePath);
      if (!abs) return { content: [{ type: "text" as const, text: `Path rejected: traversal outside vault not allowed` }] };
      if (existsSync(abs)) return readNote(abs, filePath);

      // 3. Extract the basename for searching (e.g., "Taste Graph" from "Resources/Concepts/Taste Graph.md")
      const searchTerm = filePath.replace(/\.md$/, "").split("/").pop() ?? file;

      // 4. For date-like basenames (YYYY-MM-DD), try Journal paths directly
      const dateMatch = searchTerm.match(/^(\d{4})-\d{2}-\d{2}$/);
      if (dateMatch) {
        const year = dateMatch[1];
        // Try current year folder and the year from the date
        for (const y of [year, String(new Date().getFullYear())]) {
          const journalPath = `Journal/${y}/${searchTerm}.md`;
          const journalAbs = join(VAULT_PATH, journalPath);
          if (existsSync(journalAbs)) return readNote(journalAbs, journalPath, file);
        }
      }

      // 5. Case-insensitive basename search across the entire vault
      const searchLower = searchTerm.toLowerCase();
      const allNotes = listNotes(VAULT_PATH, "*");
      const nameMatch = allNotes.find((n) => n.name.toLowerCase() === searchLower);
      if (nameMatch) {
        const matchAbs = join(VAULT_PATH, nameMatch.path);
        if (existsSync(matchAbs)) return readNote(matchAbs, nameMatch.path, file);
      }

      // 6. Also check aliases
      const aliasNotes = listNotes(VAULT_PATH, "*", { includeAliases: true });
      const aliasMatch = aliasNotes.find(
        (n) => n.aliases?.some((a) => a.toLowerCase() === searchLower),
      );
      if (aliasMatch) {
        const matchAbs = join(VAULT_PATH, aliasMatch.path);
        if (existsSync(matchAbs)) return readNote(matchAbs, aliasMatch.path, file);
      }

      // 7. Fall back to BM25 search for partial/fuzzy matches
      try {
        const results = await bm25Search(searchTerm, 3);
        if (results.length > 0) {
          // The vault_path from QMD may be lowercased; find the real path via listNotes
          const resolvedLower = results[0].vault_path.toLowerCase();
          const realNote = allNotes.find((n) => n.path.toLowerCase() === resolvedLower);
          const realPath = realNote?.path ?? results[0].vault_path;
          const resolvedAbs = join(VAULT_PATH, realPath);
          if (existsSync(resolvedAbs)) return readNote(resolvedAbs, realPath, file);
        }
      } catch {
        // BM25 search unavailable or errored — fall through to "not found"
      }

      return { content: [{ type: "text" as const, text: `Note not found: ${file}` }] };
    },
  );

  // ── Tool 3: multi_get ───────────────────────────────────────────
  server.registerTool(
    "multi_get",
    {
      title: "Batch read notes",
      description: `Read multiple notes at once. Accepts a glob pattern or comma-separated paths.
Examples: "${entityPath(VAULT_CONFIG, "person")}*.md", "${VAULT_CONFIG.structure.journal_path ?? ""}2026/*.md", "path1.md,path2.md"`,
      inputSchema: {
        pattern: z.string().describe("Glob pattern or comma-separated file paths"),
      },
    },
    async ({ pattern }) => {
      let entries: { path: string; name: string }[];
      if (pattern.includes(",")) {
        entries = pattern.split(",").map((p) => ({ path: p.trim(), name: p.trim().split("/").pop()?.replace(".md", "") ?? p }));
      } else {
        entries = listNotes(VAULT_PATH, pattern);
      }
      const results: Record<string, unknown>[] = [];
      for (const entry of entries.slice(0, 50)) {
        const abs = sanitizePath(VAULT_PATH, entry.path);
        if (!abs) {
          results.push({ path: entry.path, error: "path traversal outside vault not allowed" });
          continue;
        }
        if (!existsSync(abs)) {
          results.push({ path: entry.path, error: "not found" });
          continue;
        }
        const raw = readFileSync(abs, "utf-8");
        const { frontmatter, content } = parseNote(raw);
        // Trail filter: hidden notes return 404 (not 403)
        if (activeTrail) {
          const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags as string[] :
            typeof frontmatter.tags === "string" ? [frontmatter.tags] : [];
          const meta: NoteMetadata = { path: entry.path, type: frontmatter.type as string, tags, private: frontmatter.private === true };
          if (!filterByTrail(activeTrail, meta)) {
            results.push({ path: entry.path, error: "not found" });
            continue;
          }
        }
        const url = noteUrl(entry.path);
        const diskHash = contentHash(raw);
        results.push({
          path: entry.path,
          url,
          frontmatter,
          content,
          source_hash: getSourceHash(entry.path) ?? diskHash,
          content_hash: diskHash,
        });
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    },
  );

  // ── Tool 4: write_note ──────────────────────────────────────────
  server.registerTool(
    "write_note",
    {
      title: "Create, update, delete, or move a note",
      description: `Create, update, delete, or move notes in the vault.

ACTIONS:
  write (default) — create or update a note (requires frontmatter + content)
  delete          — soft delete: archive the note (sets archived_from/archived_at)
  hard_delete     — permanently remove the note from disk
  move            — rename/relocate a note and rewrite wikilinks pointing to it

STRUCTURE — common paths (but any path works):
${formatWriteStructure(VAULT_CONFIG)}

FILENAMES — use kebab-case (hyphens, lowercase) for clean URLs:
  ${entityPath(VAULT_CONFIG, "concept")}gentle-oxiclean-alternatives.md  ✓
  ${entityPath(VAULT_CONFIG, "concept")}Gentle OxiClean Alternatives.md  ✗
  ${entityPath(VAULT_CONFIG, "person")}John-Milinovich.md                 ✓
Use aliases in frontmatter for the human-readable title.

Only constraint: don't put a type in another type's designated folder
(e.g., don't put type: person in ${entityPath(VAULT_CONFIG, "concept")}).

FRONTMATTER — needs type (any string) + at least one tag:
  type: concept          — any string works, not just known types
  tags: [ai, research]   — at least one tag, your choice what
  aliases: ["Display Name"] — the human-readable title (required since filenames are kebab-case)

Special requirements:
  journal needs: date    recipe needs: meal_type

LINKING — use [[wikilinks]] aggressively. Pipe for readability: [[Full Name|display text]].

RESOURCE NOTES should include a dataview backlink query:
  \`\`\`dataview
  LIST FROM "Journal" WHERE contains(file.outlinks, this.file.link) SORT date DESC
  \`\`\`

SAFE UPDATES — pass if_hash (from a prior get) to prevent overwriting concurrent changes. Omit for new notes.

DELETE — prefer soft delete (action: "delete") so notes are recoverable from the archive folder. Use hard_delete only when the note must be gone permanently.

MOVE — action: "move" with move_to. Updates all exact wikilink matches across the vault in the same commit.

BATCH — pass operations: [...] to create/update many notes in one round-trip. Each op carries its own path/frontmatter/content/if_hash. Use if_hash_from_op to chain (reference the source_hash result of an earlier op). Set atomic: true to roll back the whole batch on any failure.

After writing, present the url field from the response to the user.`,
      inputSchema: {
        action: z.enum(["write", "delete", "hard_delete", "move"]).optional().default("write").describe("What to do: write (default), delete (soft/archive), hard_delete, or move"),
        path: z.string().optional().describe(`File path relative to vault root, kebab-case (e.g., '${entityPath(VAULT_CONFIG, "concept")}context-engineering.md'). Required for single-op; omit when using operations[].`),
        frontmatter: z.string().optional().describe("YAML frontmatter as JSON string (required for write; ignored otherwise)"),
        content: z.string().optional().describe("Note body (markdown) (required for write; ignored otherwise)"),
        if_hash: z.string().optional().describe("Content hash from prior read — rejects if file changed since"),
        move_to: z.string().optional().describe("Destination path (required when action is 'move')"),
        operations: z.array(z.object({
          path: z.string(),
          frontmatter: z.string().describe("YAML frontmatter as JSON string"),
          content: z.string(),
          if_hash: z.string().optional(),
          if_hash_from_op: z.number().int().nonnegative().optional().describe("Reference the source_hash of an earlier op in this batch (0-based)"),
        })).optional().describe("Batch mode: array of write ops executed in one mutex acquisition. Use instead of path/frontmatter/content for multi-note workflows."),
        atomic: z.boolean().optional().describe("When operations[] is set, atomic=true rolls back the whole batch on any failure. Default false (ops that succeed stay committed)."),
      },
    },
    async ({ action, path: notePath, frontmatter: fmInput, content, if_hash, move_to, operations, atomic }) => {
      return await dispatchWriteNote(
        { action, path: notePath, frontmatter: fmInput, content, if_hash, move_to, operations, atomic },
        { handleWriteNote, handleDeleteNote, handleMoveNote, handleWriteBatch, trail: activeTrail },
      );
    },
  );

  // ── Tool 5: list_notes ──────────────────────────────────────────
  server.registerTool(
    "list_notes",
    {
      title: "List notes in a folder",
      description: `List notes matching a pattern. Returns path, name, type, and modified date.
Use for:
  - Check if a note exists before creating (avoid duplicates)
  - Get all entity names + aliases: list_notes("${entityPath(VAULT_CONFIG, "person")}*", include_aliases=true)
  - Browse a folder: list_notes("${VAULT_CONFIG.structure.journal_path ?? ""}2026/*")
  - Find unsorted items: list_notes("${VAULT_CONFIG.structure.entities.default}*")`,
      inputSchema: {
        pattern: z.string().describe(`Glob pattern (e.g., '${entityPath(VAULT_CONFIG, "person")}*', '${VAULT_CONFIG.structure.journal_path ?? ""}2026/*')`),
        include_aliases: z.boolean().optional().default(false).describe("Include frontmatter aliases (for entity matching)"),
      },
    },
    async ({ pattern, include_aliases }) => {
      let entries = listNotes(VAULT_PATH, pattern, { includeAliases: include_aliases ?? false });
      // Trail filter: only return trail-visible notes in list
      if (activeTrail) {
        const totalCount = entries.length;
        entries = entries.filter((e) => {
          const meta: NoteMetadata = { path: e.path, type: e.type ?? undefined, tags: e.tags, private: e.private };
          return filterByTrail(activeTrail!, meta);
        });
        logTrailAccess("list", activeTrail.id, activeTrail.name, "list_notes", totalCount, entries.length);
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ count: entries.length, notes: entries }, null, 2) }],
      };
    },
  );

  // ── Tool 6: vault_status ────────────────────────────────────────
  server.registerTool(
    "vault_status",
    {
      title: "Vault health and diagnostics",
      description: `Vault health, recent changes, and diagnostics.

Modes:
  health       — doc count, last commit date
  history      — recent git log (filter by since, path_prefix)
  diagnostics  — orphan notes, broken [[links]], missing frontmatter, stale Inbox items
  graph        — wikilink graph: most connected, bridges, clusters, orphans
  digest       — garden lifecycle: seeds, sprouts, growing, mature, dormant, withering
  discovery    — recent extractions, new concepts, surprising connections, queue depth
  perf         — per-tool latency percentiles, write queue depth, discovery backlog`,
      inputSchema: {
        mode: z.enum(["health", "history", "diagnostics", "graph", "digest", "discovery", "perf"]).describe("What to check"),
        since: z.string().optional().describe("For history: date filter (e.g., '1 week ago', '2026-04-01')"),
        path_prefix: z.string().optional().describe("For history: path filter (e.g., 'Journal/')"),
      },
    },
    async ({ mode, since, path_prefix }) => {
      if (mode === "health") {
        const stats = getStats(VAULT_PATH);
        if (stats) {
          const statusResult: Record<string, unknown> = {
            total_notes: stats.vault.total_notes,
            vault_path: VAULT_PATH,
            by_folder: stats.vault.by_folder,
            by_type: stats.vault.by_type,
            frontmatter_completeness: stats.vault.frontmatter_completeness,
            freshness: stats.freshness,
            lifecycle: stats.lifecycle,
            computed_at: stats.computed_at,
          };
          // Trail: add scoped note to indicate these are vault-wide stats
          if (activeTrail) {
            statusResult.trail_note = "stats are vault-wide; use list_notes for trail-scoped counts";
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify(statusResult, null, 2) }],
          };
        }
        // Fallback: stats not yet computed, do the old way
        const notes = listNotes(VAULT_PATH, "*");
        const log = await gitLog(VAULT_PATH, { limit: 1 });
        const lastCommit = log[0] ?? null;
        let totalNotes = notes.length;
        const statusResult: Record<string, unknown> = {
          total_notes: totalNotes,
          last_commit: lastCommit ? { date: lastCommit.date, message: lastCommit.message } : null,
          vault_path: VAULT_PATH,
        };
        if (activeTrail) {
          const visibleNotes = notes.filter((n) => {
            const meta: NoteMetadata = { path: n.path, type: n.type ?? undefined, tags: n.tags, private: n.private };
            return filterByTrail(activeTrail!, meta);
          });
          statusResult.total_notes = visibleNotes.length;
          statusResult.scoped_stats = { trail_id: activeTrail.id, trail_name: activeTrail.name, total_in_vault: totalNotes, visible: visibleNotes.length };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(statusResult, null, 2) }],
        };
      }

      if (mode === "history") {
        const entries = await gitLog(VAULT_PATH, {
          since: since ?? "1 week ago",
          pathPrefix: path_prefix,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ entries: entries.slice(0, 30) }, null, 2) }],
        };
      }

      if (mode === "diagnostics") {
        return await runDiagnostics();
      }

      if (mode === "graph") {
        const stats = getStats(VAULT_PATH);
        if (stats) {
          return { content: [{ type: "text" as const, text: JSON.stringify(stats.graph, null, 2) }] };
        }
        // Fallback: compute directly
        const graph = await analyzeGraph(VAULT_PATH);
        return { content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }] };
      }

      if (mode === "digest") {
        const digest = await computeDigest(VAULT_PATH);
        return { content: [{ type: "text" as const, text: JSON.stringify(digest, null, 2) }] };
      }

      if (mode === "discovery") {
        const result = {
          recent_extractions: getRecentExtractions(20),
          new_concepts_created: getNewConceptsCreated(20, entityPath(VAULT_CONFIG, "concept")),
          surprising_connections: getSurprisingConnections(10),
          queue_depth: discoveryQueueDepth(),
          last_processed_at: getLastProcessedAt(),
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }

      if (mode === "perf") {
        const perf = await handleStatusPerf();
        return { content: [{ type: "text" as const, text: JSON.stringify(perf, null, 2) }] };
      }

      return { content: [{ type: "text" as const, text: "Unknown mode" }] };
    },
  );

  // ── Resource: vault notes accessible as MCP resources ──────────
  server.resource(
    "note",
    new ResourceTemplate("vault://life/{path}", { list: undefined }),
    async (uri, { path }) => ({
      contents: [{
        uri: uri.href,
        mimeType: "text/markdown",
        text: readFileSync(join(VAULT_PATH, path as string), "utf-8"),
      }],
    }),
  );

  return server;
}

// ── Diagnostics: orphans, broken links, missing frontmatter ───────

async function runDiagnostics() {
  const notes = listNotes(VAULT_PATH, "*", { includeAliases: true });
  const noteNames = new Set(notes.map((n) => n.name.toLowerCase()));
  const notePaths = new Set(notes.map((n) => n.path));

  const issues: { orphans: string[]; broken_links: string[]; missing_frontmatter: string[]; stale_inbox: string[] } = {
    orphans: [],
    broken_links: [],
    missing_frontmatter: [],
    stale_inbox: [],
  };

  const entityPaths = entityFolders(VAULT_CONFIG);
  const defaultFolder = VAULT_CONFIG.structure.entities.default;
  const isEntity = (p: string) => entityPaths.some((f) => p.startsWith(f));
  const isDefault = (p: string) => p.startsWith(defaultFolder);

  // Build link graph
  const incomingLinks = new Map<string, number>();
  for (const note of notes) incomingLinks.set(note.path, 0);

  for (const note of notes) {
    const abs = join(VAULT_PATH, note.path);
    let raw: string;
    try { raw = readFileSync(abs, "utf-8"); } catch {
      // File may have been deleted between listing and reading — skip
      continue;
    }

    // Extract wikilinks
    const links = [...raw.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1]);
    for (const link of links) {
      const target = link.toLowerCase();
      // Check if target exists
      const found = notes.find((n) => n.name.toLowerCase() === target || n.aliases?.some((a) => a.toLowerCase() === target));
      if (found) {
        incomingLinks.set(found.path, (incomingLinks.get(found.path) ?? 0) + 1);
      } else {
        issues.broken_links.push(`${note.path}: [[${link}]]`);
      }
    }

    // Missing frontmatter (entity notes only)
    if (isEntity(note.path) && !note.type) {
      issues.missing_frontmatter.push(note.path);
    }
  }

  // Orphans: entity notes with zero incoming links
  for (const note of notes) {
    if (isEntity(note.path) && (incomingLinks.get(note.path) ?? 0) === 0) {
      issues.orphans.push(note.path);
    }
  }

  // Stale inbox: files in the default-capture folder older than 7 days
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const note of notes) {
    if (isDefault(note.path) && new Date(note.modified_at).getTime() < sevenDaysAgo) {
      issues.stale_inbox.push(note.path);
    }
  }

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        total_notes: notes.length,
        orphans: { count: issues.orphans.length, notes: issues.orphans.slice(0, 20) },
        broken_links: { count: issues.broken_links.length, links: issues.broken_links.slice(0, 20) },
        missing_frontmatter: { count: issues.missing_frontmatter.length, notes: issues.missing_frontmatter.slice(0, 20) },
        stale_inbox: { count: issues.stale_inbox.length, notes: issues.stale_inbox },
      }, null, 2),
    }],
  };
}

// ── HTTP server with session management ───────────────────────────

const sessions = new Map<string, StreamableHTTPServerTransport>();
const sessionTrails = new Map<string, TrailConfig>(); // trail config per session
let activeTrail: TrailConfig | null = null; // current request's trail (set before tool execution)

async function createSession(): Promise<StreamableHTTPServerTransport> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, transport);
      console.log(`[grove] session ${sessionId} (${sessions.size} active)`);
    },
  });
  const server = createGroveServer();
  await server.connect(transport);
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  return transport;
}

const MAX_BODY = 1048576; // 1MB body size limit

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

const httpServer = createServer(async (req, res) => {
  // Read audit: log every request with correlation ID from proxy
  const requestId = req.headers["x-request-id"] as string | undefined;
  if (requestId) {
    auditRead(requestId, "server", "grove-server", req.method ?? "GET", { url: req.url });
  }

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, x-request-id");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Health
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, server: "grove" }));
    return;
  }

  // Discovery trigger — called by git post-commit hook
  if (req.url?.startsWith("/internal/discovery-trigger")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const path = url.searchParams.get("path");
    if (!path) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing path parameter" }));
      return;
    }
    try {
      enqueueDiscovery(path, "commit");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, path, trigger: "commit" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // MCP endpoint
  if (req.url === "/" || req.url === "/mcp") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Set active trail from proxy headers (trail resolution happens per-request)
    const trailConfigHeader = req.headers["x-trail-config"] as string | undefined;
    if (trailConfigHeader) {
      try { activeTrail = JSON.parse(trailConfigHeader); } catch { activeTrail = null; }
    } else {
      activeTrail = null;
    }

    // Store trail config per session for SSE reconnects
    if (activeTrail && sessionId) {
      sessionTrails.set(sessionId, activeTrail);
    } else if (sessionId && sessionTrails.has(sessionId)) {
      activeTrail = sessionTrails.get(sessionId)!;
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      let parsed: any;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end("Invalid JSON"); return; }

      let transport: StreamableHTTPServerTransport;

      if (sessionId && sessions.has(sessionId)) {
        transport = sessions.get(sessionId)!;
      } else if (!sessionId) {
        // New session — create transport + server
        transport = await createSession();
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid session" }));
        return;
      }

      // StreamableHTTPServerTransport.handleRequest takes Node req/res directly
      await transport.handleRequest(req, res, parsed);
      return;
    }

    if (req.method === "GET") {
      // SSE — pass to transport if session exists
      if (sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }
      res.writeHead(400);
      res.end("No session");
      return;
    }

    if (req.method === "DELETE" && sessionId) {
      sessions.delete(sessionId);
      res.writeHead(200);
      res.end();
      return;
    }
  }

  res.writeHead(404);
  res.end("Not found");
});

// ── Startup ───────────────────────────────────────────────────────

async function start() {
  console.log(`[grove] vault: ${VAULT_PATH}`);

  // Initialize SQLite database and migrate from JSON if needed
  runMigration();

  try {
    await startupRecovery(VAULT_PATH);
  } catch (err) {
    console.warn("[grove] startup recovery failed:", (err as Error).message);
  }

  // Start background stats computation (every 5 min)
  startStatsTimer(VAULT_PATH);
  console.log("[grove] stats timer started (5 min interval)");

  httpServer.listen(PORT, "127.0.0.1", () => {
    console.log(`[grove] MCP server listening on http://127.0.0.1:${PORT}`);
    console.log(`[grove] 6 tools registered: query, get, multi_get, write_note, list_notes, vault_status`);
  });
}

start().catch(console.error);

// ── Graceful shutdown (P8-A5) ────────────────────────────────────
//
// Handle SIGTERM (pm2 stop), SIGUSR2 (pm2 reload), SIGINT (^C). Order:
//   1. stop accepting new HTTP connections (existing requests continue)
//   2. drain the write queue so no git mutation is left in flight
//   3. verify git tree is clean post-drain
//   4. exit 0 (or 1 on error / hard-timeout after 60s)
//
// 60s matches the deploy workflow's health-poll window (12 × 5s), which
// is the longest the VPS is willing to wait before rolling back. If we
// can't drain in that window something's stuck — exit 1 so pm2 fails
// loudly rather than trapping the deploy.
let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const hardExit = setTimeout(() => {
    console.error(`[grove] graceful shutdown exceeded 60s; forcing exit 1`);
    process.exit(1);
  }, 60_000);
  hardExit.unref();

  try {
    console.log(`[grove] ${signal} received — draining`);
    httpServer.close((err) => {
      if (err) console.error(`[grove] httpServer.close: ${err.message}`);
    });
    await flushWriteQueue();

    try {
      const { execSync } = await import("node:child_process");
      const status = execSync(`git status --porcelain`, {
        cwd: VAULT_PATH,
        encoding: "utf8",
      });
      if (status.trim()) {
        console.warn(`[grove] git not clean at shutdown:\n${status}`);
      }
    } catch (err) {
      console.warn(`[grove] git status check failed: ${(err as Error).message}`);
    }

    clearTimeout(hardExit);
    console.log(`[grove] shutdown complete`);
    process.exit(0);
  } catch (err) {
    console.error(`[grove] shutdown error: ${(err as Error).message}`);
    clearTimeout(hardExit);
    process.exit(1);
  }
}

for (const signal of ["SIGTERM", "SIGUSR2", "SIGINT"] as const) {
  process.on(signal, () => void gracefulShutdown(signal));
}

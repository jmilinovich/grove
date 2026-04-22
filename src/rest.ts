/**
 * REST API handlers for the Grove note viewer.
 *
 * Provides GET /v1/notes/*, GET /v1/search, GET /v1/status/:mode endpoints.
 * These are thin facades over existing MCP tool logic,
 * designed for Next.js SSR fetching from grove-www.
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, unlinkSync } from "node:fs";
import { join, relative, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { hybridSearch, bm25Search } from "./hybrid-search.js";
import {
  gitLog,
  listNotes,
  gitCommit,
  gitCommitPaths,
  gitMv,
  gitRevParseHead,
  gitResetHard,
  qmdReindex,
  gitPush,
  readNoteFile,
  writeNoteFile,
  invalidateFrontmatterCache,
  updateWikilinks,
} from "./vault-ops.js";
import { validatePath, validateNote, parseNote, serializeNote, contentHash } from "./notes-validate.js";
import { loadVaultConfig, entityFolders } from "./vault-config.js";
import { filterByTrail, trailAllowsWrite, getTrailPublicInfo, getTrailConfig, type TrailConfig, type NoteMetadata } from "./trails.js";
import { getStats } from "./vault-stats.js";
import { analyzeGraph, computeDigest } from "./vault-graph.js";
import { searchMetrics, metrics } from "./metrics.js";
import { WriteQueue } from "./write-queue.js";
import { embedFile } from "./embed-single.js";
import {
  enqueueDiscovery,
  getDb,
  recordWrite,
  getSourceHash,
  getProvenance,
  setProvenanceRow,
  deleteProvenance,
  renameProvenance,
  discoveryQueueDepth,
  getLastProcessedAt,
} from "./db.js";
import { getImageStore, contentKey, extForContentType, type ImageStore } from "./image-store.js";
import { autoTagImage, type ImageTagResult } from "./image-tag.js";

const VAULT_PATH = process.env.GROVE_VAULT ?? join(homedir(), "life");

// ── Shared write queue (serializes all writes within this process) ──

const writeQueue = new WriteQueue();
writeQueue.schedulePush(() => gitPush(VAULT_PATH));

/** Flush pending writes and push — call on graceful shutdown. */
export async function flushWriteQueue(): Promise<void> {
  await writeQueue.flush();
}

/**
 * Resolve the handle (users.username) for the vault owner.
 *
 * Grove is single-tenant today — every public URL is scoped to one resident.
 * Used as the fallback when a caller hasn't supplied an explicit handle.
 * Returns "unknown" when no user row exists (fresh test databases).
 */
function getVaultOwnerHandle(): string {
  try {
    const db = getDb();
    const row = db
      .prepare(
        "SELECT u.username FROM vaults v JOIN users u ON u.id = v.owner_id ORDER BY v.created_at ASC LIMIT 1",
      )
      .get() as { username: string | null } | undefined;
    if (row?.username) return row.username;
    const fallback = db
      .prepare("SELECT username FROM users WHERE role = 'owner' LIMIT 1")
      .get() as { username: string | null } | undefined;
    return fallback?.username ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Encode a vault path as a canonical `/@<handle>/<path>` URL.
 * Every segment is URL-encoded; slashes are preserved.
 */
function noteUrl(vaultPath: string, handle: string): string {
  const stripped = vaultPath.replace(/\.md$/, "");
  const encoded = stripped.split("/").map(encodeURIComponent).join("/");
  return `https://grove.md/@${handle}/${encoded}`;
}

// ── Path traversal guard (same as server.ts) ────────────────────────

function sanitizePath(vaultRoot: string, filePath: string): string | null {
  const root = resolve(vaultRoot);
  const normalized = resolve(root, filePath);
  if (!normalized.startsWith(root + "/") && normalized !== root) return null;
  if (filePath.includes("..")) return null;
  try {
    const { isSymbolicLink } = statSync(normalized, { throwIfNoEntry: false }) ?? {};
    if (isSymbolicLink?.()) return null;
  } catch {
    // File doesn't exist — fine for reads
  }
  return normalized;
}

// ── Wikilink extraction ─────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

function extractWikilinks(text: string): string[] {
  const targets = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(WIKILINK_RE.source, "g");
  while ((m = re.exec(text)) !== null) targets.add(m[1].trim());
  return [...targets];
}

// ── Note resolution (extracted from server.ts get tool) ─────────────

interface ResolvedNote {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
  content_hash: string;
  resolved_from?: string;
}

async function resolveNote(file: string): Promise<ResolvedNote | null> {
  // 1. Normalize
  let filePath = file.replace(/^(life\/|qmd:\/\/life\/)/, "");
  if (!filePath.endsWith(".md")) filePath += ".md";

  const readNote = (abs: string, rel: string, resolvedFrom?: string): ResolvedNote => {
    const raw = readNoteFile(abs);
    const { frontmatter, content } = parseNote(raw);
    const hash = contentHash(raw);
    const result: ResolvedNote = { path: rel, frontmatter, content, content_hash: hash };
    if (resolvedFrom) result.resolved_from = resolvedFrom;
    return result;
  };

  // 2. Direct path
  const abs = sanitizePath(VAULT_PATH, filePath);
  if (!abs) return null;
  if (existsSync(abs)) return readNote(abs, filePath);

  // 3. Case-insensitive full path match (handles Resources/ vs resources/)
  const allNotes = listNotes(VAULT_PATH, "*");
  const filePathLower = filePath.toLowerCase();
  const pathMatch = allNotes.find((n) => n.path.toLowerCase() === filePathLower);
  if (pathMatch) {
    const matchAbs = join(VAULT_PATH, pathMatch.path);
    if (existsSync(matchAbs)) return readNote(matchAbs, pathMatch.path, file);
  }

  // 4. Extract basename for searching
  const searchTerm = filePath.replace(/\.md$/, "").split("/").pop() ?? file;

  // 5. Journal date pattern
  const dateMatch = searchTerm.match(/^(\d{4})-\d{2}-\d{2}$/);
  if (dateMatch) {
    const year = dateMatch[1];
    for (const y of [year, String(new Date().getFullYear())]) {
      const journalPath = `Journal/${y}/${searchTerm}.md`;
      const journalAbs = join(VAULT_PATH, journalPath);
      if (existsSync(journalAbs)) return readNote(journalAbs, journalPath, file);
    }
  }

  // 6. Case-insensitive basename search
  const searchLower = searchTerm.toLowerCase();
  const nameMatch = allNotes.find((n) => n.name.toLowerCase() === searchLower);
  if (nameMatch) {
    const matchAbs = join(VAULT_PATH, nameMatch.path);
    if (existsSync(matchAbs)) return readNote(matchAbs, nameMatch.path, file);
  }

  // 6b. Kebab-case basename match (QMD index uses kebab-case, filesystem uses spaces/punctuation)
  const toKebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const searchKebab = toKebab(searchTerm);
  const kebabMatch = allNotes.find((n) => toKebab(n.name) === searchKebab);
  if (kebabMatch) {
    const matchAbs = join(VAULT_PATH, kebabMatch.path);
    if (existsSync(matchAbs)) return readNote(matchAbs, kebabMatch.path, file);
  }

  // 7. Alias search
  const aliasNotes = listNotes(VAULT_PATH, "*", { includeAliases: true });
  const aliasMatch = aliasNotes.find(
    (n) => n.aliases?.some((a: string) => a.toLowerCase() === searchLower),
  );
  if (aliasMatch) {
    const matchAbs = join(VAULT_PATH, aliasMatch.path);
    if (existsSync(matchAbs)) return readNote(matchAbs, aliasMatch.path, file);
  }

  // 8. BM25 fallback
  try {
    const results = await bm25Search(searchTerm, 3);
    if (results.length > 0) {
      const resolvedLower = results[0].vault_path.toLowerCase();
      const realNote = allNotes.find((n) => n.path.toLowerCase() === resolvedLower);
      const realPath = realNote?.path ?? results[0].vault_path;
      const resolvedAbs = join(VAULT_PATH, realPath);
      if (existsSync(resolvedAbs)) return readNote(resolvedAbs, realPath, file);
    }
  } catch {
    // BM25 unavailable
  }

  return null;
}

// ── Backlinks computation ───────────────────────────────────────────
// Walks all .md files and finds notes that link TO the given path.
// Uses the same wikilink extraction as vault-graph.ts.

const SKIP = new Set([".obsidian", ".git", ".trash", "node_modules", ".claude"]);

function walkMd(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkMd(full, acc);
    else if (entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

// Cache backlinks index — rebuilt lazily, invalidated on a timer
let backlinkIndex: Map<string, string[]> | null = null;
let backlinkIndexAge = 0;
const BACKLINK_TTL_MS = 60_000; // rebuild every 60s max

function getBacklinkIndex(): Map<string, string[]> {
  if (backlinkIndex && Date.now() - backlinkIndexAge < BACKLINK_TTL_MS) {
    return backlinkIndex;
  }

  const index = new Map<string, string[]>();
  const files = walkMd(VAULT_PATH);

  for (const abs of files) {
    const srcPath = relative(VAULT_PATH, abs);
    const srcName = basename(abs, ".md");
    let text: string;
    try { text = readNoteFile(abs); } catch { continue; }

    const links = extractWikilinks(text);
    for (const target of links) {
      // Normalize target to just the note name (strip path prefixes)
      const targetName = target.split("/").pop() ?? target;
      if (!index.has(targetName)) index.set(targetName, []);
      index.get(targetName)!.push(srcPath);
    }
  }

  backlinkIndex = index;
  backlinkIndexAge = Date.now();
  return index;
}

function getBacklinks(notePath: string): string[] {
  const noteName = basename(notePath, ".md");
  const index = getBacklinkIndex();
  return index.get(noteName) ?? [];
}

// ── Wikilink resolution (batch) ─────────────────────────────────────
// For each wikilink target in a note, resolve it to a vault path.

async function resolveLinks(
  targets: string[],
): Promise<Record<string, { path: string | null; exists: boolean }>> {
  const allNotes = listNotes(VAULT_PATH, "*");
  const aliasNotes = listNotes(VAULT_PATH, "*", { includeAliases: true });
  const result: Record<string, { path: string | null; exists: boolean }> = {};

  for (const target of targets) {
    const searchLower = target.toLowerCase();
    // Strip any path prefixes — resolve by basename
    const searchName = target.split("/").pop()?.toLowerCase() ?? searchLower;

    // 1. Exact basename match
    const nameMatch = allNotes.find((n) => n.name.toLowerCase() === searchName);
    if (nameMatch) {
      result[target] = { path: nameMatch.path.replace(/\.md$/, ""), exists: true };
      continue;
    }

    // 2. Alias match
    const aliasMatch = aliasNotes.find(
      (n) => n.aliases?.some((a: string) => a.toLowerCase() === searchName),
    );
    if (aliasMatch) {
      result[target] = { path: aliasMatch.path.replace(/\.md$/, ""), exists: true };
      continue;
    }

    // 3. Not found
    result[target] = { path: null, exists: false };
  }

  return result;
}

// ── Public API ──────────────────────────────────────────────────────

export interface NoteResponse {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
  /**
   * Hash of what the caller last wrote. Use as `if_hash` for updates —
   * stays stable across discovery-worker mutations. Equals content_hash
   * for notes without provenance (legacy or discovery-created).
   */
  source_hash: string;
  /** Hash of the current on-disk content. */
  content_hash: string;
  links: Record<string, { path: string | null; exists: boolean }>;
  backlinks: string[];
  resolved_from?: string;
}

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
}

// ── Trail info (unauthenticated) ──────────────────────────────────

export interface TrailInfoResponse {
  name: string;
  description: string;
  note_count: number;
  created_at: string;
  owner_handle: string | null;
}

// ── Resident profile (unauthenticated, P16-1) ────────────────────

export interface ResidentProfile {
  handle: string;
  display_name: string | null;
  bio: string | null;
  public_trail_slugs: string[];
  note_count: number;
}

/**
 * Public profile for a resident, keyed by handle (users.username).
 *
 * Returns null for 404 when the handle is unknown or belongs to no user.
 * `public_trail_slugs` is currently always empty — per-trail public
 * visibility is a future phase (see PLAN.md Phase 16 scope decision).
 * `note_count` reflects the current vault total; this server is
 * single-resident today.
 */
export function handleResidentProfile(handle: string): ResidentProfile | null {
  if (!handle) return null;
  const db = getDb();
  const row = db
    .prepare("SELECT id, username, display_name, bio FROM users WHERE username = ?")
    .get(handle) as
    | { id: string; username: string; display_name: string | null; bio: string | null }
    | undefined;
  if (!row) return null;

  let noteCount = 0;
  try {
    noteCount = listNotes(VAULT_PATH, "*").length;
  } catch {
    // Vault missing or unreadable — fall back to 0 rather than 500.
  }

  return {
    handle: row.username,
    display_name: row.display_name,
    bio: row.bio,
    public_trail_slugs: [],
    note_count: noteCount,
  };
}

export function handleTrailInfo(trailId: string): TrailInfoResponse | null {
  const info = getTrailPublicInfo(trailId);
  if (!info || !info.enabled) return null;

  // Count notes matching trail filters
  const config = getTrailConfig(trailId);
  let noteCount = 0;
  if (config) {
    const allNotes = listNotes(VAULT_PATH, "*");
    noteCount = allNotes.filter((n) => {
      const meta: NoteMetadata = {
        path: n.path,
        type: n.type ?? undefined,
        tags: n.tags ?? [],
        private: n.private,
      };
      return filterByTrail(config, meta);
    }).length;
  }

  // Trails don't carry an explicit owner column — Grove is single-resident
  // today, so the vault owner is the trail's effective owner. The legacy
  // `/trails/:slug` page uses this to 301 to `/@<handle>/trails/:slug`
  // (P16-3). `getVaultOwnerHandle()` returns "unknown" on empty databases;
  // normalize that to null so the client can skip the redirect rather than
  // hit `/@unknown`.
  const rawOwner = getVaultOwnerHandle();
  const ownerHandle = rawOwner === "unknown" ? null : rawOwner;

  return {
    name: info.name,
    description: info.description,
    note_count: noteCount,
    created_at: info.created_at,
    owner_handle: ownerHandle,
  };
}

/**
 * Fetch a note by path or title. Returns note content, resolved wikilinks, and backlinks.
 * If a trail is provided, applies trail filtering (returns null for hidden notes).
 */
export async function handleGetNote(notePath: string, trail?: TrailConfig | null): Promise<NoteResponse | null> {
  const note = await resolveNote(notePath);
  if (!note) return null;

  // Trail filter: if note not visible, return null (404, not 403)
  if (trail) {
    const tags = Array.isArray(note.frontmatter.tags) ? note.frontmatter.tags as string[] :
      typeof note.frontmatter.tags === "string" ? [note.frontmatter.tags] : [];
    const meta: NoteMetadata = {
      path: note.path,
      type: note.frontmatter.type as string | undefined,
      tags,
      private: note.frontmatter.private === true,
    };
    if (!filterByTrail(trail, meta)) return null;
  }

  // Extract and resolve wikilinks from content
  const targets = extractWikilinks(note.content);
  const links = await resolveLinks(targets);

  // Trail filter wikilinks: mark trail-invisible notes as non-existent
  if (trail) {
    for (const [target, info] of Object.entries(links)) {
      if (info.exists && info.path) {
        try {
          const linkAbs = join(VAULT_PATH, info.path + ".md");
          const raw = readNoteFile(linkAbs);
          const { frontmatter } = parseNote(raw);
          const linkTags = Array.isArray(frontmatter.tags) ? frontmatter.tags as string[] : [];
          const linkMeta: NoteMetadata = {
            path: info.path + ".md",
            type: frontmatter.type as string | undefined,
            tags: linkTags,
            private: frontmatter.private === true,
          };
          if (!filterByTrail(trail, linkMeta)) {
            links[target] = { path: null, exists: false };
          }
        } catch {
          links[target] = { path: null, exists: false };
        }
      }
    }
  }

  // Get backlinks (filter by trail if scoped)
  let backlinks = getBacklinks(note.path);
  if (trail) {
    backlinks = backlinks.filter((bl) => {
      try {
        const abs = join(VAULT_PATH, bl);
        const raw = readNoteFile(abs);
        const { frontmatter } = parseNote(raw);
        const blTags = Array.isArray(frontmatter.tags) ? frontmatter.tags as string[] : [];
        const blMeta: NoteMetadata = {
          path: bl,
          type: frontmatter.type as string | undefined,
          tags: blTags,
          private: frontmatter.private === true,
        };
        return filterByTrail(trail, blMeta);
      } catch { return false; }
    });
  }

  return {
    path: note.path,
    frontmatter: note.frontmatter,
    content: note.content,
    source_hash: getSourceHash(note.path) ?? note.content_hash,
    content_hash: note.content_hash,
    links,
    backlinks,
    ...(note.resolved_from && { resolved_from: note.resolved_from }),
  };
}

export interface ListEntry {
  path: string;
  name: string;
  type: string | null;
  tags: string[];
  modified_at: string;
  // Image-specific (populated only for notes with type: image)
  thumbnail_url?: string;
  image_url?: string;
  dimensions?: { width: number; height: number };
  description?: string;
}

/**
 * Read image-specific frontmatter fields from a note file.
 * Returns undefined if the file is unreadable or missing image metadata.
 */
function readImageMetadata(notePath: string): Pick<ListEntry, "thumbnail_url" | "image_url" | "dimensions" | "description"> {
  try {
    const abs = join(VAULT_PATH, notePath);
    const raw = readFileSync(abs, "utf-8");
    const { frontmatter, content } = parseNote(raw);
    const out: Pick<ListEntry, "thumbnail_url" | "image_url" | "dimensions" | "description"> = {};
    if (typeof frontmatter.thumbnail_url === "string") out.thumbnail_url = frontmatter.thumbnail_url;
    if (typeof frontmatter.image_url === "string") out.image_url = frontmatter.image_url;
    const dim = frontmatter.dimensions;
    if (dim && typeof dim === "object" && typeof (dim as Record<string, unknown>).width === "number"
        && typeof (dim as Record<string, unknown>).height === "number") {
      out.dimensions = { width: (dim as { width: number }).width, height: (dim as { height: number }).height };
    }
    // Description: first non-heading paragraph of content, truncated
    const firstPara = content
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#") && !l.startsWith("!["));
    if (firstPara) out.description = firstPara.slice(0, 240);
    return out;
  } catch {
    return {};
  }
}

/**
 * List notes under a path prefix. Returns metadata for each note.
 * If a trail is provided, filters to trail-visible notes only.
 * If a type is provided, filters to notes with that frontmatter type.
 * Image notes (type: image) carry thumbnail_url/image_url/dimensions.
 */
export function handleListNotes(prefix: string, trail?: TrailConfig | null, type?: string | null): ListEntry[] {
  // Empty prefix means "list all notes" (for sidebar folder discovery)
  const dirPrefix = prefix === "" ? "" : (prefix.endsWith("/") ? prefix : prefix + "/");
  const allNotes = listNotes(VAULT_PATH, "*");

  return allNotes
    .filter((n) => {
      if (dirPrefix !== "" && !n.path.startsWith(dirPrefix)) return false;
      if (type && n.type !== type) return false;
      if (trail) {
        const meta: NoteMetadata = {
          path: n.path,
          type: n.type ?? undefined,
          tags: n.tags ?? [],
          private: n.private,
        };
        return filterByTrail(trail, meta);
      }
      return true;
    })
    .map((n): ListEntry => {
      const base: ListEntry = {
        path: n.path,
        name: n.name,
        type: n.type,
        tags: n.tags ?? [],
        modified_at: n.modified_at,
      };
      if (n.type === "image") Object.assign(base, readImageMetadata(n.path));
      return base;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface TrailPreviewScope {
  allow_tags?: string[];
  deny_tags?: string[];
  allow_types?: string[];
  deny_types?: string[];
  allow_paths?: string[];
  deny_paths?: string[];
}

export interface TrailPreviewSample {
  path: string;
  name: string;
  type: string | null;
  tags: string[];
}

export interface TrailPreviewResult {
  total_notes: number;
  match_count: number;
  samples: TrailPreviewSample[];
  all_tags: string[];
  all_types: string[];
}

/**
 * Preview how many notes match a proposed trail scope, plus a sample of matching notes
 * and the full lists of tags/types in the vault (for the editor's autocomplete).
 *
 * Builds an ephemeral TrailConfig from the scope and runs filterByTrail against every note.
 */
export function handleTrailPreview(
  scope: TrailPreviewScope,
  sampleLimit: number = 10,
): TrailPreviewResult {
  const ephemeral: TrailConfig = {
    id: "preview",
    name: "preview",
    description: "",
    key_id: "",
    enabled: true,
    created_at: new Date().toISOString(),
    allow_tags: scope.allow_tags ?? [],
    deny_tags: scope.deny_tags ?? [],
    allow_types: scope.allow_types ?? [],
    deny_types: scope.deny_types ?? [],
    allow_paths: scope.allow_paths ?? [],
    deny_paths: scope.deny_paths ?? [],
    rate_limit_reads: 60,
    rate_limit_writes: 0,
  };

  const allNotes = listNotes(VAULT_PATH, "*");
  const tagSet = new Set<string>();
  const typeSet = new Set<string>();
  for (const n of allNotes) {
    if (n.tags) for (const t of n.tags) tagSet.add(t);
    if (n.type) typeSet.add(n.type);
  }

  const matches = allNotes.filter((n) =>
    filterByTrail(ephemeral, {
      path: n.path,
      type: n.type ?? undefined,
      tags: n.tags ?? [],
      private: n.private,
    }),
  );

  const samples: TrailPreviewSample[] = matches
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, sampleLimit)
    .map((n) => ({
      path: n.path,
      name: n.name,
      type: n.type,
      tags: n.tags ?? [],
    }));

  return {
    total_notes: allNotes.length,
    match_count: matches.length,
    samples,
    all_tags: [...tagSet].sort(),
    all_types: [...typeSet].sort(),
  };
}

/**
 * Test whether a specific note is visible under a proposed scope, with an explanation
 * of which rule matched. Returns null if the note doesn't exist.
 */
export interface TrailPreviewTestResult {
  path: string;
  visible: boolean;
  reason: string;
  note: {
    type: string | null;
    tags: string[];
    private: boolean;
  };
}

export function handleTrailPreviewTest(
  notePath: string,
  scope: TrailPreviewScope,
): TrailPreviewTestResult | null {
  const allNotes = listNotes(VAULT_PATH, "*");
  const note = allNotes.find((n) => n.path === notePath);
  if (!note) return null;

  const meta: NoteMetadata = {
    path: note.path,
    type: note.type ?? undefined,
    tags: note.tags ?? [],
    private: note.private,
  };

  const allowTags = scope.allow_tags ?? [];
  const denyTags = scope.deny_tags ?? [];
  const allowTypes = scope.allow_types ?? [];
  const denyTypes = scope.deny_types ?? [];
  const allowPaths = scope.allow_paths ?? [];
  const denyPaths = scope.deny_paths ?? [];

  let reason = "matches scope";
  let visible = true;

  if (meta.private === true) {
    visible = false;
    reason = "note is private (frontmatter private: true)";
  } else if (allowPaths.length > 0 && !allowPaths.some((p) => meta.path.startsWith(p))) {
    visible = false;
    reason = `path not in allow_paths (${allowPaths.join(", ")})`;
  } else if (denyPaths.length > 0 && denyPaths.some((p) => meta.path.startsWith(p))) {
    visible = false;
    reason = `path matches deny_paths (${denyPaths.filter((p) => meta.path.startsWith(p)).join(", ")})`;
  } else if (allowTypes.length > 0 && (!meta.type || !allowTypes.includes(meta.type))) {
    visible = false;
    reason = `type ${meta.type ?? "(none)"} not in allow_types (${allowTypes.join(", ")})`;
  } else if (denyTypes.length > 0 && meta.type && denyTypes.includes(meta.type)) {
    visible = false;
    reason = `type ${meta.type} in deny_types`;
  } else if (allowTags.length > 0) {
    const noteTags = meta.tags ?? [];
    if (!allowTags.some((t) => noteTags.includes(t))) {
      visible = false;
      reason = `no tag matches allow_tags (${allowTags.join(", ")})`;
    }
  }

  if (visible && denyTags.length > 0) {
    const noteTags = meta.tags ?? [];
    const denied = denyTags.filter((t) => noteTags.includes(t));
    if (denied.length > 0) {
      visible = false;
      reason = `tag in deny_tags (${denied.join(", ")})`;
    }
  }

  return {
    path: note.path,
    visible,
    reason,
    note: {
      type: note.type ?? null,
      tags: note.tags ?? [],
      private: note.private === true,
    },
  };
}

/**
 * Search notes via hybrid search. Returns structured results.
 * If a trail is provided, filters results to trail-visible notes.
 * `handle` scopes result URLs to `/@<handle>/...`; falls back to the
 * vault owner when the caller doesn't know it (single-tenant mode).
 */
export async function handleSearch(query: string, limit: number = 10, trail?: TrailConfig | null, handle?: string): Promise<SearchResult[]> {
  const fetchLimit = trail ? limit * 3 : limit; // over-fetch for trail filtering
  const results = await hybridSearch(query, fetchLimit);

  const residentHandle = handle ?? getVaultOwnerHandle();

  // Resolve QMD's lowercase-kebab paths to real filesystem paths.
  // QMD index stores e.g. "resources/concepts/meditation-mindfulness.md"
  // but the filesystem has "Resources/Concepts/Meditation & Mindfulness.md".
  const allNotes = listNotes(VAULT_PATH, "*");
  const resolveRealPath = (vaultPath: string, title: string): string => {
    const vp = vaultPath.toLowerCase();
    const note = allNotes.find((n) => n.path.toLowerCase() === vp || n.name === title);
    return note?.path ?? vaultPath;
  };

  let filtered = results.map((r) => {
    const realPath = resolveRealPath(r.vault_path, r.title);
    return {
      path: realPath,
      title: r.title,
      snippet: r.snippet ?? "",
      score: r.rrf_score,
      vault_path: r.vault_path,
      real_path: realPath,
      url: noteUrl(realPath, residentHandle),
    };
  });

  if (trail) {
    filtered = filtered.filter((r) => {
      const note = allNotes.find((n) => n.path === r.real_path);
      if (!note) return false;
      const meta: NoteMetadata = {
        path: note.path,
        type: note.type ?? undefined,
        tags: note.tags ?? [],
        private: note.private,
      };
      return filterByTrail(trail, meta);
    });
  }

  // Strip internal fields from response
  return filtered.slice(0, limit).map(({ vault_path: _, real_path: _rp, ...rest }) => rest);
}

const VALID_STATS_SECTIONS = new Set(["vault", "freshness", "graph", "index", "lifecycle", "git", "search", "server"]);

/**
 * Get precomputed vault statistics, optionally filtered by section.
 * Returns null if stats haven't been computed yet.
 */
export function handleStats(
  sections?: string[],
  trail?: TrailConfig | null,
  isAdmin?: boolean,
): Record<string, unknown> | null {
  const stats = getStats(VAULT_PATH);
  if (!stats) return null;

  const result: Record<string, unknown> = {
    computed_at: stats.computed_at,
  };

  // If trail is active, note that stats are vault-wide
  if (trail) {
    result.trail_note = "stats are vault-wide, not trail-scoped";
  }

  const include = (key: string): boolean =>
    !sections || sections.includes(key);

  if (include("vault")) result.vault = stats.vault;
  if (include("freshness")) result.freshness = stats.freshness;
  if (include("graph")) result.graph = stats.graph;
  if (include("index")) result.index = stats.index;
  if (include("lifecycle")) result.lifecycle = stats.lifecycle;
  if (include("git")) result.git = stats.git;

  // Search stats are admin-only
  if (include("search") && isAdmin) {
    result.search = searchMetrics.getSearchStats();
  }

  // Server metrics
  if (include("server")) {
    const m = metrics.getMetrics();
    result.server = {
      started_at: m.started_at,
      uptime_seconds: m.uptime_seconds,
      total_requests: m.total_requests,
      error_rate: m.error_rate,
    };
  }

  return result;
}

// ── Status endpoints (vault_status modes via REST) ─────────────────

export type StatusMode = "health" | "history" | "diagnostics" | "graph" | "digest";

export const VALID_STATUS_MODES = new Set<StatusMode>(["health", "history", "diagnostics", "graph", "digest"]);

/**
 * Health: doc count, freshness, lifecycle, folder/type breakdown.
 */
export function handleStatusHealth(trail?: TrailConfig | null): Record<string, unknown> | null {
  const stats = getStats(VAULT_PATH);
  if (!stats) return null;

  const result: Record<string, unknown> = {
    total_notes: stats.vault.total_notes,
    vault_path: VAULT_PATH,
    by_folder: stats.vault.by_folder,
    by_type: stats.vault.by_type,
    frontmatter_completeness: stats.vault.frontmatter_completeness,
    freshness: stats.freshness,
    lifecycle: stats.lifecycle,
    computed_at: stats.computed_at,
  };

  if (trail) {
    result.trail_note = "stats are vault-wide; use list_notes for trail-scoped counts";
  }

  return result;
}

/**
 * History: recent git log, optionally filtered by since/path_prefix.
 */
export async function handleStatusHistory(
  since?: string,
  pathPrefix?: string,
): Promise<{ entries: unknown[] }> {
  const entries = await gitLog(VAULT_PATH, {
    since: since ?? "1 week ago",
    pathPrefix: pathPrefix ?? undefined,
  });
  return { entries: entries.slice(0, 30) };
}

/**
 * Diagnostics: orphan notes, broken links, missing frontmatter, stale inbox.
 */
export function handleStatusDiagnostics(): Record<string, unknown> {
  const notes = listNotes(VAULT_PATH, "*", { includeAliases: true });

  const config = loadVaultConfig(VAULT_PATH);
  const folders = entityFolders(config);
  const defaultFolder = config.structure.entities.default;
  const isEntityNote = (p: string) => folders.some((f) => p.startsWith(f));
  const isDefaultNote = (p: string) => p.startsWith(defaultFolder);

  const issues = {
    orphans: [] as string[],
    broken_links: [] as string[],
    missing_frontmatter: [] as string[],
    stale_inbox: [] as string[],
  };

  // Build link graph
  const incomingLinks = new Map<string, number>();
  for (const note of notes) incomingLinks.set(note.path, 0);

  for (const note of notes) {
    const abs = join(VAULT_PATH, note.path);
    let raw: string;
    try { raw = readNoteFile(abs); } catch { continue; }

    const links = [...raw.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1]);
    for (const link of links) {
      const target = link.toLowerCase();
      const found = notes.find(
        (n) => n.name.toLowerCase() === target || n.aliases?.some((a: string) => a.toLowerCase() === target),
      );
      if (found) {
        incomingLinks.set(found.path, (incomingLinks.get(found.path) ?? 0) + 1);
      } else {
        issues.broken_links.push(`${note.path}: [[${link}]]`);
      }
    }

    if (isEntityNote(note.path) && !note.type) {
      issues.missing_frontmatter.push(note.path);
    }
  }

  // Orphans: entity notes with zero incoming links
  for (const note of notes) {
    if (isEntityNote(note.path) && (incomingLinks.get(note.path) ?? 0) === 0) {
      issues.orphans.push(note.path);
    }
  }

  // Stale inbox: files in the default-capture folder older than 7 days
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const note of notes) {
    if (isDefaultNote(note.path) && new Date(note.modified_at).getTime() < sevenDaysAgo) {
      issues.stale_inbox.push(note.path);
    }
  }

  return {
    total_notes: notes.length,
    orphans: { count: issues.orphans.length, notes: issues.orphans.slice(0, 20) },
    broken_links: { count: issues.broken_links.length, links: issues.broken_links.slice(0, 20) },
    missing_frontmatter: { count: issues.missing_frontmatter.length, notes: issues.missing_frontmatter.slice(0, 20) },
    stale_inbox: { count: issues.stale_inbox.length, notes: issues.stale_inbox },
  };
}

/**
 * Graph: wikilink graph analysis — most connected, bridges, clusters, orphans.
 */
export async function handleStatusGraph(): Promise<Record<string, unknown>> {
  const stats = getStats(VAULT_PATH);
  if (stats) return stats.graph as unknown as Record<string, unknown>;
  return await analyzeGraph(VAULT_PATH) as unknown as Record<string, unknown>;
}

/**
 * Digest: garden lifecycle — seeds, sprouts, growing, mature, dormant, withering.
 */
export async function handleStatusDigest(): Promise<Record<string, unknown>> {
  return await computeDigest(VAULT_PATH) as unknown as Record<string, unknown>;
}

/**
 * Perf: observability surface for latency regressions.
 *
 * Exposes in-process counters so agents and operators can notice tail
 * latency, queue backpressure, and discovery lag without SSHing to read logs.
 * Cheap to compute (no I/O except a count() on the discovery queue).
 */
export async function handleStatusPerf(): Promise<Record<string, unknown>> {
  const toolMetrics = metrics.getMetrics();
  return {
    uptime_seconds: toolMetrics.uptime_seconds,
    total_requests: toolMetrics.total_requests,
    total_errors: toolMetrics.total_errors,
    error_rate: toolMetrics.error_rate,
    tools: toolMetrics.by_tool,
    search: searchMetrics.getSearchStats(),
    write_queue: {
      depth: writeQueue.depth(),
      oldest_queued_age_ms: writeQueue.oldestQueuedAgeMs(),
    },
    discovery: {
      queue_depth: discoveryQueueDepth(),
      last_processed_at: getLastProcessedAt(),
    },
    window_ms: 60_000 * 60,
  };
}

// ── Write ──────────────────────────────────────────────────────────

/**
 * In-mutex disk write: serialize the note, write it to disk, commit to git,
 * record provenance, and return the result shape. MUST be called from
 * within writeQueue.enqueue — it does no locking of its own.
 *
 * Extracted so handleWriteNote (single) and handleWriteBatch (many) can
 * share the exact same write semantics under one mutex acquisition.
 */
async function executeWriteInMutex(params: {
  absPath: string;
  relPath: string;
  frontmatter: Record<string, unknown>;
  content: string;
  isNew: boolean;
  keyName?: string;
  handle?: string;
}): Promise<WriteNoteResult> {
  const { absPath, relPath, frontmatter, content, isNew, keyName, handle } = params;

  const serialized = serializeNote(frontmatter, content);
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeNoteFile(absPath, serialized);
  invalidateFrontmatterCache(absPath);

  const action = isNew ? "create" : "update";
  const who = keyName ? `grove (${keyName})` : "grove (api)";
  const commitMsg = `${who}: ${action} ${relPath}`;
  const sha = await gitCommit(VAULT_PATH, relPath, commitMsg);

  const sourceHash = contentHash(serialized);
  recordWrite(relPath, sourceHash, sha, keyName ?? "api");

  qmdReindex(relPath).catch(() => {});

  return {
    path: relPath,
    action,
    source_hash: sourceHash,
    content_hash: sourceHash,
    commit: sha,
    url: noteUrl(relPath, handle ?? getVaultOwnerHandle()),
  };
}

/**
 * Optimistic-concurrency check shared by write / move / delete.
 * Prefers provenance.source_hash (stable across discovery-worker mutations);
 * falls back to the on-disk hash for paths with no provenance entry yet.
 * Throws a CONFLICT error on mismatch. No-op if the file doesn't exist
 * and provenance is absent (treated as a fresh create).
 */
function assertIfHashMatches(relPath: string, absPath: string, ifHash: string): void {
  const recordedSource = getSourceHash(relPath);
  if (recordedSource !== null) {
    if (recordedSource !== ifHash) {
      throw Object.assign(new Error("Conflict: note was modified"), {
        code: "CONFLICT",
        currentHash: recordedSource,
      });
    }
    return;
  }
  if (!existsSync(absPath)) return;
  const currentHash = contentHash(readNoteFile(absPath));
  if (currentHash !== ifHash) {
    throw Object.assign(new Error("Conflict: note was modified"), {
      code: "CONFLICT",
      currentHash,
    });
  }
}

export interface WriteNoteResult {
  path: string;
  action: string;
  /**
   * Hash of what the caller wrote (pre-discovery). Use this as `if_hash`
   * in subsequent updates — it stays stable across discovery-worker mutations.
   */
  source_hash: string;
  /**
   * Hash of the on-disk content at return time. Equal to source_hash
   * immediately after write, but may diverge once the discovery worker
   * runs. Retained for backward compatibility; prefer source_hash.
   */
  content_hash: string;
  commit: string;
  url: string;
}

/**
 * Create or update a note with validated frontmatter.
 * Serializes through the write queue, commits to git, reindexes, and re-embeds.
 *
 * Throws on validation errors (caller should catch and return 400).
 * Returns a conflict object on hash mismatch (caller should return 409).
 */
export async function handleWriteNote(
  notePath: string,
  frontmatter: Record<string, unknown>,
  content: string,
  options: { ifHash?: string; trail?: TrailConfig | null; keyName?: string; handle?: string },
): Promise<WriteNoteResult> {
  // Trail write scope check
  if (options.trail) {
    if (!trailAllowsWrite(options.trail, notePath)) {
      throw Object.assign(new Error("Write not allowed: path outside trail scope"), { code: "TRAIL_DENIED" });
    }
  }

  // Validate path
  let absPath: string;
  try {
    absPath = validatePath(VAULT_PATH, notePath);
  } catch (err: any) {
    throw Object.assign(new Error(`Path error: ${err.message}`), { code: "VALIDATION", errors: [err.message] });
  }
  const relPath = relative(VAULT_PATH, absPath);

  // Validate note structure (config drives type_paths + tag rules + journal pattern)
  const { errors } = validateNote(relPath, frontmatter, content, loadVaultConfig(VAULT_PATH));
  if (errors.length > 0) {
    throw Object.assign(new Error(`Validation errors:\n${errors.map((e) => `- ${e}`).join("\n")}`), { code: "VALIDATION", errors });
  }

  // Optimistic concurrency check (prefers provenance, falls back to disk).
  if (options.ifHash) assertIfHashMatches(relPath, absPath, options.ifHash);

  // Enqueue the write. All disk + git work is done by executeWriteInMutex,
  // so single writes and batched writes share identical semantics.
  const result = await writeQueue.enqueue(() => executeWriteInMutex({
    absPath,
    relPath,
    frontmatter,
    content,
    isNew: !options.ifHash,
    keyName: options.keyName,
    handle: options.handle,
  }));

  // Enqueue for discovery processing
  try {
    enqueueDiscovery(result.path, "write");
  } catch (err) {
    console.error(`[grove] discovery enqueue failed for ${result.path}:`, (err as Error).message);
  }

  // Fire-and-forget: re-embed the changed file. If it fails (network,
  // Voyage API down, rate limit, etc.) enqueue an embed_retry so the
  // discovery worker picks it up and retries with the ordinary poll
  // cadence. Stays silent on success; logs + retries on failure.
  embedFile(VAULT_PATH, result.path).catch((err) => {
    console.error(`[grove] embed-single failed for ${result.path}:`, err.message);
    try {
      enqueueDiscovery(result.path, "embed_retry");
    } catch (enqueueErr) {
      console.error(
        `[grove] embed_retry enqueue failed for ${result.path}:`,
        (enqueueErr as Error).message,
      );
    }
  });

  return result;
}

// ── Batch write ────────────────────────────────────────────────────

export interface BatchOperation {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
  /** Optimistic-concurrency check against recorded source_hash. */
  if_hash?: string;
  /**
   * Use the source_hash result of an earlier op in this batch (0-based
   * index). Lets a caller chain a create + update atomically without a
   * round-trip for the intermediate hash.
   */
  if_hash_from_op?: number;
}

export interface WriteBatchResult {
  results: WriteNoteResult[];
}

/**
 * Batched writes in a single mutex acquisition. Collapses N round-trips
 * into 1 and amortizes git overhead across the batch. Currently supports
 * write actions only (create/update) — move and delete batching remain
 * single-op for now.
 *
 * With `atomic: true` the batch either fully succeeds or rolls back:
 *   - git HEAD is reset to its pre-batch SHA (discards per-op commits)
 *   - provenance is restored to its pre-batch state for every touched path
 *   - the caller sees the original error
 *
 * With `atomic: false` (default), ops run in order and partial success is
 * possible — already-succeeded ops stay committed; the error stops the batch.
 */
export async function handleWriteBatch(
  operations: BatchOperation[],
  options: { atomic?: boolean; trail?: TrailConfig | null; keyName?: string; handle?: string } = {},
): Promise<WriteBatchResult> {
  if (operations.length === 0) {
    throw Object.assign(new Error("operations array is empty"), { code: "VALIDATION" });
  }
  const atomic = options.atomic ?? false;

  // Pre-flight: validate every op up front. Any failure here aborts before
  // the mutex is ever acquired — cheap feedback, no partial state risk.
  const validated: Array<{
    absPath: string;
    relPath: string;
    frontmatter: Record<string, unknown>;
    content: string;
    if_hash?: string;
    if_hash_from_op?: number;
  }> = [];
  const config = loadVaultConfig(VAULT_PATH);

  for (const [i, op] of operations.entries()) {
    if (!op || typeof op.path !== "string") {
      throw Object.assign(new Error(`op ${i}: path is required`), { code: "VALIDATION", errors: [`op ${i}: path is required`] });
    }
    if (options.trail && !trailAllowsWrite(options.trail, op.path)) {
      throw Object.assign(new Error(`op ${i}: path outside trail scope`), { code: "TRAIL_DENIED" });
    }
    let absPath: string;
    try {
      absPath = validatePath(VAULT_PATH, op.path);
    } catch (err: any) {
      throw Object.assign(new Error(`op ${i}: path error: ${err.message}`), { code: "VALIDATION", errors: [err.message] });
    }
    const relPath = relative(VAULT_PATH, absPath);
    const { errors } = validateNote(relPath, op.frontmatter ?? {}, op.content ?? "", config);
    if (errors.length > 0) {
      throw Object.assign(
        new Error(`op ${i}: validation errors:\n${errors.map((e) => `- ${e}`).join("\n")}`),
        { code: "VALIDATION", errors: errors.map((e) => `op ${i}: ${e}`) },
      );
    }
    if (op.if_hash_from_op !== undefined) {
      if (!Number.isInteger(op.if_hash_from_op) || op.if_hash_from_op < 0 || op.if_hash_from_op >= i) {
        throw Object.assign(
          new Error(`op ${i}: if_hash_from_op must be an integer < current op index`),
          { code: "VALIDATION", errors: [`op ${i}: if_hash_from_op out of range`] },
        );
      }
    }
    validated.push({
      absPath,
      relPath,
      frontmatter: op.frontmatter,
      content: op.content,
      if_hash: op.if_hash,
      if_hash_from_op: op.if_hash_from_op,
    });
  }

  // Execute inside the write mutex so no concurrent writer interleaves.
  const results = await writeQueue.enqueue(async () => {
    // Snapshot state for atomic rollback. Captured BEFORE any disk change.
    const preSha: string | null = atomic ? await gitRevParseHead(VAULT_PATH) : null;
    const preProvenance: Map<string, ReturnType<typeof getProvenance>> | null = atomic
      ? new Map(validated.map((v) => [v.relPath, getProvenance(v.relPath)]))
      : null;

    const collected: WriteNoteResult[] = [];
    try {
      for (const [i, op] of validated.entries()) {
        // Resolve chained if_hash references (no DB read — use batch-local result)
        let ifHash = op.if_hash;
        if (op.if_hash_from_op !== undefined) {
          ifHash = collected[op.if_hash_from_op]!.source_hash;
        }
        if (ifHash) assertIfHashMatches(op.relPath, op.absPath, ifHash);

        const r = await executeWriteInMutex({
          absPath: op.absPath,
          relPath: op.relPath,
          frontmatter: op.frontmatter,
          content: op.content,
          isNew: !ifHash,
          keyName: options.keyName,
          handle: options.handle,
        });
        collected.push(r);
      }
      return collected;
    } catch (err) {
      if (atomic && preSha && preProvenance) {
        // Roll back: hard-reset HEAD discards per-op commits + working-tree
        // changes. Then restore provenance table to its pre-batch shape so
        // future if_hash checks behave as if the batch never happened.
        try {
          await gitResetHard(VAULT_PATH, preSha);
        } catch (resetErr) {
          console.error(`[grove] batch rollback git reset failed: ${(resetErr as Error).message}`);
        }
        for (const [path, prior] of preProvenance) {
          if (prior === null) deleteProvenance(path);
          else setProvenanceRow(prior);
          invalidateFrontmatterCache(join(VAULT_PATH, path));
        }
      }
      throw err;
    }
  });

  // Post-batch fire-and-forget per path.
  for (const r of results) {
    try {
      enqueueDiscovery(r.path, "write");
    } catch (enqueueErr) {
      console.error(`[grove] discovery enqueue failed for ${r.path}:`, (enqueueErr as Error).message);
    }
    embedFile(VAULT_PATH, r.path).catch((err) => {
      console.error(`[grove] embed-single failed for ${r.path}:`, (err as Error).message);
      try {
        enqueueDiscovery(r.path, "embed_retry");
      } catch {
        /* swallow — already logged */
      }
    });
  }

  return { results };
}

// ── Delete ─────────────────────────────────────────────────────────

export interface DeleteNoteResult {
  action: "archived" | "deleted";
  original_path: string;
  archive_path?: string;
  commit: string;
}

/**
 * Delete a note. Soft delete (archive) by default — moves the file to the
 * configured archive_path with `archived_from` / `archived_at` frontmatter
 * and removes it from the search index. Hard delete (`hard: true`) removes
 * the file from disk entirely.
 *
 * Both variants go through the write queue and produce a single git commit
 * attributed to the caller. Returns { action, original_path, archive_path?, commit }.
 */
export async function handleDeleteNote(
  notePath: string,
  options: { hard?: boolean; ifHash?: string; trail?: TrailConfig | null; keyName?: string } = {},
): Promise<DeleteNoteResult> {
  // Validate source path
  let srcAbs: string;
  try {
    srcAbs = validatePath(VAULT_PATH, notePath);
  } catch (err: any) {
    throw Object.assign(new Error(`Path error: ${err.message}`), { code: "VALIDATION", errors: [err.message] });
  }
  const srcRel = relative(VAULT_PATH, srcAbs);

  if (!existsSync(srcAbs)) {
    throw Object.assign(new Error("Note not found"), { code: "NOT_FOUND" });
  }

  // Trail scope check — source must be allowed, and for soft delete the
  // archive destination must also be allowed (otherwise the trail could
  // write outside its scope by deleting).
  if (options.trail) {
    if (!trailAllowsWrite(options.trail, srcRel)) {
      throw Object.assign(new Error("Delete not allowed: path outside trail scope"), { code: "TRAIL_DENIED" });
    }
  }

  // Optimistic concurrency check (prefers provenance, falls back to disk).
  if (options.ifHash) assertIfHashMatches(srcRel, srcAbs, options.ifHash);

  const who = options.keyName ? `grove (${options.keyName})` : "grove (api)";

  if (options.hard) {
    const sha = await writeQueue.enqueue(async () => {
      // Unlink from working tree only; `git add -A -- <path>` in
      // gitCommitPaths stages the deletion for tracked-but-missing files.
      // (Using `git rm` removes the index entry too, which makes a later
      // `git add -A -- <path>` fail with "pathspec did not match any files".)
      unlinkSync(srcAbs);
      invalidateFrontmatterCache(srcAbs);
      const commitSha = await gitCommitPaths(VAULT_PATH, [srcRel], `${who}: delete ${srcRel}`);
      qmdReindex(srcRel).catch(() => {});
      deleteProvenance(srcRel);
    // refreshStats moved to 5-min timer — computing on every write blocks the event loop (CPU-bound graph analysis). See vault-stats.ts startStatsTimer.
      return commitSha;
    });
    return { action: "deleted", original_path: srcRel, commit: sha };
  }

  // Soft delete — compute archive destination and enforce trail scope on it too.
  const config = loadVaultConfig(VAULT_PATH);
  const archiveRoot = config.structure.archive_path; // e.g. "Archives/"
  const archiveRel = `${archiveRoot}${srcRel}`;

  let archiveAbs: string;
  try {
    archiveAbs = validatePath(VAULT_PATH, archiveRel);
  } catch (err: any) {
    throw Object.assign(new Error(`Archive path error: ${err.message}`), { code: "VALIDATION", errors: [err.message] });
  }

  if (options.trail && !trailAllowsWrite(options.trail, archiveRel)) {
    throw Object.assign(
      new Error(`Archive destination ${archiveRel} outside trail scope — use ?hard=true to delete instead`),
      { code: "TRAIL_DENIED" },
    );
  }

  if (existsSync(archiveAbs)) {
    throw Object.assign(new Error(`Archive destination already exists: ${archiveRel}`), { code: "CONFLICT" });
  }

  const sha = await writeQueue.enqueue(async () => {
    const raw = readNoteFile(srcAbs);
    const { frontmatter, content } = parseNote(raw);
    const archivedFm: Record<string, unknown> = {
      ...frontmatter,
      archived_from: srcRel,
      archived_at: new Date().toISOString(),
    };
    const serialized = serializeNote(archivedFm, content);

    const archiveDir = dirname(archiveAbs);
    if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
    writeNoteFile(archiveAbs, serialized);
    invalidateFrontmatterCache(archiveAbs);

    // Unlink source from working tree; gitCommitPaths's `git add -A -- ...`
    // stages the deletion (tracked-but-missing file) alongside the new archive.
    unlinkSync(srcAbs);
    invalidateFrontmatterCache(srcAbs);

    const commitSha = await gitCommitPaths(
      VAULT_PATH,
      [srcRel, archiveRel],
      `${who}: archive ${srcRel}`,
    );
    qmdReindex(srcRel).catch(() => {});
    // Archive path has new content (added archived_from/archived_at to frontmatter),
    // so we record a fresh source_hash rather than renaming the old provenance.
    deleteProvenance(srcRel);
    recordWrite(archiveRel, contentHash(serialized), commitSha, options.keyName ?? "api");
    // refreshStats moved to 5-min timer — computing on every write blocks the event loop (CPU-bound graph analysis). See vault-stats.ts startStatsTimer.
    return commitSha;
  });

  return { action: "archived", original_path: srcRel, archive_path: archiveRel, commit: sha };
}

// ── Move ───────────────────────────────────────────────────────────

export interface MoveNoteResult {
  action: "moved";
  from: string;
  to: string;
  links_updated: number;
  commit: string;
  /**
   * Hash of caller-written content (stable across discovery mutations).
   * Use as `if_hash` in subsequent updates.
   */
  source_hash: string;
  content_hash: string;
  url: string;
}

/**
 * Move or rename a note. Validates both source and destination paths,
 * refuses to overwrite an existing destination, moves the file via `git mv`,
 * scans the vault for wikilinks pointing to the old path/basename/aliases
 * and rewrites them in place. All changes land in a single commit.
 */
export async function handleMoveNote(
  notePath: string,
  newPath: string,
  options: { ifHash?: string; trail?: TrailConfig | null; keyName?: string; handle?: string } = {},
): Promise<MoveNoteResult> {
  // Validate both paths
  let srcAbs: string;
  try {
    srcAbs = validatePath(VAULT_PATH, notePath);
  } catch (err: any) {
    throw Object.assign(new Error(`Source path error: ${err.message}`), { code: "VALIDATION", errors: [err.message] });
  }
  let dstAbs: string;
  try {
    dstAbs = validatePath(VAULT_PATH, newPath);
  } catch (err: any) {
    throw Object.assign(new Error(`Destination path error: ${err.message}`), { code: "VALIDATION", errors: [err.message] });
  }

  const srcRel = relative(VAULT_PATH, srcAbs);
  const dstRel = relative(VAULT_PATH, dstAbs);

  if (srcRel === dstRel) {
    throw Object.assign(new Error("Destination is the same as source"), { code: "VALIDATION", errors: ["source and destination must differ"] });
  }

  if (!existsSync(srcAbs)) {
    throw Object.assign(new Error("Source note not found"), { code: "NOT_FOUND" });
  }
  if (existsSync(dstAbs)) {
    throw Object.assign(new Error(`Destination already exists: ${dstRel}`), { code: "CONFLICT" });
  }

  // Trail scope: must allow both source and destination
  if (options.trail) {
    if (!trailAllowsWrite(options.trail, srcRel)) {
      throw Object.assign(new Error("Move not allowed: source outside trail scope"), { code: "TRAIL_DENIED" });
    }
    if (!trailAllowsWrite(options.trail, dstRel)) {
      throw Object.assign(new Error("Move not allowed: destination outside trail scope"), { code: "TRAIL_DENIED" });
    }
  }

  // Optimistic concurrency check (prefers provenance, falls back to disk).
  if (options.ifHash) assertIfHashMatches(srcRel, srcAbs, options.ifHash);

  // Read aliases for wikilink rewriting
  let aliases: string[] = [];
  try {
    const { frontmatter } = parseNote(readNoteFile(srcAbs));
    if (Array.isArray(frontmatter.aliases)) {
      aliases = (frontmatter.aliases as unknown[]).filter((a): a is string => typeof a === "string");
    }
  } catch {
    // If we can't read, skip alias rewriting
  }

  const who = options.keyName ? `grove (${options.keyName})` : "grove (api)";

  const result = await writeQueue.enqueue(async () => {
    // Ensure destination directory exists (git mv requires it)
    const dstDir = dirname(dstAbs);
    if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });

    await gitMv(VAULT_PATH, srcRel, dstRel);
    invalidateFrontmatterCache(srcAbs);
    invalidateFrontmatterCache(dstAbs);

    const modified = updateWikilinks(VAULT_PATH, srcRel, dstRel, aliases);

    const paths = [srcRel, dstRel, ...modified];
    const commitSha = await gitCommitPaths(
      VAULT_PATH,
      paths,
      `${who}: move ${srcRel} → ${dstRel}`,
    );

    qmdReindex(dstRel).catch(() => {});
    // refreshStats moved to 5-min timer — computing on every write blocks the event loop (CPU-bound graph analysis). See vault-stats.ts startStatsTimer.

    // The moved file's own content is unchanged by the move (only its path),
    // so rename its provenance to preserve the caller's source_hash. Other
    // files whose wikilinks were rewritten are treated like discovery
    // mutations — no provenance update, source_hash stays pinned to caller
    // intent for those files.
    renameProvenance(srcRel, dstRel);

    const finalRaw = readNoteFile(dstAbs);
    const diskHash = contentHash(finalRaw);
    return {
      commit: commitSha,
      links_updated: modified.length,
      // Prefer the preserved source_hash from provenance (survived the
      // rename); fall back to disk hash for files that had no provenance
      // (pre-migration, or never written through the API).
      source_hash: getSourceHash(dstRel) ?? diskHash,
      content_hash: diskHash,
    };
  });

  // Fire-and-forget: re-embed the moved note. Retry via discovery queue on failure.
  embedFile(VAULT_PATH, dstRel).catch((err) => {
    console.error(`[grove] embed-single failed for ${dstRel}:`, err.message);
    try {
      enqueueDiscovery(dstRel, "embed_retry");
    } catch (enqueueErr) {
      console.error(
        `[grove] embed_retry enqueue failed for ${dstRel}:`,
        (enqueueErr as Error).message,
      );
    }
  });

  return {
    action: "moved",
    from: srcRel,
    to: dstRel,
    links_updated: result.links_updated,
    commit: result.commit,
    source_hash: result.source_hash,
    content_hash: result.content_hash,
    url: noteUrl(dstRel, options.handle ?? getVaultOwnerHandle()),
  };
}

// ── Image upload ───────────────────────────────────────────────────

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_NOTE_PREFIX = "Resources/Images/";

export interface ImageUploadInput {
  file: Buffer;
  contentType: string;
  filename?: string;
  path?: string;
  tags?: string[];
}

export interface ImageUploadResult {
  image_url: string;
  thumbnail_url: string;
  note_path: string;
  content_hash: string;
  auto_tags: string[];
  description: string;
  ocr_text: string;
  dimensions: { width: number; height: number };
  url: string;
  enrichment_pending: boolean;
}

/** Read image dimensions from header bytes. Returns {0,0} if unrecognized. */
export function readImageDimensions(data: Buffer, contentType: string): { width: number; height: number } {
  try {
    if (contentType === "image/png" && data.length >= 24) {
      // PNG IHDR: width at offset 16, height at offset 20 (big-endian u32)
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    }
    if ((contentType === "image/jpeg" || contentType === "image/jpg") && data.length > 4) {
      // Scan JPEG SOF markers
      let i = 2;
      while (i < data.length) {
        if (data[i] !== 0xff) break;
        const marker = data[i + 1];
        const segLen = data.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = data.readUInt16BE(i + 5);
          const width = data.readUInt16BE(i + 7);
          return { width, height };
        }
        i += 2 + segLen;
      }
    }
    if (contentType === "image/gif" && data.length >= 10) {
      return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    }
    if (contentType === "image/webp" && data.length >= 30) {
      // VP8L chunk: bits at offset 21; VP8X at offset 24. Handle VP8 (lossy) simple form.
      const chunk = data.slice(12, 16).toString("ascii");
      if (chunk === "VP8 ") {
        return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === "VP8L") {
        const b0 = data[21], b1 = data[22], b2 = data[23], b3 = data[24];
        const width = 1 + (((b1 & 0x3f) << 8) | b0);
        const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        return { width, height };
      }
      if (chunk === "VP8X") {
        const width = 1 + (data[24] | (data[25] << 8) | (data[26] << 16));
        const height = 1 + (data[27] | (data[28] << 8) | (data[29] << 16));
        return { width, height };
      }
    }
  } catch {
    // fall through to unknown
  }
  return { width: 0, height: 0 };
}

/** Derive a kebab-case slug from the first few words of the description. */
export function slugFromDescription(description: string, hash: string): string {
  const trimmed = description
    .toLowerCase()
    .split(/\s+/)
    .slice(0, 6)
    .join(" ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (trimmed.length >= 3) return trimmed;
  return `image-${hash.slice(0, 12)}`;
}

type VaultIdResolver = () => string;
let vaultIdResolver: VaultIdResolver = () => process.env.GROVE_VAULT_ID ?? "life";

/** Override vault-id resolution (tests). */
export function setVaultIdResolver(fn: VaultIdResolver): void {
  vaultIdResolver = fn;
}

type AutoTagFn = (data: Buffer, contentType: string) => Promise<ImageTagResult>;
let autoTagFn: AutoTagFn = autoTagImage;

/** Override auto-tag fn (tests). */
export function setAutoTagFn(fn: AutoTagFn): void {
  autoTagFn = fn;
}

type ImageStoreResolver = () => ImageStore;
let imageStoreResolver: ImageStoreResolver = () => getImageStore();

/** Override image-store resolver (tests). */
export function setImageStoreResolver(fn: ImageStoreResolver): void {
  imageStoreResolver = fn;
}

/** Slugify a raw filename stem for use as an image note path. */
function slugFromFilename(filename: string | undefined, hash: string): string {
  if (!filename) return `image-${hash.slice(0, 12)}`;
  const stem = filename.replace(/\.[^.]+$/, "");
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug.length >= 3 ? slug : `image-${hash.slice(0, 12)}`;
}

/**
 * Upload an image (fast path): stores bytes in R2, creates a stub companion
 * note, returns immediately. Vision auto-tagging runs asynchronously via the
 * discovery queue — the client gets a URL + path in ~2s instead of 10s+.
 *
 * Failure semantics:
 *   - R2 upload failure → throw (nothing to recover; retry is the client's job)
 *   - Note write failure → throw (R2 blob is harmless leftover; dedup by hash)
 *   - Vision tagging failure → image + stub note persist; enrichment retries
 */
export async function handleImageUpload(
  input: ImageUploadInput,
  options: { trail?: TrailConfig | null; keyName?: string; handle?: string } = {},
): Promise<ImageUploadResult> {
  // Validate size
  if (input.file.length === 0) {
    throw Object.assign(new Error("empty file"), { code: "VALIDATION" });
  }
  if (input.file.length > IMAGE_MAX_BYTES) {
    throw Object.assign(new Error("image exceeds 10MB limit"), { code: "PAYLOAD_TOO_LARGE" });
  }

  // Validate content type → extension
  const ext = extForContentType(input.contentType);
  if (!ext) {
    throw Object.assign(new Error(`unsupported content type: ${input.contentType}`), { code: "VALIDATION" });
  }

  // Compute content-addressed key
  const vaultId = vaultIdResolver();
  const key = contentKey(vaultId, input.file, ext);
  const hash = key.split("/").pop()!.replace(/\.[^.]+$/, "");

  // Upload to R2 (unavoidable — must succeed before the note can reference it)
  const store = imageStoreResolver();
  const uploaded = await store.upload(key, input.file, input.contentType);

  // Thumbnail: TODO integrate sharp for real resize — for now reuse the original URL.
  const thumbnailUrl = store.getUrl(key);

  // Dimensions from header bytes — cheap, synchronous
  const dimensions = readImageDimensions(input.file, input.contentType);

  // Derive an initial path from the filename (enrichment can rename later
  // via a separate move op if the user wants a description-based slug).
  const userTags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const slug = slugFromFilename(input.filename, hash);
  const notePath = input.path ?? `${IMAGE_NOTE_PREFIX}${slug}.md`;

  // Enforce trail-scoped writes
  if (options.trail && !trailAllowsWrite(options.trail, notePath)) {
    throw Object.assign(new Error("Write not allowed: path outside trail scope"), { code: "TRAIL_DENIED" });
  }

  const title = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const frontmatter: Record<string, unknown> = {
    type: "image",
    // Always include 'image' + any user-supplied tags. Vision tags are
    // merged in later during enrichment.
    tags: Array.from(new Set(["image", ...userTags])),
    image_url: uploaded.url,
    thumbnail_url: thumbnailUrl,
    content_hash: hash,
    dimensions,
    uploaded_at: new Date().toISOString(),
    enrichment_pending: true,
  };

  const placeholderDescription =
    `Image uploaded ${new Date().toISOString().slice(0, 10)} — awaiting enrichment.`;
  const content = `# ${title}\n\n${placeholderDescription}\n\n![${title}](${uploaded.url})\n`;

  // Write the stub note (validates + commits + reindexes + fires embed)
  const noteResult = await handleWriteNote(notePath, frontmatter, content, {
    trail: options.trail,
    keyName: options.keyName,
    handle: options.handle,
  });

  // Queue async enrichment (Vision description + tags + OCR → rewrite note)
  try {
    enqueueDiscovery(noteResult.path, "image_enrich");
  } catch (err) {
    console.error(
      `[grove] image_enrich enqueue failed for ${noteResult.path}:`,
      (err as Error).message,
    );
  }

  return {
    image_url: uploaded.url,
    thumbnail_url: thumbnailUrl,
    note_path: noteResult.path,
    content_hash: hash,
    auto_tags: [],
    description: placeholderDescription,
    ocr_text: "",
    dimensions,
    url: noteResult.url,
    enrichment_pending: true,
  };
}

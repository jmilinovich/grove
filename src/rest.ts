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
import {
  composeCommitMessage,
  provenanceToTrailers,
  validateCallerProvenance,
  type Provenance,
} from "./provenance.js";
import {
  computeProvenanceFields,
  type BlameSegment,
} from "./blame.js";
import { loadVaultConfig, entityFolders } from "./vault-config.js";
import { filterByTrail, trailAllowsWrite, getTrailPublicInfo, getTrailConfig, type TrailConfig, type NoteMetadata } from "./trails.js";
import { getStats } from "./vault-stats.js";
import { computeDigest } from "./vault-graph.js";
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
import { type VaultContext } from "./vault-router.js";

/**
 * Build a `VaultContext` from the legacy single-vault env vars.
 *
 * Used by tests and any caller that doesn't (yet) supply a real per-request
 * context. Production traffic comes through the proxy, which always builds a
 * context from the routed vault row — so this fallback only matters for
 * unit-test invocations and the tail end of the legacy code path that hasn't
 * threaded `ctx` through yet.
 */
export function defaultVaultContext(): VaultContext {
  return {
    vaultPath: process.env.GROVE_VAULT ?? join(homedir(), "life"),
    vaultId: process.env.GROVE_VAULT_ID ?? "vault_00000000",
    vaultSlug: process.env.GROVE_VAULT_SLUG ?? "personal",
  };
}

// ── Per-vault write queues (serializes writes within each vault) ────
// One PM2 process serves many vaults via the proxy, so we can't reuse a
// single module-level queue — that would force vault X's writes to wait
// behind vault Y's git op. Each vault gets its own queue, lazily created
// on first write. CLAUDE.md rule #3 (writes serialized per-repo) holds
// inside each queue; cross-vault writes proceed in parallel.

const writeQueueByVault = new Map<string, WriteQueue>();

function getWriteQueue(ctx: VaultContext): WriteQueue {
  let q = writeQueueByVault.get(ctx.vaultId);
  if (!q) {
    q = new WriteQueue();
    // Capture vaultPath at queue-creation time — this closure runs after
    // every drain to push the per-vault repo. The map keys by vault_id so
    // a vault can never silently bind to a different path mid-process.
    const pushPath = ctx.vaultPath;
    q.schedulePush(() => gitPush(pushPath));
    writeQueueByVault.set(ctx.vaultId, q);
  }
  return q;
}

/** Flush pending writes across every known vault — call on graceful shutdown. */
export async function flushWriteQueue(): Promise<void> {
  await Promise.all(
    Array.from(writeQueueByVault.values()).map((q) => q.flush()),
  );
}

import { noteUrl, vaultOwnerHandle } from "./url.js";

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

async function resolveNote(
  ctx: VaultContext,
  file: string,
  opts?: { exact?: boolean },
): Promise<ResolvedNote | null> {
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
  const abs = sanitizePath(ctx.vaultPath, filePath);
  if (!abs) return null;
  if (existsSync(abs)) return readNote(abs, filePath);

  // When `opts.exact` is set (share resolution, direct URL navigation),
  // skip every fuzzy fallback below. The fallbacks are useful for
  // wikilink resolution but are a cross-boundary leak vector when the
  // caller has a specific path they want exactly.
  if (opts?.exact) return null;

  // 3. Case-insensitive full path match (handles Resources/ vs resources/)
  const allNotes = listNotes(ctx.vaultPath, "*");
  const filePathLower = filePath.toLowerCase();
  const pathMatch = allNotes.find((n) => n.path.toLowerCase() === filePathLower);
  if (pathMatch) {
    const matchAbs = join(ctx.vaultPath, pathMatch.path);
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
      const journalAbs = join(ctx.vaultPath, journalPath);
      if (existsSync(journalAbs)) return readNote(journalAbs, journalPath, file);
    }
  }

  // 6. Case-insensitive basename search
  const searchLower = searchTerm.toLowerCase();
  const nameMatch = allNotes.find((n) => n.name.toLowerCase() === searchLower);
  if (nameMatch) {
    const matchAbs = join(ctx.vaultPath, nameMatch.path);
    if (existsSync(matchAbs)) return readNote(matchAbs, nameMatch.path, file);
  }

  // 6b. Kebab-case basename match (QMD index uses kebab-case, filesystem uses spaces/punctuation)
  const toKebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const searchKebab = toKebab(searchTerm);
  const kebabMatch = allNotes.find((n) => toKebab(n.name) === searchKebab);
  if (kebabMatch) {
    const matchAbs = join(ctx.vaultPath, kebabMatch.path);
    if (existsSync(matchAbs)) return readNote(matchAbs, kebabMatch.path, file);
  }

  // 6c. Codepoint-slug basename match — QMD's indexer encodes non-ASCII
  // characters (emoji, etc.) as their lowercase Unicode codepoint
  // hex wrapped in hyphens. Grove's `toKebab` drops those codepoints
  // entirely, so slugs like `...have-fun-1faf6-system` (🫶) never
  // match. Strip sequences of 4-6 hex chars (requiring at least one
  // a-f letter so year dates like `-2026-` don't get clobbered) from
  // the incoming query and retry the kebab comparison.
  const searchKebabCollapsed = searchKebab
    .replace(/-[0-9a-f]*[a-f][0-9a-f]*-/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (searchKebabCollapsed !== searchKebab) {
    const collapsedMatch = allNotes.find(
      (n) => toKebab(n.name) === searchKebabCollapsed,
    );
    if (collapsedMatch) {
      const matchAbs = join(ctx.vaultPath, collapsedMatch.path);
      if (existsSync(matchAbs)) return readNote(matchAbs, collapsedMatch.path, file);
    }
  }

  // 7. Alias search
  const aliasNotes = listNotes(ctx.vaultPath, "*", { includeAliases: true });
  const aliasMatch = aliasNotes.find(
    (n) => n.aliases?.some((a: string) => a.toLowerCase() === searchLower),
  );
  if (aliasMatch) {
    const matchAbs = join(ctx.vaultPath, aliasMatch.path);
    if (existsSync(matchAbs)) return readNote(matchAbs, aliasMatch.path, file);
  }

  // 8. BM25 fallback — scoped to this vault's QMD collection so the
  // fallback never resolves a wikilink to a note in a different vault.
  const collection = ctx.vaultPath.split("/").filter(Boolean).pop() ?? "";
  try {
    const results = await bm25Search(searchTerm, 3, collection);
    if (results.length > 0) {
      const resolvedLower = results[0].vault_path.toLowerCase();
      const realNote = allNotes.find((n) => n.path.toLowerCase() === resolvedLower);
      const realPath = realNote?.path ?? results[0].vault_path;
      const resolvedAbs = join(ctx.vaultPath, realPath);
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

// Per-vault backlink cache — rebuilt lazily, invalidated on a timer.
// Each vault has its own cache so cross-vault traffic doesn't churn one
// shared index. Key by vault_id (not vaultPath) so renames or fs-link
// changes don't accidentally split the cache.
const backlinkIndexByVault = new Map<string, { index: Map<string, string[]>; age: number }>();
const BACKLINK_TTL_MS = 60_000; // rebuild every 60s max

function getBacklinkIndex(ctx: VaultContext): Map<string, string[]> {
  const cached = backlinkIndexByVault.get(ctx.vaultId);
  if (cached && Date.now() - cached.age < BACKLINK_TTL_MS) {
    return cached.index;
  }

  const index = new Map<string, string[]>();
  const files = walkMd(ctx.vaultPath);

  for (const abs of files) {
    const srcPath = relative(ctx.vaultPath, abs);
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

  backlinkIndexByVault.set(ctx.vaultId, { index, age: Date.now() });
  return index;
}

function getBacklinks(ctx: VaultContext, notePath: string): string[] {
  const noteName = basename(notePath, ".md");
  const index = getBacklinkIndex(ctx);
  return index.get(noteName) ?? [];
}

// ── Wikilink resolution (batch) ─────────────────────────────────────
// For each wikilink target in a note, resolve it to a vault path.

async function resolveLinks(
  ctx: VaultContext,
  targets: string[],
): Promise<Record<string, { path: string | null; exists: boolean }>> {
  const allNotes = listNotes(ctx.vaultPath, "*");
  const aliasNotes = listNotes(ctx.vaultPath, "*", { includeAliases: true });
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
  /**
   * Per-segment authorship attribution computed via git blame +
   * Provenance-* trailer parse from each blame commit. Present when the
   * GROVE_PROVENANCE_ENABLED feature flag is on. Each segment covers a
   * contiguous run of lines; voice="legacy-unknown" means the originating
   * commit had no Provenance-* trailers (pre-rollout, discovery worker,
   * external manual write) and the read directive treats those as
   * transparent.
   */
  provenance_blame?: BlameSegment[];
  /**
   * True when any segment in provenance_blame has voice="perishable".
   * Lifted to the response envelope so a Claude consumer can branch on it
   * without scanning the full blame array. The read-site directive in the
   * MCP tool description requires Claude to name perishable segments
   * before extending or building on them.
   */
  has_perishable_segments?: boolean;
  /**
   * Imperative usage directive emitted only when has_perishable_segments
   * is true. Mirrors the language in the MCP tool description so the
   * directive is reinforced per-call, not just once-per-conversation.
   */
  usage_directive?: string;
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
export function handleResidentProfile(_ctx: VaultContext, handle: string): ResidentProfile | null {
  if (!handle) return null;
  const db = getDb();
  const row = db
    .prepare("SELECT id, username, display_name, bio FROM users WHERE username = ?")
    .get(handle) as
    | { id: string; username: string; display_name: string | null; bio: string | null }
    | undefined;
  if (!row) return null;

  // Public profile: don't leak a note count. The previous shape
  // computed it from whichever vault `ctx` happened to point at
  // (usually the proxy's default), which fingerprinted private
  // activity in that vault to every anonymous viewer of the
  // profile. When public-trail-based counting is re-introduced it
  // will come from an explicit `trails + memberships` query, not a
  // filesystem walk.
  return {
    handle: row.username,
    display_name: row.display_name,
    bio: row.bio,
    public_trail_slugs: [],
    note_count: 0,
  };
}

export function handleTrailInfo(ctx: VaultContext, trailId: string): TrailInfoResponse | null {
  const info = getTrailPublicInfo(trailId);
  if (!info || !info.enabled) return null;

  // Count notes matching trail filters
  const config = getTrailConfig(trailId);
  let noteCount = 0;
  if (config) {
    const allNotes = listNotes(ctx.vaultPath, "*");
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

  // Trails don't carry an explicit owner column — the vault's owner is the
  // trail's effective owner. The legacy `/trails/:slug` page uses this to
  // 301 to `/@<handle>/trails/:slug` (P16-3). `vaultOwnerHandle(ctx)`
  // returns "unknown" on empty databases; normalize that to null so the
  // client can skip the redirect rather than hit `/@unknown`.
  const rawOwner = vaultOwnerHandle(ctx);
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
export async function handleGetNote(
  ctx: VaultContext,
  notePath: string,
  trail?: TrailConfig | null,
  opts?: { exact?: boolean },
): Promise<NoteResponse | null> {
  const note = await resolveNote(ctx, notePath, opts);
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
  const links = await resolveLinks(ctx, targets);

  // Trail filter wikilinks: mark trail-invisible notes as non-existent
  if (trail) {
    for (const [target, info] of Object.entries(links)) {
      if (info.exists && info.path) {
        try {
          const linkAbs = join(ctx.vaultPath, info.path + ".md");
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
  let backlinks = getBacklinks(ctx, note.path);
  if (trail) {
    backlinks = backlinks.filter((bl) => {
      try {
        const abs = join(ctx.vaultPath, bl);
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

  const sourceHash = getSourceHash(note.path) ?? note.content_hash;
  const provFields = await computeProvenanceFields(ctx.vaultPath, note.path, sourceHash);

  return {
    path: note.path,
    frontmatter: note.frontmatter,
    content: note.content,
    source_hash: sourceHash,
    content_hash: note.content_hash,
    links,
    backlinks,
    ...(note.resolved_from && { resolved_from: note.resolved_from }),
    ...provFields,
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
function readImageMetadata(ctx: VaultContext, notePath: string): Pick<ListEntry, "thumbnail_url" | "image_url" | "dimensions" | "description"> {
  try {
    const abs = join(ctx.vaultPath, notePath);
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
export function handleListNotes(ctx: VaultContext, prefix: string, trail?: TrailConfig | null, type?: string | null): ListEntry[] {
  // Empty prefix means "list all notes" (for sidebar folder discovery)
  const dirPrefix = prefix === "" ? "" : (prefix.endsWith("/") ? prefix : prefix + "/");
  const allNotes = listNotes(ctx.vaultPath, "*");

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
      if (n.type === "image") Object.assign(base, readImageMetadata(ctx, n.path));
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
  ctx: VaultContext,
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

  const allNotes = listNotes(ctx.vaultPath, "*");
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
  ctx: VaultContext,
  notePath: string,
  scope: TrailPreviewScope,
): TrailPreviewTestResult | null {
  const allNotes = listNotes(ctx.vaultPath, "*");
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
export async function handleSearch(ctx: VaultContext, query: string, limit: number = 10, trail?: TrailConfig | null, handle?: string): Promise<SearchResult[]> {
  const fetchLimit = trail ? limit * 3 : limit; // over-fetch for trail filtering
  // Derive the QMD collection from the vault's on-disk basename so
  // multi-vault deployments don't return another vault's notes.
  // Matches vault-stats.ts's derivation.
  const collection = ctx.vaultPath.split("/").filter(Boolean).pop() ?? "";
  const results = await hybridSearch(query, fetchLimit, collection);

  const residentHandle = handle ?? vaultOwnerHandle(ctx);

  // Resolve QMD's lowercase-kebab paths to real filesystem paths.
  // QMD index stores e.g. "resources/concepts/meditation-mindfulness.md"
  // but the filesystem has "Resources/Concepts/Meditation & Mindfulness.md".
  const allNotes = listNotes(ctx.vaultPath, "*");
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
      url: noteUrl(ctx, realPath, residentHandle),
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
  ctx: VaultContext,
  sections?: string[],
  trail?: TrailConfig | null,
  isAdmin?: boolean,
): Record<string, unknown> | null {
  const stats = getStats(ctx.vaultPath);
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

export type StatusMode = "health" | "history" | "diagnostics" | "digest";

export const VALID_STATUS_MODES = new Set<StatusMode>(["health", "history", "diagnostics", "digest"]);

/**
 * Health: doc count, freshness, lifecycle, folder/type breakdown.
 */
export function handleStatusHealth(ctx: VaultContext, trail?: TrailConfig | null): Record<string, unknown> | null {
  const stats = getStats(ctx.vaultPath);
  if (!stats) return null;

  const result: Record<string, unknown> = {
    total_notes: stats.vault.total_notes,
    vault_path: ctx.vaultPath,
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
  ctx: VaultContext,
  since?: string,
  pathPrefix?: string,
): Promise<{ entries: unknown[] }> {
  const entries = await gitLog(ctx.vaultPath, {
    since: since ?? "1 week ago",
    pathPrefix: pathPrefix ?? undefined,
  });
  return { entries: entries.slice(0, 30) };
}

/**
 * Diagnostics: orphan notes, broken links, missing frontmatter, stale inbox.
 */
export function handleStatusDiagnostics(ctx: VaultContext): Record<string, unknown> {
  const notes = listNotes(ctx.vaultPath, "*", { includeAliases: true });

  const config = loadVaultConfig(ctx.vaultPath);
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
    const abs = join(ctx.vaultPath, note.path);
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
 * Digest: garden lifecycle — seeds, sprouts, growing, mature, dormant, withering.
 */
export async function handleStatusDigest(ctx: VaultContext): Promise<Record<string, unknown>> {
  return await computeDigest(ctx.vaultPath) as unknown as Record<string, unknown>;
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
  // Aggregate write-queue stats across every per-vault queue. depth is a
  // sum; oldest_queued_age_ms is the max so the worst-case latency is what
  // operators see (matches the legacy single-queue semantics).
  let depthSum = 0;
  let oldestAge = 0;
  for (const q of writeQueueByVault.values()) {
    depthSum += q.depth();
    const age = q.oldestQueuedAgeMs();
    if (age > oldestAge) oldestAge = age;
  }
  return {
    uptime_seconds: toolMetrics.uptime_seconds,
    total_requests: toolMetrics.total_requests,
    total_errors: toolMetrics.total_errors,
    error_rate: toolMetrics.error_rate,
    tools: toolMetrics.by_tool,
    search: searchMetrics.getSearchStats(),
    write_queue: {
      depth: depthSum,
      oldest_queued_age_ms: oldestAge,
      vaults: writeQueueByVault.size,
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
  ctx: VaultContext;
  absPath: string;
  relPath: string;
  frontmatter: Record<string, unknown>;
  content: string;
  isNew: boolean;
  keyName?: string;
  handle?: string;
  provenance?: Provenance;
}): Promise<WriteNoteResult> {
  const { ctx, absPath, relPath, frontmatter, content, isNew, keyName, handle, provenance } = params;

  const serialized = serializeNote(frontmatter, content);
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeNoteFile(absPath, serialized);
  invalidateFrontmatterCache(absPath);

  const action = isNew ? "create" : "update";
  const who = keyName ? `grove (${keyName})` : "grove (api)";
  const subject = `${who}: ${action} ${relPath}`;
  const commitMsg = provenance
    ? composeCommitMessage(subject, provenanceToTrailers(provenance))
    : subject;
  const sha = await gitCommit(ctx.vaultPath, relPath, commitMsg);

  const sourceHash = contentHash(serialized);
  recordWrite(relPath, sourceHash, sha, keyName ?? "api");

  qmdReindex(ctx.vaultPath).catch(() => {});

  return {
    path: relPath,
    action,
    source_hash: sourceHash,
    content_hash: sourceHash,
    commit: sha,
    url: noteUrl(ctx, relPath, handle),
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
  ctx: VaultContext,
  notePath: string,
  frontmatter: Record<string, unknown>,
  content: string,
  options: {
    ifHash?: string;
    trail?: TrailConfig | null;
    keyName?: string;
    handle?: string;
    provenance?: Provenance;
  },
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
    absPath = validatePath(ctx.vaultPath, notePath);
  } catch (err: any) {
    throw Object.assign(new Error(`Path error: ${err.message}`), { code: "VALIDATION", errors: [err.message] });
  }
  const relPath = relative(ctx.vaultPath, absPath);

  // Validate note structure (config drives type_paths + tag rules + journal pattern)
  const { errors } = validateNote(relPath, frontmatter, content, loadVaultConfig(ctx.vaultPath));
  if (errors.length > 0) {
    throw Object.assign(new Error(`Validation errors:\n${errors.map((e) => `- ${e}`).join("\n")}`), { code: "VALIDATION", errors });
  }

  // Validate provenance (rejects legacy-unknown from callers, malformed timestamps, etc.)
  if (options.provenance) {
    try {
      validateCallerProvenance(options.provenance);
    } catch (err: any) {
      throw Object.assign(new Error(`Provenance: ${err.message}`), {
        code: "VALIDATION",
        errors: [err.message],
      });
    }
  }

  // Optimistic concurrency check (prefers provenance, falls back to disk).
  if (options.ifHash) assertIfHashMatches(relPath, absPath, options.ifHash);

  // Enqueue the write. All disk + git work is done by executeWriteInMutex,
  // so single writes and batched writes share identical semantics.
  const result = await getWriteQueue(ctx).enqueue(() => executeWriteInMutex({
    ctx,
    absPath,
    relPath,
    frontmatter,
    content,
    isNew: !options.ifHash,
    keyName: options.keyName,
    handle: options.handle,
    provenance: options.provenance,
  }));

  // Enqueue for discovery processing — tag the row with the writing vault
  // so the per-vault discovery worker (which scopes its dequeue by
  // vault_id) actually picks it up.
  try {
    enqueueDiscovery(result.path, "write", ctx.vaultId);
  } catch (err) {
    console.error(`[grove] discovery enqueue failed for ${result.path}:`, (err as Error).message);
  }

  // Fire-and-forget: re-embed the changed file. If it fails (network,
  // Voyage API down, rate limit, etc.) enqueue an embed_retry so the
  // discovery worker picks it up and retries with the ordinary poll
  // cadence. Stays silent on success; logs + retries on failure.
  embedFile(ctx.vaultPath, result.path).catch((err) => {
    console.error(`[grove] embed-single failed for ${result.path}:`, err.message);
    try {
      enqueueDiscovery(result.path, "embed_retry", ctx.vaultId);
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
  /**
   * Provenance for this op's commit. Each op gets its own commit and its
   * own trailer set; ops in a single batch can mix human + claude voices.
   */
  provenance?: Provenance;
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
  ctx: VaultContext,
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
    provenance?: Provenance;
  }> = [];
  const config = loadVaultConfig(ctx.vaultPath);

  for (const [i, op] of operations.entries()) {
    if (!op || typeof op.path !== "string") {
      throw Object.assign(new Error(`op ${i}: path is required`), { code: "VALIDATION", errors: [`op ${i}: path is required`] });
    }
    if (options.trail && !trailAllowsWrite(options.trail, op.path)) {
      throw Object.assign(new Error(`op ${i}: path outside trail scope`), { code: "TRAIL_DENIED" });
    }
    let absPath: string;
    try {
      absPath = validatePath(ctx.vaultPath, op.path);
    } catch (err: any) {
      throw Object.assign(new Error(`op ${i}: path error: ${err.message}`), { code: "VALIDATION", errors: [err.message] });
    }
    const relPath = relative(ctx.vaultPath, absPath);
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
    if (op.provenance) {
      try {
        validateCallerProvenance(op.provenance);
      } catch (err: any) {
        throw Object.assign(new Error(`op ${i}: provenance: ${err.message}`), {
          code: "VALIDATION",
          errors: [`op ${i}: ${err.message}`],
        });
      }
    }
    validated.push({
      absPath,
      relPath,
      frontmatter: op.frontmatter,
      content: op.content,
      if_hash: op.if_hash,
      if_hash_from_op: op.if_hash_from_op,
      provenance: op.provenance,
    });
  }

  // Execute inside the write mutex so no concurrent writer interleaves.
  const results = await getWriteQueue(ctx).enqueue(async () => {
    // Snapshot state for atomic rollback. Captured BEFORE any disk change.
    const preSha: string | null = atomic ? await gitRevParseHead(ctx.vaultPath) : null;
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
          ctx,
          absPath: op.absPath,
          relPath: op.relPath,
          frontmatter: op.frontmatter,
          content: op.content,
          isNew: !ifHash,
          keyName: options.keyName,
          handle: options.handle,
          provenance: op.provenance,
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
          await gitResetHard(ctx.vaultPath, preSha);
        } catch (resetErr) {
          console.error(`[grove] batch rollback git reset failed: ${(resetErr as Error).message}`);
        }
        for (const [path, prior] of preProvenance) {
          if (prior === null) deleteProvenance(path);
          else setProvenanceRow(prior);
          invalidateFrontmatterCache(join(ctx.vaultPath, path));
        }
      }
      throw err;
    }
  });

  // Post-batch fire-and-forget per path.
  for (const r of results) {
    try {
      enqueueDiscovery(r.path, "write", ctx.vaultId);
    } catch (enqueueErr) {
      console.error(`[grove] discovery enqueue failed for ${r.path}:`, (enqueueErr as Error).message);
    }
    embedFile(ctx.vaultPath, r.path).catch((err) => {
      console.error(`[grove] embed-single failed for ${r.path}:`, (err as Error).message);
      try {
        enqueueDiscovery(r.path, "embed_retry", ctx.vaultId);
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
  ctx: VaultContext,
  notePath: string,
  options: { hard?: boolean; ifHash?: string; trail?: TrailConfig | null; keyName?: string } = {},
): Promise<DeleteNoteResult> {
  // Validate source path
  let srcAbs: string;
  try {
    srcAbs = validatePath(ctx.vaultPath, notePath);
  } catch (err: any) {
    throw Object.assign(new Error(`Path error: ${err.message}`), { code: "VALIDATION", errors: [err.message] });
  }
  const srcRel = relative(ctx.vaultPath, srcAbs);

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
  const queue = getWriteQueue(ctx);

  if (options.hard) {
    const sha = await queue.enqueue(async () => {
      // Unlink from working tree only; `git add -A -- <path>` in
      // gitCommitPaths stages the deletion for tracked-but-missing files.
      // (Using `git rm` removes the index entry too, which makes a later
      // `git add -A -- <path>` fail with "pathspec did not match any files".)
      unlinkSync(srcAbs);
      invalidateFrontmatterCache(srcAbs);
      const commitSha = await gitCommitPaths(ctx.vaultPath, [srcRel], `${who}: delete ${srcRel}`);
      qmdReindex(ctx.vaultPath).catch(() => {});
      deleteProvenance(srcRel);
    // refreshStats moved to 5-min timer — computing on every write blocks the event loop (CPU-bound graph analysis). See vault-stats.ts startStatsTimer.
      return commitSha;
    });
    return { action: "deleted", original_path: srcRel, commit: sha };
  }

  // Soft delete — compute archive destination and enforce trail scope on it too.
  const config = loadVaultConfig(ctx.vaultPath);
  const archiveRoot = config.structure.archive_path; // e.g. "Archives/"
  const archiveRel = `${archiveRoot}${srcRel}`;

  let archiveAbs: string;
  try {
    archiveAbs = validatePath(ctx.vaultPath, archiveRel);
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

  const sha = await queue.enqueue(async () => {
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
      ctx.vaultPath,
      [srcRel, archiveRel],
      `${who}: archive ${srcRel}`,
    );
    qmdReindex(ctx.vaultPath).catch(() => {});
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
  ctx: VaultContext,
  notePath: string,
  newPath: string,
  options: { ifHash?: string; trail?: TrailConfig | null; keyName?: string; handle?: string } = {},
): Promise<MoveNoteResult> {
  // Validate both paths
  let srcAbs: string;
  try {
    srcAbs = validatePath(ctx.vaultPath, notePath);
  } catch (err: any) {
    throw Object.assign(new Error(`Source path error: ${err.message}`), { code: "VALIDATION", errors: [err.message] });
  }
  let dstAbs: string;
  try {
    dstAbs = validatePath(ctx.vaultPath, newPath);
  } catch (err: any) {
    throw Object.assign(new Error(`Destination path error: ${err.message}`), { code: "VALIDATION", errors: [err.message] });
  }

  const srcRel = relative(ctx.vaultPath, srcAbs);
  const dstRel = relative(ctx.vaultPath, dstAbs);

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

  const result = await getWriteQueue(ctx).enqueue(async () => {
    // Ensure destination directory exists (git mv requires it)
    const dstDir = dirname(dstAbs);
    if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });

    await gitMv(ctx.vaultPath, srcRel, dstRel);
    invalidateFrontmatterCache(srcAbs);
    invalidateFrontmatterCache(dstAbs);

    const modified = updateWikilinks(ctx.vaultPath, srcRel, dstRel, aliases);

    const paths = [srcRel, dstRel, ...modified];
    const commitSha = await gitCommitPaths(
      ctx.vaultPath,
      paths,
      `${who}: move ${srcRel} → ${dstRel}`,
    );

    qmdReindex(ctx.vaultPath).catch(() => {});
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
  embedFile(ctx.vaultPath, dstRel).catch((err) => {
    console.error(`[grove] embed-single failed for ${dstRel}:`, err.message);
    try {
      enqueueDiscovery(dstRel, "embed_retry", ctx.vaultId);
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
    url: noteUrl(ctx, dstRel, options.handle),
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
  ctx: VaultContext,
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

  // Compute content-addressed key. Prefer the request's vault_id so the
  // R2 object lands in this vault's prefix; fall back to the legacy
  // `vaultIdResolver()` if the caller didn't supply a context (test code).
  const vaultId = ctx.vaultId ?? vaultIdResolver();
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
  const noteResult = await handleWriteNote(ctx, notePath, frontmatter, content, {
    trail: options.trail,
    keyName: options.keyName,
    handle: options.handle,
  });

  // Queue async enrichment (Vision description + tags + OCR → rewrite note)
  try {
    enqueueDiscovery(noteResult.path, "image_enrich", ctx.vaultId);
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

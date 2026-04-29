/**
 * Hybrid search: BM25 + vector + RRF fusion.
 *
 * - BM25: FTS5 full-text search directly against QMD's SQLite index
 * - Vector: embeds query via Voyage AI API, then cosine
 *   search against pre-computed vectors in QMD's SQLite vec0 table
 * - RRF: fuses both result sets via Reciprocal Rank Fusion
 */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { searchMetrics } from "./metrics.js";
import { assertUnlocked, indexWorkingPath } from "./index-crypto.js";

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY ?? "";
const VOYAGE_MODEL = process.env.VOYAGE_MODEL ?? "voyage-4-large";
const BM25_WEIGHT = parseFloat(process.env.BM25_WEIGHT ?? "1.2");
const VEC_WEIGHT = parseFloat(process.env.VEC_WEIGHT ?? "1.2");

interface SearchResult {
  title: string;      // note title, e.g. "Agent Runtime"
  vault_path: string; // lowercase vault-relative path from QMD index, e.g. "resources/concepts/agent-runtime.md"
  score: number;
  snippet: string;
  docid?: string;
}

interface HybridResult {
  title: string;      // note title, e.g. "Agent Runtime"
  vault_path: string; // lowercase vault-relative path from QMD index, e.g. "resources/concepts/agent-runtime.md"
  rrf_score: number;
  snippet: string;
  sources: string[];  // which backends contributed: ["bm25", "vector"]
  thumbnail_url?: string; // for image notes (populated post-search by enrichImageMetadata)
}

/**
 * Embed a query string via Voyage AI API.
 */
async function embedQuery(text: string): Promise<number[]> {
  if (!VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY not set");
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: text,
      model: VOYAGE_MODEL,
      input_type: "query",
    }),
  });
  if (!res.ok) throw new Error(`Voyage API error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data[0].embedding;
}

// ── Shared helpers ──────────────────────────────────────────────────

const STOPWORDS = new Set(["the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "from", "is", "it", "that", "this", "was", "are", "be", "has", "had", "not", "you", "how", "what", "who", "why", "when", "do", "does", "can"]);

/** Strip [[wikilink]] syntax from a string: [[Target|Display]] → Display, [[Target]] → Target */
function stripWikilinks(s: string): string {
  return s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, display) => display ?? target);
}

/** Extract search terms from a query, removing stopwords but keeping short terms like "AI". */
function extractTerms(query: string): string[] {
  return query
    .replace(/[%"'()\-]/g, " ") // strip FTS5 special chars
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t.toLowerCase()));
}

/** Extract vault path from FTS5 filepath (strip life/ prefix). */
function ftsVaultPath(filepath: string): string {
  return filepath.startsWith("life/") ? filepath.slice(5) : filepath;
}

/**
 * BM25 search via FTS5 directly against QMD's SQLite index.
 *
 * When `collection` is provided, restricts matches to
 * `documents.collection = ?` so multi-vault deployments don't return
 * another vault's notes. Legacy single-vault callers omit it and get
 * the old global behavior.
 */
function bm25Search(query: string, n: number, collection?: string): SearchResult[] {
  const db = getDb();

  // Escape FTS5 special characters
  const sanitized = query.replace(/['"%()\-]/g, " ").trim();
  if (!sanitized) return [];

  const terms = extractTerms(sanitized);
  // Prefix matching with OR for broad recall — FTS5 rank handles relevance
  const ftsQuery = terms.length > 1 ? terms.map(t => `${t}*`).join(" OR ") : sanitized;

  const collectionClause = collection ? "AND d.collection = ?" : "";
  const stmt = db.prepare(
    `SELECT f.filepath, f.title, rank,
            substr(f.body, 1, 200) as snippet
     FROM documents_fts f
     JOIN documents d ON d.path = SUBSTR(f.filepath, 6) AND d.active = 1
     ${collectionClause}
     WHERE documents_fts MATCH ?
     ORDER BY rank
     LIMIT ?`
  );
  const rows = (collection
    ? stmt.all(collection, ftsQuery, n * 2)
    : stmt.all(ftsQuery, n * 2)) as {
    filepath: string;
    title: string;
    rank: number;
    snippet: string;
  }[];

  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const cleanTitle = stripWikilinks(row.title);
    if (seen.has(cleanTitle)) continue;
    seen.add(cleanTitle);

    // Normalize score: FTS5 rank is negative (more negative = better match)
    const score = Math.round(Math.abs(row.rank) * 100) / 100;

    const vaultPath = ftsVaultPath(row.filepath);

    // Boost Resource notes in BM25 results — concept notes are high signal
    const boostedScore = vaultPath.startsWith("resources/") ? score * 1.3 : score;

    results.push({
      title: cleanTitle,
      vault_path: vaultPath,
      score: boostedScore,
      snippet: row.snippet?.trim().substring(0, 200) ?? "",
    });

    if (results.length >= n) break;
  }

  // Re-rank by boosted score
  results.sort((a, b) => b.score - a.score);

  return results;
}

/**
 * Title-only FTS5 search — matches query terms against note titles.
 * Catches concept notes that vector search misses due to semantic gap.
 *
 * `collection` restricts matches to the given QMD collection (vault).
 */
function titleSearch(query: string, n: number, collection?: string): SearchResult[] {
  const db = getDb();

  const sanitized = query.replace(/['"%()\-]/g, " ").trim();
  if (!sanitized) return [];

  const terms = extractTerms(sanitized);
  if (terms.length === 0) return [];

  // 1. Check alias index — match when query contains a known alias phrase.
  // Filter by collection so a title search for vault A never returns
  // vault B's alias-matched notes. The alias index is process-global and
  // contains entries from every indexed vault.
  const aliasIndex = getAliasIndex();
  const aliasHits: SearchResult[] = [];
  const queryLower = sanitized.toLowerCase();
  for (const [alias, entry] of aliasIndex) {
    // Skip entries that belong to a different vault's collection.
    if (collection && entry.collection !== collection) continue;
    // Only match if the full alias appears in the query (case-insensitive)
    if (alias.length >= 3 && queryLower.includes(alias)) {
      const prefix = `${entry.collection}/`;
      const vaultPath = entry.filepath.startsWith(prefix) ? entry.filepath.slice(prefix.length) : entry.filepath;
      aliasHits.push({
        title: entry.title,
        vault_path: vaultPath,
        score: 20,
        snippet: `(alias: ${alias})`,
      });
    }
  }

  // 2. FTS5 title search
  const titleQuery = terms.map(t => `title:${t}*`).join(" OR ");
  const collectionClause = collection ? "AND d.collection = ?" : "";
  const stmt = db.prepare(
    `SELECT f.filepath, f.title, rank,
            substr(f.body, 1, 200) as snippet
     FROM documents_fts f
     JOIN documents d ON d.path = SUBSTR(f.filepath, 6) AND d.active = 1
     ${collectionClause}
     WHERE documents_fts MATCH ?
     ORDER BY rank
     LIMIT ?`
  );
  const rows = (collection
    ? stmt.all(collection, titleQuery, n * 2)
    : stmt.all(titleQuery, n * 2)) as {
    filepath: string;
    title: string;
    rank: number;
    snippet: string;
  }[];

  const results: SearchResult[] = [];
  const seen = new Set<string>();

  // Alias hits first (highest confidence)
  for (const hit of aliasHits) {
    if (seen.has(hit.title)) continue;
    seen.add(hit.title);
    results.push(hit);
  }

  // Then FTS5 title hits
  for (const row of rows) {
    const cleanTitle = stripWikilinks(row.title);
    if (seen.has(cleanTitle)) continue;
    seen.add(cleanTitle);
    const score = Math.round(Math.abs(row.rank) * 100) / 100;
    const vaultPath = ftsVaultPath(row.filepath);
    results.push({ title: cleanTitle, vault_path: vaultPath, score, snippet: row.snippet?.trim().substring(0, 200) ?? "" });
    if (results.length >= n) break;
  }

  return results;
}

// --- Alias index: maps lowercase alias → { title, file } ---
//
// `filepath` is `<collection>/<row.path>` so consumers can derive a
// vault-relative path by stripping the leading `<collection>/`. Hardcoding
// `life/` here was a multi-vault bug: for a sharpshoot grove-server the
// alias index would point at fictitious `life/...` paths instead of the
// real `sharpshoot/...` ones. `collection` is captured separately so
// consumers don't have to know which prefix to strip.

export interface AliasIndexEntry {
  title: string;
  filepath: string;
  collection: string;
}

interface AliasRow {
  path: string;
  title: string;
  collection: string;
  doc: string;
}

/**
 * Pure helper: convert raw alias-bearing rows into [alias, entry] pairs.
 * Exposed for unit tests; production callers go through `getAliasIndex`.
 */
export function buildAliasEntries(rows: AliasRow[]): [string, AliasIndexEntry][] {
  const out: [string, AliasIndexEntry][] = [];
  for (const row of rows) {
    // Parse aliases from YAML frontmatter (handles both quoted and unquoted)
    const fm = row.doc.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    const aliasMatch = fm[1].match(/aliases:\s*\n((?:\s+-\s+.*\n?)*)/);
    if (!aliasMatch) continue;

    const cleanTitle = stripWikilinks(row.title);
    const aliases = [...aliasMatch[1].matchAll(/-\s+"?([^"\n]+)"?\s*$/gm)]
      .map(m => m[1].trim())
      .filter(a => a.length > 0);

    for (const alias of aliases) {
      out.push([
        alias.toLowerCase(),
        {
          title: cleanTitle,
          filepath: `${row.collection}/${row.path}`,
          collection: row.collection,
        },
      ]);
    }
  }
  return out;
}

let _aliasIndex: Map<string, AliasIndexEntry> | null = null;

export function getAliasIndex(): Map<string, AliasIndexEntry> {
  if (_aliasIndex) return _aliasIndex;

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT d.path, d.title, d.collection, c.doc
       FROM documents d
       JOIN content c ON d.hash = c.hash
       WHERE d.active = 1 AND c.doc LIKE '%aliases:%'`
    )
    .all() as AliasRow[];

  const index = new Map<string, AliasIndexEntry>(buildAliasEntries(rows));

  console.log(`[hybrid] alias index: ${index.size} aliases from ${rows.length} notes`);
  _aliasIndex = index;
  return index;
}

// --- Lazy-initialized SQLite connection with vec0 extension ---

let _db: InstanceType<typeof Database> | null = null;

function getDb(): InstanceType<typeof Database> {
  assertUnlocked();
  if (_db) return _db;

  const vec0Paths = [
    `${homedir()}/.npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-linux-x64/vec0`,
    `${homedir()}/.npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-arm64/vec0`,
    `${homedir()}/.npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-x64/vec0`,
    `/opt/homebrew/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-arm64/vec0`,
    `/usr/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-linux-x64/vec0`,
  ];

  // better-sqlite3 adds the .so/.dylib extension automatically, but we need
  // to verify the file actually exists (check both extensions)
  let vec0Path: string | null = null;
  for (const base of vec0Paths) {
    if (existsSync(`${base}.so`) || existsSync(`${base}.dylib`)) {
      vec0Path = base;
      break;
    }
  }
  if (!vec0Path) {
    throw new Error("sqlite-vec vec0 extension not found");
  }

  const db = new Database(indexWorkingPath(), { readonly: true });
  db.loadExtension(vec0Path);
  _db = db;
  return db;
}

/**
 * Close the cached DB handle. The vault key manager must call this before
 * re-encrypting the index (a held handle would keep the plaintext file
 * open and may prevent rename/unlink on Windows).
 */
export function closeDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
  _aliasIndex = null;
}

/**
 * Vector search: embed query via TEI, then cosine search via sqlite-vec.
 *
 * When `collection` is provided, drops rows whose doc belongs to a
 * different collection after we hydrate them. sqlite-vec doesn't let
 * us pre-filter on a joined column, so we oversample more and filter
 * in JS.
 */
async function vectorSearch(query: string, n: number, collection?: string): Promise<SearchResult[]> {
  const queryVec = await embedQuery(query);

  // Pack float32 vector into a little-endian buffer
  const buf = Buffer.alloc(queryVec.length * 4);
  for (let i = 0; i < queryVec.length; i++) {
    buf.writeFloatLE(queryVec[i], i * 4);
  }

  const db = getDb();

  // Oversample aggressively to allow re-ranking after dedup. When
  // filtering by collection we need a bigger window because rows
  // from other collections will be discarded.
  const oversample = collection ? n * 20 : n * 5;
  const rows = db
    .prepare(
      `SELECT hash_seq, distance FROM vectors_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    )
    .all(buf, oversample) as { hash_seq: string; distance: number }[];

  const candidates: SearchResult[] = [];
  const seenFiles = new Set<string>();

  for (const { hash_seq, distance } of rows) {
    const docHash = hash_seq.substring(0, hash_seq.lastIndexOf("_"));

    const doc = db
      .prepare("SELECT path, title, collection FROM documents WHERE hash = ? AND active = 1")
      .get(docHash) as { path: string; title: string; collection: string } | undefined;
    if (!doc) continue;
    if (collection && doc.collection !== collection) continue;

    const cleanTitle = stripWikilinks(doc.title);
    if (seenFiles.has(doc.path)) continue;
    seenFiles.add(doc.path);

    // Get snippet from content table
    let snippet = "";
    const content = db
      .prepare("SELECT doc FROM content WHERE hash = ?")
      .get(docHash) as { doc: string } | undefined;
    if (content) {
      let text = content.doc;
      // Strip YAML frontmatter
      if (text.startsWith("---\n")) {
        const end = text.indexOf("\n---\n", 4);
        if (end !== -1) text = text.substring(end + 5);
      }
      snippet = text.trim().substring(0, 200);
    }

    let score = 1.0 - distance;

    // Boost Resource/concept notes — they're higher signal than journal entries
    // Note: doc.path from QMD index is lowercase (e.g. "resources/concepts/...")
    if (doc.path.startsWith("resources/")) score *= 1.25;
    // Penalize journal entries and source captures (they dilute concept results)
    if (/^journal\/|^sources\//.test(doc.path)) score *= 0.80;

    candidates.push({
      title: cleanTitle,
      vault_path: doc.path,
      score: Math.round(score * 10000) / 10000,
      snippet,
      docid: `#${docHash.substring(0, 6)}`,
    });
  }

  // Re-rank by adjusted score
  candidates.sort((a, b) => b.score - a.score);

  return candidates.slice(0, n);
}

/**
 * RRF fusion: merge two ranked lists
 */
export function rrfFuse(
  lists: { results: SearchResult[]; weight: number; label: string }[],
  n: number,
  k = 20
): HybridResult[] {
  const scores: Record<string, number> = {};
  const meta: Record<string, SearchResult> = {};
  const sources: Record<string, Set<string>> = {};

  for (const { results, weight, label } of lists) {
    for (let rank = 0; rank < results.length; rank++) {
      const key = results[rank].vault_path;
      scores[key] = (scores[key] ?? 0) + weight / (k + rank);
      if (!meta[key]) meta[key] = results[rank];
      if (!sources[key]) sources[key] = new Set();
      sources[key].add(label);
    }
  }

  return Object.keys(scores)
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, n)
    .map((key) => ({
      title: meta[key].title,
      vault_path: meta[key].vault_path,
      rrf_score: Math.round(scores[key] * 10000) / 10000,
      snippet: meta[key].snippet,
      sources: [...(sources[key] ?? [])],
    }));
}

/**
 * Hybrid search: BM25 + vector with RRF fusion.
 * Runs both backends in parallel. Falls back to BM25-only if vector
 * search fails (TEI down, vec0 missing, etc.).
 *
 * `collection` restricts matches to a single QMD collection (vault).
 * Omit it for single-vault callers that want the global index.
 */
export async function hybridSearch(
  query: string,
  limit: number = 10,
  collection?: string,
): Promise<HybridResult[]> {
  assertUnlocked();
  const searchStart = Date.now();
  const oversample = Math.min(limit * 5, 50);

  let bm25: SearchResult[] = [];
  try {
    bm25 = bm25Search(query, oversample, collection);
  } catch (err) {
    console.error(`[hybrid] BM25 search failed: ${(err as Error).message}`);
  }

  const vec = await vectorSearch(query, oversample, collection).catch((err) => {
    console.error(`[hybrid] vector search failed, falling back to BM25-only: ${err.message}`);
    return null;
  });

  if (!vec) {
    // BM25-only fallback
    const fallbackResults = bm25.slice(0, limit).map((r) => ({
      title: r.title,
      vault_path: r.vault_path,
      rrf_score: r.score,
      snippet: r.snippet,
      sources: ["bm25"],
    }));
    searchMetrics.recordSearch(query, fallbackResults.length, Date.now() - searchStart);
    return fallbackResults;
  }

  // Title search — fast FTS5 title-only match for concept note discovery
  let titles: SearchResult[] = [];
  try {
    titles = titleSearch(query, oversample, collection);
  } catch (err) {
    console.error(`[hybrid] title search failed: ${(err as Error).message}`);
  }

  const lists: { results: SearchResult[]; weight: number; label: string }[] = [
    { results: bm25, weight: BM25_WEIGHT, label: "bm25" },
    { results: vec, weight: VEC_WEIGHT, label: "vector" },
    { results: titles, weight: 3.0, label: "title" },
  ];

  const fused = rrfFuse(lists, limit);

  // Alias injection: if a known alias appears in the query, ensure that note
  // is in the results (bypasses RRF when vec noise would otherwise bury it).
  // MUST filter by collection: the alias index is a process-global singleton
  // spanning all vaults. Without this check, vault A's search can inject
  // vault B's alias-matched notes into the result set.
  const aliasIndex = getAliasIndex();
  const queryLower = query.toLowerCase().replace(/['"%()\-]/g, " ");
  const injected = new Set<string>();
  for (const [alias, entry] of aliasIndex) {
    if (collection && entry.collection !== collection) continue;
    if (alias.length >= 3 && queryLower.includes(alias) && !injected.has(entry.title)) {
      injected.add(entry.title);
      // If already in results, boost to top 3; if missing, inject
      const idx = fused.findIndex(r => r.title === entry.title);
      if (idx > 2) {
        // Move to position 2 (after any rank-1 results that earned their spot)
        const [item] = fused.splice(idx, 1);
        fused.splice(Math.min(2, fused.length), 0, item);
      } else if (idx === -1) {
        const prefix = `${entry.collection}/`;
        const vaultPath = entry.filepath.startsWith(prefix) ? entry.filepath.slice(prefix.length) : entry.filepath;
        fused.splice(Math.min(2, fused.length), 0, {
          title: entry.title,
          vault_path: vaultPath,
          rrf_score: 0.5,
          snippet: `(alias match: ${alias})`,
          sources: ["alias"],
        });
      }
    }
  }

  const finalResults = fused.slice(0, limit);
  searchMetrics.recordSearch(query, finalResults.length, Date.now() - searchStart);
  return finalResults;
}

/**
 * Format hybrid results as text for MCP response.
 * resolveRealPath maps QMD's lowercase-kebab vault_path to the real filesystem path
 * (e.g. "resources/concepts/meditation-mindfulness.md" → "Resources/Concepts/Meditation & Mindfulness.md").
 * Without it, URLs are built from the QMD index path which may not resolve on case-sensitive filesystems.
 *
 * `handle` scopes result URLs to `/@<handle>/...` — the owner's username for
 * whichever vault this server is bound to. `vaultSlug` further scopes the URL
 * to `/@<handle>/<slug>/<path>` so a multi-vault user clicking a search result
 * lands in the vault the search ran against, not whatever vault grove-www's
 * legacy catch-all picks from the bound session key. Omitting either is only
 * safe in tests; production callers in server.ts always supply both.
 */
export function formatResults(
  results: HybridResult[],
  resolveRealPath?: (vaultPath: string, title: string) => string,
  handle?: string,
  vaultSlug?: string,
): string {
  if (results.length === 0) return "No results found.";
  const base = process.env.GROVE_PUBLIC_BASE_URL ?? "https://grove.md";
  const slugSegment = handle && vaultSlug ? `/${vaultSlug}` : "";
  const scope = handle ? `/@${handle}${slugSegment}` : "";
  return results
    .map(
      (r) => {
        const displayPath = resolveRealPath ? resolveRealPath(r.vault_path, r.title) : r.vault_path;
        const encodedPath = displayPath.replace(/\.md$/, "").split("/").map(encodeURIComponent).join("/");
        const url = `${base}${scope}/${encodedPath}`;
        const thumb = r.thumbnail_url ? `\n![thumbnail](${r.thumbnail_url})` : "";
        return `**${r.title}** (${url})${thumb}\n${r.snippet ?? ""}`;
      }
    )
    .join("\n\n---\n\n");
}

export { embedQuery, bm25Search, vectorSearch, titleSearch, stripWikilinks };
export { VaultLockedError } from "./index-crypto.js";

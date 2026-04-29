/**
 * Semantic neighbor surfacing — finds embedding-similar notes not already linked.
 *
 * After a note is processed by the discovery loop, this module:
 * 1. Reads the note from disk and extracts its wikilinks
 * 2. Runs vector search using the note's title + opening content
 * 3. Filters out the source note itself and already-linked notes
 * 4. Classifies results as "semantic neighbor" or "potential duplicate"
 * 5. Stores results in the discovery_results table
 */

import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import {
  insertDiscoveryResult,
  clearUndismissedResults,
  type DiscoveryResultRow,
} from "./db.js";

// ── Types ────────────────────────────────────────────────────────────

export interface VectorSearchResult {
  vault_path: string;
  score: number;
}

export type VectorSearchFn = (
  query: string,
  n: number,
) => Promise<VectorSearchResult[]>;

// ── Wikilink extraction ─────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

function extractWikilinks(text: string): Set<string> {
  const targets = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(WIKILINK_RE.source, "g");
  while ((m = re.exec(text)) !== null) targets.add(normalize(m[1].trim()));
  return targets;
}

// ── Normalization ───────────────────────────────────────────────────

/** Normalize a note name for comparison: lowercase, strip hyphens/spaces/underscores. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[-_ ]/g, "");
}

// ── Frontmatter parsing ─────────────────────────────────────────────

function parseTitle(content: string, filePath: string): string {
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---\n", 4);
    if (end !== -1) {
      const fm = content.substring(4, end);
      const titleMatch = fm.match(/^title:\s*(.+)$/m);
      if (titleMatch) return titleMatch[1].replace(/^["']|["']$/g, "").trim();
    }
  }
  // Fallback to filename stem
  return basename(filePath, ".md").replace(/-/g, " ");
}

function stripFrontmatter(content: string): string {
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---\n", 4);
    if (end !== -1) return content.substring(end + 5);
  }
  return content;
}

// ── Thresholds ──────────────────────────────────────────────────────

const DUPLICATE_THRESHOLD = 0.85;
const DEFAULT_MIN_SIMILARITY = 0.3;
const DEFAULT_LIMIT = 10;

// ── Core logic ──────────────────────────────────────────────────────

/**
 * Find semantically similar notes for a source note.
 *
 * Reads the note, extracts wikilinks, runs vector search, filters
 * already-linked notes, classifies results, and stores them.
 *
 * @param sourcePath  Vault-relative path (e.g. "Resources/Concepts/transformers.md")
 * @param vaultRoot   Absolute path to the vault root
 * @param searchFn    Vector search function (injectable for testing)
 * @param options     Limit, minimum similarity threshold, and optional vault id.
 *                    `vaultId` scopes both the clear and the inserts so vault
 *                    A's reprocess doesn't wipe vault B's same-path results —
 *                    the helpers default to `$GROVE_VAULT_ID` when omitted.
 */
export async function findNeighbors(
  sourcePath: string,
  vaultRoot: string,
  searchFn: VectorSearchFn,
  options?: { limit?: number; minSimilarity?: number; vaultId?: string },
): Promise<DiscoveryResultRow[]> {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const minSimilarity = options?.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

  // Read source note
  const fullPath = join(vaultRoot, sourcePath);
  const raw = readFileSync(fullPath, "utf-8");

  // Extract linked note names (normalized for comparison)
  const linkedNames = extractWikilinks(raw);

  // Build search query: title + first ~300 chars of body
  const title = parseTitle(raw, sourcePath);
  const body = stripFrontmatter(raw).trim();
  const queryText = `${title} ${body.substring(0, 300)}`.trim();

  // Oversample to allow filtering
  const candidates = await searchFn(queryText, limit * 3);

  // Filter and classify
  const sourceNorm = normalize(basename(sourcePath, ".md"));
  const results: DiscoveryResultRow[] = [];

  for (const candidate of candidates) {
    // Skip self
    const candidateStem = normalize(basename(candidate.vault_path, ".md"));
    if (candidateStem === sourceNorm) continue;

    // Skip already-linked notes (match by normalized filename stem)
    if (linkedNames.has(candidateStem)) continue;

    // Also check path-style links: [[folder/note]]
    const candidatePathNorm = normalize(
      candidate.vault_path.replace(/\.md$/, ""),
    );
    let isLinked = false;
    for (const link of linkedNames) {
      if (candidatePathNorm.endsWith(link)) {
        isLinked = true;
        break;
      }
    }
    if (isLinked) continue;

    // Apply minimum similarity threshold
    if (candidate.score < minSimilarity) continue;

    const relationship =
      candidate.score >= DUPLICATE_THRESHOLD
        ? "potential duplicate"
        : "semantic neighbor";
    const id = randomBytes(8).toString("hex");
    const now = new Date().toISOString();

    results.push({
      id,
      source_path: sourcePath,
      target_path: candidate.vault_path,
      similarity: candidate.score,
      relationship,
      created_at: now,
      dismissed_at: null,
    });

    if (results.length >= limit) break;
  }

  // Persist: clear old undismissed results, then insert fresh ones.
  // Both calls are vault-scoped so concurrent reprocessing across vaults
  // doesn't wipe one another's rows when paths collide.
  const vaultId = options?.vaultId;
  clearUndismissedResults(sourcePath, vaultId);
  for (const r of results) {
    insertDiscoveryResult(
      r.id,
      r.source_path,
      r.target_path,
      r.similarity,
      r.relationship!,
      vaultId,
    );
  }

  return results;
}

/**
 * Wikilink wiring — inserts [[wikilinks]] into notes after extraction.
 *
 * For each suggested_link from extraction:
 *   - Find the from_text in note content
 *   - Wrap it as [[to_path|from_text]]
 *   - Skip if already linked or inside frontmatter
 *
 * Also creates new concept notes from extraction results.
 *
 * Writes go through the vault directly (discovery loop is serial,
 * no concurrent writers). Git commits and QMD reindex follow each write.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { gitCommit, qmdReindex } from "./vault-ops.js";
import type { ExtractionResult, SuggestedLink, NewNote } from "./discovery-extract.js";

// ── Frontmatter boundary detection ──────────────────────────────────

/**
 * Find the byte offset where frontmatter ends.
 * Frontmatter is delimited by --- on the first line and --- on a subsequent line.
 * Returns 0 if no frontmatter is found.
 */
export function frontmatterEndIndex(content: string): number {
  if (!content.startsWith("---")) return 0;
  const secondFence = content.indexOf("\n---", 3);
  if (secondFence === -1) return 0;
  // Return index after the closing --- and its newline
  const afterFence = content.indexOf("\n", secondFence + 1);
  return afterFence === -1 ? secondFence + 4 : afterFence + 1;
}

// ── Link insertion ──────────────────────────────────────────────────

/**
 * Check if a text span is inside an existing wikilink.
 * Detects both [[path|display]] and [[display]] formats.
 * Returns true if the match position falls anywhere between [[ and ]].
 */
function isAlreadyLinked(content: string, matchIndex: number, fromText: string): boolean {
  // Look backwards from the match for [[ (within 300 chars to handle long paths)
  const searchStart = Math.max(0, matchIndex - 300);
  const before = content.slice(searchStart, matchIndex);
  const after = content.slice(matchIndex);

  // Find the nearest [[ before this position
  const lastOpen = before.lastIndexOf("[[");
  if (lastOpen === -1) return false;

  // Check there's no ]] between the [[ and our match (which would close it)
  const lastClose = before.lastIndexOf("]]");
  if (lastClose > lastOpen) return false;

  // Find the next ]] after or within our match
  const nextClose = after.indexOf("]]");
  if (nextClose === -1) return false;

  // We're inside [[...]] — the match falls between an open and close
  return true;
}

/**
 * Insert wikilinks into note content based on extraction suggestions.
 *
 * Rules:
 * - Only link the first occurrence of each from_text (after frontmatter)
 * - Skip text that's already inside a wikilink
 * - Don't touch frontmatter
 * - Case-sensitive match on from_text (Claude returns exact spans)
 *
 * Returns the modified content, or the original if no changes were made.
 */
export function insertWikilinks(
  content: string,
  suggestedLinks: SuggestedLink[],
): string {
  if (suggestedLinks.length === 0) return content;

  const fmEnd = frontmatterEndIndex(content);
  const frontmatter = content.slice(0, fmEnd);
  let body = content.slice(fmEnd);

  // Process each link — first unlinkified occurrence only
  for (const link of suggestedLinks) {
    const { from_text, to_path } = link;
    if (!from_text || !to_path) continue;

    // Skip from_text that already contains wikilink syntax. Extraction
    // occasionally returns whole `[[...]]` spans; wrapping those produces
    // invalid nested brackets like `[[path|[[Grove|alias]]]]`.
    if (from_text.includes("[[") || from_text.includes("]]")) continue;

    // Search for the first occurrence that isn't already inside a wikilink
    let searchFrom = 0;
    let linked = false;
    while (!linked) {
      const idx = body.indexOf(from_text, searchFrom);
      if (idx === -1) break;

      // Check if this occurrence is inside an existing wikilink
      if (isAlreadyLinked(frontmatter + body, fmEnd + idx, from_text)) {
        searchFrom = idx + from_text.length;
        continue;
      }

      // Build and insert the wikilink
      const wikilink = `[[${to_path}|${from_text}]]`;
      body = body.slice(0, idx) + wikilink + body.slice(idx + from_text.length);
      linked = true;
    }
  }

  return frontmatter + body;
}

// ── New note creation ───────────────────────────────────────────────

/**
 * Build frontmatter + body for a new concept note.
 * If the extraction already provided content with frontmatter, use it as-is.
 * Otherwise, generate standard frontmatter.
 */
function buildNewNoteContent(note: NewNote): string {
  if (note.content.startsWith("---")) {
    return note.content;
  }

  const tags = note.tags.length > 0
    ? `\ntags:\n${note.tags.map((t) => `  - ${t}`).join("\n")}`
    : "";
  const nameFromPath = note.path.split("/").pop()?.replace(".md", "") ?? "";
  const aliases = nameFromPath ? `\naliases:\n  - ${nameFromPath}` : "";

  return `---
type: ${note.type}${tags}${aliases}
---

${note.content}
`;
}

// ── High-level wiring ───────────────────────────────────────────────

export interface WiringResult {
  links_wired: number;
  notes_created: string[];
}

/**
 * Wire wikilinks into a source note and create new concept notes.
 *
 * @param vaultPath    Absolute path to the vault root
 * @param notePath     Relative path of the source note
 * @param extraction   Result from concept extraction
 * @returns            Summary of what was changed
 */
export async function wireLinks(
  vaultPath: string,
  notePath: string,
  extraction: ExtractionResult,
): Promise<WiringResult> {
  const result: WiringResult = { links_wired: 0, notes_created: [] };

  // 1. Insert wikilinks into the source note
  if (extraction.suggested_links.length > 0) {
    const absPath = join(vaultPath, notePath);
    const original = readFileSync(absPath, "utf-8");
    const updated = insertWikilinks(original, extraction.suggested_links);

    if (updated !== original) {
      writeFileSync(absPath, updated, "utf-8");
      const sha = await gitCommit(vaultPath, notePath, `discovery: wire links in ${notePath}`);
      await qmdReindex(notePath);
      // Count actual links inserted (compare lengths as proxy)
      result.links_wired = extraction.suggested_links.filter(
        (l) => updated.includes(`[[${l.to_path}|${l.from_text}]]`),
      ).length;
      console.log(`[link] wired ${result.links_wired} links in ${notePath} (${sha})`);
    }
  }

  // 2. Create new concept notes
  for (const note of extraction.new_notes) {
    const absPath = join(vaultPath, note.path);

    // Don't overwrite existing notes
    if (existsSync(absPath)) {
      console.log(`[link] skipping ${note.path} — already exists`);
      continue;
    }

    const dir = dirname(absPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const content = buildNewNoteContent(note);
    writeFileSync(absPath, content, "utf-8");
    const sha = await gitCommit(vaultPath, note.path, `discovery: create ${note.path}`);
    await qmdReindex(note.path);

    result.notes_created.push(note.path);
    console.log(`[link] created ${note.path} (${sha})`);
  }

  return result;
}

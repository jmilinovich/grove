/**
 * Bookmark integration — syncs X bookmarks into Source notes and enqueues for discovery.
 *
 * Fetches bookmarks via `bird` CLI, creates Source notes in <sources>/X/ (the
 * folder is derived from `structure.type_paths.source` in the vault config,
 * defaulting to "Sources/"), and enqueues each new note in discovery_queue for
 * concept extraction.
 *
 * Deduplicates by tweet ID: checks existing notes in the bookmarks folder for
 * matching tweet_id frontmatter.
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { parseNote, serializeNote, inferTags } from "./notes-validate.js";
import { deleteNoteBlame, enqueueDiscovery } from "./db.js";
import { loadVaultConfig, sourcePath, type VaultConfig } from "./vault-config.js";

/** Where bookmarked tweets live, relative to the vault root. */
function bookmarksFolder(config: VaultConfig): string {
  return `${sourcePath(config)}X/`;
}

function getVaultPath(): string {
  return process.env.GROVE_VAULT ?? join(homedir(), "life");
}

// ── Bird bookmark shape ──────────────────────────────────────────

export interface BirdBookmark {
  id: string;
  text: string;
  createdAt: string;
  author: { username: string; name: string };
  authorId?: string;
  replyCount?: number;
  retweetCount?: number;
  likeCount?: number;
  conversationId?: string;
  media?: Array<{ type: string; url: string }>;
}

// ── Fetch bookmarks from bird CLI ───────────────────────────────

export function fetchBookmarks(count: number = 20): BirdBookmark[] {
  const raw = execSync(`bird bookmarks --count ${count} --json --plain`, {
    encoding: "utf-8",
    timeout: 30_000,
  });
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed as BirdBookmark[];
}

// ── Build note path and content from a bookmark ──────────────────

function slugify(text: string, maxLen: number = 60): string {
  return text
    .replace(/https?:\/\/\S+/g, "")  // strip URLs
    .replace(/[^\w\s-]/g, "")         // strip special chars
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, maxLen)
    .replace(/-+$/, "");              // trim trailing dashes
}

function parseTweetDate(createdAt: string): string {
  // bird format: "Sat Apr 11 15:52:54 +0000 2026"
  const d = new Date(createdAt);
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

export function bookmarkToNote(
  bookmark: BirdBookmark,
  config?: VaultConfig,
): {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
} {
  const folder = bookmarksFolder(config ?? loadVaultConfig(getVaultPath()));
  const date = parseTweetDate(bookmark.createdAt);
  const handle = bookmark.author.username;
  const slug = slugify(bookmark.text) || bookmark.id;
  const filename = `${date} @${handle} - ${slug}.md`;
  const path = `${folder}${filename}`;
  const tweetUrl = `https://x.com/${handle}/status/${bookmark.id}`;

  const frontmatter: Record<string, unknown> = {
    type: "source",
    tags: ["x-bookmark"],
    author: `@${handle}`,
    tweet_id: bookmark.id,
    url: tweetUrl,
    date,
    bookmarked: new Date().toISOString().slice(0, 10),
  };

  const lines: string[] = [];
  lines.push(`> ${bookmark.text.replace(/\n/g, "\n> ")}`);
  lines.push("");
  lines.push(`— [${bookmark.author.name} (@${handle})](${tweetUrl})`);

  if (bookmark.likeCount || bookmark.retweetCount) {
    const stats: string[] = [];
    if (bookmark.likeCount) stats.push(`${bookmark.likeCount} likes`);
    if (bookmark.retweetCount) stats.push(`${bookmark.retweetCount} retweets`);
    lines.push(`\n${stats.join(" · ")}`);
  }

  return { path, frontmatter, content: "\n" + lines.join("\n") + "\n" };
}

// ── Dedup: find tweet IDs already in vault ──────────────────────

export function existingTweetIds(
  vaultPath: string,
  config?: VaultConfig,
): Set<string> {
  const folder = bookmarksFolder(config ?? loadVaultConfig(vaultPath));
  const sourcesDir = join(vaultPath, folder);
  const ids = new Set<string>();

  if (!existsSync(sourcesDir)) return ids;

  for (const entry of readdirSync(sourcesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    try {
      const raw = readFileSync(join(sourcesDir, entry.name), "utf-8");
      const { frontmatter } = parseNote(raw);
      if (typeof frontmatter.tweet_id === "string") {
        ids.add(frontmatter.tweet_id);
      }
    } catch {
      // Skip unparseable files
    }
  }

  return ids;
}

// ── Write a bookmark as a Source note ────────────────────────────

function writeBookmarkNote(
  vaultPath: string,
  note: { path: string; frontmatter: Record<string, unknown>; content: string },
): void {
  const fullPath = join(vaultPath, note.path);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  // V3 §B3 — invalidate blame cache before mutation; HEAD-in-key was masking this previously
  deleteNoteBlame(note.path);
  const raw = serializeNote(note.frontmatter, note.content);
  writeFileSync(fullPath, raw, "utf-8");
}

// ── Main sync function ──────────────────────────────────────────

export interface BookmarkSyncResult {
  fetched: number;
  created: number;
  skipped: number;
  enqueued: number;
  errors: string[];
  notes: string[];
}

/**
 * Sync X bookmarks into the vault.
 *
 * 1. Fetch bookmarks via bird CLI
 * 2. Dedup against existing Source notes (by tweet_id)
 * 3. Write new Source notes to Sources/X/
 * 4. Enqueue each new note for discovery processing
 */
export function syncBookmarks(
  count: number = 20,
  opts?: { vaultPath?: string; bookmarks?: BirdBookmark[]; config?: VaultConfig },
): BookmarkSyncResult {
  const vaultPath = opts?.vaultPath ?? getVaultPath();
  const config = opts?.config ?? loadVaultConfig(vaultPath);
  const result: BookmarkSyncResult = {
    fetched: 0,
    created: 0,
    skipped: 0,
    enqueued: 0,
    errors: [],
    notes: [],
  };

  // Fetch bookmarks (or use provided ones for testing)
  const bookmarks = opts?.bookmarks ?? fetchBookmarks(count);
  result.fetched = bookmarks.length;

  if (bookmarks.length === 0) return result;

  // Dedup
  const existing = existingTweetIds(vaultPath, config);

  for (const bm of bookmarks) {
    if (existing.has(bm.id)) {
      result.skipped++;
      continue;
    }

    try {
      const note = bookmarkToNote(bm, config);
      writeBookmarkNote(vaultPath, note);
      result.created++;
      result.notes.push(note.path);

      // Enqueue for discovery
      try {
        enqueueDiscovery(note.path, "ingest");
        result.enqueued++;
      } catch {
        // DB may not be available — note is still written
      }
    } catch (err) {
      result.errors.push(`${bm.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

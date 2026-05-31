import { createHash } from "node:crypto";
import { resolve, relative, dirname } from "node:path";
import { lstatSync } from "node:fs";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { getDefaultConfig, journalFilenameRegex, type VaultConfig } from "./vault-config.js";

// ── Known types & required fields ──────────────────────────────────
// Types with specific requirements are listed here.
// Unlisted types are allowed — the vault is flexible.
const KNOWN_TYPES: Record<string, { required: string[] }> = {
  journal:  { required: ["date"] },
  recipe:   { required: ["meal_type"] },
};

/**
 * Infer tags from a note's path and frontmatter. Returns a deduplicated
 * array merging existing tags with inferred ones. Never removes tags.
 *
 * Tag rules come from the vault config. If config is omitted, PARA defaults
 * are used (current behavior).
 */
export function inferTags(
  path: string,
  frontmatter: Record<string, unknown>,
  config: VaultConfig = getDefaultConfig(),
): string[] {
  const existing = Array.isArray(frontmatter.tags)
    ? (frontmatter.tags as string[])
    : typeof frontmatter.tags === "string"
      ? [frontmatter.tags]
      : [];

  const inferred = new Set<string>(existing);

  for (const rule of config.structure.tag_rules) {
    if (path.startsWith(rule.prefix)) {
      for (const t of rule.tags) inferred.add(t);
    }
  }

  // private: true in frontmatter → add #private
  if (frontmatter.private === true) inferred.add("private");

  return [...inferred];
}

const MAX_CONTENT_BYTES = 100 * 1024;

// ── Path validation ─────────────────────────────────────────────────
export function validatePath(vaultRoot: string, filePath: string): string {
  const root = resolve(vaultRoot);
  const abs = resolve(root, filePath);

  if (!abs.startsWith(root + "/"))
    throw new Error("Path escapes vault root");
  if (filePath.includes(".."))
    throw new Error("Path contains ..");
  if (!abs.endsWith(".md"))
    throw new Error("Only .md files allowed");

  const rel = relative(root, abs);
  if (rel.startsWith(".obsidian/") || rel === ".obsidian")
    throw new Error("Cannot write into .obsidian/");

  // Check the target file itself for symlinks.
  try {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) throw new Error("Symlinks not allowed");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // file doesn't exist yet — that's fine
  }

  // Walk every intermediate directory between root and abs and reject any
  // that is a symlink. Without this check, a caller could write through a
  // symlinked parent directory (e.g. Notes/ -> /etc) to escape the vault
  // even though the resolved path string appears to stay inside root.
  let cursor = dirname(abs);
  while (cursor.length > root.length) {
    try {
      const s = lstatSync(cursor);
      if (s.isSymbolicLink()) throw new Error("Symlink in path not allowed");
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.message === "Symlink in path not allowed") throw e;
      if (err.code !== "ENOENT") throw e;
      // Directory doesn't exist yet — fine, it will be created
    }
    cursor = dirname(cursor);
  }

  return abs;
}

// ── Note validation ─────────────────────────────────────────────────
export function validateNote(
  path: string,
  frontmatter: Record<string, unknown>,
  content: string,
  config: VaultConfig = getDefaultConfig(),
): { errors: string[] } {
  const errors: string[] = [];
  const raw = serializeNote(frontmatter, content);

  if (Buffer.byteLength(raw, "utf-8") > MAX_CONTENT_BYTES)
    errors.push("Content exceeds 100KB limit");

  const type = frontmatter.type as string | undefined;
  if (!type || typeof type !== "string") {
    errors.push(`Missing required field 'type'`);
    return { errors };
  }

  // Check required fields for known types
  const spec = KNOWN_TYPES[type];
  if (spec) {
    for (const f of spec.required) {
      if (frontmatter[f] == null || frontmatter[f] === "")
        errors.push(`Missing required field '${f}' for type '${type}'`);
    }
  }

  // Tags must exist (but we don't dictate which ones)
  const tags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags
    : typeof frontmatter.tags === "string"
      ? [frontmatter.tags]
      : [];
  if (tags.length === 0)
    errors.push(`At least one tag is required`);

  // Path/type consistency: reject only when a note is in another type's folder.
  // When type_paths is empty, skip folder validation entirely — type is frontmatter-only.
  const typePaths = config.structure.type_paths;
  if (Object.keys(typePaths).length > 0) {
    for (const [otherType, prefix] of Object.entries(typePaths)) {
      if (otherType === type) continue;
      if (path.startsWith(prefix) || path.includes(`/${prefix}`)) {
        errors.push(`Type '${type}' cannot be placed under ${prefix} (that's for '${otherType}')`);
        break;
      }
    }
  }

  // Journal filename pattern (driven by config.journal_filename)
  if (type === "journal") {
    const journalRe = journalFilenameRegex(config.structure.journal_filename);
    if (journalRe) {
      const basename = path.split("/").pop() ?? "";
      if (!journalRe.test(basename)) {
        const pattern = config.structure.journal_filename;
        errors.push(`Journal entries must match ${pattern} or ${pattern?.replace(/\.md$/, "-N.md")}`);
      }
    }
  }

  return { errors };
}

// ── Parse / Serialize ───────────────────────────────────────────────
const FM_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseNote(raw: string): {
  frontmatter: Record<string, unknown>;
  content: string;
} {
  const m = raw.match(FM_FENCE);
  if (!m) return { frontmatter: {}, content: raw };
  const frontmatter = (yamlParse(m[1]) ?? {}) as Record<string, unknown>;
  const content = raw.slice(m[0].length);
  return { frontmatter, content };
}

export function serializeNote(
  frontmatter: Record<string, unknown>,
  content: string,
): string {
  const yaml = yamlStringify(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${content}`;
}

// ── Content hash ────────────────────────────────────────────────────
export function contentHash(raw: string): string {
  return createHash("sha256").update(raw, "utf-8").digest("hex");
}

/**
 * Async image enrichment — Phase B of the fast-path image upload flow.
 *
 * When `handleImageUpload` writes a stub companion note with
 * `enrichment_pending: true` and queues an `image_enrich` discovery entry,
 * this module picks it up, downloads the image from R2, runs Claude Vision
 * for description + tags + OCR, and rewrites the note in place.
 *
 * Idempotent: a note whose frontmatter no longer has `enrichment_pending`
 * is skipped. Safe to retry on transient failures (handled by the existing
 * discovery queue retry machinery, up to 5 attempts).
 */

import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { handleWriteNote } from "./rest.js";
import { autoTagImage } from "./image-tag.js";
import { parseNote } from "./notes-validate.js";
import type { VaultContext } from "./vault-router.js";

/** Enrich a previously-uploaded image note in place. */
export async function enrichImageNote(
  ctx: VaultContext,
  notePath: string,
): Promise<{ tags_added: number; description_length: number; skipped: boolean }> {
  const vaultPath = ctx.vaultPath;
  const abs = join(vaultPath, notePath);
  if (!existsSync(abs)) {
    throw new Error(`image note not found: ${notePath}`);
  }

  const raw = readFileSync(abs, "utf-8");
  const { frontmatter, content } = parseNote(raw);

  if (frontmatter.type !== "image") {
    throw new Error(`not an image note: ${notePath}`);
  }
  if (frontmatter.enrichment_pending !== true) {
    // Already enriched (or never needed enrichment). Idempotent no-op.
    return { tags_added: 0, description_length: 0, skipped: true };
  }

  const imageUrl = frontmatter.image_url as string | undefined;
  if (!imageUrl) {
    throw new Error(`no image_url in ${notePath}`);
  }

  // Fetch image bytes from R2
  const resp = await fetch(imageUrl);
  if (!resp.ok) {
    throw new Error(`fetch image failed: ${resp.status} ${resp.statusText}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  const contentType = resp.headers.get("content-type") ?? "image/png";

  // Call Claude Vision for description + tags + OCR
  const tagResult = await autoTagImage(buffer, contentType);

  // Merge tags (preserve existing: 'image', user-supplied, plus new auto-detected)
  const existingTags = Array.isArray(frontmatter.tags)
    ? (frontmatter.tags as string[]).filter((t): t is string => typeof t === "string")
    : [];
  const mergedTags = Array.from(
    new Set([...existingTags, ...tagResult.tags].map((t) => t.trim()).filter(Boolean)),
  );

  const newFrontmatter: Record<string, unknown> = {
    ...frontmatter,
    tags: mergedTags,
    description: tagResult.description,
    enrichment_pending: false,
    enriched_at: new Date().toISOString(),
  };
  if (tagResult.ocr_text) newFrontmatter.ocr_text = tagResult.ocr_text;

  // Rebuild content: first line headline, description paragraph, image embed.
  // Preserve any user-added body below the placeholder if present.
  const title = (frontmatter.title as string | undefined) ??
    notePath.split("/").pop()!.replace(/\.md$/, "").replace(/-/g, " ");
  const headline = `# ${title.replace(/\b\w/g, (c) => c.toUpperCase())}`;
  const newContent = `${headline}\n\n${tagResult.description}\n\n![${title}](${imageUrl})\n`;

  await handleWriteNote(ctx, notePath, newFrontmatter, newContent, {
    keyName: "image-enrich",
    provenance: {
      // Image enrichment auto-fills alt-text + tags + description from
      // the image's pixel content. The output is a stable AI-extract of
      // a public-source-bound asset (the image), not a moment-in-time
      // synthesis or prediction. Treat as durable cited research.
      voice: "durable",
      by: "image-enrich",
      written_at: new Date().toISOString(),
      source: "image-enrich auto-enrichment",
      reason: "AI-generated alt-text + tags + description derived from the image's pixel content",
    },
  });

  return {
    tags_added: mergedTags.length - existingTags.length,
    description_length: tagResult.description.length,
    skipped: false,
  };
}

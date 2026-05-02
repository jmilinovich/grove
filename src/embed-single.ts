/**
 * Embed a single file into the vec0 index.
 *
 * Called fire-and-forget after write_note completes. Reads the file,
 * chunks it, calls Voyage AI for embeddings, and upserts into SQLite vec0.
 *
 * Uses the same chunking params and DB schema as embed-node.ts.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import Database from "better-sqlite3";

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY ?? "";
const VOYAGE_MODEL = process.env.VOYAGE_MODEL ?? "voyage-4-large";
const QMD_INDEX = process.env.QMD_INDEX ?? `${process.env.HOME}/.cache/qmd/index.sqlite`;
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 180;
const MODEL_LABEL = "voyage-4-large";

// ── vec0 extension discovery ─────────────────────────────────────

function findVec0(): string {
  const paths = [
    `${homedir()}/.npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-linux-x64/vec0`,
    `${homedir()}/.npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-arm64/vec0`,
    `/opt/homebrew/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-arm64/vec0`,
    `/usr/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-linux-x64/vec0`,
  ];
  for (const p of paths) {
    if (existsSync(`${p}.dylib`) || existsSync(`${p}.so`)) return p;
  }
  throw new Error("vec0 extension not found");
}

// ── Chunking (same logic as embed-node.ts) ───────────────────────

function chunkText(text: string, title: string): { pos: number; text: string }[] {
  const full = title ? `${title}\n\n${text}` : text;
  if (full.length <= CHUNK_SIZE) return [{ pos: 0, text: full }];

  const chunks: { pos: number; text: string }[] = [];
  let start = 0;
  while (start < full.length) {
    let end = Math.min(start + CHUNK_SIZE, full.length);
    if (end < full.length) {
      const sl = full.slice(start, end);
      const lastPara = sl.lastIndexOf("\n\n");
      const lastNl = sl.lastIndexOf("\n");
      if (lastPara > CHUNK_SIZE * 0.5) end = start + lastPara + 2;
      else if (lastNl > CHUNK_SIZE * 0.5) end = start + lastNl + 1;
    }
    chunks.push({ pos: start, text: full.slice(start, end) });
    const nextStart = end - CHUNK_OVERLAP;
    start = nextStart > start ? nextStart : end;
    if (start >= full.length) break;
  }
  return chunks;
}

// ── Voyage AI embedding call ─────────────────────────────────────

async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY not set");
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: texts,
      model: VOYAGE_MODEL,
      input_type: "document",
    }),
  });
  if (!res.ok) throw new Error(`Voyage API error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
  const embs: number[][] = new Array(texts.length);
  for (const item of data.data) embs[item.index] = item.embedding;
  return embs;
}

function float32Buffer(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

// ── Main export ──────────────────────────────────────────────────

/**
 * Embed (or re-embed) a single vault file into the vec0 index.
 *
 * @param vaultPath  Absolute path to the vault root (e.g., /root/life)
 * @param filePath   Relative path within the vault (e.g., Resources/Concepts/Foo.md)
 */
export async function embedFile(vaultPath: string, filePath: string): Promise<void> {
  const abs = join(vaultPath, filePath);
  if (!existsSync(abs)) {
    console.warn(`[embed-single] file not found: ${abs}`);
    return;
  }

  // Read and strip frontmatter
  let raw = readFileSync(abs, "utf-8");
  let body = raw;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---\n", 4);
    if (end !== -1) body = body.slice(end + 5);
  }
  body = body.trim();
  if (!body) {
    console.log(`[embed-single] empty body, skipping: ${filePath}`);
    return;
  }

  // Compute content hash (same as QMD uses — md5 of full file)
  const hash = createHash("md5").update(raw).digest("hex");
  const title = basename(filePath, ".md");

  // Chunk and embed
  const chunks = chunkText(body, title);
  const texts = chunks.map((c) => c.text);
  const embeddings = await embedBatch(texts);

  // Open DB with vec0
  const db = new Database(QMD_INDEX);
  db.loadExtension(findVec0());
  db.pragma("journal_mode = WAL");

  // Scope by collection so embedFile in vault A doesn't wipe vault B's
  // embeddings when both vaults happen to hold a note at the same relative
  // path (e.g. Resources/Concepts/AI.md). The unscoped query was a real
  // cross-vault data-corruption path: every documents-table read at write
  // time must filter on collection, just like hybrid-search already does.
  const collection = vaultPath.split("/").filter(Boolean).pop() ?? "";

  try {
    // Delete old vectors for this file (any hash that maps to this path)
    const oldHashes = db
      .prepare(
        "SELECT hash FROM documents WHERE (path = ? OR title = ?) AND collection = ?",
      )
      .all(filePath, title, collection) as { hash: string }[];

    const deleteCv = db.prepare("DELETE FROM content_vectors WHERE hash = ? AND model = ?");
    const deleteVec = db.prepare("DELETE FROM vectors_vec WHERE hash_seq LIKE ?");

    const insertCv = db.prepare(
      "INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, ?, ?, ?, datetime('now'))",
    );
    const insertVec = db.prepare(
      "INSERT OR REPLACE INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)",
    );

    const tx = db.transaction(() => {
      // Remove old embeddings for this document
      for (const { hash: oldHash } of oldHashes) {
        deleteCv.run(oldHash, MODEL_LABEL);
        deleteVec.run(`${oldHash}_%`);
      }

      // Insert new embeddings
      for (let i = 0; i < chunks.length; i++) {
        const hashSeq = `${hash}_${i}`;
        insertCv.run(hash, i, chunks[i].pos, MODEL_LABEL);
        insertVec.run(hashSeq, float32Buffer(embeddings[i]));
      }
    });
    tx();

    console.log(`[embed-single] ${filePath}: ${chunks.length} chunks embedded (hash=${hash.slice(0, 8)})`);
  } finally {
    db.close();
  }
}

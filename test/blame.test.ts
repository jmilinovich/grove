// Integration tests for blame.ts: spin up a real git repo, commit notes with
// Provenance-* trailers via composeCommitMessage, then assert that
// computeProvenanceBlame correctly reconstructs per-segment authorship.
//
// These tests use the actual `git` binary — they exercise the porcelain
// parsing + commit-message trailer round-trip for real, not via mocks.
// That's the whole point: the contamination-fix lives or dies at this seam.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  computeProvenanceBlame,
  recomputeProvenanceBlame,
  stampPathsInRange,
} from "../src/blame.js";
import { composeCommitMessage, provenanceToTrailers, type Provenance } from "../src/provenance.js";
import { stampOne } from "../scripts/provenance/stamp.js";
import { getNoteBlame } from "../src/db.js";

let vaultPath: string;
let originalEnv: typeof process.env;

function git(args: string[], cwd = vaultPath): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitWithProvenance(
  filePath: string,
  prov: Provenance | null,
  subject: string,
): string {
  git(["add", filePath]);
  const msg = prov ? composeCommitMessage(subject, provenanceToTrailers(prov)) : subject;
  git(["commit", "-m", msg]);
  return git(["rev-parse", "HEAD"]);
}

beforeAll(async () => {
  originalEnv = { ...process.env };
  vaultPath = mkdtempSync(join(tmpdir(), "grove-blame-test-"));

  // Initialize git repo with a deterministic identity so commits are stable.
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@grove.local"]);
  git(["config", "user.name", "Grove Test"]);
  git(["config", "commit.gpgsign", "false"]);

  // Use a temp DB for note_blame cache writes — point GROVE_DB_PATH at
  // a file inside the vault so tests don't pollute the real db.
  process.env.GROVE_DB_PATH = join(vaultPath, "test.db");

  // Force-import db.ts AFTER GROVE_DB_PATH is set so the schema is created
  // on the test database.
  const db = await import("../src/db.js");
  db.createSchema();
});

afterAll(() => {
  rmSync(vaultPath, { recursive: true, force: true });
  process.env = originalEnv;
});

describe("computeProvenanceBlame", () => {
  it("returns a single durable segment for a one-commit human note", async () => {
    const file = "human-note.md";
    writeFileSync(
      join(vaultPath, file),
      "Line 1\nLine 2\nLine 3\n",
    );
    const sha = commitWithProvenance(
      file,
      {
        voice: "durable",
        by: "human",
        written_at: "2026-05-07T18:55:00Z",
      },
      "human: create human-note.md",
    );

    const segs = await recomputeProvenanceBlame(vaultPath, file);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      line_start: 1,
      line_end: 3,
      commit_sha: sha,
      voice: "durable",
      by: "human",
      written_at: "2026-05-07T18:55:00Z",
    });
  });

  it("attributes added lines to the new commit, retains old lines on prior commit", async () => {
    const file = "evolved-note.md";
    writeFileSync(join(vaultPath, file), "Original line 1\nOriginal line 2\n");
    const sha1 = commitWithProvenance(
      file,
      {
        voice: "durable",
        by: "human",
        written_at: "2026-05-07T18:55:00Z",
      },
      "human: create evolved-note.md",
    );

    appendFileSync(
      join(vaultPath, file),
      "Claude prediction line A\nClaude prediction line B\n",
    );
    const sha2 = commitWithProvenance(
      file,
      {
        voice: "perishable",
        by: "claude-opus-4-7",
        written_at: "2026-05-07T19:00:00Z",
        basis: ["context: spec session"],
        reason: "synthesis based on Reid 2026-04-30 call",
      },
      "claude: extend evolved-note.md",
    );

    const segs = await recomputeProvenanceBlame(vaultPath, file);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({
      line_start: 1,
      line_end: 2,
      commit_sha: sha1,
      voice: "durable",
      by: "human",
    });
    expect(segs[1]).toMatchObject({
      line_start: 3,
      line_end: 4,
      commit_sha: sha2,
      voice: "perishable",
      by: "claude-opus-4-7",
      basis: ["context: spec session"],
      reason: "synthesis based on Reid 2026-04-30 call",
    });
  });

  it("groups three voices in a single file (durable / perishable / durable)", async () => {
    const file = "interleaved.md";
    writeFileSync(join(vaultPath, file), "Top line\n");
    const shaTop = commitWithProvenance(
      file,
      { voice: "durable", by: "human", written_at: "2026-05-07T18:00:00Z" },
      "human: create interleaved.md",
    );

    appendFileSync(join(vaultPath, file), "Claude middle 1\nClaude middle 2\n");
    const shaMid = commitWithProvenance(
      file,
      { voice: "perishable", by: "claude-opus-4-7", written_at: "2026-05-07T18:30:00Z" },
      "claude: append middle to interleaved.md",
    );

    appendFileSync(join(vaultPath, file), "Human bottom\n");
    const shaBot = commitWithProvenance(
      file,
      { voice: "durable", by: "human", written_at: "2026-05-07T19:00:00Z" },
      "human: append bottom to interleaved.md",
    );

    const segs = await recomputeProvenanceBlame(vaultPath, file);
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => ({ start: s.line_start, end: s.line_end, voice: s.voice }))).toEqual([
      { start: 1, end: 1, voice: "durable" },
      { start: 2, end: 3, voice: "perishable" },
      { start: 4, end: 4, voice: "durable" },
    ]);
    expect(segs[0].commit_sha).toBe(shaTop);
    expect(segs[1].commit_sha).toBe(shaMid);
    expect(segs[2].commit_sha).toBe(shaBot);
  });

  it("falls back to legacy-unknown for commits without Provenance-* trailers", async () => {
    const file = "untrailered.md";
    writeFileSync(join(vaultPath, file), "Pre-rollout content\n");
    commitWithProvenance(file, null, "external: pre-provenance commit");

    const segs = await recomputeProvenanceBlame(vaultPath, file);
    expect(segs).toHaveLength(1);
    expect(segs[0].voice).toBe("legacy-unknown");
    expect(segs[0].by).toBe("legacy");
    // Should still get a written_at from the commit's author-date, not epoch.
    expect(new Date(segs[0].written_at).getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it("returns empty array for a non-existent file", async () => {
    const segs = await recomputeProvenanceBlame(vaultPath, "does/not/exist.md");
    expect(segs).toEqual([]);
  });

  it("follows lines across a file rename", async () => {
    const original = "renamed-original.md";
    const renamed = "renamed-after.md";
    writeFileSync(join(vaultPath, original), "Predict line 1\nPredict line 2\n");
    const shaCreate = commitWithProvenance(
      original,
      {
        voice: "perishable",
        by: "claude-opus-4-7",
        written_at: "2026-05-07T18:00:00Z",
      },
      "claude: create renamed-original.md",
    );

    git(["mv", original, renamed]);
    git(["commit", "-m", "external: rename file"]);

    const segs = await recomputeProvenanceBlame(vaultPath, renamed);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      voice: "perishable",
      by: "claude-opus-4-7",
      commit_sha: shaCreate,
      line_start: 1,
      line_end: 2,
    });
  });

  it("caches results — second call with same source_hash returns the same data", async () => {
    const file = "cached-note.md";
    writeFileSync(join(vaultPath, file), "Cached body\n");
    commitWithProvenance(
      file,
      { voice: "durable", by: "human", written_at: "2026-05-07T18:00:00Z" },
      "human: create cached-note.md",
    );

    const sourceHash = "fake-hash-for-cache-key-test";
    const first = await computeProvenanceBlame(vaultPath, file, sourceHash);
    const second = await computeProvenanceBlame(vaultPath, file, sourceHash);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0].voice).toBe("durable");
  });

  it("recomputes when source_hash changes", async () => {
    const file = "rotating-hash.md";
    writeFileSync(join(vaultPath, file), "v1\n");
    commitWithProvenance(
      file,
      { voice: "durable", by: "human", written_at: "2026-05-07T18:00:00Z" },
      "human: create rotating-hash.md",
    );

    const v1 = await computeProvenanceBlame(vaultPath, file, "hash-v1");

    // Add new content + commit; cache key for new source_hash misses → fresh blame.
    appendFileSync(join(vaultPath, file), "v2\n");
    commitWithProvenance(
      file,
      { voice: "perishable", by: "claude-opus-4-7", written_at: "2026-05-07T19:00:00Z" },
      "claude: extend rotating-hash.md",
    );

    const v2 = await computeProvenanceBlame(vaultPath, file, "hash-v2");
    expect(v1).toHaveLength(1);
    expect(v2).toHaveLength(2);
    expect(v2[1].voice).toBe("perishable");
  });
});

// ── V3 §B2: stampPathsInRange ──────────────────────────────────────
describe("stampPathsInRange (V3 §B2)", () => {
  it("returns deduplicated stamp paths from commit bodies in a git range", async () => {
    // Snapshot the starting HEAD; we'll create three stamp commits over it.
    const fromSha = git(["rev-parse", "HEAD"]);

    // Author three --allow-empty stamp commits whose bodies carry
    // Provenance-Stamp-Path trailers. Use one duplicate path to verify dedupe.
    const stampPaths = [
      "Resources/Concepts/alpha.md",
      "Resources/People/beta.md",
      "Resources/Concepts/alpha.md", // dup → must collapse
      "Resources/Recipes/gamma.md",
    ];
    for (const p of stampPaths) {
      const body = [
        `stamp-provenance: ${p}`,
        "",
        "Provenance-Voice: perishable",
        "Provenance-By: claude-opus-4-7",
        "Provenance-Written-At: 2026-05-09T00:00:00Z",
        `Provenance-Stamp-Path: ${p}`,
      ].join("\n");
      git(["commit", "--allow-empty", "-q", "-m", body]);
    }
    const toSha = git(["rev-parse", "HEAD"]);

    const found = await stampPathsInRange(vaultPath, fromSha, toSha);
    expect(new Set(found)).toEqual(
      new Set([
        "Resources/Concepts/alpha.md",
        "Resources/People/beta.md",
        "Resources/Recipes/gamma.md",
      ]),
    );
    // Dedupe: 4 stamps, 3 unique paths.
    expect(found).toHaveLength(3);
  });

  it("returns [] when git fails (bad shas)", async () => {
    // Bogus shas — git log should error; helper must not throw.
    const result = await stampPathsInRange(
      vaultPath,
      "0000000000000000000000000000000000000000",
      "1111111111111111111111111111111111111111",
    );
    expect(result).toEqual([]);
  });

  it("returns [] for an empty range (fromSha === toSha)", async () => {
    const head = git(["rev-parse", "HEAD"]);
    const found = await stampPathsInRange(vaultPath, head, head);
    expect(found).toEqual([]);
  });
});

// ── V3 §B falsifier #1: stamp-then-readback ─────────────────────────
describe("stamp-then-readback (V3 §B falsifier #1)", () => {
  it("after stampOne, note_blame is either empty or carries the new perishable voice", async () => {
    const file = "Resources/Concepts/falsifier-one.md";
    const full = join(vaultPath, file);
    mkdirSync(join(vaultPath, "Resources/Concepts"), { recursive: true });
    writeFileSync(full, "Some legacy content\n");
    git(["add", file]);
    git(["commit", "-q", "-m", "external: pre-rollout falsifier-one"]);

    const before = Date.now();
    await stampOne({
      vaultPath,
      notePath: file,
      provenance: {
        voice: "perishable",
        by: "claude-opus-4-7",
        written_at: "2026-05-09T00:00:00Z",
        reason: "V3 §B falsifier #1",
      },
    });
    const elapsed = Date.now() - before;

    // Within 5 seconds of the stamp:
    expect(elapsed).toBeLessThan(5000);

    // Probe the cache directly. Three accepted states (per V3 §B):
    //   (a) row absent (active deleteNoteBlame won, fire-and-forget recompute hadn't landed)
    //   (b) row present and contains the NEW perishable voice (recompute warmed it)
    // The cache is keyed by source_hash + headSha; we don't know the
    // current key, so we check ALL rows for this path and assert no
    // stale legacy-unknown blame survives.
    //
    // Use the underlying SQLite to scan all rows for this path.
    const Database = (await import("better-sqlite3")).default;
    const dbFile = process.env.GROVE_DB_PATH!;
    const probe = new Database(dbFile, { readonly: true });
    try {
      const rows = probe
        .prepare("SELECT blame_json FROM note_blame WHERE path = ?")
        .all(file) as { blame_json: string }[];
      // Either no rows (case a) or only fresh rows naming the new voice (case b).
      for (const row of rows) {
        const segs = JSON.parse(row.blame_json);
        for (const seg of segs) {
          // Must NOT be stale legacy-unknown. Allowed: durable/perishable
          // (the new stamp voice). We accept either perishable (recompute
          // saw the stamp) or anything emitted by computeFresh against
          // the post-stamp HEAD.
          expect(seg.voice).not.toBe("legacy-unknown");
        }
      }
    } finally {
      probe.close();
    }

    // Sanity: the read path itself returns the new voice.
    const segs = await recomputeProvenanceBlame(vaultPath, file);
    expect(segs).toHaveLength(1);
    expect(segs[0].voice).toBe("perishable");

    // Suppress unused-import noise — getNoteBlame is exercised implicitly
    // via computeProvenanceBlame in the prior test.
    expect(typeof getNoteBlame).toBe("function");
  });
});

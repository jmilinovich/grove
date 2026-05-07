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

import { computeProvenanceBlame, recomputeProvenanceBlame } from "../src/blame.js";
import { composeCommitMessage, provenanceToTrailers, type Provenance } from "../src/provenance.js";

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

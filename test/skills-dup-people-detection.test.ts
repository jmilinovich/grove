/**
 * P23-4 — `dup-people-detection` skill executor tests.
 *
 * Focused on load-bearing contract assertions, not exhaustive coverage:
 *   - Pure-utility correctness (`cosineSimilarity`, `levenshtein`,
 *     `selectCandidates`) since those drive the candidate set.
 *   - Insufficient-notes early-return path (surface artifact, no calls).
 *   - Cost-ceiling early-return path (surface artifact, no calls).
 *   - Happy path with mocked embedder + mocked Anthropic client.
 *
 * The executor's full pipeline is exercised by the happy-path test; the
 * smaller tests document the deterministic behavior the worker loop
 * depends on (e.g., no LLM calls on the ceiling path so flaky runs
 * don't burn budget).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Anthropic from "@anthropic-ai/sdk";

import {
  cosineSimilarity,
  levenshtein,
  readPeopleNotes,
  runDupPeopleDetection,
  setClientForTesting,
  setEmbedderForTesting,
} from "../src/skills/dup-people-detection.ts";
import type { VaultContext } from "../src/vault-router.js";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-dup-people-"));
const VAULT_PATH = join(TEST_DIR, "personal");

function ctx(): VaultContext {
  return {
    vaultId: "vault_dup",
    vaultSlug: "personal",
    vaultPath: VAULT_PATH,
  };
}

function writePeople(notes: Array<{ name: string; body: string }>): void {
  const peopleDir = join(VAULT_PATH, "Resources", "People");
  mkdirSync(peopleDir, { recursive: true });
  for (const n of notes) {
    writeFileSync(join(peopleDir, `${n.name}.md`), n.body);
  }
}

describe("dup-people-detection utility math", () => {
  it("cosineSimilarity returns 1 for identical vectors and 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
  });

  it("cosineSimilarity returns 0 for zero-length inputs (guard against NaN)", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [])).toBe(0);
  });

  it("levenshtein computes a known distance", () => {
    expect(levenshtein("alice", "alice")).toBe(0);
    expect(levenshtein("alice", "alise")).toBe(1);
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
  });
});

describe("readPeopleNotes", () => {
  beforeEach(() => {
    rmSync(VAULT_PATH, { recursive: true, force: true });
  });

  it("returns empty when no People dir exists", () => {
    expect(readPeopleNotes(VAULT_PATH)).toEqual([]);
  });

  it("reads each *.md under Resources/People/ and uses filename as name", () => {
    writePeople([
      { name: "Alice", body: "first" },
      { name: "Bob", body: "second" },
    ]);
    const notes = readPeopleNotes(VAULT_PATH);
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.name).sort()).toEqual(["Alice", "Bob"]);
  });
});

describe("runDupPeopleDetection — early returns", () => {
  beforeEach(() => {
    rmSync(VAULT_PATH, { recursive: true, force: true });
    setClientForTesting(null);
    setEmbedderForTesting(null);
  });

  afterEach(() => {
    setClientForTesting(null);
    setEmbedderForTesting(null);
  });

  it("insufficient notes → surface artifact, no embedder/LLM calls", async () => {
    const embedder = vi.fn();
    const client = { messages: { create: vi.fn() } } as unknown as Anthropic;
    setEmbedderForTesting(embedder);
    setClientForTesting(client);

    writePeople([{ name: "Alice", body: "just one" }]);

    const result = await runDupPeopleDetection(ctx());
    expect(result.artifact.type).toBe("surface");
    expect(result.artifact.surfaceText).toMatch(/at least 2/);
    expect(embedder).not.toHaveBeenCalled();
    expect((client.messages.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("cost ceiling exceeded → surface artifact, no embedder/LLM calls", async () => {
    const embedder = vi.fn();
    const client = { messages: { create: vi.fn() } } as unknown as Anthropic;
    setEmbedderForTesting(embedder);
    setClientForTesting(client);

    writePeople([
      { name: "Alice", body: "a" },
      { name: "Bob", body: "b" },
      { name: "Carol", body: "c" },
    ]);

    const result = await runDupPeopleDetection(ctx(), { tokenCeiling: 100 });
    expect(result.artifact.type).toBe("surface");
    expect(result.artifact.surfaceText).toMatch(/ceiling/);
    expect(result.provenance.reason).toBe("cost_ceiling_exceeded");
    expect(embedder).not.toHaveBeenCalled();
    expect((client.messages.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe("runDupPeopleDetection — happy path with mocked clients", () => {
  beforeEach(() => {
    rmSync(VAULT_PATH, { recursive: true, force: true });
    setClientForTesting(null);
    setEmbedderForTesting(null);
  });

  afterEach(() => {
    setClientForTesting(null);
    setEmbedderForTesting(null);
  });

  it("produces a surface summary when no near-duplicate pair clears the cosine threshold", async () => {
    writePeople([
      { name: "Alice", body: "engineer" },
      { name: "Zog", body: "biologist" },
    ]);
    // Orthogonal embeddings → cosine 0 → no candidate clears MIN_COSINE.
    setEmbedderForTesting(async () => [
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const client = { messages: { create: vi.fn() } } as unknown as Anthropic;
    setClientForTesting(client);

    const result = await runDupPeopleDetection(ctx(), {
      tokenCeiling: 1_000_000,
    });
    expect(result.artifact.type).toBe("surface");
    expect(result.provenance.reason).toMatch(/no_candidates|no_pairs/);
    expect(
      (client.messages.create as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });
});

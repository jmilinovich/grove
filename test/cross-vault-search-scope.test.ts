import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Cross-vault search-scope invariants.
 *
 * QMD indexes every vault into one shared SQLite file
 * (~/.cache/qmd/index.sqlite); each vault's documents live under a
 * `collection` keyed by the vault's on-disk basename. Every per-vault
 * grove-server process reads from that shared file.
 *
 * The dangerous shape is `hybridSearch(query, limit)` or
 * `bm25Search(term, n)` — no collection arg — inside any code that runs
 * pinned to a single vault. With no collection, FTS / vec search
 * returns notes from EVERY vault on the box. The MCP `query` tool used
 * to do exactly this; results, snippets, titles, and URLs leaked across
 * vaults — the 2026-04-29 bug where Sumon's sharpshoot vector queries
 * returned John's `Areas/Business/Legacy Holdings/...` content with
 * sharpshoot URLs minted on top.
 *
 * These tests catch the regression by reading source as bytes — coarse
 * on purpose, better than no test, and cheap to keep green.
 */

const REPO_ROOT = join(__dirname, "..");

function readSrc(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf-8");
}

describe("cross-vault search-scope invariants", () => {
  it("server.ts threads VAULT_COLLECTION into hybridSearch", () => {
    const src = readSrc("src/server.ts");
    // Definition of the collection constant must be present.
    expect(src).toMatch(/VAULT_COLLECTION\s*=\s*VAULT_PATH\.split/);
    // hybridSearch must always be called with the collection arg in this
    // file (no bare two-arg call). Match liberally so formatting drift
    // doesn't break the test.
    const calls = [...src.matchAll(/hybridSearch\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      // Three args: query, limit, collection
      const argCount = args.split(",").map((s) => s.trim()).filter(Boolean).length;
      expect(
        argCount,
        `hybridSearch in server.ts must include collection arg, got: hybridSearch(${args})`,
      ).toBeGreaterThanOrEqual(3);
      expect(args).toMatch(/VAULT_COLLECTION/);
    }
  });

  it("server.ts threads VAULT_COLLECTION into bm25Search fuzzy fallback", () => {
    const src = readSrc("src/server.ts");
    const calls = [...src.matchAll(/bm25Search\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      const argCount = args.split(",").map((s) => s.trim()).filter(Boolean).length;
      expect(
        argCount,
        `bm25Search in server.ts must include collection arg, got: bm25Search(${args})`,
      ).toBeGreaterThanOrEqual(3);
      expect(args).toMatch(/VAULT_COLLECTION/);
    }
  });

  it("hybrid-search.ts hybridSearch signature accepts an optional collection arg", () => {
    const src = readSrc("src/hybrid-search.ts");
    // The 3rd parameter should be `collection` (typed as string-ish).
    expect(src).toMatch(/export async function hybridSearch[\s\S]*?collection\??:/);
  });

  it("hybrid-search.ts bm25Search signature accepts an optional collection arg", () => {
    const src = readSrc("src/hybrid-search.ts");
    expect(src).toMatch(/function bm25Search[\s\S]*?collection\??:/);
  });

  /**
   * Regression test for the searches[].type-ignored bug.
   *
   * The `query` MCP tool exposes a `type` field per sub-query ("lex", "vec",
   * "hyde") so callers can request keyword-only or vector-only search. Before
   * this fix, server.ts always called `hybridSearch(queryText, limit, collection)`
   * — ignoring `type` entirely — so a pure-lex query would silently activate
   * vector embedding (a Voyage API call) and return nearest-neighbor results
   * that didn't contain the literal query term.
   *
   * The fix: derive a `SearchMode` from the searches[] types and pass it as
   * the 4th arg to hybridSearch. This test checks the static invariant.
   */
  it("server.ts passes searchMode (4th arg) to hybridSearch derived from searches[].type", () => {
    const src = readSrc("src/server.ts");
    // The mode derivation block must be present.
    expect(src).toMatch(/searchMode.*SearchMode/);
    // hybridSearch calls in server.ts must include 4 args (query, limit, collection, mode).
    const calls = [...src.matchAll(/hybridSearch\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      const argCount = args.split(",").map((s) => s.trim()).filter(Boolean).length;
      expect(
        argCount,
        `hybridSearch in server.ts must include searchMode arg, got: hybridSearch(${args})`,
      ).toBeGreaterThanOrEqual(4);
    }
  });

  it("hybrid-search.ts hybridSearch signature accepts a mode arg", () => {
    const src = readSrc("src/hybrid-search.ts");
    // The 4th parameter should be `mode` typed as SearchMode.
    expect(src).toMatch(/export async function hybridSearch[\s\S]*?mode.*SearchMode/);
  });

  it("hybrid-search.ts lex mode skips vector embedding (wantVec guard present)", () => {
    const src = readSrc("src/hybrid-search.ts");
    // The lex/vec gating logic must be present.
    expect(src).toMatch(/wantLex.*mode.*===.*lex/);
    expect(src).toMatch(/wantVec.*mode.*===.*vec/);
  });
});

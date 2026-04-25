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
 * pinned to a single vault. With no collection, FTS / vec search returns
 * notes from EVERY vault on the box. The MCP `query` tool used to do
 * exactly this; results, snippets, titles, and URLs leaked across vaults.
 *
 * These tests catch the regression by reading source as bytes. They're
 * coarse on purpose — better than no test at all, and cheap to keep
 * green.
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
      expect(argCount, `hybridSearch in server.ts must include collection arg, got: hybridSearch(${args})`).toBeGreaterThanOrEqual(3);
      expect(args).toMatch(/VAULT_COLLECTION/);
    }
  });

  it("server.ts threads VAULT_COLLECTION into bm25Search fuzzy fallback", () => {
    const src = readSrc("src/server.ts");
    const calls = [...src.matchAll(/bm25Search\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      const argCount = args.split(",").map((s) => s.trim()).filter(Boolean).length;
      expect(argCount, `bm25Search in server.ts must include collection arg, got: bm25Search(${args})`).toBeGreaterThanOrEqual(3);
      expect(args).toMatch(/VAULT_COLLECTION/);
    }
  });

  it("rest.ts handleSearch and resolveNote pass a derived collection", () => {
    const src = readSrc("src/rest.ts");
    // Both call sites must include `collection` as a third arg.
    expect(src).toMatch(/hybridSearch\([^)]+,\s*[^)]*,\s*collection\s*\)/);
    expect(src).toMatch(/bm25Search\([^)]+,\s*[^)]*,\s*collection\s*\)/);
  });

  it("hybrid-search.ts alias entries carry their source collection", () => {
    const src = readSrc("src/hybrid-search.ts");
    // The AliasEntry shape and the cross-vault guard must both exist.
    expect(src).toMatch(/interface\s+AliasEntry/);
    expect(src).toMatch(/entry\.collection\s*!==\s*collection/);
  });
});

import { describe, it, expect } from "vitest";
import { stripWikilinks, formatResults, rrfFuse, buildAliasEntries } from "../src/hybrid-search.js";

interface SearchResult {
  title: string;
  vault_path: string;
  score: number;
  snippet: string;
  docid?: string;
}

interface HybridResult {
  title: string;
  vault_path: string;
  rrf_score: number;
  snippet: string;
  sources: string[];
}

// ── RRF fusion (exported) ────────────────────────────────────────────

describe("rrfFuse", () => {
  const bm25Results: SearchResult[] = [
    { vault_path: "a.md", title: "A", score: 0.9, snippet: "snippet a" },
    { vault_path: "b.md", title: "B", score: 0.7, snippet: "snippet b" },
    { vault_path: "c.md", title: "C", score: 0.5, snippet: "snippet c" },
  ];

  const vecResults: SearchResult[] = [
    { vault_path: "b.md", title: "B", score: 0.95, snippet: "snippet b vec" },
    { vault_path: "d.md", title: "D", score: 0.8, snippet: "snippet d" },
    { vault_path: "a.md", title: "A", score: 0.6, snippet: "snippet a vec" },
  ];

  it("fuses two result lists with RRF scoring", () => {
    const fused = rrfFuse(
      [
        { results: bm25Results, weight: 1.2, label: "bm25" },
        { results: vecResults, weight: 1.0, label: "vector" },
      ],
      10,
    );

    const files = fused.map((r) => r.vault_path);
    expect(files).toContain("a.md");
    expect(files).toContain("b.md");

    const aResult = fused.find((r) => r.vault_path === "a.md")!;
    expect(aResult.sources).toContain("bm25");
    expect(aResult.sources).toContain("vector");
  });

  it("respects limit parameter", () => {
    const fused = rrfFuse(
      [
        { results: bm25Results, weight: 1.0, label: "bm25" },
        { results: vecResults, weight: 1.0, label: "vector" },
      ],
      2,
    );
    expect(fused).toHaveLength(2);
  });

  it("handles single list (BM25-only fallback)", () => {
    const fused = rrfFuse(
      [{ results: bm25Results, weight: 1.0, label: "bm25" }],
      10,
    );
    expect(fused).toHaveLength(3);
    expect(fused.every((r) => r.sources.includes("bm25"))).toBe(true);
    expect(fused.every((r) => r.sources.length === 1)).toBe(true);
  });

  it("items in both lists score higher than single-list items", () => {
    const fused = rrfFuse(
      [
        { results: bm25Results, weight: 1.0, label: "bm25" },
        { results: vecResults, weight: 1.0, label: "vector" },
      ],
      10,
    );

    const bScore = fused.find((r) => r.vault_path === "b.md")!.rrf_score;
    const dScore = fused.find((r) => r.vault_path === "d.md")!.rrf_score;
    expect(bScore).toBeGreaterThan(dScore);
  });

  it("applies weight correctly", () => {
    const heavyBm25 = rrfFuse(
      [
        { results: bm25Results, weight: 10.0, label: "bm25" },
        { results: vecResults, weight: 0.1, label: "vector" },
      ],
      10,
    );
    expect(heavyBm25[0].vault_path).toBe("a.md");
  });

  it("returns empty for empty input", () => {
    const fused = rrfFuse([], 10);
    expect(fused).toEqual([]);
  });
});

// ── stripWikilinks ──────────────────────────────────────────────────

describe("stripWikilinks", () => {
  it("strips simple wikilinks", () => {
    expect(stripWikilinks("about [[Anxiety]]")).toBe("about Anxiety");
  });

  it("strips piped wikilinks using display text", () => {
    expect(stripWikilinks("[[Anxiety & Fear Management|Anxiety]]")).toBe("Anxiety");
  });

  it("strips multiple wikilinks in one string", () => {
    expect(stripWikilinks("[[Mila]] and [[Nina]]")).toBe("Mila and Nina");
  });

  it("handles mixed piped and simple wikilinks", () => {
    expect(stripWikilinks("Organizational Changes and [[Anxiety & Fear Management|Anxiety]]"))
      .toBe("Organizational Changes and Anxiety");
  });

  it("returns string unchanged when no wikilinks", () => {
    expect(stripWikilinks("plain text")).toBe("plain text");
  });

  it("handles empty string", () => {
    expect(stripWikilinks("")).toBe("");
  });
});

// ── formatResults (exported) ────────────────────────────────────────

describe("formatResults", () => {
  it("returns 'No results found.' for empty array", () => {
    expect(formatResults([])).toBe("No results found.");
  });

  it("formats results with title, path, score, and snippet", () => {
    const results: HybridResult[] = [
      { vault_path: "test.md", title: "Test", rrf_score: 0.5, snippet: "hello", sources: ["bm25"] },
    ];
    const output = formatResults(results);
    expect(output).toContain("**Test**");
    expect(output).toContain("test");
    expect(output).toContain("hello");
  });

  it("separates multiple results with ---", () => {
    const results: HybridResult[] = [
      { vault_path: "a.md", title: "A", rrf_score: 0.9, snippet: "aaa", sources: ["bm25"] },
      { vault_path: "b.md", title: "B", rrf_score: 0.8, snippet: "bbb", sources: ["vector"] },
    ];
    const output = formatResults(results);
    expect(output).toContain("---");
    expect(output.split("---")).toHaveLength(2);
  });

  it("includes thumbnail_url as markdown image when present", () => {
    const output = formatResults([
      {
        vault_path: "resources/images/arch-diagram.md",
        title: "Architecture Diagram",
        rrf_score: 0.9,
        snippet: "System architecture diagram",
        sources: ["vector"],
        thumbnail_url: "https://assets.grove.md/v1/abc_thumb.webp",
      },
    ]);
    expect(output).toContain("![thumbnail](https://assets.grove.md/v1/abc_thumb.webp)");
    expect(output).toContain("**Architecture Diagram**");
    expect(output).toContain("System architecture diagram");
  });

  it("omits thumbnail markdown when thumbnail_url is absent", () => {
    const output = formatResults([
      {
        vault_path: "resources/concepts/agent.md",
        title: "Agent",
        rrf_score: 0.9,
        snippet: "text",
        sources: ["bm25"],
      },
    ]);
    expect(output).not.toContain("![thumbnail]");
  });

  it("scopes URLs to /@<handle>/<path> when handle is supplied without a slug (legacy single-vault)", () => {
    const output = formatResults(
      [
        {
          vault_path: "Resources/Recipes/Chicken Rice Broccoli.md",
          title: "Chicken Rice Broccoli",
          rrf_score: 0.9,
          snippet: "weeknight dinner",
          sources: ["bm25"],
        },
      ],
      undefined,
      "alice",
    );
    expect(output).toContain(
      "(https://grove.md/@alice/Resources/Recipes/Chicken%20Rice%20Broccoli)",
    );
  });

  it("scopes URLs to /@<handle>/<slug>/<path> when both handle and vaultSlug are supplied", () => {
    // Multi-vault: URL must include the slug so the click lands in the same
    // vault the search ran against — not whatever vault grove-www's legacy
    // catch-all resolves from the bound session key.
    const output = formatResults(
      [
        {
          vault_path: "Resources/Concepts/Taste Graph.md",
          title: "Taste Graph",
          rrf_score: 0.8,
          snippet: "graph of preferences",
          sources: ["bm25"],
        },
      ],
      undefined,
      "alice",
      "bravo",
    );
    expect(output).toContain(
      "(https://grove.md/@alice/bravo/Resources/Concepts/Taste%20Graph)",
    );
    // Defensive: URL must NOT match the legacy unscoped shape so a click
    // can't be silently routed to the wrong vault by the catch-all.
    expect(output).not.toMatch(/\(https:\/\/grove\.md\/@alice\/Resources\//);
  });

  it("ignores vaultSlug when no handle is supplied (sanity, no slug-without-handle URL shape)", () => {
    const output = formatResults(
      [
        {
          vault_path: "a/b.md",
          title: "Note",
          rrf_score: 0.5,
          snippet: "",
          sources: ["bm25"],
        },
      ],
      undefined,
      undefined,
      "bravo",
    );
    expect(output).toContain("(https://grove.md/a/b)");
    expect(output).not.toContain("/bravo/");
    expect(output).not.toContain("/@");
  });

  it("emits an unscoped URL only when no handle is supplied (test/legacy)", () => {
    // Production callers in server.ts always pass a handle. This guards the
    // fallback so unit tests don't need a DB.
    const output = formatResults([
      {
        vault_path: "a/b.md",
        title: "Note",
        rrf_score: 0.5,
        snippet: "",
        sources: ["bm25"],
      },
    ]);
    expect(output).toContain("(https://grove.md/a/b)");
    expect(output).not.toContain("/@");
  });
});

// ── Alias index: filepath uses row.collection, never hardcoded "life/" ──
//
// Regression for the multi-vault bug where the alias index stamped every
// entry with `life/<path>` even when the row came from sharpshoot or any
// other non-life vault. The fix uses `${row.collection}/${row.path}` so
// downstream consumers can strip the right prefix.

describe("buildAliasEntries", () => {
  const docWithAlias = `---
title: "Foo"
aliases:
  - "FooBar"
  - "FB"
---

body`;

  it("prefixes filepath with the row's collection (life)", () => {
    const entries = buildAliasEntries([
      { path: "inbox/foo.md", title: "Foo", collection: "life", doc: docWithAlias },
    ]);
    expect(entries).toHaveLength(2);
    const [, entry] = entries[0];
    expect(entry.collection).toBe("life");
    expect(entry.filepath).toBe("life/inbox/foo.md");
    expect(entry.filepath.startsWith("life/")).toBe(true);
  });

  it("prefixes filepath with the row's collection (sharpshoot — non-life vault)", () => {
    const entries = buildAliasEntries([
      { path: "inbox/foo.md", title: "Foo", collection: "sharpshoot", doc: docWithAlias },
    ]);
    expect(entries).toHaveLength(2);
    for (const [, entry] of entries) {
      expect(entry.collection).toBe("sharpshoot");
      expect(entry.filepath).toBe("sharpshoot/inbox/foo.md");
      // The bug we are guarding against: never stamp non-life rows with life/.
      expect(entry.filepath.startsWith("life/")).toBe(false);
    }
  });

  it("preserves per-row collection when mixing vaults", () => {
    const entries = buildAliasEntries([
      { path: "a.md", title: "A", collection: "life", doc: `---\naliases:\n  - "AAA"\n---\n` },
      { path: "b.md", title: "B", collection: "sharpshoot", doc: `---\naliases:\n  - "BBB"\n---\n` },
    ]);
    const map = new Map(entries);
    expect(map.get("aaa")?.filepath).toBe("life/a.md");
    expect(map.get("aaa")?.collection).toBe("life");
    expect(map.get("bbb")?.filepath).toBe("sharpshoot/b.md");
    expect(map.get("bbb")?.collection).toBe("sharpshoot");
  });

  it("skips rows without an aliases block", () => {
    const entries = buildAliasEntries([
      { path: "x.md", title: "X", collection: "life", doc: `---\ntitle: "X"\n---\n` },
    ]);
    expect(entries).toHaveLength(0);
  });
});

// ── Cross-vault alias scoping invariant ─────────────────────────────
//
// The alias index is a process-global singleton spanning every vault in the
// shared QMD index. hybridSearch and titleSearch MUST filter alias hits by
// `entry.collection` to prevent vault A's search from injecting vault B's
// alias-matched notes into the result set.
//
// These tests exercise `buildAliasEntries` (the pure data builder) to
// establish that the `collection` field is always present and correct.
// End-to-end alias injection is covered in the hybridSearch integration
// tests; here we guard the invariant that collection is never cross-applied.

describe("alias collection isolation", () => {
  const lifeDoc = `---\naliases:\n  - "meditation"\n---\nbody`;
  const otherVaultDoc = `---\naliases:\n  - "meditation"\n---\nbody`;

  it("same alias in two vaults produces entries with distinct collections", () => {
    const entries = buildAliasEntries([
      { path: "resources/concepts/meditation.md", title: "Meditation", collection: "life", doc: lifeDoc },
      { path: "resources/concepts/meditation.md", title: "Meditation", collection: "othervault", doc: otherVaultDoc },
    ]);
    // Both entries share the same alias key "meditation" but last-write wins in Map;
    // what matters is each raw entry has the right collection.
    const byCollection = entries.reduce<Record<string, string[]>>(
      (acc, [, e]) => {
        acc[e.collection] = [...(acc[e.collection] ?? []), e.filepath];
        return acc;
      },
      {},
    );
    expect(byCollection["life"]).toBeDefined();
    expect(byCollection["othervault"]).toBeDefined();
    // life entry must never carry othervault's prefix
    for (const fp of byCollection["life"] ?? []) {
      expect(fp.startsWith("life/")).toBe(true);
      expect(fp.startsWith("othervault/")).toBe(false);
    }
    // othervault entry must never carry life's prefix
    for (const fp of byCollection["othervault"] ?? []) {
      expect(fp.startsWith("othervault/")).toBe(true);
      expect(fp.startsWith("life/")).toBe(false);
    }
  });

  it("entry.collection matches the row's collection, never another vault", () => {
    const entries = buildAliasEntries([
      { path: "inbox/note.md", title: "Note", collection: "alice-vault", doc: `---\naliases:\n  - "secretnote"\n---\n` },
    ]);
    expect(entries).toHaveLength(1);
    const [, entry] = entries[0];
    expect(entry.collection).toBe("alice-vault");
    // Filepath must be scoped to alice-vault, not "life" or any global default
    expect(entry.filepath).toBe("alice-vault/inbox/note.md");
  });
});

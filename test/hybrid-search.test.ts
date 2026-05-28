import { describe, it, expect } from "vitest";
import {
  stripWikilinks,
  formatResults,
  rrfFuse,
  buildAliasEntries,
  detectVoicePreference,
} from "../src/hybrid-search.js";

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

  it("formats URLs against the configured public base", () => {
    const output = formatResults([
      {
        vault_path: "a/b.md",
        title: "Note",
        rrf_score: 0.5,
        snippet: "",
        sources: ["bm25"],
      },
    ]);
    // Default base is `grove://vault`; configurable via GROVE_PUBLIC_BASE_URL.
    expect(output).toContain("(grove://vault/a/b)");
  });

  // V3 §D — envelope additions (voice + written_at + usage_directive)
  it("renders voice + written_at + usage_directive when present", () => {
    const output = formatResults([
      {
        vault_path: "Inbox/perishable.md",
        title: "Recent Synth",
        rrf_score: 0.7,
        snippet: "snippet body",
        sources: ["bm25"],
        voice: "perishable",
        written_at: "2026-04-15T00:00:00Z",
        usage_directive: "PAUSE AND NAME IT before extending",
      },
    ]);
    expect(output).toContain("_voice: perishable, written 2026-04-15T00:00:00Z_");
    expect(output).toContain("> PAUSE AND NAME IT before extending");
    expect(output).toContain("**Recent Synth**");
  });

  it("omits envelope fields when reweight didn't run (dark-launch / flag off)", () => {
    const output = formatResults([
      {
        vault_path: "a.md",
        title: "Plain",
        rrf_score: 0.5,
        snippet: "",
        sources: ["bm25"],
      },
    ]);
    expect(output).not.toContain("_voice:");
    expect(output).not.toContain("> ");
  });

  it("renders durable voice without a directive", () => {
    const output = formatResults([
      {
        vault_path: "Resources/Concepts/parametric-design.md",
        title: "Parametric Design",
        rrf_score: 0.9,
        snippet: "",
        sources: ["bm25", "vector"],
        voice: "durable",
        written_at: "2024-03-12T00:00:00Z",
        // no usage_directive — durable doesn't get one
      },
    ]);
    expect(output).toContain("_voice: durable, written 2024-03-12T00:00:00Z_");
    expect(output).not.toContain("> ");
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

// ── V3 §G: voice_preference auto-detection ──────────────────────────

describe("detectVoicePreference (V3 §G)", () => {
  it("returns 'mixed' for plain canonical queries", () => {
    expect(detectVoicePreference("parametric design philosophy")).toBe("mixed");
    expect(detectVoicePreference("attachment theory bids for connection")).toBe("mixed");
  });

  it("returns 'recent' for explicit freshness terms", () => {
    expect(detectVoicePreference("today's recruiter calls")).toBe("recent");
    expect(detectVoicePreference("what's the latest Claude lineup")).toBe("recent");
    expect(detectVoicePreference("vault stats this week")).toBe("recent");
    expect(detectVoicePreference("Claude releases lately")).toBe("recent");
    expect(detectVoicePreference("recently announced features")).toBe("recent");
  });

  it("returns 'recent' for ISO date markers (full YYYY-MM-DD)", () => {
    expect(detectVoicePreference("notes from 2026-04-22")).toBe("recent");
    expect(detectVoicePreference("2026-05-09 retrospective")).toBe("recent");
  });

  it("returns 'recent' for month-year markers", () => {
    expect(detectVoicePreference("April 2026 priorities")).toBe("recent");
    expect(detectVoicePreference("February 2026 recruiter status")).toBe("recent");
  });

  it("returns 'mixed' when durable-intent terms override freshness terms (negative gate)", () => {
    // round-3 IR + KG hardening: 'latest understanding of X' is canonical-intent
    expect(detectVoicePreference("latest thinking on parametric design")).toBe("mixed");
    expect(detectVoicePreference("recent understanding of attachment theory")).toBe("mixed");
    expect(detectVoicePreference("today's framework for high agency")).toBe("mixed");
    expect(detectVoicePreference("definition of taste graphs as of this month")).toBe("mixed");
  });

  it("does not match 'current' or 'now' as standalone freshness terms (round-3 IR fold-in)", () => {
    // 'current' was dropped from FRESHNESS_TERMS to avoid false positives like
    // 'current understanding of X' being mis-routed to recent.
    expect(detectVoicePreference("current state of attachment theory")).toBe("mixed"); // 'understanding' not present, but 'current' alone shouldn't trigger
  });
});

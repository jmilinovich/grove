import { describe, it, expect } from "vitest";
import { stripWikilinks, formatResults as realFormatResults } from "../src/hybrid-search.js";

// ── RRF Fusion logic ────────────────────────────────────────────────
// Re-implement the pure rrfFuse function for testing since it's not exported.

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

function rrfFuse(
  lists: { results: SearchResult[]; weight: number; label: string }[],
  n: number,
  k = 60,
): HybridResult[] {
  const scores: Record<string, number> = {};
  const meta: Record<string, SearchResult> = {};
  const sources: Record<string, Set<string>> = {};

  for (const { results, weight, label } of lists) {
    for (let rank = 0; rank < results.length; rank++) {
      const key = results[rank].vault_path;
      scores[key] = (scores[key] ?? 0) + weight / (k + rank);
      if (!meta[key]) meta[key] = results[rank];
      if (!sources[key]) sources[key] = new Set();
      sources[key].add(label);
    }
  }

  return Object.keys(scores)
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, n)
    .map((key) => ({
      title: meta[key].title,
      vault_path: meta[key].vault_path,
      rrf_score: Math.round(scores[key] * 10000) / 10000,
      snippet: meta[key].snippet,
      sources: [...(sources[key] ?? [])],
    }));
}

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

    // Both A and B appear in both lists, so they should score higher
    const files = fused.map((r) => r.vault_path);
    expect(files).toContain("a.md");
    expect(files).toContain("b.md");

    // A and B should have both sources
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

    // B is rank 0 in vec, rank 1 in bm25 => highest dual score
    // D only appears in vec => lower score
    const bScore = fused.find((r) => r.vault_path === "b.md")!.rrf_score;
    const dScore = fused.find((r) => r.vault_path === "d.md")!.rrf_score;
    expect(bScore).toBeGreaterThan(dScore);
  });

  it("applies weight correctly", () => {
    // Same results, but heavily weight bm25
    const heavyBm25 = rrfFuse(
      [
        { results: bm25Results, weight: 10.0, label: "bm25" },
        { results: vecResults, weight: 0.1, label: "vector" },
      ],
      10,
    );

    // With heavy bm25 weight, A (rank 0 in bm25) should come first
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

// ── formatResults ───────────────────────────────────────────────────

describe("formatResults", () => {
  // Re-implement the pure formatResults function
  function formatResults(results: HybridResult[]): string {
    if (results.length === 0) return "No results found.";
    return results
      .map(
        (r) =>
          `**${r.title}** (${r.vault_path}, score: ${r.rrf_score})\n${r.snippet ?? ""}`,
      )
      .join("\n\n---\n\n");
  }

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
});

// ── Image metadata enrichment (P14-3) ───────────────────────────────

describe("formatResults (exported) — image metadata", () => {
  it("includes thumbnail_url as markdown image when present", () => {
    const output = realFormatResults([
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
    const output = realFormatResults([
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
});

// ── URL shape: /@<handle>/<path> (regression for missing-handle bug) ─

describe("formatResults (exported) — URL shape", () => {
  it("scopes URLs to /@<handle>/<path> when handle is supplied", () => {
    const output = realFormatResults(
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

  it("emits an unscoped URL only when no handle is supplied (test/legacy)", () => {
    // Production callers in server.ts always pass a handle. This guards the
    // fallback so unit tests don't need a DB.
    const output = realFormatResults([
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

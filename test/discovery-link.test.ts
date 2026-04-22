import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  insertWikilinks,
  frontmatterEndIndex,
  wireLinks,
} from "../src/discovery-link.js";
import type { ExtractionResult } from "../src/discovery-extract.js";

// Mock vault-ops so wireLinks doesn't need a real git repo
vi.mock("../src/vault-ops.js", () => ({
  gitCommit: vi.fn().mockResolvedValue("abc1234"),
  qmdReindex: vi.fn().mockResolvedValue(undefined),
}));

// ── frontmatterEndIndex ──────────────────────────────────────────────

describe("frontmatterEndIndex", () => {
  it("returns 0 for content without frontmatter", () => {
    expect(frontmatterEndIndex("Just some text.")).toBe(0);
    expect(frontmatterEndIndex("")).toBe(0);
  });

  it("finds the end of valid frontmatter", () => {
    const content = "---\ntype: journal\ntags:\n  - daily\n---\nBody text here.";
    const idx = frontmatterEndIndex(content);
    expect(idx).toBeGreaterThan(0);
    expect(content.slice(idx)).toBe("Body text here.");
  });

  it("handles frontmatter with no trailing content", () => {
    const content = "---\ntype: concept\n---\n";
    const idx = frontmatterEndIndex(content);
    expect(idx).toBe(content.length);
  });

  it("returns 0 for unclosed frontmatter", () => {
    const content = "---\ntype: broken\nno closing fence";
    expect(frontmatterEndIndex(content)).toBe(0);
  });
});

// ── insertWikilinks ──────────────────────────────────────────────────

describe("insertWikilinks", () => {
  it("wraps first occurrence of from_text with wikilink", () => {
    const content = "I discussed machine learning with the team.";
    const result = insertWikilinks(content, [
      { from_text: "machine learning", to_path: "Resources/Concepts/Machine Learning.md" },
    ]);
    expect(result).toBe(
      "I discussed [[Resources/Concepts/Machine Learning.md|machine learning]] with the team.",
    );
  });

  it("only links the first occurrence", () => {
    const content = "ML is great. ML is everywhere. ML is the future.";
    const result = insertWikilinks(content, [
      { from_text: "ML", to_path: "Resources/Concepts/Machine Learning.md" },
    ]);
    // First "ML" is linked, rest are not
    expect(result).toBe(
      "[[Resources/Concepts/Machine Learning.md|ML]] is great. ML is everywhere. ML is the future.",
    );
  });

  it("does not link text already inside a wikilink", () => {
    const content = "See [[Resources/People/John Smith.md|John Smith]] for details about John Smith.";
    const result = insertWikilinks(content, [
      { from_text: "John Smith", to_path: "Resources/People/John Smith.md" },
    ]);
    // The "John Smith" inside the existing wikilink path and display text are skipped.
    // The second bare "John Smith" outside the link gets linked.
    expect(result).toBe(
      "See [[Resources/People/John Smith.md|John Smith]] for details about [[Resources/People/John Smith.md|John Smith]].",
    );
  });

  it("does not modify frontmatter", () => {
    const content = "---\ntype: journal\ntags:\n  - machine learning\n---\nToday I studied machine learning.";
    const result = insertWikilinks(content, [
      { from_text: "machine learning", to_path: "Resources/Concepts/Machine Learning.md" },
    ]);
    // Frontmatter should be untouched, body should be linked
    expect(result).toContain("---\ntype: journal\ntags:\n  - machine learning\n---\n");
    expect(result).toContain("[[Resources/Concepts/Machine Learning.md|machine learning]]");
    // Should NOT have linked the one in frontmatter tags
    const fmSection = result.slice(0, result.indexOf("---\n", 4) + 4);
    expect(fmSection).not.toContain("[[");
  });

  it("handles multiple links in one note", () => {
    const content = "John works on machine learning at Acme Corp.";
    const result = insertWikilinks(content, [
      { from_text: "John", to_path: "Resources/People/John Smith.md" },
      { from_text: "machine learning", to_path: "Resources/Concepts/Machine Learning.md" },
      { from_text: "Acme Corp", to_path: "Resources/Companies/Acme Corp.md" },
    ]);
    expect(result).toContain("[[Resources/People/John Smith.md|John]]");
    expect(result).toContain("[[Resources/Concepts/Machine Learning.md|machine learning]]");
    expect(result).toContain("[[Resources/Companies/Acme Corp.md|Acme Corp]]");
  });

  it("returns original content when no links match", () => {
    const content = "Nothing to link here.";
    const result = insertWikilinks(content, [
      { from_text: "nonexistent term", to_path: "Resources/Concepts/Nothing.md" },
    ]);
    expect(result).toBe(content);
  });

  it("returns original content for empty link array", () => {
    const content = "Some text.";
    expect(insertWikilinks(content, [])).toBe(content);
  });

  it("skips links with missing from_text or to_path", () => {
    const content = "Some text.";
    const result = insertWikilinks(content, [
      { from_text: "", to_path: "Resources/X.md" },
      { from_text: "text", to_path: "" },
    ]);
    expect(result).toBe(content);
  });

  it("skips from_text that is itself a full wikilink (prevents nested brackets)", () => {
    // Extraction sometimes returns an entire existing wikilink as from_text.
    // Wrapping it would produce `[[path|[[Grove|alias]]]]` — invalid syntax
    // that corrupts the note. The link must be left alone.
    const content = "- [[Grove|the Grove project]]\n";
    const result = insertWikilinks(content, [
      { from_text: "[[Grove|the Grove project]]", to_path: "Resources/Projects/Grove.md" },
    ]);
    expect(result).toBe(content);
  });

  it("skips from_text that is a bracketed short-form wikilink", () => {
    const content = "Discussing [[some concept]] today.";
    const result = insertWikilinks(content, [
      { from_text: "[[some concept]]", to_path: "Resources/Concepts/Some Concept.md" },
    ]);
    expect(result).toBe(content);
  });

  it("skips from_text containing stray brackets from partial extraction", () => {
    const content = "This has [[broken syntax here.";
    const result = insertWikilinks(content, [
      { from_text: "[[broken", to_path: "Resources/X.md" },
    ]);
    expect(result).toBe(content);
  });
});

// ── wireLinks (integration with filesystem) ──────────────────────────

describe("wireLinks", () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = mkdtempSync(join(tmpdir(), "grove-link-test-"));
    mkdirSync(join(vaultDir, "Journal", "2026"), { recursive: true });
    mkdirSync(join(vaultDir, "Resources", "Concepts"), { recursive: true });
  });

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it("wires links into a source note on disk", async () => {
    writeFileSync(
      join(vaultDir, "Journal", "2026", "2026-04-13.md"),
      "---\ntype: journal\n---\nToday I studied machine learning.\n",
    );

    const extraction: ExtractionResult = {
      entities: [
        { name: "Machine Learning", type: "concept", confidence: 0.95, existing_path: "Resources/Concepts/Machine Learning.md" },
      ],
      suggested_links: [
        { from_text: "machine learning", to_path: "Resources/Concepts/Machine Learning.md" },
      ],
      new_notes: [],
    };

    const result = await wireLinks(vaultDir, "Journal/2026/2026-04-13.md", extraction);

    expect(result.links_wired).toBe(1);
    const content = readFileSync(join(vaultDir, "Journal", "2026", "2026-04-13.md"), "utf-8");
    expect(content).toContain("[[Resources/Concepts/Machine Learning.md|machine learning]]");
  });

  it("creates new concept notes", async () => {
    writeFileSync(
      join(vaultDir, "Journal", "2026", "2026-04-13.md"),
      "---\ntype: journal\n---\nExploring reinforcement learning.\n",
    );

    const extraction: ExtractionResult = {
      entities: [
        { name: "Reinforcement Learning", type: "concept", confidence: 0.9 },
      ],
      suggested_links: [
        { from_text: "reinforcement learning", to_path: "Resources/Concepts/Reinforcement Learning.md" },
      ],
      new_notes: [
        {
          path: "Resources/Concepts/Reinforcement Learning.md",
          type: "concept",
          tags: ["ai", "ml"],
          content: "A type of machine learning where agents learn from rewards.",
        },
      ],
    };

    const result = await wireLinks(vaultDir, "Journal/2026/2026-04-13.md", extraction);

    expect(result.notes_created).toEqual(["Resources/Concepts/Reinforcement Learning.md"]);
    const newNote = readFileSync(join(vaultDir, "Resources", "Concepts", "Reinforcement Learning.md"), "utf-8");
    expect(newNote).toContain("type: concept");
    expect(newNote).toContain("tags:");
    expect(newNote).toContain("- ai");
    expect(newNote).toContain("- ml");
    expect(newNote).toContain("Reinforcement Learning");
  });

  it("does not overwrite existing notes", async () => {
    writeFileSync(
      join(vaultDir, "Journal", "2026", "2026-04-13.md"),
      "---\ntype: journal\n---\nSome note.\n",
    );
    writeFileSync(
      join(vaultDir, "Resources", "Concepts", "Existing.md"),
      "---\ntype: concept\n---\nOriginal content.\n",
    );

    const extraction: ExtractionResult = {
      entities: [],
      suggested_links: [],
      new_notes: [
        {
          path: "Resources/Concepts/Existing.md",
          type: "concept",
          tags: [],
          content: "Overwritten content.",
        },
      ],
    };

    const result = await wireLinks(vaultDir, "Journal/2026/2026-04-13.md", extraction);

    expect(result.notes_created).toEqual([]);
    const content = readFileSync(join(vaultDir, "Resources", "Concepts", "Existing.md"), "utf-8");
    expect(content).toContain("Original content.");
  });

  it("preserves frontmatter when wiring links", async () => {
    const original = "---\ntype: journal\ntags:\n  - daily\n  - machine learning\n---\nLearning about machine learning today.\n";
    writeFileSync(join(vaultDir, "Journal", "2026", "2026-04-13.md"), original);

    const extraction: ExtractionResult = {
      entities: [],
      suggested_links: [
        { from_text: "machine learning", to_path: "Resources/Concepts/Machine Learning.md" },
      ],
      new_notes: [],
    };

    await wireLinks(vaultDir, "Journal/2026/2026-04-13.md", extraction);

    const content = readFileSync(join(vaultDir, "Journal", "2026", "2026-04-13.md"), "utf-8");
    // Frontmatter preserved
    expect(content.startsWith("---\ntype: journal\ntags:\n  - daily\n  - machine learning\n---\n")).toBe(true);
    // Body linked
    expect(content).toContain("[[Resources/Concepts/Machine Learning.md|machine learning]]");
  });

  it("creates notes with proper frontmatter when content lacks it", async () => {
    writeFileSync(
      join(vaultDir, "Journal", "2026", "2026-04-13.md"),
      "---\ntype: journal\n---\nSome note.\n",
    );

    const extraction: ExtractionResult = {
      entities: [],
      suggested_links: [],
      new_notes: [
        {
          path: "Resources/Concepts/New Concept.md",
          type: "concept",
          tags: ["ai"],
          content: "A new concept in AI.",
        },
      ],
    };

    await wireLinks(vaultDir, "Journal/2026/2026-04-13.md", extraction);

    const content = readFileSync(join(vaultDir, "Resources", "Concepts", "New Concept.md"), "utf-8");
    expect(content).toContain("---");
    expect(content).toContain("type: concept");
    expect(content).toContain("- ai");
    expect(content).toContain("aliases:");
    expect(content).toContain("- New Concept");
    expect(content).toContain("A new concept in AI.");
  });

  it("handles no changes gracefully", async () => {
    writeFileSync(
      join(vaultDir, "Journal", "2026", "2026-04-13.md"),
      "---\ntype: journal\n---\nNothing to link.\n",
    );

    const extraction: ExtractionResult = {
      entities: [],
      suggested_links: [],
      new_notes: [],
    };

    const result = await wireLinks(vaultDir, "Journal/2026/2026-04-13.md", extraction);
    expect(result.links_wired).toBe(0);
    expect(result.notes_created).toEqual([]);
  });
});

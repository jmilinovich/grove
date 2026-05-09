import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  matchEntity,
  buildVocabulary,
  extractEntities,
  setClient,
  resetClient,
  type VocabEntry,
  type ExtractionResult,
} from "../src/discovery-extract.js";

// ── matchEntity ──────────────────────────────────────────────────────

describe("matchEntity", () => {
  const vocab: VocabEntry[] = [
    { path: "Resources/People/John Smith.md", name: "John Smith", type: "person", aliases: ["JS", "Johnny"] },
    { path: "Resources/Concepts/Machine Learning.md", name: "Machine Learning", type: "concept", aliases: ["ML"] },
    { path: "Resources/Companies/Acme Corp.md", name: "Acme Corp", type: "company", aliases: [] },
  ];

  it("matches by exact name (case-insensitive)", () => {
    expect(matchEntity("John Smith", vocab)).toBe("Resources/People/John Smith.md");
    expect(matchEntity("john smith", vocab)).toBe("Resources/People/John Smith.md");
    expect(matchEntity("JOHN SMITH", vocab)).toBe("Resources/People/John Smith.md");
  });

  it("matches by alias (case-insensitive)", () => {
    expect(matchEntity("ML", vocab)).toBe("Resources/Concepts/Machine Learning.md");
    expect(matchEntity("ml", vocab)).toBe("Resources/Concepts/Machine Learning.md");
    expect(matchEntity("JS", vocab)).toBe("Resources/People/John Smith.md");
    expect(matchEntity("Johnny", vocab)).toBe("Resources/People/John Smith.md");
  });

  it("returns undefined for unknown entities", () => {
    expect(matchEntity("Unknown Person", vocab)).toBeUndefined();
    expect(matchEntity("Quantum Computing", vocab)).toBeUndefined();
  });
});

// ── buildVocabulary ──────────────────────────────────────────────────

describe("buildVocabulary", () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = mkdtempSync(join(tmpdir(), "grove-vocab-test-"));
    // Create Resources structure with notes
    mkdirSync(join(vaultDir, "Resources", "People"), { recursive: true });
    mkdirSync(join(vaultDir, "Resources", "Concepts"), { recursive: true });

    writeFileSync(
      join(vaultDir, "Resources", "People", "Jane Doe.md"),
      `---\ntype: person\naliases:\n  - JD\n---\nA person.\n`,
    );
    writeFileSync(
      join(vaultDir, "Resources", "Concepts", "Neural Networks.md"),
      `---\ntype: concept\ntags:\n  - ai\n---\nDeep learning concept.\n`,
    );
    // Non-resource note (should not appear in vocab)
    mkdirSync(join(vaultDir, "Journal", "2026"), { recursive: true });
    writeFileSync(
      join(vaultDir, "Journal", "2026", "2026-04-13.md"),
      `---\ntype: journal\n---\nToday I learned.\n`,
    );
  });

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it("returns entries from Resources/ with aliases", () => {
    const vocab = buildVocabulary(vaultDir);
    expect(vocab.length).toBe(2);

    const jane = vocab.find((v) => v.name === "Jane Doe");
    expect(jane).toBeDefined();
    expect(jane!.path).toBe("Resources/People/Jane Doe.md");
    expect(jane!.aliases).toEqual(["JD"]);

    const nn = vocab.find((v) => v.name === "Neural Networks");
    expect(nn).toBeDefined();
    expect(nn!.aliases).toEqual([]);
  });

  it("scans only the entity folders declared in the passed config", () => {
    // Add a Zettelkasten-style folder and confirm a custom config picks it up
    mkdirSync(join(vaultDir, "Zettelkasten"), { recursive: true });
    writeFileSync(
      join(vaultDir, "Zettelkasten", "Attention Is All You Need.md"),
      `---\ntype: concept\n---\nA paper.\n`,
    );

    const customConfig = {
      structure: {
        entities: { default: "Inbox/", concept: "Zettelkasten/" },
        type_paths: {},
        tag_rules: [],
        private_paths: [],
        archive_path: "Archives/",
        journal_path: null,
        journal_filename: null,
      },
    };

    const vocab = buildVocabulary(vaultDir, customConfig);
    // Should find the Zettelkasten note, NOT the Resources/ ones
    expect(vocab.map((v) => v.path)).toEqual([
      "Zettelkasten/Attention Is All You Need.md",
    ]);
  });
});

// ── extractEntities (with mocked Claude API) ────────────────────────

describe("extractEntities", () => {
  const vocab: VocabEntry[] = [
    { path: "Resources/People/John Smith.md", name: "John Smith", type: "person", aliases: ["JS"] },
    { path: "Resources/Concepts/Machine Learning.md", name: "Machine Learning", type: "concept", aliases: ["ML"] },
  ];

  afterEach(() => {
    resetClient();
  });

  function mockClient(response: ExtractionResult) {
    // Mirrors the tool-use response shape from anthropic.messages.create —
    // a single tool_use block whose `input` is the structured payload.
    // Mirrors what we get back when we force tool_choice on extract_entities.
    const mock = {
      messages: {
        create: vi.fn().mockResolvedValue({
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_test_01",
              name: "extract_entities",
              input: response,
            },
          ],
        }),
      },
    } as any;
    setClient(mock);
    return mock;
  }

  it("matches extracted entities against existing vault notes", async () => {
    const apiResponse: ExtractionResult = {
      entities: [
        { name: "John Smith", type: "person", confidence: 0.95 },
        { name: "machine learning", type: "concept", confidence: 0.9 },
      ],
      suggested_links: [
        { from_text: "John Smith", to_path: "Resources/People/John Smith.md" },
        { from_text: "machine learning", to_path: "Resources/Concepts/Machine Learning.md" },
      ],
      new_notes: [],
    };

    const mock = mockClient(apiResponse);
    const result = await extractEntities("Some note about John Smith and machine learning.", vocab);

    // Entities should have existing_path resolved
    expect(result.entities[0].existing_path).toBe("Resources/People/John Smith.md");
    expect(result.entities[1].existing_path).toBe("Resources/Concepts/Machine Learning.md");

    // Verify API was called
    expect(mock.messages.create).toHaveBeenCalledOnce();
  });

  it("does not create duplicate notes for existing entities", async () => {
    const apiResponse: ExtractionResult = {
      entities: [
        { name: "John Smith", type: "person", confidence: 0.95 },
      ],
      suggested_links: [],
      new_notes: [
        // Claude wrongly suggested creating a note for an existing entity
        {
          path: "Resources/People/John Smith.md",
          type: "person",
          tags: ["person"],
          content: "---\ntype: person\n---\n",
        },
      ],
    };

    mockClient(apiResponse);
    const result = await extractEntities("Note about John Smith.", vocab);

    // Should filter out the duplicate new_note
    expect(result.new_notes).toHaveLength(0);
  });

  it("keeps new notes for unknown entities", async () => {
    const apiResponse: ExtractionResult = {
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

    mockClient(apiResponse);
    const result = await extractEntities("I've been studying reinforcement learning.", vocab);

    expect(result.new_notes).toHaveLength(1);
    expect(result.new_notes[0].path).toBe("Resources/Concepts/Reinforcement Learning.md");
  });

  it("rewrites new-note paths to the folder configured for the type", async () => {
    const customConfig = {
      structure: {
        entities: { default: "Inbox/", concept: "Ideas/" },
        type_paths: {},
        tag_rules: [],
        private_paths: [],
        archive_path: "Archives/",
        journal_path: null,
        journal_filename: null,
      },
    };

    const apiResponse: ExtractionResult = {
      entities: [
        { name: "Context Engineering", type: "concept", confidence: 0.95 },
      ],
      suggested_links: [],
      // Claude returned the old PARA path — we should rewrite to Ideas/
      new_notes: [
        {
          path: "Resources/Concepts/Context Engineering.md",
          type: "concept",
          tags: ["ai"],
          content: "Prompting discipline.",
        },
      ],
    };

    mockClient(apiResponse);
    const result = await extractEntities(
      "Lots of context engineering lately.",
      [],
      customConfig,
    );

    expect(result.new_notes).toHaveLength(1);
    expect(result.new_notes[0].path).toBe("Ideas/Context Engineering.md");
  });

  it("includes confidence scores and logs low-confidence entities", async () => {
    const apiResponse: ExtractionResult = {
      entities: [
        { name: "John Smith", type: "person", confidence: 0.95 },
        { name: "the", type: "concept", confidence: 0.1 },
      ],
      suggested_links: [],
      new_notes: [],
    };

    mockClient(apiResponse);
    const result = await extractEntities("John Smith mentioned the thing.", vocab);

    expect(result.entities).toHaveLength(2);
    expect(result.entities[0].confidence).toBe(0.95);
    expect(result.entities[1].confidence).toBe(0.1);
  });

  it("filters out suggested links with missing fields", async () => {
    const apiResponse: ExtractionResult = {
      entities: [],
      suggested_links: [
        { from_text: "valid text", to_path: "Resources/Concepts/Valid.md" },
        { from_text: "", to_path: "Resources/Concepts/Empty.md" },
        { from_text: "no path", to_path: "" },
      ],
      new_notes: [],
    };

    mockClient(apiResponse);
    const result = await extractEntities("valid text and no path.", vocab);

    expect(result.suggested_links).toHaveLength(1);
    expect(result.suggested_links[0].from_text).toBe("valid text");
  });

  it("resolves entity paths even when Claude omits existing_path", async () => {
    const apiResponse: ExtractionResult = {
      entities: [
        // Claude didn't include existing_path, but entity matches vocab
        { name: "ML", type: "concept", confidence: 0.85 },
      ],
      suggested_links: [],
      new_notes: [],
    };

    mockClient(apiResponse);
    const result = await extractEntities("Working with ML models.", vocab);

    // Should resolve via alias matching
    expect(result.entities[0].existing_path).toBe("Resources/Concepts/Machine Learning.md");
  });

  it("invokes the API with extract_entities tool and forced tool_choice", async () => {
    const mock = mockClient({
      entities: [],
      suggested_links: [],
      new_notes: [],
    });
    await extractEntities("Note body.", vocab);

    const call = mock.messages.create.mock.calls[0][0];
    expect(call.tools).toBeDefined();
    expect(call.tools).toHaveLength(1);
    expect(call.tools[0].name).toBe("extract_entities");
    expect(call.tools[0].input_schema.required).toContain("entities");
    expect(call.tool_choice).toEqual({ type: "tool", name: "extract_entities" });
    // 8K headroom for large notes that previously truncated at 4K.
    expect(call.max_tokens).toBeGreaterThanOrEqual(8192);
  });

  it("parses a large extraction (~50 entities, ~50 links) without error", async () => {
    // Reproduces the shape that chronically truncated under the previous
    // free-form-JSON path on notes like
    // Resources/Concepts/public-company-role-candidates.md and
    // Resources/Concepts/role-candidates-impact-lens.md (~40-50 entities,
    // ~40+ wikilinks each). Tool-use returns input as a parsed object
    // regardless of payload size — there's no JSON.parse step left to fail.
    const N = 50;
    const big: ExtractionResult = {
      entities: Array.from({ length: N }, (_, i) => ({
        name: `Entity Number ${i}`,
        type: (["person", "concept", "project", "company"] as const)[i % 4],
        confidence: 0.6 + ((i * 7) % 40) / 100,
      })),
      suggested_links: Array.from({ length: N }, (_, i) => ({
        from_text: `Entity Number ${i}`,
        to_path: `Resources/Concepts/Entity Number ${i}.md`,
      })),
      new_notes: Array.from({ length: 10 }, (_, i) => ({
        path: `Resources/Concepts/New Concept ${i}.md`,
        type: "concept",
        tags: ["auto"],
        content: "---\ntype: concept\n---\nA new concept.",
      })),
    };

    mockClient(big);
    const result = await extractEntities("(large note body)", vocab);

    expect(result.entities).toHaveLength(N);
    expect(result.suggested_links).toHaveLength(N);
    expect(result.new_notes).toHaveLength(10);
  });

  it("throws a clear error when the model emits no tool_use block", async () => {
    // Defensive: should never happen with forced tool_choice, but guard
    // so the worker logs a useful message instead of a TypeError.
    const mock = {
      messages: {
        create: vi.fn().mockResolvedValue({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "I refuse." }],
        }),
      },
    } as any;
    setClient(mock);

    await expect(
      extractEntities("Some content.", vocab),
    ).rejects.toThrow(/extract_entities/);
  });

  it("survives a malformed tool call missing array fields", async () => {
    // If the model somehow emits a tool_use with a partial input, we
    // shouldn't crash with `TypeError: cannot iterate undefined`.
    const mock = {
      messages: {
        create: vi.fn().mockResolvedValue({
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_test_partial",
              name: "extract_entities",
              input: { entities: [{ name: "Foo", type: "concept", confidence: 0.5 }] },
            },
          ],
        }),
      },
    } as any;
    setClient(mock);

    const result = await extractEntities("note body", vocab);
    expect(result.entities).toHaveLength(1);
    expect(result.suggested_links).toEqual([]);
    expect(result.new_notes).toEqual([]);
  });
});

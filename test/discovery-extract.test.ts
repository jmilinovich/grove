import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  matchEntity,
  buildVocabulary,
  extractEntities,
  extractFromNote,
  setClient,
  resetClient,
  _resetVocabCacheForTests,
  type VocabEntry,
  type ExtractionResult,
} from "../src/discovery-extract.js";
import * as discoveryExtract from "../src/discovery-extract.js";

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
    // Filename gets kebab-cased at normalization time, even when the LLM
    // emits Title Case with spaces. See `kebabFilename` in discovery-extract.
    expect(result.new_notes[0].path).toBe("Resources/Concepts/reinforcement-learning.md");
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
    expect(result.new_notes[0].path).toBe("Ideas/context-engineering.md");
  });

  it("kebab-cases Title-Case filenames the LLM emits (avoids duplicate stubs)", async () => {
    // Reproduces the echo-vault 2026-05-18 incident: the LLM kept emitting
    // `Hadal Zone.md` filenames even though the prompt said kebab-case, and
    // those landed alongside the user's own `hadal-zone.md`. The normalizer
    // collapses them to a single kebab path, so the existsSync check in
    // discovery-link.ts hits the already-existing note.
    const apiResponse: ExtractionResult = {
      entities: [
        { name: "Hadal Zone", type: "concept", confidence: 0.95 },
        { name: "John Smith", type: "person", confidence: 0.9 },
      ],
      suggested_links: [],
      new_notes: [
        { path: "Resources/Concepts/Hadal Zone.md", type: "concept", tags: ["ocean"], content: "x" },
        { path: "Resources/People/John Smith.md", type: "person", tags: ["person"], content: "x" },
      ],
    };

    mockClient(apiResponse);
    const result = await extractEntities("Reading about the hadal zone with John.", []);

    expect(result.new_notes).toHaveLength(2);
    expect(result.new_notes[0].path).toBe("Resources/Concepts/hadal-zone.md");
    expect(result.new_notes[1].path).toBe("Resources/People/john-smith.md");
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

  it("sets ephemeral cache_control on the tool schema and the static prefix", async () => {
    // Cache breakpoints turn the per-call cost of the (large) vocab dump
    // from full input rate into 0.1× cache-read on subsequent drains
    // within the 5-min TTL. A regression here silently re-bills the
    // full vocab on every Discovery call.
    const mock = mockClient({
      entities: [],
      suggested_links: [],
      new_notes: [],
    });
    await extractEntities("Some note body.", vocab);

    const call = mock.messages.create.mock.calls[0][0];

    // Tool schema is cached.
    expect(call.tools[0].cache_control).toEqual({ type: "ephemeral" });

    // The user message is structured as two text blocks: the static
    // prefix (vocab + instructions) carries the cache breakpoint;
    // the note-content block does not.
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].role).toBe("user");
    expect(Array.isArray(call.messages[0].content)).toBe(true);
    const blocks = call.messages[0].content;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[0].text).toContain("knowledge graph extraction engine");
    expect(blocks[0].text).toContain("Existing vault entities");
    // Note content lives in the uncached trailing block.
    expect(blocks[1].type).toBe("text");
    expect(blocks[1].cache_control).toBeUndefined();
    expect(blocks[1].text).toContain("Some note body.");
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

// ── P7-COST-7: cache_usage logging + vocab TTL cache ────────────────

describe("extractEntities cache_usage logging", () => {
  afterEach(() => {
    resetClient();
    vi.restoreAllMocks();
  });

  function mockClientWithUsage(
    response: ExtractionResult,
    usage: {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      input_tokens?: number;
    },
  ) {
    const mock = {
      messages: {
        create: vi.fn().mockResolvedValue({
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_usage_test",
              name: "extract_entities",
              input: response,
            },
          ],
          usage,
        }),
      },
    } as any;
    setClient(mock);
    return mock;
  }

  it("logs cache_usage line with created/read tokens", async () => {
    const empty: ExtractionResult = { entities: [], suggested_links: [], new_notes: [] };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // First call — cache miss (created > 0, read = 0).
    mockClientWithUsage(empty, {
      cache_creation_input_tokens: 2048,
      cache_read_input_tokens: 0,
      input_tokens: 100,
    });
    await extractEntities("note A", [], undefined, "Resources/Concepts/A.md");

    // Second call — cache hit (created = 0, read > 0).
    mockClientWithUsage(empty, {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2048,
      input_tokens: 100,
    });
    await extractEntities("note B", [], undefined, "Resources/Concepts/B.md");

    const matches = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => /\[discovery\] cache usage: created=\d+ read=\d+ input=\d+ note=/.test(s));
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches[0]).toContain("created=2048");
    expect(matches[0]).toContain("read=0");
    expect(matches[0]).toContain("note=Resources/Concepts/A.md");
    expect(matches[1]).toContain("created=0");
    expect(matches[1]).toContain("read=2048");
    expect(matches[1]).toContain("note=Resources/Concepts/B.md");
  });

  it("logs cache_usage with zero defaults when response.usage is missing", async () => {
    const empty: ExtractionResult = { entities: [], suggested_links: [], new_notes: [] };
    // Older SDK shapes / mocks may omit usage entirely; logger must not crash.
    const mock = {
      messages: {
        create: vi.fn().mockResolvedValue({
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_no_usage",
              name: "extract_entities",
              input: empty,
            },
          ],
        }),
      },
    } as any;
    setClient(mock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(extractEntities("note", [])).resolves.toBeDefined();

    const matched = logSpy.mock.calls
      .map((c) => String(c[0]))
      .some((s) => s.includes("[discovery] cache usage: created=0 read=0 input=0 note="));
    expect(matched).toBe(true);
  });
});

describe("vocab TTL cache (P7-COST-7)", () => {
  let vaultDir: string;
  let vaultB: string;
  let tempDir: string;
  const TEST_VAULT_ID = "vault_test_vocab";

  beforeEach(async () => {
    _resetVocabCacheForTests();
    // Stable, larger-than-default TTL for the within-TTL cases.
    process.env.GROVE_DISCOVERY_VOCAB_TTL_MS = "60000";

    // Fresh DB per test — extractFromNote now calls getCachedExtraction (P7-COST-3)
    // which requires the discovery_cache table + a vault_id with a corresponding
    // vaults row.
    tempDir = mkdtempSync(join(tmpdir(), "grove-vocab-db-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    const dbMod = await import("../src/db.js");
    dbMod.resetDb();
    dbMod.createSchema();
    const db = dbMod.getDb();
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_vocab_test", "test", "test@grove.local", "owner");
    db.prepare(
      "INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
    ).run(TEST_VAULT_ID, "user_vocab_test", "vocab", "Vocab Vault", tempDir);
    db.prepare(
      "INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
    ).run("vault_other", "user_vocab_test", "other", "Other Vault", tempDir);

    vaultDir = mkdtempSync(join(tmpdir(), "grove-vocab-cache-a-"));
    mkdirSync(join(vaultDir, "Resources", "Concepts"), { recursive: true });
    writeFileSync(
      join(vaultDir, "Resources", "Concepts", "Seed Concept.md"),
      `---\ntype: concept\n---\nSeed.\n`,
    );

    vaultB = mkdtempSync(join(tmpdir(), "grove-vocab-cache-b-"));
    mkdirSync(join(vaultB, "Resources", "Concepts"), { recursive: true });
    writeFileSync(
      join(vaultB, "Resources", "Concepts", "Other Concept.md"),
      `---\ntype: concept\n---\nOther.\n`,
    );
  });

  afterEach(async () => {
    const dbMod = await import("../src/db.js");
    dbMod.resetDb();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
    rmSync(vaultB, { recursive: true, force: true });
    delete process.env.GROVE_DB_PATH;
    resetClient();
    vi.restoreAllMocks();
    delete process.env.GROVE_DISCOVERY_VOCAB_TTL_MS;
    _resetVocabCacheForTests();
  });

  function mockEmpty() {
    const mock = {
      messages: {
        create: vi.fn().mockResolvedValue({
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_vocab",
              name: "extract_entities",
              input: { entities: [], suggested_links: [], new_notes: [] },
            },
          ],
          usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 0 },
        }),
      },
    } as any;
    setClient(mock);
    return mock;
  }

  function writeProbeNote(root: string, name: string): string {
    const rel = join("Resources", "Concepts", `${name}.md`);
    writeFileSync(join(root, rel), `---\ntype: concept\n---\n${name}\n`);
    return rel;
  }

  // Each test uses a fresh probe path per call so the P7-COST-3 content-hash
  // cache doesn't short-circuit subsequent calls. We're isolating P7-COST-7
  // vocab-cache behavior; different paths = different content-cache keys =
  // we exercise the vocab cache on every call.

  it("vocab is built once across calls within TTL", async () => {
    mockEmpty();
    const probe1 = writeProbeNote(vaultDir, "Probe One A");
    const probe2 = writeProbeNote(vaultDir, "Probe One B");

    const spy = vi.spyOn(discoveryExtract._vocabInternals, "buildVocabulary");

    await extractFromNote(vaultDir, probe1, TEST_VAULT_ID);
    await extractFromNote(vaultDir, probe2, TEST_VAULT_ID);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("vocab is rebuilt after TTL expires", async () => {
    process.env.GROVE_DISCOVERY_VOCAB_TTL_MS = "10";
    _resetVocabCacheForTests();

    mockEmpty();
    const probe1 = writeProbeNote(vaultDir, "Probe Two A");
    const probe2 = writeProbeNote(vaultDir, "Probe Two B");

    const spy = vi.spyOn(discoveryExtract._vocabInternals, "buildVocabulary");

    await extractFromNote(vaultDir, probe1, TEST_VAULT_ID);
    await new Promise((r) => setTimeout(r, 20));
    await extractFromNote(vaultDir, probe2, TEST_VAULT_ID);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("vocab is rebuilt when vault path changes", async () => {
    mockEmpty();
    const probeA = writeProbeNote(vaultDir, "Probe A");
    const probeB = writeProbeNote(vaultB, "Probe B");

    const spy = vi.spyOn(discoveryExtract._vocabInternals, "buildVocabulary");

    await extractFromNote(vaultDir, probeA, TEST_VAULT_ID);
    await extractFromNote(vaultB, probeB, "vault_other");

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("_resetVocabCacheForTests empties the cache", async () => {
    mockEmpty();
    const probe1 = writeProbeNote(vaultDir, "Probe Reset A");
    const probe2 = writeProbeNote(vaultDir, "Probe Reset B");

    const spy = vi.spyOn(discoveryExtract._vocabInternals, "buildVocabulary");

    await extractFromNote(vaultDir, probe1, TEST_VAULT_ID);
    _resetVocabCacheForTests();
    await extractFromNote(vaultDir, probe2, TEST_VAULT_ID);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("logs the effective TTL once on first call", async () => {
    _resetVocabCacheForTests();
    mockEmpty();
    const probe1 = writeProbeNote(vaultDir, "Probe TTL Log A");
    const probe2 = writeProbeNote(vaultDir, "Probe TTL Log B");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await extractFromNote(vaultDir, probe1, TEST_VAULT_ID);
    await extractFromNote(vaultDir, probe2, TEST_VAULT_ID);

    const ttlLogs = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => /^\[discovery\] vocab cache TTL: \d+ms$/.test(s));
    expect(ttlLogs).toHaveLength(1);
  });
});

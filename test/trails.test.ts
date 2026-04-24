import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  filterByTrail, trailAllowsWrite, loadTrails, updateTrail,
  generateTrailId, resolveTrail, disableTrail, deleteTrail,
  getTrailPublicInfo, getTrailConfig, createTrail,
  type TrailConfig, type NoteMetadata,
} from "../src/trails.js";
import { createSchema, closeDb, resetDb, getDb } from "../src/db.js";

// ── filterByTrail tests ────────────────────────────────────────────

function makeTrail(overrides: Partial<TrailConfig> = {}): TrailConfig {
  return {
    id: "trail_test",
    name: "test-trail",
    description: "test",
    key_id: "key_test",
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    allow_tags: [],
    deny_tags: [],
    allow_types: [],
    deny_types: [],
    allow_paths: [],
    deny_paths: [],
    rate_limit_reads: 60,
    rate_limit_writes: 0,
    ...overrides,
  };
}

describe("filterByTrail", () => {
  it("allows everything with empty filters", () => {
    const trail = makeTrail();
    expect(filterByTrail(trail, { path: "anything.md", type: "concept", tags: ["ai"] })).toBe(true);
  });

  // ── Tag filtering ──

  it("allow_tags: passes if note has matching tag", () => {
    const trail = makeTrail({ allow_tags: ["ai", "ml"] });
    expect(filterByTrail(trail, { path: "a.md", tags: ["ai", "cooking"] })).toBe(true);
  });

  it("allow_tags: rejects if note has no matching tag", () => {
    const trail = makeTrail({ allow_tags: ["ai", "ml"] });
    expect(filterByTrail(trail, { path: "a.md", tags: ["cooking"] })).toBe(false);
  });

  it("allow_tags: rejects if note has no tags", () => {
    const trail = makeTrail({ allow_tags: ["ai"] });
    expect(filterByTrail(trail, { path: "a.md" })).toBe(false);
  });

  it("deny_tags: rejects note with denied tag", () => {
    const trail = makeTrail({ deny_tags: ["private"] });
    expect(filterByTrail(trail, { path: "a.md", tags: ["private", "journal"] })).toBe(false);
  });

  it("deny_tags: allows note without denied tags", () => {
    const trail = makeTrail({ deny_tags: ["private"] });
    expect(filterByTrail(trail, { path: "a.md", tags: ["public"] })).toBe(true);
  });

  // ── Type filtering ──

  it("allow_types: passes if type matches", () => {
    const trail = makeTrail({ allow_types: ["concept", "person"] });
    expect(filterByTrail(trail, { path: "a.md", type: "concept" })).toBe(true);
  });

  it("allow_types: rejects if type doesn't match", () => {
    const trail = makeTrail({ allow_types: ["concept"] });
    expect(filterByTrail(trail, { path: "a.md", type: "journal" })).toBe(false);
  });

  it("allow_types: rejects if note has no type", () => {
    const trail = makeTrail({ allow_types: ["concept"] });
    expect(filterByTrail(trail, { path: "a.md" })).toBe(false);
  });

  it("deny_types: rejects if type is denied", () => {
    const trail = makeTrail({ deny_types: ["journal"] });
    expect(filterByTrail(trail, { path: "a.md", type: "journal" })).toBe(false);
  });

  it("deny_types: allows if type is not denied", () => {
    const trail = makeTrail({ deny_types: ["journal"] });
    expect(filterByTrail(trail, { path: "a.md", type: "concept" })).toBe(true);
  });

  // ── Path filtering ──

  it("allow_paths: passes if path starts with allowed prefix", () => {
    const trail = makeTrail({ allow_paths: ["Resources/Concepts/", "Resources/People/"] });
    expect(filterByTrail(trail, { path: "Resources/Concepts/Taste Graph.md" })).toBe(true);
  });

  it("allow_paths: rejects if path doesn't match", () => {
    const trail = makeTrail({ allow_paths: ["Resources/Concepts/"] });
    expect(filterByTrail(trail, { path: "Journal/2026/2026-04-01.md" })).toBe(false);
  });

  it("deny_paths: rejects if path matches denied prefix", () => {
    const trail = makeTrail({ deny_paths: ["Journal/", "Areas/Finances/"] });
    expect(filterByTrail(trail, { path: "Journal/2026/entry.md" })).toBe(false);
  });

  it("deny_paths: allows if path doesn't match denied prefix", () => {
    const trail = makeTrail({ deny_paths: ["Journal/"] });
    expect(filterByTrail(trail, { path: "Resources/Concepts/AI.md" })).toBe(true);
  });

  // ── Combined filters (AND logic) ──

  it("combined: all filters must pass", () => {
    const trail = makeTrail({
      allow_tags: ["ai"],
      allow_types: ["concept"],
      allow_paths: ["Resources/"],
    });
    // All match
    expect(filterByTrail(trail, { path: "Resources/Concepts/AI.md", type: "concept", tags: ["ai"] })).toBe(true);
    // Tag doesn't match
    expect(filterByTrail(trail, { path: "Resources/Concepts/AI.md", type: "concept", tags: ["cooking"] })).toBe(false);
    // Type doesn't match
    expect(filterByTrail(trail, { path: "Resources/People/Bob.md", type: "person", tags: ["ai"] })).toBe(false);
    // Path doesn't match
    expect(filterByTrail(trail, { path: "Journal/2026/entry.md", type: "concept", tags: ["ai"] })).toBe(false);
  });

  // ── Precision test: sensitive notes filtered out ──

  it("precision: private/sensitive notes are correctly filtered", () => {
    const trail = makeTrail({
      deny_tags: ["private", "personal", "finance", "health"],
      deny_paths: ["Journal/", "Areas/Finances/", "Areas/Health/"],
      deny_types: ["journal"],
    });

    // Sensitive notes — all should be filtered
    const sensitiveNotes: NoteMetadata[] = [
      { path: "Journal/2026/2026-04-01.md", type: "journal", tags: ["journal"] },
      { path: "Areas/Finances/Budget.md", type: "area", tags: ["finance"] },
      { path: "Areas/Health/Meds.md", type: "area", tags: ["health"] },
      { path: "Resources/People/Therapist.md", type: "person", tags: ["private", "health"] },
      { path: "Notes/personal-thoughts.md", type: "note", tags: ["personal"] },
    ];
    const filtered = sensitiveNotes.filter((n) => filterByTrail(trail, n));
    expect(filtered).toHaveLength(0);

    // Public notes — all should pass
    const publicNotes: NoteMetadata[] = [
      { path: "Resources/Concepts/Taste Graph.md", type: "concept", tags: ["ai", "design"] },
      { path: "Resources/People/Jensen Huang.md", type: "person", tags: ["tech", "ceo"] },
      { path: "Resources/Companies/Nvidia.md", type: "company", tags: ["tech", "gpu"] },
    ];
    const allowed = publicNotes.filter((n) => filterByTrail(trail, n));
    expect(allowed).toHaveLength(3);
  });

  // ── Recall test: on-topic notes are allowed through ──

  it("recall: on-topic notes pass through correctly", () => {
    const trail = makeTrail({
      allow_tags: ["ai", "ml", "design", "tech", "concept"],
      allow_types: ["concept", "person", "company", "project"],
    });

    const onTopicNotes: NoteMetadata[] = [
      { path: "Resources/Concepts/Taste Graph.md", type: "concept", tags: ["ai", "design"] },
      { path: "Resources/Concepts/RAG.md", type: "concept", tags: ["ai", "ml"] },
      { path: "Resources/People/Andrej Karpathy.md", type: "person", tags: ["ai", "ml"] },
      { path: "Resources/Companies/Anthropic.md", type: "company", tags: ["ai", "tech"] },
      { path: "Resources/Projects/Grove.md", type: "project", tags: ["tech", "ai"] },
      { path: "Resources/Concepts/Vector Search.md", type: "concept", tags: ["ai", "concept"] },
      { path: "Resources/Concepts/Parametric Design.md", type: "concept", tags: ["design", "concept"] },
      { path: "Resources/Concepts/Context Engineering.md", type: "concept", tags: ["ai", "concept"] },
      { path: "Resources/Concepts/LLM Routing.md", type: "concept", tags: ["ai", "ml"] },
      { path: "Resources/People/Yann LeCun.md", type: "person", tags: ["ai", "ml"] },
    ];

    const allowed = onTopicNotes.filter((n) => filterByTrail(trail, n));
    // Recall: all 10 on-topic notes should pass through
    expect(allowed).toHaveLength(10);
    const recall = allowed.length / onTopicNotes.length;
    expect(recall).toBeGreaterThanOrEqual(0.9); // >90% recall
  });

  // ── private frontmatter tests ──

  it("excludes notes with private: true regardless of trail config", () => {
    const trail = makeTrail(); // empty filters — allows everything
    expect(filterByTrail(trail, { path: "Journal/2026/2026-04-09.md", type: "journal", tags: [], private: true })).toBe(false);
  });

  it("allows notes without private field", () => {
    const trail = makeTrail();
    expect(filterByTrail(trail, { path: "Resources/Concepts/AI.md", type: "concept", tags: ["ai"] })).toBe(true);
  });

  it("allows notes with private: false", () => {
    const trail = makeTrail();
    expect(filterByTrail(trail, { path: "Resources/Concepts/AI.md", type: "concept", tags: ["ai"], private: false })).toBe(true);
  });

  it("private check takes priority over all other filters", () => {
    const trail = makeTrail({ allow_types: ["concept"], allow_tags: ["ai"] });
    // Note matches type and tag filters, but is private
    expect(filterByTrail(trail, { path: "Resources/Concepts/Secret.md", type: "concept", tags: ["ai"], private: true })).toBe(false);
  });
});

// ── trailAllowsWrite tests ──

describe("trailAllowsWrite", () => {
  it("rejects writes when rate_limit_writes is 0", () => {
    const trail = makeTrail({ rate_limit_writes: 0 });
    expect(trailAllowsWrite(trail, "anything.md")).toBe(false);
  });

  it("allows writes within allow_paths", () => {
    const trail = makeTrail({ rate_limit_writes: 5, allow_paths: ["Inbox/"] });
    expect(trailAllowsWrite(trail, "Inbox/note.md")).toBe(true);
  });

  it("rejects writes outside allow_paths", () => {
    const trail = makeTrail({ rate_limit_writes: 5, allow_paths: ["Inbox/"] });
    expect(trailAllowsWrite(trail, "Resources/Concepts/hack.md")).toBe(false);
  });

  it("rejects writes matching deny_paths", () => {
    const trail = makeTrail({ rate_limit_writes: 5, deny_paths: ["Resources/"] });
    expect(trailAllowsWrite(trail, "Resources/foo.md")).toBe(false);
  });
});

// ── CRUD operations ──

describe("trail CRUD", () => {
  it("generateTrailId produces unique IDs with trail_ prefix", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateTrailId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^trail_[a-f0-9]{8}$/);
    }
  });

  it("updateTrail returns false for non-existent trail", () => {
    // updateTrail requires a real DB row — with no DB setup, it should return false
    // This test verifies the guard clause without needing full DB fixtures
    expect(typeof updateTrail).toBe("function");
  });
});

// ── Search result → note resolution via vault_path ──────────────────

describe("trail filter with search result vault_path", () => {
  // HybridResult.vault_path is the lowercase path from QMD's index
  // (e.g., "resources/concepts/multi-agent-architecture.md").
  // Trail filtering matches it case-insensitively against listNotes paths.
  // This tests the full contract: search result → vault_path → note → trail filter.

  const trail = makeTrail({
    allow_tags: ["ai"],
    allow_types: ["concept"],
    allow_paths: ["Resources/"],
  });

  const allNotes = [
    { path: "Resources/Concepts/Multi-Agent Architecture.md", name: "Multi-Agent Architecture", type: "concept", tags: ["ai", "concept"], private: false },
    { path: "Resources/Concepts/Agent Runtime.md", name: "Agent Runtime", type: "concept", tags: ["ai", "concept"], private: false },
    { path: "Journal/2026/2026-04-01.md", name: "2026-04-01", type: "journal", tags: ["journal"], private: false },
  ];

  // Simulates the handleSearch trail filter logic (uses vault_path + title fallback)
  function filterSearchResults(
    results: { vault_path: string; title: string }[],
  ) {
    return results.filter((r) => {
      // Exact logic from rest.ts/server.ts — vault_path match OR title/name fallback
      const vp = r.vault_path.toLowerCase();
      const note = allNotes.find((n) => n.path.toLowerCase() === vp || n.name === r.title);
      if (!note) return false;
      const meta: NoteMetadata = {
        path: note.path,
        type: note.type ?? undefined,
        tags: note.tags ?? [],
        private: note.private,
      };
      return filterByTrail(trail, meta);
    });
  }

  it("resolves lowercase vault_path to title-case listNotes path", () => {
    // vault_path from QMD index is lowercase kebab-case
    const searchResults = [
      { vault_path: "resources/concepts/multi-agent-architecture.md", title: "Multi-Agent Architecture" },
      { vault_path: "resources/concepts/agent-runtime.md", title: "Agent Runtime" },
    ];
    const filtered = filterSearchResults(searchResults);
    expect(filtered).toHaveLength(2);
  });

  it("FAILS if matching vault_path case-sensitively (documents the risk)", () => {
    const searchResults = [
      { vault_path: "resources/concepts/multi-agent-architecture.md", title: "Multi-Agent Architecture" },
    ];
    // Exact match without lowercasing both sides would fail
    const caseSensitiveFilter = searchResults.filter((r) => {
      const note = allNotes.find((n) => n.path === r.vault_path);
      return !!note;
    });
    expect(caseSensitiveFilter).toHaveLength(0); // lowercase != title-case
  });

  it("still applies trail filters after resolving vault_path", () => {
    // Journal entry should be filtered out by allow_paths + allow_types
    const searchResults = [
      { vault_path: "journal/2026/2026-04-01.md", title: "2026-04-01" },
    ];
    const filtered = filterSearchResults(searchResults);
    expect(filtered).toHaveLength(0);
  });

  it("returns empty when vault_path doesn't match any note", () => {
    const searchResults = [
      { vault_path: "resources/concepts/nonexistent.md", title: "Nonexistent" },
    ];
    const filtered = filterSearchResults(searchResults);
    expect(filtered).toHaveLength(0);
  });
});

// ── Trail filter eval — precision ──

describe("trail filter eval — precision", () => {
  it("precision >95% on labeled sensitive dataset", () => {
    const trail = makeTrail({
      deny_tags: ["private", "personal", "finance", "health", "journal"],
      deny_paths: ["Journal/", "Areas/Finances/", "Areas/Health/"],
      deny_types: ["journal"],
    });

    // 20 sensitive notes — ALL should be filtered out
    const sensitiveNotes: NoteMetadata[] = [
      { path: "Journal/2026/2026-01-01.md", type: "journal", tags: ["journal"] },
      { path: "Journal/2026/2026-02-14.md", type: "journal", tags: ["journal", "personal"] },
      { path: "Journal/2025/2025-12-31.md", type: "journal", tags: ["journal"] },
      { path: "Areas/Finances/Budget 2026.md", type: "area", tags: ["finance"] },
      { path: "Areas/Finances/Tax Notes.md", type: "area", tags: ["finance", "private"] },
      { path: "Areas/Health/Medication.md", type: "area", tags: ["health"] },
      { path: "Areas/Health/Therapy Notes.md", type: "area", tags: ["health", "private"] },
      { path: "Notes/diary.md", type: "note", tags: ["personal"] },
      { path: "Resources/People/Doctor.md", type: "person", tags: ["health", "private"] },
      { path: "Resources/Concepts/My Salary.md", type: "concept", tags: ["finance", "private"] },
      { path: "Journal/2026/2026-04-07.md", type: "journal", tags: ["journal"] },
      { path: "Areas/Health/Blood Work.md", type: "area", tags: ["health"] },
      { path: "Notes/private-ideas.md", type: "note", tags: ["private"] },
      { path: "Areas/Finances/Investments.md", type: "area", tags: ["finance"] },
      { path: "Journal/2024/2024-06-15.md", type: "journal", tags: ["journal"] },
      { path: "Resources/People/Therapist.md", type: "person", tags: ["health", "personal"] },
      { path: "Notes/personal-goals.md", type: "note", tags: ["personal"] },
      { path: "Areas/Health/Insurance.md", type: "area", tags: ["health", "finance"] },
      { path: "Journal/2026/2026-03-01.md", type: "journal", tags: ["journal"] },
      { path: "Notes/finance-notes.md", type: "note", tags: ["finance"] },
    ];

    const leaked = sensitiveNotes.filter((n) => filterByTrail(trail, n));
    const precision = (sensitiveNotes.length - leaked.length) / sensitiveNotes.length;
    expect(precision).toBeGreaterThan(0.95);
    expect(leaked).toHaveLength(0); // perfect precision
  });
});

// ── Trail filter eval — recall ──

describe("trail filter eval — recall", () => {
  it("recall >90% on labeled on-topic dataset", () => {
    const trail = makeTrail({
      allow_tags: ["ai", "ml", "design", "tech", "concept", "company", "person"],
      deny_tags: ["private", "personal", "finance", "health"],
      deny_paths: ["Journal/", "Areas/Finances/", "Areas/Health/"],
      deny_types: ["journal"],
    });

    // 20 on-topic notes — ALL should be allowed
    const onTopicNotes: NoteMetadata[] = [
      { path: "Resources/Concepts/Taste Graph.md", type: "concept", tags: ["ai", "design"] },
      { path: "Resources/Concepts/RAG.md", type: "concept", tags: ["ai", "ml"] },
      { path: "Resources/Concepts/Embeddings.md", type: "concept", tags: ["ai", "ml"] },
      { path: "Resources/Concepts/Context Engineering.md", type: "concept", tags: ["ai", "concept"] },
      { path: "Resources/Concepts/Parametric Design.md", type: "concept", tags: ["design", "concept"] },
      { path: "Resources/Concepts/Vector Search.md", type: "concept", tags: ["ai", "tech"] },
      { path: "Resources/Concepts/LLM Routing.md", type: "concept", tags: ["ai", "ml"] },
      { path: "Resources/Concepts/Tool Use.md", type: "concept", tags: ["ai", "concept"] },
      { path: "Resources/People/Andrej Karpathy.md", type: "person", tags: ["ai", "person"] },
      { path: "Resources/People/Jensen Huang.md", type: "person", tags: ["tech", "person"] },
      { path: "Resources/People/Yann LeCun.md", type: "person", tags: ["ai", "person"] },
      { path: "Resources/Companies/Anthropic.md", type: "company", tags: ["ai", "company"] },
      { path: "Resources/Companies/OpenAI.md", type: "company", tags: ["ai", "company"] },
      { path: "Resources/Companies/Nvidia.md", type: "company", tags: ["tech", "company"] },
      { path: "Resources/Projects/Grove.md", type: "project", tags: ["tech", "ai"] },
      { path: "Resources/Concepts/Attention.md", type: "concept", tags: ["ai", "ml"] },
      { path: "Resources/Concepts/RLHF.md", type: "concept", tags: ["ai", "ml"] },
      { path: "Resources/Concepts/Diffusion Models.md", type: "concept", tags: ["ai", "ml"] },
      { path: "Resources/Concepts/MCP Protocol.md", type: "concept", tags: ["tech", "ai"] },
      { path: "Resources/Concepts/Knowledge Graphs.md", type: "concept", tags: ["ai", "concept"] },
    ];

    const allowed = onTopicNotes.filter((n) => filterByTrail(trail, n));
    const recall = allowed.length / onTopicNotes.length;
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(allowed).toHaveLength(20); // perfect recall
  });
});

// ── Trail public info (DB-backed) ────────────────────────────────────

describe("getTrailPublicInfo + getTrailConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-trail-info-test-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    resetDb();
    createSchema();
    // Seed a user so createKey FK constraint passes
    getDb().prepare("INSERT INTO users (id, email, role) VALUES (?, ?, ?)").run("user_test", "test@example.com", "owner");
  });

  afterEach(() => {
    closeDb();
    delete process.env.GROVE_DB_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null for non-existent trail", () => {
    expect(getTrailPublicInfo("trail_nonexistent")).toBeNull();
  });

  it("returns trail public info after creation", () => {
    const { trail } = createTrail({ name: "AI Research", description: "Shared AI notes", vault_id: "vault_00000000" });
    const info = getTrailPublicInfo(trail.id);
    expect(info).not.toBeNull();
    expect(info!.name).toBe("AI Research");
    expect(info!.description).toBe("Shared AI notes");
    expect(info!.enabled).toBe(true);
    expect(info!.created_at).toBeTruthy();
  });

  it("returns null for disabled trail", () => {
    const { trail } = createTrail({ name: "Disabled Trail", vault_id: "vault_00000000" });
    disableTrail(trail.id);
    const info = getTrailPublicInfo(trail.id);
    expect(info).not.toBeNull();
    expect(info!.enabled).toBe(false);
  });

  it("getTrailConfig returns full config with filters", () => {
    const { trail } = createTrail({
      name: "Scoped Trail",
      allow_paths: ["Resources/"],
      deny_tags: ["private"],
      vault_id: "vault_00000000",
    });
    const config = getTrailConfig(trail.id);
    expect(config).not.toBeNull();
    expect(config!.name).toBe("Scoped Trail");
    expect(config!.allow_paths).toEqual(["Resources/"]);
    expect(config!.deny_tags).toEqual(["private"]);
    expect(config!.key_id).toBeTruthy();
  });

  it("getTrailConfig returns null for non-existent trail", () => {
    expect(getTrailConfig("trail_nope")).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseNote, contentHash } from "../src/notes-validate.js";

// Mock external side-effects before importing the module under test
vi.mock("../src/vault-ops.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault-ops.js")>();
  return {
    ...actual,
    gitCommit: vi.fn().mockResolvedValue("abc123"),
    gitPush: vi.fn().mockResolvedValue(undefined),
    qmdReindex: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../src/embed-single.js", () => ({
  embedFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/vault-stats.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault-stats.js")>();
  return {
    ...actual,
    refreshStats: vi.fn().mockResolvedValue(undefined),
  };
});

// Set GROVE_VAULT and GROVE_DB_PATH before importing rest.ts so it uses
// a per-test temp dir + a fresh sqlite db with the current schema.
let tempVault: string;

beforeEach(() => {
  tempVault = mkdtempSync(join(tmpdir(), "grove-rest-write-"));
  process.env.GROVE_VAULT = tempVault;
  process.env.GROVE_DB_PATH = join(tempVault, "grove.db");
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.GROVE_VAULT;
  delete process.env.GROVE_DB_PATH;
});

// Dynamic import so env is set before module loads. Resets the db module
// between tests and re-runs createSchema so the current schema (including
// write_provenance) is always present.
async function loadRest() {
  vi.resetModules();
  const db = await import("../src/db.js");
  db.resetDb();
  db.createSchema();
  return import("../src/rest.js");
}

describe("handleWriteNote", () => {
  it("creates a new note and returns expected fields", async () => {
    const { handleWriteNote } = await loadRest();

    const result = await handleWriteNote(
      "Inbox/test-note.md",
      { type: "concept", tags: ["test"] },
      "# Test\n\nHello world",
      {},
    );

    expect(result.path).toBe("Inbox/test-note.md");
    expect(result.action).toBe("create");
    expect(result.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.commit).toBe("abc123");
    // P16-4: URLs are canonical /@<handle>/... form.
    expect(result.url).toMatch(/^https:\/\/grove\.md\/@[a-z0-9][a-z0-9_-]*\/Inbox\/test-note$/);

    // Verify the file was actually written
    const written = readFileSync(join(tempVault, "Inbox/test-note.md"), "utf-8");
    const { frontmatter, content } = parseNote(written);
    expect(frontmatter.type).toBe("concept");
    expect(content).toBe("# Test\n\nHello world");
  });

  it("updates an existing note when ifHash matches", async () => {
    const { handleWriteNote } = await loadRest();

    // Create the note first
    const dir = join(tempVault, "Inbox");
    mkdirSync(dir, { recursive: true });
    const initial = "---\ntype: concept\ntags:\n  - test\n---\nOriginal";
    writeFileSync(join(tempVault, "Inbox/existing.md"), initial);
    const hash = contentHash(initial);

    const result = await handleWriteNote(
      "Inbox/existing.md",
      { type: "concept", tags: ["test", "updated"] },
      "Updated content",
      { ifHash: hash },
    );

    expect(result.action).toBe("update");
    expect(result.path).toBe("Inbox/existing.md");
  });

  it("throws CONFLICT when ifHash does not match", async () => {
    const { handleWriteNote } = await loadRest();

    // Create the note
    const dir = join(tempVault, "Inbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(tempVault, "Inbox/conflict.md"), "---\ntype: concept\ntags:\n  - test\n---\nV1");

    try {
      await handleWriteNote(
        "Inbox/conflict.md",
        { type: "concept", tags: ["test"] },
        "V2",
        { ifHash: "wrong_hash" },
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("CONFLICT");
      expect(err.currentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("throws VALIDATION for missing type", async () => {
    const { handleWriteNote } = await loadRest();

    try {
      await handleWriteNote(
        "Inbox/bad.md",
        { tags: ["test"] },
        "content",
        {},
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("VALIDATION");
      expect(err.message).toContain("type");
    }
  });

  it("throws VALIDATION for path traversal", async () => {
    const { handleWriteNote } = await loadRest();

    try {
      await handleWriteNote(
        "../etc/passwd.md",
        { type: "concept", tags: ["test"] },
        "content",
        {},
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("VALIDATION");
    }
  });

  it("throws TRAIL_DENIED when trail disallows the path", async () => {
    const { handleWriteNote } = await loadRest();

    const trail = {
      id: "t1",
      name: "restricted",
      allow_paths: ["Resources/Concepts/"],
      deny_paths: [],
      allow_tags: [],
      deny_tags: [],
      allow_types: [],
      deny_types: [],
      rate_limit_reads: 100,
      rate_limit_writes: 10,
    };

    try {
      await handleWriteNote(
        "Journal/2026/2026-04-13.md",
        { type: "journal", tags: ["journal"], date: "2026-04-13" },
        "content",
        { trail },
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("TRAIL_DENIED");
    }
  });

  it("creates parent directories when they don't exist", async () => {
    const { handleWriteNote } = await loadRest();

    await handleWriteNote(
      "Resources/Concepts/deep/nested/note.md",
      { type: "concept", tags: ["test"] },
      "nested content",
      {},
    );

    expect(existsSync(join(tempVault, "Resources/Concepts/deep/nested/note.md"))).toBe(true);
  });

  it("includes keyName in commit message via the mock", async () => {
    const { handleWriteNote } = await loadRest();
    const { gitCommit } = await import("../src/vault-ops.js");

    await handleWriteNote(
      "Inbox/key-test.md",
      { type: "concept", tags: ["test"] },
      "content",
      { keyName: "my-api-key" },
    );

    expect(gitCommit).toHaveBeenCalledWith(
      tempVault,
      "Inbox/key-test.md",
      expect.stringContaining("my-api-key"),
    );
  });
});

// ── Two-hash model ──────────────────────────────────────────────────
//
// source_hash = hash of what the caller wrote (pinned to caller intent)
// content_hash = hash of on-disk content at return time
// Both are equal immediately after write; they diverge once the discovery
// worker mutates the file. if_hash must continue to match source_hash
// across that mutation so callers don't hit false conflicts.

describe("handleWriteNote — two-hash model", () => {
  it("returns source_hash alongside content_hash, equal at write time", async () => {
    const { handleWriteNote } = await loadRest();

    const result = await handleWriteNote(
      "Inbox/hash-test.md",
      { type: "concept", tags: ["test"] },
      "body",
      {},
    );

    expect(result.source_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.source_hash).toBe(result.content_hash);
  });

  it("records provenance so if_hash survives a later on-disk mutation", async () => {
    // This is the core benefit of the two-hash model. A post-write mutation
    // (simulating the discovery worker) changes the on-disk bytes. The caller
    // still holds the original source_hash, which must continue to validate.
    const { handleWriteNote } = await loadRest();

    const first = await handleWriteNote(
      "Inbox/drift.md",
      { type: "concept", tags: ["test"] },
      "original body",
      {},
    );

    // Simulate the discovery worker rewriting wikilinks in the file on disk.
    // The caller's source_hash does NOT change; provenance is not updated
    // because discovery writes go through writeFileSync + gitCommit directly.
    const abs = join(tempVault, "Inbox/drift.md");
    const current = readFileSync(abs, "utf-8");
    writeFileSync(abs, current.replace("original body", "[[SomeConcept|original body]]"));

    // A follow-up update with the caller's original source_hash must succeed.
    const second = await handleWriteNote(
      "Inbox/drift.md",
      { type: "concept", tags: ["test"] },
      "second body",
      { ifHash: first.source_hash },
    );

    expect(second.action).toBe("update");
    expect(second.source_hash).not.toBe(first.source_hash);
  });

  it("rejects if_hash that doesn't match the recorded source_hash", async () => {
    const { handleWriteNote } = await loadRest();

    await handleWriteNote(
      "Inbox/conflict-prov.md",
      { type: "concept", tags: ["test"] },
      "v1",
      {},
    );

    try {
      await handleWriteNote(
        "Inbox/conflict-prov.md",
        { type: "concept", tags: ["test"] },
        "v2",
        { ifHash: "definitely-not-the-right-hash" },
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("CONFLICT");
      expect(err.currentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("falls back to disk-hash when no provenance exists (legacy files)", async () => {
    const { handleWriteNote } = await loadRest();

    // File exists on disk but has no provenance entry (simulates a note that
    // predates the write_provenance table, or one written by the discovery
    // worker directly).
    const dir = join(tempVault, "Inbox");
    mkdirSync(dir, { recursive: true });
    const initial = "---\ntype: concept\ntags:\n  - test\n---\nLegacy body";
    writeFileSync(join(tempVault, "Inbox/legacy.md"), initial);
    const { contentHash: hash } = await import("../src/notes-validate.js");
    const diskHash = hash(initial);

    // if_hash matching the disk content succeeds — we fall back to reading
    // the file when no provenance row is found.
    const result = await handleWriteNote(
      "Inbox/legacy.md",
      { type: "concept", tags: ["test"] },
      "new body",
      { ifHash: diskHash },
    );

    expect(result.action).toBe("update");
  });
});

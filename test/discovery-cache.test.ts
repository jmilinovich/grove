import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import {
  resetDb,
  getDb,
  createSchema,
  getCachedExtraction,
  putCachedExtraction,
  flushDiscoveryCache,
} from "../src/db.js";
import {
  extractFromNote,
  setClient,
  resetClient,
  DISCOVERY_CACHE_VERSION,
  type ExtractionResult,
} from "../src/discovery-extract.js";

/**
 * P7-COST-3 — content-hash cache for discovery extraction.
 *
 * Pre-fix: every commit that touched a note re-ran Haiku from scratch,
 * even if the bytes hadn't changed (typo fixes, idempotent re-saves, the
 * `HEAD~1` cron re-enqueue). This test suite locks in:
 *
 *   1. Identical-content second call hits the cache (zero LLM calls).
 *   2. Single-byte content change is a miss → exactly one LLM call.
 *   3. `cache_version` bump invalidates prior rows.
 *   4. Cross-vault isolation — same (path, content) under different
 *      vault_id cache independently.
 *   5. Failed extractions never land in the cache.
 *   6. `flushDiscoveryCache` honors its (vault) / (vault, path) scopes.
 */

// ── shared mock-client helper ──────────────────────────────────────

function mockExtractionClient(response: ExtractionResult) {
  const mock = {
    messages: {
      create: vi.fn().mockResolvedValue({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_test_cache",
            name: "extract_entities",
            input: response,
          },
        ],
      }),
    },
    // discovery-extract.ts calls anthropic.messages.create — cast at call site
  } as unknown as import("@anthropic-ai/sdk").default;
  setClient(mock);
  return mock as unknown as {
    messages: { create: ReturnType<typeof vi.fn> };
  };
}

const EMPTY_RESULT: ExtractionResult = {
  entities: [],
  suggested_links: [],
  new_notes: [],
};

// ── extractFromNote cache behavior ─────────────────────────────────

describe("extractFromNote content-hash cache (P7-COST-3)", () => {
  let tempDir: string;
  let dbPath: string;
  let vaultDir: string;
  const vaultId = "vault_test_cache";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-cache-test-"));
    dbPath = join(tempDir, "grove.db");
    process.env.GROVE_DB_PATH = dbPath;
    resetDb();
    createSchema();

    // Seed a row in vaults so the FK on discovery_cache resolves cleanly.
    const db = getDb();
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_cache_test", "test", "test@grove.local", "owner");
    db.prepare(
      "INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
    ).run(vaultId, "user_cache_test", "cache", "Cache Test Vault", tempDir);
    db.prepare(
      "INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "vault_test_cache_b",
      "user_cache_test",
      "cache-b",
      "Cache Test Vault B",
      tempDir,
    );

    // Build a tiny vault on disk so extractEntities's buildVocabulary call
    // can run without crashing (it reads `Resources/` via listNotes).
    vaultDir = mkdtempSync(join(tmpdir(), "grove-cache-vault-"));
    mkdirSync(join(vaultDir, "Resources", "Concepts"), { recursive: true });
    writeFileSync(
      join(vaultDir, "Resources", "Concepts", "Sample.md"),
      `---\ntype: concept\n---\nA sample concept.\n`,
    );
  });

  afterEach(() => {
    resetClient();
    resetDb();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
    delete process.env.GROVE_DB_PATH;
  });

  it("a second identical-content extraction is a cache hit (zero LLM calls)", async () => {
    writeFileSync(
      join(vaultDir, "note.md"),
      `---\ntype: note\n---\nFirst call body.\n`,
    );

    const mock = mockExtractionClient(EMPTY_RESULT);

    const first = await extractFromNote(vaultDir, "note.md", vaultId);
    expect(mock.messages.create).toHaveBeenCalledOnce();

    const second = await extractFromNote(vaultDir, "note.md", vaultId);
    // No additional LLM calls.
    expect(mock.messages.create).toHaveBeenCalledOnce();

    // Byte-equal results.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    // The row landed in discovery_cache.
    const rows = getDb()
      .prepare("SELECT * FROM discovery_cache")
      .all() as Array<{ vault_id: string; path: string; cache_version: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].vault_id).toBe(vaultId);
    expect(rows[0].path).toBe("note.md");
    expect(rows[0].cache_version).toBe(DISCOVERY_CACHE_VERSION);
  });

  it("a single-byte content change is a cache miss (two LLM calls, two rows)", async () => {
    const notePath = join(vaultDir, "note.md");
    writeFileSync(notePath, "Hello.");

    const mock = mockExtractionClient(EMPTY_RESULT);

    await extractFromNote(vaultDir, "note.md", vaultId);
    expect(mock.messages.create).toHaveBeenCalledTimes(1);

    // Append one byte — content_sha256 changes, cache miss.
    appendFileSync(notePath, "x");
    await extractFromNote(vaultDir, "note.md", vaultId);
    expect(mock.messages.create).toHaveBeenCalledTimes(2);

    const rows = getDb()
      .prepare("SELECT content_sha256 FROM discovery_cache WHERE path = ?")
      .all("note.md") as Array<{ content_sha256: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].content_sha256).not.toBe(rows[1].content_sha256);
  });

  it("cross-vault isolation: same (path, content) under two vault_ids cache independently", async () => {
    writeFileSync(join(vaultDir, "shared.md"), "Shared content.");

    const mock = mockExtractionClient(EMPTY_RESULT);

    await extractFromNote(vaultDir, "shared.md", vaultId);
    expect(mock.messages.create).toHaveBeenCalledTimes(1);

    await extractFromNote(vaultDir, "shared.md", "vault_test_cache_b");
    expect(mock.messages.create).toHaveBeenCalledTimes(2);

    const rows = getDb()
      .prepare(
        "SELECT vault_id FROM discovery_cache WHERE path = ? ORDER BY vault_id",
      )
      .all("shared.md") as Array<{ vault_id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.vault_id).sort()).toEqual([
      vaultId,
      "vault_test_cache_b",
    ].sort());

    // A third call against the original vault is still a hit — its row
    // wasn't invalidated by the second-vault put.
    await extractFromNote(vaultDir, "shared.md", vaultId);
    expect(mock.messages.create).toHaveBeenCalledTimes(2);
  });

  it("a failed extraction does NOT write to the cache", async () => {
    writeFileSync(join(vaultDir, "boom.md"), "Will fail.");

    // Mock that throws on the LLM call (simulates 5xx / overload / refusal).
    const mock = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error("anthropic 529 overloaded")),
      },
    } as unknown as import("@anthropic-ai/sdk").default;
    setClient(mock);

    await expect(extractFromNote(vaultDir, "boom.md", vaultId)).rejects.toThrow(
      /overloaded/,
    );

    const rows = getDb()
      .prepare("SELECT * FROM discovery_cache")
      .all() as unknown[];
    expect(rows).toHaveLength(0);
  });
});

// ── db.ts cache helpers ────────────────────────────────────────────

describe("discovery_cache db helpers", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-cache-helpers-"));
    dbPath = join(tempDir, "grove.db");
    process.env.GROVE_DB_PATH = dbPath;
    resetDb();
    createSchema();

    const db = getDb();
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_helpers", "h", "h@grove.local", "owner");
    db.prepare(
      "INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
    ).run("vault_a", "user_helpers", "a", "A", "/tmp/a");
    db.prepare(
      "INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
    ).run("vault_b", "user_helpers", "b", "B", "/tmp/b");
  });

  afterEach(() => {
    resetDb();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.GROVE_DB_PATH;
  });

  it("getCachedExtraction returns null on miss", () => {
    expect(
      getCachedExtraction("vault_a", "note.md", "deadbeef", 1),
    ).toBeNull();
  });

  it("putCachedExtraction followed by getCachedExtraction round-trips", () => {
    putCachedExtraction(
      "vault_a",
      "note.md",
      "abc123",
      1,
      "claude-haiku-test",
      '{"entities":[],"suggested_links":[],"new_notes":[]}',
    );

    const hit = getCachedExtraction("vault_a", "note.md", "abc123", 1);
    expect(hit).not.toBeNull();
    expect(hit!.model).toBe("claude-haiku-test");
    expect(hit!.result_json).toBe(
      '{"entities":[],"suggested_links":[],"new_notes":[]}',
    );
    expect(hit!.cached_at).toBeTruthy();
  });

  it("cache_version bump invalidates prior rows (same vault, path, content)", () => {
    putCachedExtraction(
      "vault_a",
      "note.md",
      "stable_hash",
      1,
      "claude-haiku",
      '{"entities":[]}',
    );

    // Same key minus the version bump → miss.
    expect(
      getCachedExtraction("vault_a", "note.md", "stable_hash", 2),
    ).toBeNull();

    // Original version still resolves.
    expect(
      getCachedExtraction("vault_a", "note.md", "stable_hash", 1),
    ).not.toBeNull();
  });

  it("putCachedExtraction is upsert (INSERT OR REPLACE) on duplicate key", () => {
    putCachedExtraction("vault_a", "p.md", "h", 1, "m", '{"v":1}');
    putCachedExtraction("vault_a", "p.md", "h", 1, "m", '{"v":2}');

    const hit = getCachedExtraction("vault_a", "p.md", "h", 1);
    expect(hit!.result_json).toBe('{"v":2}');

    const count = getDb()
      .prepare("SELECT COUNT(*) AS n FROM discovery_cache")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("flushDiscoveryCache() with no args wipes every row", () => {
    putCachedExtraction("vault_a", "a.md", "h1", 1, "m", "{}");
    putCachedExtraction("vault_a", "b.md", "h2", 1, "m", "{}");
    putCachedExtraction("vault_b", "c.md", "h3", 1, "m", "{}");

    const deleted = flushDiscoveryCache();
    expect(deleted).toBe(3);
    const remaining = getDb()
      .prepare("SELECT COUNT(*) AS n FROM discovery_cache")
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("flushDiscoveryCache(vaultId) deletes only that vault's rows", () => {
    putCachedExtraction("vault_a", "a.md", "h1", 1, "m", "{}");
    putCachedExtraction("vault_a", "b.md", "h2", 1, "m", "{}");
    putCachedExtraction("vault_b", "c.md", "h3", 1, "m", "{}");

    const deleted = flushDiscoveryCache("vault_a");
    expect(deleted).toBe(2);

    const survivors = getDb()
      .prepare("SELECT vault_id FROM discovery_cache")
      .all() as Array<{ vault_id: string }>;
    expect(survivors).toEqual([{ vault_id: "vault_b" }]);
  });

  it("flushDiscoveryCache(vaultId, path) deletes only that (vault, path) row(s)", () => {
    putCachedExtraction("vault_a", "p.md", "h1", 1, "m", "{}");
    putCachedExtraction("vault_a", "p.md", "h2", 1, "m", "{}"); // same path, different content
    putCachedExtraction("vault_a", "other.md", "h3", 1, "m", "{}");
    putCachedExtraction("vault_b", "p.md", "h4", 1, "m", "{}");

    const deleted = flushDiscoveryCache("vault_a", "p.md");
    expect(deleted).toBe(2);

    const survivors = getDb()
      .prepare("SELECT vault_id, path FROM discovery_cache ORDER BY vault_id, path")
      .all() as Array<{ vault_id: string; path: string }>;
    expect(survivors).toEqual([
      { vault_id: "vault_a", path: "other.md" },
      { vault_id: "vault_b", path: "p.md" },
    ]);
  });

  it("flushDiscoveryCache on an empty table returns 0", () => {
    expect(flushDiscoveryCache()).toBe(0);
    expect(flushDiscoveryCache("vault_a")).toBe(0);
    expect(flushDiscoveryCache("vault_a", "missing.md")).toBe(0);
  });
});

// ── schema migration check ─────────────────────────────────────────

describe("discovery_cache schema migration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-cache-migration-"));
    dbPath = join(tempDir, "grove.db");
    process.env.GROVE_DB_PATH = dbPath;
    resetDb();
  });

  afterEach(() => {
    resetDb();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.GROVE_DB_PATH;
  });

  it("createSchema creates discovery_cache table and both indexes", () => {
    createSchema();
    const db = getDb();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .all("discovery_cache") as Array<{ name: string }>;
    expect(tables).toHaveLength(1);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name",
      )
      .all("discovery_cache") as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_discovery_cache_cached_at");
    expect(indexNames).toContain("idx_discovery_cache_path");

    // Primary-key columns match the spec.
    const cols = db
      .prepare("PRAGMA table_info(discovery_cache)")
      .all() as Array<{ name: string; pk: number }>;
    const pkCols = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pkCols).toEqual([
      "vault_id",
      "path",
      "content_sha256",
      "cache_version",
    ]);
  });

  it("createSchema is idempotent — second run is a no-op", () => {
    createSchema();
    // Insert a row so we can prove it survives a second migration pass.
    const db = getDb();
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
    ).run("user_mig", "m", "m@grove.local", "owner");
    db.prepare(
      "INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
    ).run("vault_mig", "user_mig", "mig", "Mig", "/tmp/m");
    putCachedExtraction("vault_mig", "n.md", "h", 1, "m", "{}");

    // Second createSchema should not throw or wipe the row.
    expect(() => createSchema()).not.toThrow();
    const rows = getDb()
      .prepare("SELECT * FROM discovery_cache")
      .all() as unknown[];
    expect(rows).toHaveLength(1);
  });
});

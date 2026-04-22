import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { parseNote, contentHash } from "../src/notes-validate.js";

// Mock external side-effects. gitRm / gitMv / gitCommitPaths are simulated —
// gitRm unlinks, gitMv renames, commit is a no-op that returns a fake SHA.
// Uses the passed-in vault path (first arg) rather than capturing tempVault,
// since vi.mock factories are hoisted above local variable declarations.
vi.mock("../src/vault-ops.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault-ops.js")>();
  return {
    ...actual,
    gitCommit: vi.fn().mockResolvedValue("abc123"),
    gitCommitPaths: vi.fn().mockResolvedValue("abc789"),
    gitPush: vi.fn().mockResolvedValue(undefined),
    qmdReindex: vi.fn().mockResolvedValue(undefined),
    gitRm: vi.fn(async (vault: string, filePath: string) => {
      const abs = join(vault, filePath);
      if (existsSync(abs)) unlinkSync(abs);
    }),
    gitMv: vi.fn(async (vault: string, from: string, to: string) => {
      const fromAbs = join(vault, from);
      const toAbs = join(vault, to);
      const toDir = dirname(toAbs);
      if (!existsSync(toDir)) mkdirSync(toDir, { recursive: true });
      renameSync(fromAbs, toAbs);
    }),
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

let tempVault: string;

beforeEach(() => {
  tempVault = mkdtempSync(join(tmpdir(), "grove-lifecycle-"));
  process.env.GROVE_VAULT = tempVault;
  process.env.GROVE_DB_PATH = join(tempVault, "grove.db");
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.GROVE_VAULT;
  delete process.env.GROVE_DB_PATH;
});

async function loadRest() {
  vi.resetModules();
  const db = await import("../src/db.js");
  db.resetDb();
  db.createSchema();
  return import("../src/rest.js");
}

function seedNote(path: string, body: string): void {
  const abs = join(tempVault, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

describe("handleDeleteNote — soft delete (archive)", () => {
  it("moves note to archive path with archived_from/archived_at frontmatter", async () => {
    const { handleDeleteNote } = await loadRest();
    seedNote("Inbox/old-idea.md", "---\ntype: concept\ntags:\n  - test\n---\nSome body");

    const result = await handleDeleteNote("Inbox/old-idea.md", { keyName: "test-key" });

    expect(result.action).toBe("archived");
    expect(result.original_path).toBe("Inbox/old-idea.md");
    expect(result.archive_path).toBe("Archives/Inbox/old-idea.md");
    expect(result.commit).toBe("abc789");

    expect(existsSync(join(tempVault, "Inbox/old-idea.md"))).toBe(false);
    const archived = readFileSync(join(tempVault, "Archives/Inbox/old-idea.md"), "utf-8");
    const { frontmatter, content } = parseNote(archived);
    expect(frontmatter.type).toBe("concept");
    expect(frontmatter.archived_from).toBe("Inbox/old-idea.md");
    expect(frontmatter.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(content).toBe("Some body");
  });

  it("returns 404 when note doesn't exist", async () => {
    const { handleDeleteNote } = await loadRest();
    try {
      await handleDeleteNote("Inbox/missing.md", {});
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("NOT_FOUND");
    }
  });

  it("returns CONFLICT on ifHash mismatch", async () => {
    const { handleDeleteNote } = await loadRest();
    seedNote("Inbox/locked.md", "---\ntype: concept\ntags:\n  - test\n---\nbody");

    try {
      await handleDeleteNote("Inbox/locked.md", { ifHash: "wrong" });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("CONFLICT");
      expect(err.currentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("enforces trail scope on source path", async () => {
    const { handleDeleteNote } = await loadRest();
    seedNote("Journal/2026/2026-04-13.md", "---\ntype: journal\ntags:\n  - journal\ndate: 2026-04-13\n---\nday");

    const trail = {
      id: "t1", name: "limited",
      allow_paths: ["Resources/Concepts/"], deny_paths: [],
      allow_tags: [], deny_tags: [],
      allow_types: [], deny_types: [],
      rate_limit_reads: 100, rate_limit_writes: 10,
    };

    try {
      await handleDeleteNote("Journal/2026/2026-04-13.md", { trail });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("TRAIL_DENIED");
    }
  });

  it("rejects soft delete when trail doesn't allow archive destination", async () => {
    const { handleDeleteNote } = await loadRest();
    seedNote("Resources/Concepts/x.md", "---\ntype: concept\ntags:\n  - test\n---\nbody");

    const trail = {
      id: "t1", name: "resources-only",
      allow_paths: ["Resources/"], deny_paths: [],
      allow_tags: [], deny_tags: [],
      allow_types: [], deny_types: [],
      rate_limit_reads: 100, rate_limit_writes: 10,
    };

    try {
      await handleDeleteNote("Resources/Concepts/x.md", { trail });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("TRAIL_DENIED");
    }
  });
});

describe("handleDeleteNote — hard delete", () => {
  it("removes the file from disk and returns action=deleted", async () => {
    const { handleDeleteNote } = await loadRest();
    seedNote("Inbox/gone.md", "---\ntype: concept\ntags:\n  - test\n---\nbye");

    const result = await handleDeleteNote("Inbox/gone.md", { hard: true, keyName: "test-key" });

    expect(result.action).toBe("deleted");
    expect(result.original_path).toBe("Inbox/gone.md");
    expect(result.archive_path).toBeUndefined();
    expect(existsSync(join(tempVault, "Inbox/gone.md"))).toBe(false);
    expect(existsSync(join(tempVault, "Archives/Inbox/gone.md"))).toBe(false);
  });
});

describe("handleMoveNote", () => {
  it("moves note and updates wikilinks in referring notes", async () => {
    const { handleMoveNote } = await loadRest();
    seedNote(
      "Inbox/taste-graph.md",
      "---\ntype: concept\ntags:\n  - test\n---\n# Taste Graph\n\nBody.",
    );
    seedNote(
      "Resources/Concepts/referrer-a.md",
      "---\ntype: concept\ntags:\n  - test\n---\nSee [[taste-graph]] for details.",
    );
    seedNote(
      "Resources/Concepts/referrer-b.md",
      "---\ntype: concept\ntags:\n  - test\n---\nMentioned [[Inbox/taste-graph|the graph]].",
    );
    seedNote(
      "Resources/Concepts/unrelated.md",
      "---\ntype: concept\ntags:\n  - test\n---\nNo links here.",
    );

    const result = await handleMoveNote(
      "Inbox/taste-graph.md",
      "Resources/Concepts/taste-graph.md",
      { keyName: "test-key" },
    );

    expect(result.action).toBe("moved");
    expect(result.from).toBe("Inbox/taste-graph.md");
    expect(result.to).toBe("Resources/Concepts/taste-graph.md");
    // referrer-a uses basename [[taste-graph]] — still resolves to new location, so unchanged.
    // referrer-b uses full path [[Inbox/taste-graph|the graph]] — rewritten to new path.
    expect(result.links_updated).toBe(1);
    expect(result.commit).toBe("abc789");

    expect(existsSync(join(tempVault, "Inbox/taste-graph.md"))).toBe(false);
    expect(existsSync(join(tempVault, "Resources/Concepts/taste-graph.md"))).toBe(true);

    const a = readFileSync(join(tempVault, "Resources/Concepts/referrer-a.md"), "utf-8");
    const b = readFileSync(join(tempVault, "Resources/Concepts/referrer-b.md"), "utf-8");
    const u = readFileSync(join(tempVault, "Resources/Concepts/unrelated.md"), "utf-8");
    expect(a).toContain("[[taste-graph]]"); // basename unchanged — still matches
    expect(b).toContain("[[Resources/Concepts/taste-graph|the graph]]");
    expect(u).toContain("No links here.");
  });

  it("updates alias-based wikilinks to use the new basename", async () => {
    const { handleMoveNote } = await loadRest();
    seedNote(
      "Inbox/old-name.md",
      "---\ntype: concept\ntags:\n  - test\naliases:\n  - Taste Graph\n---\nbody",
    );
    seedNote(
      "Resources/Concepts/ref.md",
      "---\ntype: concept\ntags:\n  - test\n---\nRefs [[Taste Graph]].",
    );

    const result = await handleMoveNote(
      "Inbox/old-name.md",
      "Resources/Concepts/new-name.md",
      {},
    );

    expect(result.links_updated).toBe(1);
    const ref = readFileSync(join(tempVault, "Resources/Concepts/ref.md"), "utf-8");
    expect(ref).toContain("[[new-name]]");
  });

  it("returns 409 when destination already exists", async () => {
    const { handleMoveNote } = await loadRest();
    seedNote("Inbox/src.md", "---\ntype: concept\ntags:\n  - test\n---\nbody");
    seedNote("Resources/Concepts/dst.md", "---\ntype: concept\ntags:\n  - test\n---\nexisting");

    try {
      await handleMoveNote("Inbox/src.md", "Resources/Concepts/dst.md", {});
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("CONFLICT");
    }
  });

  it("returns 404 when source doesn't exist", async () => {
    const { handleMoveNote } = await loadRest();
    try {
      await handleMoveNote("Inbox/missing.md", "Resources/Concepts/x.md", {});
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("NOT_FOUND");
    }
  });

  it("enforces trail scope on both source and destination", async () => {
    const { handleMoveNote } = await loadRest();
    seedNote("Resources/Concepts/a.md", "---\ntype: concept\ntags:\n  - test\n---\nbody");

    const trail = {
      id: "t1", name: "concepts-only",
      allow_paths: ["Resources/Concepts/"], deny_paths: [],
      allow_tags: [], deny_tags: [],
      allow_types: [], deny_types: [],
      rate_limit_reads: 100, rate_limit_writes: 10,
    };

    try {
      await handleMoveNote("Resources/Concepts/a.md", "Inbox/a.md", { trail });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("TRAIL_DENIED");
    }
  });

  it("rejects moving to the same path", async () => {
    const { handleMoveNote } = await loadRest();
    seedNote("Inbox/same.md", "---\ntype: concept\ntags:\n  - test\n---\nbody");
    try {
      await handleMoveNote("Inbox/same.md", "Inbox/same.md", {});
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("VALIDATION");
    }
  });

  it("respects If-Match (ifHash) on source", async () => {
    const { handleMoveNote } = await loadRest();
    seedNote("Inbox/locked.md", "---\ntype: concept\ntags:\n  - test\n---\nbody");
    try {
      await handleMoveNote("Inbox/locked.md", "Resources/Concepts/locked.md", { ifHash: "nope" });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("CONFLICT");
    }
  });
});

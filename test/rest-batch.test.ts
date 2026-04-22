import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseNote } from "../src/notes-validate.js";

// Track mock git state so we can assert rollback behavior without a real repo.
let commitCounter = 0;
let lastResetSha: string | null = null;
let revParseCallCount = 0;

vi.mock("../src/vault-ops.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault-ops.js")>();
  return {
    ...actual,
    gitCommit: vi.fn(async () => {
      commitCounter++;
      return `sha-${commitCounter.toString().padStart(4, "0")}`;
    }),
    gitCommitPaths: vi.fn(async () => {
      commitCounter++;
      return `sha-${commitCounter.toString().padStart(4, "0")}`;
    }),
    gitRevParseHead: vi.fn(async () => {
      revParseCallCount++;
      return `sha-pre-${revParseCallCount.toString().padStart(4, "0")}`;
    }),
    gitResetHard: vi.fn(async (_vault: string, sha: string) => {
      lastResetSha = sha;
    }),
    qmdReindex: vi.fn().mockResolvedValue(undefined),
    gitPush: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../src/embed-single.js", () => ({
  embedFile: vi.fn().mockResolvedValue(undefined),
}));

let tempVault: string;

beforeEach(() => {
  tempVault = mkdtempSync(join(tmpdir(), "grove-batch-"));
  process.env.GROVE_VAULT = tempVault;
  process.env.GROVE_DB_PATH = join(tempVault, "grove.db");
  commitCounter = 0;
  lastResetSha = null;
  revParseCallCount = 0;
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.GROVE_VAULT;
  delete process.env.GROVE_DB_PATH;
  rmSync(tempVault, { recursive: true, force: true });
});

async function loadRest() {
  vi.resetModules();
  const db = await import("../src/db.js");
  db.resetDb();
  db.createSchema();
  return import("../src/rest.js");
}

describe("handleWriteBatch — basics", () => {
  it("writes multiple notes in one call and returns a result per op", async () => {
    const { handleWriteBatch } = await loadRest();

    const result = await handleWriteBatch(
      [
        { path: "Inbox/a.md", frontmatter: { type: "concept", tags: ["t"] }, content: "A" },
        { path: "Inbox/b.md", frontmatter: { type: "concept", tags: ["t"] }, content: "B" },
        { path: "Inbox/c.md", frontmatter: { type: "concept", tags: ["t"] }, content: "C" },
      ],
      {},
    );

    expect(result.results).toHaveLength(3);
    expect(result.results[0]!.path).toBe("Inbox/a.md");
    expect(result.results[1]!.path).toBe("Inbox/b.md");
    expect(result.results[2]!.path).toBe("Inbox/c.md");
    expect(existsSync(join(tempVault, "Inbox/a.md"))).toBe(true);
    expect(existsSync(join(tempVault, "Inbox/b.md"))).toBe(true);
    expect(existsSync(join(tempVault, "Inbox/c.md"))).toBe(true);
  });

  it("returns source_hash and content_hash (equal at write time) per op", async () => {
    const { handleWriteBatch } = await loadRest();
    const { results } = await handleWriteBatch(
      [
        { path: "Inbox/x.md", frontmatter: { type: "concept", tags: ["t"] }, content: "body" },
      ],
      {},
    );
    const r = results[0]!;
    expect(r.source_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.source_hash).toBe(r.content_hash);
  });

  it("rejects an empty operations array", async () => {
    const { handleWriteBatch } = await loadRest();
    await expect(handleWriteBatch([], {})).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("pre-flight validation rejects a bad op before any mutex work", async () => {
    const { handleWriteBatch } = await loadRest();

    await expect(
      handleWriteBatch(
        [
          { path: "Inbox/good.md", frontmatter: { type: "concept", tags: ["t"] }, content: "A" },
          // Second op has no `type` — rejected up front
          { path: "Inbox/bad.md", frontmatter: { tags: ["t"] } as any, content: "B" },
        ],
        {},
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // Even the good op should NOT have been written, because pre-flight
    // failed before the mutex was ever acquired.
    expect(existsSync(join(tempVault, "Inbox/good.md"))).toBe(false);
  });
});

describe("handleWriteBatch — chained if_hash_from_op", () => {
  it("resolves if_hash_from_op to an earlier op's source_hash", async () => {
    const { handleWriteBatch, handleWriteNote } = await loadRest();

    // Seed: a note already exists via handleWriteNote so we know its source_hash.
    const seeded = await handleWriteNote(
      "Inbox/seed.md",
      { type: "concept", tags: ["t"] },
      "v1",
      {},
    );

    // Now a batch: op 0 updates the seed, op 1 updates it again using op 0's
    // resulting source_hash via if_hash_from_op.
    const { results } = await handleWriteBatch(
      [
        {
          path: "Inbox/seed.md",
          frontmatter: { type: "concept", tags: ["t"] },
          content: "v2",
          if_hash: seeded.source_hash,
        },
        {
          path: "Inbox/seed.md",
          frontmatter: { type: "concept", tags: ["t"] },
          content: "v3",
          if_hash_from_op: 0,
        },
      ],
      {},
    );

    expect(results[0]!.action).toBe("update");
    expect(results[1]!.action).toBe("update");
    expect(results[1]!.source_hash).not.toBe(results[0]!.source_hash);
  });

  it("rejects if_hash_from_op referencing a later op", async () => {
    const { handleWriteBatch } = await loadRest();
    await expect(
      handleWriteBatch(
        [
          { path: "Inbox/a.md", frontmatter: { type: "concept", tags: ["t"] }, content: "A", if_hash_from_op: 1 },
          { path: "Inbox/b.md", frontmatter: { type: "concept", tags: ["t"] }, content: "B" },
        ],
        {},
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("handleWriteBatch — atomic rollback", () => {
  it("atomic=true triggers git reset on failure", async () => {
    const { handleWriteBatch } = await loadRest();
    const vaultOps = await import("../src/vault-ops.js");

    // Second op will fail during assertIfHashMatches because we seed the file
    // with a hash that no one has ever written, and pass a wrong if_hash.
    const dir = join(tempVault, "Inbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(tempVault, "Inbox/existing.md"), "---\ntype: concept\ntags:\n  - t\n---\nseed");

    await expect(
      handleWriteBatch(
        [
          { path: "Inbox/new-a.md", frontmatter: { type: "concept", tags: ["t"] }, content: "A" },
          {
            path: "Inbox/existing.md",
            frontmatter: { type: "concept", tags: ["t"] },
            content: "B",
            if_hash: "definitely-not-the-right-hash",
          },
        ],
        { atomic: true },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // gitResetHard should have been called with the pre-batch SHA.
    expect(vaultOps.gitResetHard).toHaveBeenCalled();
    expect(lastResetSha).toMatch(/^sha-pre-/);
  });

  it("atomic=false leaves earlier successful ops committed on failure", async () => {
    const { handleWriteBatch } = await loadRest();
    const vaultOps = await import("../src/vault-ops.js");

    const dir = join(tempVault, "Inbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(tempVault, "Inbox/existing.md"), "---\ntype: concept\ntags:\n  - t\n---\nseed");

    await expect(
      handleWriteBatch(
        [
          { path: "Inbox/a.md", frontmatter: { type: "concept", tags: ["t"] }, content: "A" },
          {
            path: "Inbox/existing.md",
            frontmatter: { type: "concept", tags: ["t"] },
            content: "B",
            if_hash: "wrong",
          },
        ],
        {}, // atomic omitted → defaults to false
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // First op's file exists on disk (it was written before the second failed).
    expect(existsSync(join(tempVault, "Inbox/a.md"))).toBe(true);
    // No rollback attempted.
    expect(vaultOps.gitResetHard).not.toHaveBeenCalled();
  });

  it("atomic=true + success path does NOT reset", async () => {
    const { handleWriteBatch } = await loadRest();
    const vaultOps = await import("../src/vault-ops.js");

    const { results } = await handleWriteBatch(
      [
        { path: "Inbox/a.md", frontmatter: { type: "concept", tags: ["t"] }, content: "A" },
        { path: "Inbox/b.md", frontmatter: { type: "concept", tags: ["t"] }, content: "B" },
      ],
      { atomic: true },
    );
    expect(results).toHaveLength(2);
    expect(vaultOps.gitResetHard).not.toHaveBeenCalled();
  });
});

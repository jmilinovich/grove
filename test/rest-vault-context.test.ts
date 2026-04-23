import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseNote } from "../src/notes-validate.js";
import type { VaultContext } from "../src/vault-router.js";

// Mock side-effects so writes don't try to push or reindex.
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

// Two independent vaults, each with its own root + db. The proxy is
// shared in production, so writes coming through it must each carry
// their own VaultContext or one vault will accidentally write into
// the other's tree. This test pins that invariant down with two real
// directories and asserts every byte lands in the right one.
describe("rest.ts handler vault isolation", () => {
  let vaultA: string;
  let vaultB: string;
  let dbPath: string;
  let ctxA: VaultContext;
  let ctxB: VaultContext;

  beforeEach(async () => {
    vaultA = mkdtempSync(join(tmpdir(), "grove-vaultA-"));
    vaultB = mkdtempSync(join(tmpdir(), "grove-vaultB-"));
    dbPath = join(mkdtempSync(join(tmpdir(), "grove-db-")), "grove.db");
    process.env.GROVE_DB_PATH = dbPath;

    // Both vaults need a journal/inbox to satisfy validation defaults.
    for (const v of [vaultA, vaultB]) {
      mkdirSync(join(v, "Inbox"), { recursive: true });
    }

    ctxA = { vaultPath: vaultA, vaultId: "vault_aaaaaaaa", vaultSlug: "alpha" };
    ctxB = { vaultPath: vaultB, vaultId: "vault_bbbbbbbb", vaultSlug: "bravo" };

    vi.resetModules();
    const db = await import("../src/db.js");
    db.resetDb();
    db.createSchema();
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.GROVE_DB_PATH;
    rmSync(vaultA, { recursive: true, force: true });
    rmSync(vaultB, { recursive: true, force: true });
  });

  it("handleWriteNote with two contexts writes into two separate vault dirs", async () => {
    const { handleWriteNote } = await import("../src/rest.js");

    await handleWriteNote(ctxA, "Inbox/from-alpha.md", { type: "concept", tags: ["a"] }, "alpha body", {});
    await handleWriteNote(ctxB, "Inbox/from-bravo.md", { type: "concept", tags: ["b"] }, "bravo body", {});

    // Each vault sees only its own file.
    expect(existsSync(join(vaultA, "Inbox/from-alpha.md"))).toBe(true);
    expect(existsSync(join(vaultA, "Inbox/from-bravo.md"))).toBe(false);
    expect(existsSync(join(vaultB, "Inbox/from-bravo.md"))).toBe(true);
    expect(existsSync(join(vaultB, "Inbox/from-alpha.md"))).toBe(false);

    // And the bytes are correct in each.
    const a = parseNote(readFileSync(join(vaultA, "Inbox/from-alpha.md"), "utf-8"));
    const b = parseNote(readFileSync(join(vaultB, "Inbox/from-bravo.md"), "utf-8"));
    expect(a.content).toContain("alpha body");
    expect(b.content).toContain("bravo body");
  });

  it("handleListNotes is scoped to the ctx's vault", async () => {
    const { handleWriteNote, handleListNotes } = await import("../src/rest.js");

    await handleWriteNote(ctxA, "Inbox/only-in-a.md", { type: "concept", tags: ["a"] }, "a", {});
    await handleWriteNote(ctxB, "Inbox/only-in-b.md", { type: "concept", tags: ["b"] }, "b", {});

    const listA = handleListNotes(ctxA, "Inbox");
    const listB = handleListNotes(ctxB, "Inbox");

    expect(listA.map((n) => n.path)).toEqual(["Inbox/only-in-a.md"]);
    expect(listB.map((n) => n.path)).toEqual(["Inbox/only-in-b.md"]);
  });

  it("discovery_queue rows tag the writing vault's id", async () => {
    const { handleWriteNote } = await import("../src/rest.js");
    const { getDb } = await import("../src/db.js");

    await handleWriteNote(ctxA, "Inbox/a.md", { type: "concept", tags: ["a"] }, "a", {});
    await handleWriteNote(ctxB, "Inbox/b.md", { type: "concept", tags: ["b"] }, "b", {});

    const rows = getDb()
      .prepare("SELECT path, vault_id FROM discovery_queue ORDER BY id")
      .all() as Array<{ path: string; vault_id: string }>;
    expect(rows).toEqual([
      { path: "Inbox/a.md", vault_id: "vault_aaaaaaaa" },
      { path: "Inbox/b.md", vault_id: "vault_bbbbbbbb" },
    ]);
  });
});

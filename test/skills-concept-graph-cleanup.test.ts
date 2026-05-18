/**
 * P23-3 — `concept-graph-cleanup` skill executor tests.
 *
 * Focused on load-bearing contract assertions, not exhaustive coverage:
 *   - Pure-utility correctness (`levenshtein`, `selectCandidates`
 *     scoring tiers).
 *   - `readConceptNotes` filesystem contract.
 *   - Insufficient-concepts early-return (surface artifact, no calls).
 *   - Cost-ceiling early-return (surface artifact, no calls).
 *   - Happy paths for each of the three tool actions (merge / prune /
 *     expand) with a mocked Anthropic client.
 *
 * Tests use a temp vault on disk (no fixture is required) plus the
 * real per-vault state.db migrations so the INSERT path executes
 * against the schema the worker loop sees.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-concept-cleanup-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");
// Don't auto-start the polling worker — it would race with the per-
// vault state.db assertions below.
process.env.GROVE_DISABLE_TASK_WORKER = "1";

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import {
  levenshtein,
  readConceptNotes,
  runConceptGraphCleanup,
  selectCandidates,
  setClientForTesting,
} from "../src/skills/concept-graph-cleanup.ts";
import { resetCostLedger } from "../src/skills/cost-ceiling.ts";
import type { VaultContext } from "../src/vault-router.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_MIGRATIONS_DIR = join(HERE, "..", "src", "migrations", "vault");
const VAULT_ID = "vault_concept_cleanup";
const VAULT_SLUG = "personal";
const VAULT_PATH = join(TEST_DIR, "repos", VAULT_SLUG);

function ctx(): VaultContext {
  return { vaultId: VAULT_ID, vaultSlug: VAULT_SLUG, vaultPath: VAULT_PATH };
}

function copyRealMigrations(): void {
  const dir = process.env.GROVE_VAULT_MIGRATIONS_DIR!;
  mkdirSync(dir, { recursive: true });
  for (const name of ["001_init_vault_state.sql", "002_v2_tasks.sql"]) {
    writeFileSync(
      join(dir, name),
      readFileSync(join(REAL_MIGRATIONS_DIR, name), "utf8"),
    );
  }
}

function seedControl(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run("user_concept", "concept-tester", "concept@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(VAULT_ID, "user_concept", VAULT_SLUG, VAULT_SLUG, VAULT_PATH);
}

function writeConcepts(
  notes: Array<{ name: string; body: string; mtime?: Date }>,
): void {
  const dir = join(VAULT_PATH, "Resources", "Concepts");
  mkdirSync(dir, { recursive: true });
  for (const n of notes) {
    const path = join(dir, `${n.name}.md`);
    writeFileSync(path, n.body);
    if (n.mtime) {
      const t = n.mtime.getTime() / 1000;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { utimesSync } = require("node:fs") as typeof import("node:fs");
      utimesSync(path, t, t);
    }
  }
}

/**
 * Build a mocked Anthropic client whose `messages.create` returns the
 * supplied tool_use blocks in order — one per call.
 */
function mockClientSequence(
  inputs: Array<Record<string, unknown>>,
): { create: ReturnType<typeof vi.fn>; client: Anthropic } {
  const create = vi.fn();
  for (const input of inputs) {
    create.mockResolvedValueOnce({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: `toolu_${Math.random().toString(36).slice(2, 8)}`,
          name: "propose_concept_cleanup",
          input,
        },
      ],
      usage: { input_tokens: 800, output_tokens: 300 },
    });
  }
  const client = { messages: { create } } as unknown as Anthropic;
  setClientForTesting(client);
  return { create, client };
}

function freshTestState(): void {
  resetDb();
  closeAllVaultDbs();
  resetCostLedger();
  setClientForTesting(null);
  rmSync(VAULT_PATH, { recursive: true, force: true });
  rmSync(process.env.GROVE_VAULT_STATE_ROOT!, { recursive: true, force: true });
  rmSync(process.env.GROVE_VAULT_MIGRATIONS_DIR!, {
    recursive: true,
    force: true,
  });
  rmSync(process.env.GROVE_DB_PATH!, { force: true });
  rmSync(`${process.env.GROVE_DB_PATH!}-wal`, { force: true });
  rmSync(`${process.env.GROVE_DB_PATH!}-shm`, { force: true });
  copyRealMigrations();
  createSchema();
  seedControl();
  getVaultDb(VAULT_ID);
}

describe("concept-graph-cleanup utility math", () => {
  it("levenshtein computes a known distance", () => {
    expect(levenshtein("alice", "alice")).toBe(0);
    expect(levenshtein("alice", "alise")).toBe(1);
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
  });

  it("selectCandidates ranks orphans above near-dups above thins", () => {
    // Hand-crafted note set covering all three tiers. The expected
    // top-3 cap should pick the orphan first, then the near-dup pair
    // (older note as candidate), then the thin note.
    const now = Date.now();
    const notes = [
      // Orphan: no inbound, no outbound, irrelevant body length.
      {
        path: "Resources/Concepts/Orphan.md",
        name: "Orphan",
        slug: "orphan",
        content: "an orphan",
        wordCount: 200,
        outbound: new Set<string>(),
        inbound: new Set<string>(),
        mtimeMs: now - 86_400_000, // a day ago
      },
      // Near-dup pair "Foo" / "Fooo" (Levenshtein = 1).
      {
        path: "Resources/Concepts/Foo.md",
        name: "Foo",
        slug: "foo",
        content: "foo body",
        wordCount: 200,
        outbound: new Set<string>(["Bar"]),
        inbound: new Set<string>(["Bar"]),
        mtimeMs: now - 2 * 86_400_000, // older
      },
      {
        path: "Resources/Concepts/Fooo.md",
        name: "Fooo",
        slug: "fooo",
        content: "fooo body",
        wordCount: 200,
        outbound: new Set<string>(["Bar"]),
        inbound: new Set<string>(["Bar"]),
        mtimeMs: now,
      },
      // Thin: <100 words, zero outbound, but inbound non-empty so
      // it doesn't qualify as an orphan.
      {
        path: "Resources/Concepts/Thin.md",
        name: "Thin",
        slug: "thin",
        content: "thin",
        wordCount: 12,
        outbound: new Set<string>(),
        inbound: new Set<string>(["Foo"]),
        mtimeMs: now - 3 * 86_400_000,
      },
      // Healthy: shouldn't get picked.
      {
        path: "Resources/Concepts/Healthy.md",
        name: "Healthy",
        slug: "healthy",
        content: "healthy",
        wordCount: 5_000,
        outbound: new Set<string>(["Foo", "Orphan"]),
        inbound: new Set<string>(["Foo"]),
        mtimeMs: now,
      },
    ];
    const candidates = selectCandidates(notes, { maxCandidates: 3 });
    expect(candidates).toHaveLength(3);
    expect(candidates[0].kind).toBe("orphan");
    expect(candidates[0].note.name).toBe("Orphan");
    expect(candidates[1].kind).toBe("near-dup");
    // Older of the two ("Foo") is the candidate, "Fooo" the partner.
    expect(candidates[1].note.name).toBe("Foo");
    expect(candidates[1].partner?.name).toBe("Fooo");
    expect(candidates[2].kind).toBe("thin");
    expect(candidates[2].note.name).toBe("Thin");
  });
});

describe("readConceptNotes", () => {
  beforeEach(() => {
    rmSync(VAULT_PATH, { recursive: true, force: true });
  });

  it("returns empty when no Concepts dir exists", () => {
    expect(readConceptNotes(VAULT_PATH)).toEqual([]);
  });

  it("reads *.md and counts inbound peer wikilinks", () => {
    writeConcepts([
      {
        name: "Foo",
        body: "---\ntype: concept\n---\n\nFoo links to [[Bar]] and [[Baz]].",
      },
      { name: "Bar", body: "---\ntype: concept\n---\n\nBar body." },
      { name: "Baz", body: "---\ntype: concept\n---\n\nBaz body." },
    ]);
    const notes = readConceptNotes(VAULT_PATH);
    expect(notes.map((n) => n.name).sort()).toEqual(["Bar", "Baz", "Foo"]);
    const bar = notes.find((n) => n.name === "Bar")!;
    expect(bar.inbound.has("Foo")).toBe(true);
    const foo = notes.find((n) => n.name === "Foo")!;
    expect(foo.outbound.has("Bar")).toBe(true);
    expect(foo.outbound.has("Baz")).toBe(true);
  });
});

describe("runConceptGraphCleanup — early returns", () => {
  beforeEach(() => {
    freshTestState();
  });

  afterEach(() => {
    closeAllVaultDbs();
    setClientForTesting(null);
  });

  it("no concept notes → surface artifact, zero LLM calls", async () => {
    const create = vi.fn();
    setClientForTesting({ messages: { create } } as unknown as Anthropic);

    const result = await runConceptGraphCleanup(ctx());
    expect(result.artifact.type).toBe("surface");
    expect(result.artifact.surfaceText).toMatch(/no concept notes/);
    expect(result.provenance.reason).toBe("no_concept_notes");
    expect(create).not.toHaveBeenCalled();
  });

  it("cost ceiling exceeded → surface artifact, zero LLM calls", async () => {
    const create = vi.fn();
    setClientForTesting({ messages: { create } } as unknown as Anthropic);

    writeConcepts([
      { name: "Alpha", body: "a" },
      { name: "Beta", body: "b" },
      { name: "Gamma", body: "g" },
    ]);

    const result = await runConceptGraphCleanup(ctx(), { tokenCeiling: 100 });
    expect(result.artifact.type).toBe("surface");
    expect(result.artifact.surfaceText).toMatch(/exceeds the ceiling/);
    expect(result.provenance.reason).toBe("cost_ceiling_exceeded");
    expect(create).not.toHaveBeenCalled();

    // No child tasks inserted on the ceiling path.
    const row = getVaultDb(VAULT_ID)
      .prepare("SELECT COUNT(*) AS n FROM tasks")
      .get() as { n: number };
    expect(row.n).toBe(0);
  });

  it("no candidates pass selection → surface, zero LLM calls", async () => {
    const create = vi.fn();
    setClientForTesting({ messages: { create } } as unknown as Anthropic);

    // Two "healthy" notes — each has 200+ words and links to the
    // other. Neither qualifies as orphan/near-dup/thin.
    const longBody = ["[[Other]]", ...new Array(250).fill("word")].join(" ");
    writeConcepts([
      {
        name: "Healthy",
        body: `---\ntype: concept\n---\n\n${longBody.replace("Other", "Other2")}`,
      },
      {
        name: "Other2",
        body: `---\ntype: concept\n---\n\n${longBody.replace("Other", "Healthy")}`,
      },
    ]);

    const result = await runConceptGraphCleanup(ctx(), {
      tokenCeiling: 1_000_000,
    });
    expect(result.artifact.type).toBe("surface");
    expect(result.provenance.reason).toBe("no_candidates");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("runConceptGraphCleanup — happy paths per action", () => {
  beforeEach(() => {
    freshTestState();
  });

  afterEach(() => {
    closeAllVaultDbs();
    setClientForTesting(null);
  });

  it("orphan candidate → prune child task with note-change artifact", async () => {
    // One orphan note (no inbound, no outbound) is enough; no other
    // notes are needed.
    writeConcepts([
      {
        name: "Lonely",
        body: "---\ntype: concept\n---\n\nA note with no links at all.",
      },
    ]);

    const { create } = mockClientSequence([
      {
        action: "prune",
        path: "Resources/Concepts/Lonely.md",
        rationale: "Zero inbound, zero outbound — safe to archive.",
      },
    ]);

    const result = await runConceptGraphCleanup(ctx(), {
      tokenCeiling: 1_000_000,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(result.artifact.type).toBe("surface");
    expect(result.artifact.surfaceText).toMatch(/Generated 1 cleanup proposal/);

    const rows = getVaultDb(VAULT_ID)
      .prepare(
        `SELECT t.id, t.skill_slug, t.state, t.title, r.artifact_json, r.note_change_json
           FROM tasks t JOIN task_results r ON t.id = r.task_id`,
      )
      .all() as Array<{
      id: string;
      skill_slug: string;
      state: string;
      title: string;
      artifact_json: string;
      note_change_json: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].skill_slug).toBe("concept-graph-cleanup");
    expect(rows[0].state).toBe("review");
    expect(rows[0].title).toMatch(/Prune orphan/);
    const artifact = JSON.parse(rows[0].artifact_json) as { type: string };
    expect(artifact.type).toBe("note-change");
    const noteChange = JSON.parse(rows[0].note_change_json!) as {
      action: string;
      path: string;
    };
    expect(noteChange.action).toBe("prune");
    expect(noteChange.path).toBe("Resources/Concepts/Lonely.md");
  });

  it("near-dup candidate → merge child task with merge payload", async () => {
    // Two near-duplicate concepts AND a healthy hub that links to
    // both — so neither is an orphan; the near-dup tier fires.
    writeConcepts([
      {
        name: "Taste Graphs",
        body:
          "---\ntype: concept\n---\n\nNotes on taste graphs.\n\n" +
          "Long body padding to keep word count above the thin " +
          "threshold. ".repeat(20),
      },
      {
        name: "Taste Graph",
        body:
          "---\ntype: concept\n---\n\nNotes on the taste graph.\n\n" +
          "Long body padding to keep word count above the thin " +
          "threshold. ".repeat(20),
      },
      {
        name: "Hub",
        body:
          "---\ntype: concept\n---\n\n" +
          "Links into [[Taste Graphs]] and [[Taste Graph]] and " +
          "[[Taste Graphs|TG]] and a bunch more body content so " +
          "this hub isn't itself a thin candidate. ".repeat(10),
      },
    ]);

    const { create } = mockClientSequence([
      {
        action: "merge",
        targetPath: "Resources/Concepts/Taste Graphs.md",
        redirectPath: "Resources/Concepts/Taste Graph.md",
        targetContent:
          "---\ntype: concept\n---\n\nMerged notes on taste graphs.\n",
        redirectContent: "[[Taste Graphs]]\n",
        rationale: "Plural/singular variants of the same concept.",
      },
    ]);

    const result = await runConceptGraphCleanup(ctx(), {
      tokenCeiling: 1_000_000,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(result.artifact.type).toBe("surface");

    const row = getVaultDb(VAULT_ID)
      .prepare(
        `SELECT t.title, r.artifact_json, r.note_change_json
           FROM tasks t JOIN task_results r ON t.id = r.task_id`,
      )
      .get() as {
      title: string;
      artifact_json: string;
      note_change_json: string;
    };
    expect(row.title).toMatch(/Merge Taste Graph/);
    const artifact = JSON.parse(row.artifact_json) as {
      type: string;
      notePath: string;
    };
    expect(artifact.type).toBe("note-change");
    expect(artifact.notePath).toBe("Resources/Concepts/Taste Graphs.md");
    const noteChange = JSON.parse(row.note_change_json) as {
      action: string;
      target: { path: string };
      redirect: { path: string };
      sourcePaths: string[];
    };
    expect(noteChange.action).toBe("merge");
    expect(noteChange.target.path).toBe("Resources/Concepts/Taste Graphs.md");
    expect(noteChange.redirect.path).toBe("Resources/Concepts/Taste Graph.md");
    expect(noteChange.sourcePaths.sort()).toEqual([
      "Resources/Concepts/Taste Graph.md",
      "Resources/Concepts/Taste Graphs.md",
    ]);
  });

  it("thin candidate → expand child task as a SURFACE artifact (no note_change_json)", async () => {
    // One thin note + one hub linking to it (so it's not an orphan,
    // it's just underdeveloped). The thin note has zero outbound and
    // body word count below the threshold.
    writeConcepts([
      {
        name: "Hub",
        body:
          "---\ntype: concept\n---\n\nLinks into [[Stub]] and padding " +
          "to keep this above thin. ".repeat(30),
      },
      {
        name: "Stub",
        body: "---\ntype: concept\n---\n\nJust a stub.",
      },
    ]);

    const { create } = mockClientSequence([
      {
        action: "expand",
        path: "Resources/Concepts/Stub.md",
        rationale: "Thin but referenced from Hub — worth a writing prompt.",
        promptForUser: "What's the one-paragraph definition of Stub?",
      },
    ]);

    const result = await runConceptGraphCleanup(ctx(), {
      tokenCeiling: 1_000_000,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(result.artifact.type).toBe("surface");

    const row = getVaultDb(VAULT_ID)
      .prepare(
        `SELECT t.title, t.body, r.artifact_json, r.note_change_json
           FROM tasks t JOIN task_results r ON t.id = r.task_id`,
      )
      .get() as {
      title: string;
      body: string;
      artifact_json: string;
      note_change_json: string | null;
    };
    expect(row.title).toMatch(/Expand thin concept/);
    expect(row.body).toMatch(/one-paragraph definition/);
    const artifact = JSON.parse(row.artifact_json) as {
      type: string;
      notePath: string;
    };
    expect(artifact.type).toBe("surface");
    expect(artifact.notePath).toBe("Resources/Concepts/Stub.md");
    // Expand never carries a note_change_json — the column must be
    // NULL so the /review pipeline can't accidentally auto-apply it.
    expect(row.note_change_json).toBeNull();
  });
});

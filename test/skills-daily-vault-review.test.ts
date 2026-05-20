/**
 * P22-5 — `daily-vault-review` skill executor tests.
 *
 * Drives `runDailyVaultReview` against a seeded fixture vault:
 *   - control db has graph_health_flags + discovery_results scoped to
 *     the test vault
 *   - per-vault state.db is initialized via the real migrations so SQL
 *     stays under test
 *   - the Anthropic client is mocked to return a structured tool-use
 *     payload so the executor's prompt-shaping + child-task-insertion
 *     paths are exercised without a live API call
 *
 * Key assertions per the user's P22-5 brief:
 *   - the ceiling-exceeded path produces a SURFACE artifact (not partial)
 *     and never calls the LLM
 *   - surface-only mode never produces note-change artifacts even when
 *     the model proposes them
 *   - writes-allowed mode CAN produce note-change artifacts that the
 *     /review pipeline can later disposition
 *   - the executor inserts 3–5 child tasks with proper skill_slug,
 *     source_flag_id, and body framing
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-daily-review-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");
// Don't auto-start the polling worker — it would race with assertions
// against the per-vault state.db.
process.env.GROVE_DISABLE_TASK_WORKER = "1";

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import {
  runDailyVaultReview,
  setClientForTesting,
} from "../src/skills/daily-vault-review.ts";
import { resetCostLedger } from "../src/skills/cost-ceiling.ts";
import type { VaultContext } from "../src/vault-router.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_MIGRATIONS_DIR = join(HERE, "..", "src", "migrations", "vault");

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

const VAULT_ID = "vault_review";
const VAULT_SLUG = "personal";

function ctx(): VaultContext {
  return {
    vaultId: VAULT_ID,
    vaultSlug: VAULT_SLUG,
    vaultPath: join(TEST_DIR, "repos", VAULT_SLUG),
  };
}

function seedControl(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run("user_review", "review-tester", "review@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(
    VAULT_ID,
    "user_review",
    VAULT_SLUG,
    VAULT_SLUG,
    join(TEST_DIR, "repos", VAULT_SLUG),
  );
}

function seedFlags(count: number): string[] {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO graph_health_flags (id, flag_type, source_path, target_path, details, vault_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `flag_${i}_${Math.random().toString(36).slice(2, 8)}`;
    insert.run(
      id,
      "duplicate_candidate",
      `Resources/Concepts/Source ${i}.md`,
      `Resources/Concepts/Target ${i}.md`,
      JSON.stringify({ similarity: 0.92 }),
      VAULT_ID,
    );
    ids.push(id);
  }
  return ids;
}

function seedDiscovery(count: number, similarity = 0.95): string[] {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO discovery_results (id, source_path, target_path, similarity, relationship, vault_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `disc_${i}_${Math.random().toString(36).slice(2, 8)}`;
    insert.run(
      id,
      `Resources/Concepts/Disc Source ${i}.md`,
      `Resources/Concepts/Disc Target ${i}.md`,
      similarity,
      "duplicate",
      VAULT_ID,
    );
    ids.push(id);
  }
  return ids;
}

function mockAnthropic(tasks: Array<{
  title: string;
  body: string;
  artifactType: string;
  notePath?: string;
  sourceFlagId?: string;
  noteChangeContent?: string;
}>): { create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue({
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "toolu_test",
        name: "propose_review_tasks",
        input: { tasks },
      },
    ],
    usage: { input_tokens: 600, output_tokens: 200 },
  });
  setClientForTesting({ messages: { create } } as never);
  return { create };
}

function freshTestState(): void {
  resetDb();
  closeAllVaultDbs();
  resetCostLedger();
  setClientForTesting(null);
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
  // Force the per-vault state.db to initialize so migrations run before
  // the first prepared-statement read.
  getVaultDb(VAULT_ID);
}

describe("runDailyVaultReview (P22-5)", () => {
  beforeEach(() => {
    freshTestState();
  });

  afterEach(() => {
    closeAllVaultDbs();
    setClientForTesting(null);
    resetDb();
    resetCostLedger();
  });

  it("hard-fails on cost ceiling exceeded — surface artifact, no LLM call", async () => {
    seedFlags(5);
    seedDiscovery(5);

    // Use a single shared spy so we can both inject it into the client
    // AND assert it was never invoked.
    const create = vi.fn();
    setClientForTesting({ messages: { create } } as never);

    const result = await runDailyVaultReview(ctx(), {
      mode: "surface-only",
      tokenCeiling: 100, // way below any plausible 10-row estimate
    });

    expect(create).not.toHaveBeenCalled();
    expect(result.artifact.type).toBe("surface");
    expect(result.artifact.surfaceText).toMatch(/exceeds the ceiling/);
    expect(result.artifact.surfaceText).toMatch(/No LLM call was made/);
    expect(result.provenance.voice).toBe("perishable");
    expect(result.provenance.reason).toBe("cost_ceiling_exceeded");

    // No child tasks were inserted on the ceiling-exceeded path.
    const tasks = getVaultDb(VAULT_ID)
      .prepare("SELECT COUNT(*) AS n FROM tasks")
      .get() as { n: number };
    expect(tasks.n).toBe(0);
  });

  it("returns a summary surface artifact and inserts child review tasks under the ceiling", async () => {
    const [flagId] = seedFlags(2);
    seedDiscovery(1);

    const { create } = mockAnthropic([
      {
        title: "Merge duplicate concept candidates",
        body: "Source 0 and Target 0 look like duplicates — confirm or dismiss.",
        artifactType: "surface",
        sourceFlagId: flagId,
      },
      {
        title: "Review high-similarity discovery row",
        body: "Disc Source 0 / Disc Target 0 cosine 0.95 — link or dismiss.",
        artifactType: "surface",
      },
      {
        title: "Check the second flag",
        body: "Source 1 vs Target 1 — duplicate candidate from graph health.",
        artifactType: "surface",
      },
    ]);

    const result = await runDailyVaultReview(ctx(), {
      mode: "surface-only",
      tokenCeiling: 50_000,
    });

    expect(create).toHaveBeenCalledOnce();
    expect(result.artifact.type).toBe("surface");
    expect(result.artifact.surfaceText).toMatch(
      /Generated 3 review tasks from 2 unresolved flags \+ 1 discovery result/,
    );

    const vaultDb = getVaultDb(VAULT_ID);
    const rows = vaultDb
      .prepare(
        "SELECT id, skill_slug, state, title, source_flag_id FROM tasks ORDER BY created_at ASC",
      )
      .all() as Array<{
        id: string;
        skill_slug: string;
        state: string;
        title: string;
        source_flag_id: string | null;
      }>;
    expect(rows).toHaveLength(3);
    expect(rows[0].skill_slug).toBe("daily-vault-review");
    expect(rows[0].state).toBe("review");
    expect(rows[0].source_flag_id).toBe(flagId);

    // Every child task has a matching task_results row whose artifact
    // is surface (mode forced it).
    const resultRows = vaultDb
      .prepare("SELECT task_id, artifact_json FROM task_results")
      .all() as Array<{ task_id: string; artifact_json: string }>;
    expect(resultRows).toHaveLength(3);
    for (const r of resultRows) {
      const artifact = JSON.parse(r.artifact_json) as { type: string };
      expect(artifact.type).toBe("surface");
    }
  });

  it("surface-only mode downgrades note-change proposals to surface", async () => {
    seedFlags(1);

    mockAnthropic([
      {
        title: "Rewrite the duplicate note",
        body: "Replace stale content with the merged version.",
        artifactType: "note-change",
        notePath: "Resources/Concepts/Source 0.md",
        noteChangeContent: "---\ntype: concept\n---\n\nMerged body.\n",
      },
      {
        title: "Another safe one",
        body: "Just a surface.",
        artifactType: "surface",
      },
      {
        title: "Third",
        body: "Surface.",
        artifactType: "surface",
      },
    ]);

    await runDailyVaultReview(ctx(), {
      mode: "surface-only",
      tokenCeiling: 50_000,
    });

    const rows = getVaultDb(VAULT_ID)
      .prepare(
        "SELECT artifact_json, note_change_json FROM task_results ORDER BY task_id",
      )
      .all() as Array<{ artifact_json: string; note_change_json: string | null }>;

    // None of the three results carry a note-change artifact OR a
    // note_change_json payload — surface-only mode is structurally
    // safe even when the model proposes writes.
    for (const r of rows) {
      const artifact = JSON.parse(r.artifact_json) as { type: string };
      expect(artifact.type).toBe("surface");
      expect(r.note_change_json).toBeNull();
    }
  });

  it("writes-allowed mode preserves note-change artifacts with note_change_json", async () => {
    seedFlags(1);

    mockAnthropic([
      {
        title: "Rewrite the duplicate note",
        body: "Replace stale content with the merged version.",
        artifactType: "note-change",
        notePath: "Resources/Concepts/Source 0.md",
        noteChangeContent: "---\ntype: concept\n---\n\nMerged body.\n",
      },
      {
        title: "Surface 1",
        body: "Surface.",
        artifactType: "surface",
      },
      {
        title: "Surface 2",
        body: "Surface.",
        artifactType: "surface",
      },
    ]);

    await runDailyVaultReview(ctx(), {
      mode: "writes-allowed",
      tokenCeiling: 50_000,
    });

    const noteChangeRow = getVaultDb(VAULT_ID)
      .prepare(
        `SELECT artifact_json, note_change_json FROM task_results
         WHERE note_change_json IS NOT NULL`,
      )
      .get() as { artifact_json: string; note_change_json: string };

    expect(noteChangeRow).toBeDefined();
    const artifact = JSON.parse(noteChangeRow.artifact_json) as {
      type: string;
      notePath: string;
    };
    expect(artifact.type).toBe("note-change");
    expect(artifact.notePath).toBe("Resources/Concepts/Source 0.md");
    const noteChange = JSON.parse(noteChangeRow.note_change_json) as {
      content: string;
    };
    expect(noteChange.content).toContain("Merged body.");
  });

  it("returns a fallback surface artifact when the LLM proposes no tasks", async () => {
    seedFlags(1);
    mockAnthropic([]);

    const result = await runDailyVaultReview(ctx(), {
      mode: "surface-only",
      tokenCeiling: 50_000,
    });

    expect(result.artifact.type).toBe("surface");
    expect(result.artifact.surfaceText).toMatch(/no actionable tasks/);

    const tasks = getVaultDb(VAULT_ID)
      .prepare("SELECT COUNT(*) AS n FROM tasks")
      .get() as { n: number };
    expect(tasks.n).toBe(0);
  });

  it("scopes flag + discovery reads to the requesting vault", async () => {
    // Seed a second vault and put loud rows there that should NOT
    // surface in `vault_review`'s daily run.
    const otherId = "vault_other";
    const db = getDb();
    db.prepare(
      "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
    ).run(otherId, "user_review", "other", "other", join(TEST_DIR, "repos", "other"));
    db.prepare(
      `INSERT INTO graph_health_flags (id, flag_type, source_path, target_path, details, vault_id)
       VALUES (?, 'duplicate_candidate', ?, ?, '{}', ?)`,
    ).run("flag_other", "Other/A.md", "Other/B.md", otherId);
    db.prepare(
      `INSERT INTO discovery_results (id, source_path, target_path, similarity, relationship, vault_id)
       VALUES (?, ?, ?, ?, 'duplicate', ?)`,
    ).run("disc_other", "Other/C.md", "Other/D.md", 0.99, otherId);

    // The target vault gets one row of each type.
    const [ourFlag] = seedFlags(1);
    seedDiscovery(1);

    const { create } = mockAnthropic([
      {
        title: "Ours 1",
        body: "Only the ours-scoped row should appear in the prompt.",
        artifactType: "surface",
        sourceFlagId: ourFlag,
      },
      { title: "Ours 2", body: ".", artifactType: "surface" },
      { title: "Ours 3", body: ".", artifactType: "surface" },
    ]);

    await runDailyVaultReview(ctx(), {
      mode: "surface-only",
      tokenCeiling: 50_000,
    });

    // The prompt text passed to the mock must not contain the OTHER
    // vault's row identifiers — the per-vault scope is enforced at the
    // SELECT, not at presentation.
    const call = create.mock.calls[0]?.[0] as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    const userBlocks = call.messages[0].content.map((c) => c.text).join("\n");
    expect(userBlocks).not.toContain("flag_other");
    expect(userBlocks).not.toContain("disc_other");
    expect(userBlocks).toContain(ourFlag);
  });

  describe("open-task threshold + per-title dedup", () => {
    function seedOpenReviewTasks(count: number, titlePrefix = "Write today's journal entry"): void {
      const vdb = getVaultDb(VAULT_ID);
      const stmt = vdb.prepare(
        `INSERT INTO tasks (id, skill_slug, state, title, body)
         VALUES (?, 'daily-vault-review', 'review', ?, ?)`,
      );
      for (let i = 0; i < count; i++) {
        stmt.run(
          `seeded_${i}_${Math.random().toString(36).slice(2, 8)}`,
          i === 0 ? titlePrefix : `${titlePrefix} ${i}`,
          ".",
        );
      }
    }

    it("short-circuits the LLM call when >=5 open tasks are already pending", async () => {
      seedFlags(3);
      seedOpenReviewTasks(5);

      const create = vi.fn();
      setClientForTesting({ messages: { create } } as never);

      const result = await runDailyVaultReview(ctx(), {
        mode: "surface-only",
        tokenCeiling: 50_000,
      });

      expect(create).not.toHaveBeenCalled();
      expect(result.artifact.type).toBe("surface");
      expect(result.artifact.surfaceText).toMatch(/5 daily-vault-review tasks/);
      expect(result.provenance.reason).toBe("open_task_threshold_exceeded");

      const rows = getVaultDb(VAULT_ID)
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks WHERE skill_slug = 'daily-vault-review'`,
        )
        .get() as { n: number };
      expect(rows.n).toBe(5);
    });

    it("runs normally when the open-task count is below the threshold", async () => {
      seedFlags(2);
      seedOpenReviewTasks(4);

      const { create } = mockAnthropic([
        { title: "Fresh task A", body: ".", artifactType: "surface" },
        { title: "Fresh task B", body: ".", artifactType: "surface" },
        { title: "Fresh task C", body: ".", artifactType: "surface" },
      ]);

      await runDailyVaultReview(ctx(), {
        mode: "surface-only",
        tokenCeiling: 50_000,
      });

      expect(create).toHaveBeenCalledOnce();
      const total = getVaultDb(VAULT_ID)
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks WHERE skill_slug = 'daily-vault-review'`,
        )
        .get() as { n: number };
      expect(total.n).toBe(7);
    });

    it("skips inserts when a proposed title matches an existing open task (case-insensitive)", async () => {
      seedFlags(2);
      const vdb = getVaultDb(VAULT_ID);
      vdb.prepare(
        `INSERT INTO tasks (id, skill_slug, state, title, body)
         VALUES ('seeded_dup', 'daily-vault-review', 'review', ?, '.')`,
      ).run("Process Inbox/");

      mockAnthropic([
        { title: "process inbox/", body: ".", artifactType: "surface" },
        { title: "Revisit long-orphan concepts", body: ".", artifactType: "surface" },
        { title: "Brand new title", body: ".", artifactType: "surface" },
      ]);

      await runDailyVaultReview(ctx(), {
        mode: "surface-only",
        tokenCeiling: 50_000,
      });

      const rows = getVaultDb(VAULT_ID)
        .prepare(
          `SELECT title FROM tasks WHERE skill_slug = 'daily-vault-review' ORDER BY title`,
        )
        .all() as Array<{ title: string }>;
      const titles = rows.map((r) => r.title);
      expect(titles).toContain("Process Inbox/");
      expect(titles).toContain("Revisit long-orphan concepts");
      expect(titles).toContain("Brand new title");
      expect(titles.length).toBe(3);
    });
  });
});

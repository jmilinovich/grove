/**
 * P23-1 — Scheduler worker drain tests.
 *
 * `drainOnePendingTask(vault)` claims the oldest pending task whose
 * `scheduled_for` is in the past, flips it to `running`, dispatches the
 * executor through the existing `runTaskOnce` path (P22-1), and writes
 * `task_results` + transitions to the executor's `finalState`.
 *
 * We override the executor via `setExecutorForTesting` so tests don't
 * hit the Anthropic API.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-scheduler-worker-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");
process.env.GROVE_DISABLE_TASK_WORKER = "1";

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import { drainOnePendingTask } from "../src/scheduler.js";
import {
  setExecutorForTesting,
  clearExecutorOverrides,
  type SkillExecutor,
} from "../src/v2-task-run.js";
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

const VAULT_ID = "vault_sched_worker";
const VAULT_SLUG = "personal";

function seedVault(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run("user_sched", "sched-tester", "sched@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(
    VAULT_ID,
    "user_sched",
    VAULT_SLUG,
    "Personal",
    join(TEST_DIR, "repos", VAULT_SLUG),
  );
  getVaultDb(VAULT_ID);
}

function ctx(): VaultContext {
  return {
    vaultId: VAULT_ID,
    vaultSlug: VAULT_SLUG,
    vaultPath: join(TEST_DIR, "repos", VAULT_SLUG),
  };
}

function insertTask(opts: {
  id: string;
  state?: "pending" | "running";
  scheduledFor?: string | null;
  createdAt?: string;
}): void {
  const db = getVaultDb(VAULT_ID);
  // Manual created_at lets a test prove FIFO ordering on multiple
  // pending rows without relying on insert microseconds.
  if (opts.createdAt) {
    db.prepare(
      `INSERT INTO tasks (id, skill_slug, state, title, scheduled_for, created_at, updated_at)
       VALUES (?, 'enrichment', ?, ?, ?, ?, ?)`,
    ).run(
      opts.id,
      opts.state ?? "pending",
      `Task ${opts.id}`,
      opts.scheduledFor ?? null,
      opts.createdAt,
      opts.createdAt,
    );
  } else {
    db.prepare(
      `INSERT INTO tasks (id, skill_slug, state, title, scheduled_for)
       VALUES (?, 'enrichment', ?, ?, ?)`,
    ).run(
      opts.id,
      opts.state ?? "pending",
      `Task ${opts.id}`,
      opts.scheduledFor ?? null,
    );
  }
}

const fakeExecutor: SkillExecutor = async () => ({
  artifact: { type: "surface", surfaceText: "fake executor ran" },
  provenance: {
    voice: "perishable",
    by: "test",
    writtenAt: new Date().toISOString(),
    reason: "scheduler-worker test",
  },
  finalState: "review",
});

describe("scheduler worker drain (P23-1)", () => {
  beforeEach(() => {
    resetDb();
    closeAllVaultDbs();
    clearExecutorOverrides();
    rmSync(process.env.GROVE_VAULT_STATE_ROOT!, { recursive: true, force: true });
    rmSync(process.env.GROVE_VAULT_MIGRATIONS_DIR!, { recursive: true, force: true });
    rmSync(process.env.GROVE_DB_PATH!, { force: true });
    rmSync(`${process.env.GROVE_DB_PATH!}-wal`, { force: true });
    rmSync(`${process.env.GROVE_DB_PATH!}-shm`, { force: true });
    copyRealMigrations();
    createSchema();
    seedVault();
    setExecutorForTesting("enrichment", fakeExecutor);
  });

  afterEach(() => {
    clearExecutorOverrides();
    closeAllVaultDbs();
    resetDb();
  });

  it("claims and runs a single pending task, transitioning to review", async () => {
    insertTask({ id: "task_one" });

    const processed = await drainOnePendingTask(ctx());
    expect(processed).toBe(true);

    const row = getVaultDb(VAULT_ID)
      .prepare(
        "SELECT state, started_at, completed_at FROM tasks WHERE id = ?",
      )
      .get("task_one") as {
      state: string;
      started_at: string | null;
      completed_at: string | null;
    };
    expect(row.state).toBe("review");
    expect(row.started_at).not.toBeNull();
  });

  it("writes a task_results row with the executor's artifact + provenance", async () => {
    insertTask({ id: "task_artifact" });

    await drainOnePendingTask(ctx());

    const result = getVaultDb(VAULT_ID)
      .prepare(
        "SELECT artifact_json, provenance_json FROM task_results WHERE task_id = ?",
      )
      .get("task_artifact") as {
      artifact_json: string;
      provenance_json: string;
    };
    expect(result).toBeDefined();
    const artifact = JSON.parse(result.artifact_json) as {
      type: string;
      surfaceText: string;
    };
    expect(artifact.type).toBe("surface");
    expect(artifact.surfaceText).toBe("fake executor ran");
    const provenance = JSON.parse(result.provenance_json) as { voice: string };
    expect(provenance.voice).toBe("perishable");
  });

  it("returns false when no pending task is runnable", async () => {
    expect(await drainOnePendingTask(ctx())).toBe(false);
  });

  it("skips tasks whose scheduled_for is in the future", async () => {
    insertTask({
      id: "task_future",
      scheduledFor: "2099-01-01 00:00:00",
    });

    expect(await drainOnePendingTask(ctx())).toBe(false);
    const row = getVaultDb(VAULT_ID)
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get("task_future") as { state: string };
    expect(row.state).toBe("pending");
  });

  it("processes the earliest scheduled_for task first (FIFO)", async () => {
    insertTask({
      id: "task_newer",
      scheduledFor: "2020-06-01 00:00:00",
      createdAt: "2020-06-01 00:00:00",
    });
    insertTask({
      id: "task_older",
      scheduledFor: "2020-01-01 00:00:00",
      createdAt: "2020-01-01 00:00:00",
    });

    await drainOnePendingTask(ctx());

    const states = getVaultDb(VAULT_ID)
      .prepare("SELECT id, state FROM tasks ORDER BY id ASC")
      .all() as { id: string; state: string }[];
    const byId = Object.fromEntries(states.map((r) => [r.id, r.state]));
    expect(byId.task_older).toBe("review");
    expect(byId.task_newer).toBe("pending");
  });

  it("flips the task to failed on executor throw", async () => {
    setExecutorForTesting("enrichment", async () => {
      throw new Error("executor blew up");
    });
    insertTask({ id: "task_throw" });

    await drainOnePendingTask(ctx());

    const row = getVaultDb(VAULT_ID)
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get("task_throw") as { state: string };
    expect(row.state).toBe("failed");

    const result = getVaultDb(VAULT_ID)
      .prepare("SELECT artifact_json FROM task_results WHERE task_id = ?")
      .get("task_throw") as { artifact_json: string };
    const artifact = JSON.parse(result.artifact_json) as {
      surfaceText: string;
    };
    expect(artifact.surfaceText).toContain("executor blew up");
  });

  it("does not double-claim a task that another drain already took", async () => {
    insertTask({ id: "task_race" });

    // First drain runs to completion; the row is now in `review`.
    expect(await drainOnePendingTask(ctx())).toBe(true);
    // A subsequent drain finds nothing pending.
    expect(await drainOnePendingTask(ctx())).toBe(false);

    const state = getVaultDb(VAULT_ID)
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get("task_race") as { state: string };
    expect(state.state).toBe("review");
  });
});

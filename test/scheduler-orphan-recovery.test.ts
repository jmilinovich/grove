/**
 * P23-1 — Scheduler orphan recovery tests.
 *
 * `recoverOrphanedTasks(vaultId, ageSeconds)` flips `state='running'`
 * rows whose `started_at` is older than the threshold back to `pending`.
 * Mirrors `recoverOrphanedDiscoveryProcessing` (discovery's fix #151) —
 * the per-vault PM2 pin guarantees no sibling is mid-claim at scheduler
 * boot, so the recovery is safe to run unconditionally on startup.
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-scheduler-orphan-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");
process.env.GROVE_DISABLE_TASK_WORKER = "1";

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import { recoverOrphanedTasks } from "../src/scheduler.js";

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

const VAULT_ID = "vault_sched_orphan";

function seedVault(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run("user_sched", "sched-tester", "sched@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(VAULT_ID, "user_sched", "personal", "Personal", join(TEST_DIR, "repos", "personal"));
  getVaultDb(VAULT_ID);
}

function insertRunningTask(id: string, startedAt: string): void {
  getVaultDb(VAULT_ID)
    .prepare(
      `INSERT INTO tasks (id, skill_slug, state, title, started_at)
       VALUES (?, 'enrichment', 'running', ?, ?)`,
    )
    .run(id, `Task ${id}`, startedAt);
}

describe("scheduler orphan recovery (P23-1)", () => {
  beforeEach(() => {
    resetDb();
    closeAllVaultDbs();
    rmSync(process.env.GROVE_VAULT_STATE_ROOT!, { recursive: true, force: true });
    rmSync(process.env.GROVE_VAULT_MIGRATIONS_DIR!, { recursive: true, force: true });
    rmSync(process.env.GROVE_DB_PATH!, { force: true });
    rmSync(`${process.env.GROVE_DB_PATH!}-wal`, { force: true });
    rmSync(`${process.env.GROVE_DB_PATH!}-shm`, { force: true });
    copyRealMigrations();
    createSchema();
    seedVault();
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
  });

  it("flips stale running rows back to pending and clears started_at", () => {
    // ~10 min old → comfortably past the 5-min threshold
    insertRunningTask("task_stale", "2020-01-01 00:00:00");

    const recovered = recoverOrphanedTasks(VAULT_ID);
    expect(recovered).toBe(1);

    const row = getVaultDb(VAULT_ID)
      .prepare("SELECT state, started_at FROM tasks WHERE id = ?")
      .get("task_stale") as { state: string; started_at: string | null };
    expect(row.state).toBe("pending");
    expect(row.started_at).toBeNull();
  });

  it("leaves fresh running rows (started_at within window) alone", () => {
    // Just-started — well inside the 5-min window. The HTTP /run path
    // depends on this to keep its row claimed during dispatch.
    const fresh = new Date(Date.now() - 5_000).toISOString().replace("T", " ").slice(0, 19);
    insertRunningTask("task_fresh", fresh);

    const recovered = recoverOrphanedTasks(VAULT_ID);
    expect(recovered).toBe(0);

    const row = getVaultDb(VAULT_ID)
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get("task_fresh") as { state: string };
    expect(row.state).toBe("running");
  });

  it("respects a custom ageSeconds threshold", () => {
    // Row started 30s ago. With the default 300s threshold it's fresh;
    // with a 10s override it's stale.
    const tenSecondsAgo = new Date(Date.now() - 30_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    insertRunningTask("task_borderline", tenSecondsAgo);

    expect(recoverOrphanedTasks(VAULT_ID, 300)).toBe(0);
    expect(recoverOrphanedTasks(VAULT_ID, 10)).toBe(1);

    const row = getVaultDb(VAULT_ID)
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get("task_borderline") as { state: string };
    expect(row.state).toBe("pending");
  });

  it("ignores non-running rows even if started_at is stale", () => {
    // A `review` row whose started_at is old is legitimate — the
    // executor finished long ago and the user hasn't dispositioned it.
    // Recovery must NOT touch it.
    getVaultDb(VAULT_ID)
      .prepare(
        `INSERT INTO tasks (id, skill_slug, state, title, started_at)
         VALUES (?, 'enrichment', 'review', ?, ?)`,
      )
      .run("task_review", "Already reviewed", "2020-01-01 00:00:00");

    expect(recoverOrphanedTasks(VAULT_ID)).toBe(0);
    const row = getVaultDb(VAULT_ID)
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get("task_review") as { state: string };
    expect(row.state).toBe("review");
  });

  it("returns 0 when there are no running rows at all", () => {
    expect(recoverOrphanedTasks(VAULT_ID)).toBe(0);
  });
});

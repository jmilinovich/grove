/**
 * P23-1 — Scheduler cron tick tests.
 *
 * `runCronTick(vaultId)` walks `skill_configs` for enabled rows whose
 * `next_run_at` is in the past, inserts one pending task per match, and
 * advances `next_run_at` by the configured cadence. Drives the tick
 * directly against a seeded per-vault state.db — no timers, no PM2.
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-scheduler-tick-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");
process.env.GROVE_DISABLE_TASK_WORKER = "1";

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import { runCronTick } from "../src/scheduler.js";

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

const VAULT_ID = "vault_sched_tick";

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

function upsertSkillConfig(opts: {
  slug: string;
  enabled: 0 | 1;
  cadence: "daily" | "weekly" | "on-demand" | "on-trigger";
  nextRunAt: string | null;
}): void {
  getVaultDb(VAULT_ID)
    .prepare(
      `INSERT INTO skill_configs (skill_slug, enabled, cadence, next_run_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(skill_slug) DO UPDATE SET
         enabled = excluded.enabled,
         cadence = excluded.cadence,
         next_run_at = excluded.next_run_at,
         updated_at = datetime('now')`,
    )
    .run(opts.slug, opts.enabled, opts.cadence, opts.nextRunAt);
}

interface TaskRow {
  id: string;
  skill_slug: string;
  state: string;
  scheduled_for: string | null;
}

function selectTasks(): TaskRow[] {
  return getVaultDb(VAULT_ID)
    .prepare(
      "SELECT id, skill_slug, state, scheduled_for FROM tasks ORDER BY created_at ASC",
    )
    .all() as TaskRow[];
}

describe("scheduler cron tick (P23-1)", () => {
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

  it("enqueues one pending task per due skill_configs row", () => {
    upsertSkillConfig({
      slug: "daily-vault-review",
      enabled: 1,
      cadence: "daily",
      nextRunAt: "2020-01-01 00:00:00", // far past
    });

    const enqueued = runCronTick(VAULT_ID);
    expect(enqueued).toBe(1);

    const tasks = selectTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].skill_slug).toBe("daily-vault-review");
    expect(tasks[0].state).toBe("pending");
    expect(tasks[0].scheduled_for).not.toBeNull();
  });

  it("advances next_run_at by +1 day for daily cadence", () => {
    upsertSkillConfig({
      slug: "daily-vault-review",
      enabled: 1,
      cadence: "daily",
      nextRunAt: "2020-01-01 00:00:00",
    });

    runCronTick(VAULT_ID);

    const row = getVaultDb(VAULT_ID)
      .prepare(
        "SELECT next_run_at, last_run_at FROM skill_configs WHERE skill_slug = ?",
      )
      .get("daily-vault-review") as {
      next_run_at: string;
      last_run_at: string;
    };
    // next_run_at = now + 1 day → must be in the future, well past the
    // seeded 2020 sentinel.
    const next = new Date(row.next_run_at + "Z").getTime();
    const nowPlus23h = Date.now() + 23 * 3600 * 1000;
    expect(next).toBeGreaterThan(nowPlus23h);
    expect(row.last_run_at).not.toBeNull();
  });

  it("advances next_run_at by +7 days for weekly cadence", () => {
    upsertSkillConfig({
      slug: "concept-graph-cleanup",
      enabled: 1,
      cadence: "weekly",
      nextRunAt: "2020-01-01 00:00:00",
    });

    const enqueued = runCronTick(VAULT_ID);
    expect(enqueued).toBe(1);

    const row = getVaultDb(VAULT_ID)
      .prepare("SELECT next_run_at FROM skill_configs WHERE skill_slug = ?")
      .get("concept-graph-cleanup") as { next_run_at: string };
    const next = new Date(row.next_run_at + "Z").getTime();
    const nowPlus6d = Date.now() + 6 * 24 * 3600 * 1000;
    expect(next).toBeGreaterThan(nowPlus6d);
  });

  it("skips on-demand and on-trigger cadences (never auto-enqueues)", () => {
    upsertSkillConfig({
      slug: "daily-vault-review",
      enabled: 1,
      cadence: "on-demand",
      nextRunAt: null,
    });
    upsertSkillConfig({
      slug: "concept-graph-cleanup",
      enabled: 1,
      cadence: "on-trigger",
      nextRunAt: null,
    });
    // Even with a seemingly-due nextRunAt, on-demand stays manual.
    upsertSkillConfig({
      slug: "dup-people-detection",
      enabled: 1,
      cadence: "on-demand",
      nextRunAt: "2020-01-01 00:00:00",
    });

    const enqueued = runCronTick(VAULT_ID);
    expect(enqueued).toBe(0);
    expect(selectTasks()).toHaveLength(0);
  });

  it("skips disabled rows even if next_run_at is in the past", () => {
    upsertSkillConfig({
      slug: "daily-vault-review",
      enabled: 0,
      cadence: "daily",
      nextRunAt: "2020-01-01 00:00:00",
    });

    expect(runCronTick(VAULT_ID)).toBe(0);
    expect(selectTasks()).toHaveLength(0);
  });

  it("skips rows whose next_run_at is in the future", () => {
    upsertSkillConfig({
      slug: "daily-vault-review",
      enabled: 1,
      cadence: "daily",
      nextRunAt: "2099-01-01 00:00:00",
    });

    expect(runCronTick(VAULT_ID)).toBe(0);
    expect(selectTasks()).toHaveLength(0);
  });

  it("is idempotent within a tick window — a second tick enqueues nothing", () => {
    upsertSkillConfig({
      slug: "daily-vault-review",
      enabled: 1,
      cadence: "daily",
      nextRunAt: "2020-01-01 00:00:00",
    });

    expect(runCronTick(VAULT_ID)).toBe(1);
    // After the first tick, next_run_at is now+1d — the second tick
    // sees no due rows and enqueues nothing.
    expect(runCronTick(VAULT_ID)).toBe(0);
    expect(selectTasks()).toHaveLength(1);
  });

  it("uses the registry display name as the task title", () => {
    upsertSkillConfig({
      slug: "daily-vault-review",
      enabled: 1,
      cadence: "daily",
      nextRunAt: "2020-01-01 00:00:00",
    });

    runCronTick(VAULT_ID);

    const row = getVaultDb(VAULT_ID)
      .prepare("SELECT title FROM tasks LIMIT 1")
      .get() as { title: string };
    expect(row.title).toBe("Daily Vault Review");
  });
});

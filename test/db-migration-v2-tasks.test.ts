/**
 * P21-2 — Schema migration `002_v2_tasks.sql` for the per-vault state.db.
 *
 * Asserts:
 *   - Migration creates `tasks`, `task_results`, `skill_configs` with the
 *     expected columns + indexes.
 *   - state enum is CHECK-constrained to the 6 task states.
 *   - cadence enum is CHECK-constrained to 4 values including 'on-trigger'.
 *   - task_results.task_id cascades on delete from tasks.
 *   - Migration is idempotent (running twice is a no-op).
 *
 * The migration file is copied from the real
 * `src/migrations/vault/002_v2_tasks.sql` into the test migrations dir
 * so the production file stays under test without monkey-patching the
 * vault migrations directory globally.
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-db-v2-tasks-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");

import { getDb, resetDb, createSchema } from "../src/db.js";
import {
  getVaultDb,
  closeAllVaultDbs,
} from "../src/db-per-vault.js";

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

function seedVault(id: string, slug: string): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run("user_v2", "tester", "tester@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "user_v2", slug, slug, join(TEST_DIR, "repos", slug));
}

describe("v2 tasks schema migration (002_v2_tasks.sql)", () => {
  beforeEach(() => {
    resetDb();
    closeAllVaultDbs();
    rmSync(process.env.GROVE_VAULT_STATE_ROOT!, {
      recursive: true,
      force: true,
    });
    rmSync(process.env.GROVE_VAULT_MIGRATIONS_DIR!, {
      recursive: true,
      force: true,
    });
    copyRealMigrations();
    createSchema();
    seedVault("vault_v2", "personal");
  });

  afterEach(() => {
    closeAllVaultDbs();
  });

  it("creates the three v2 tables on a fresh vault", () => {
    const db = getVaultDb("vault_v2");
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("tasks");
    expect(names).toContain("task_results");
    expect(names).toContain("skill_configs");
  });

  it("creates the three task-table indexes", () => {
    const db = getVaultDb("vault_v2");
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_tasks_state_scheduled");
    expect(names).toContain("idx_tasks_skill_slug");
    expect(names).toContain("idx_tasks_state_started_at");
  });

  it("enforces the state enum via CHECK constraint", () => {
    const db = getVaultDb("vault_v2");
    expect(() =>
      db
        .prepare(
          "INSERT INTO tasks (id, skill_slug, state, title) VALUES (?, ?, ?, ?)",
        )
        .run("t1", "daily-vault-review", "not-a-real-state", "test"),
    ).toThrow(/CHECK constraint/);
  });

  it("enforces the cadence enum and accepts 'on-trigger'", () => {
    const db = getVaultDb("vault_v2");

    expect(() =>
      db
        .prepare(
          "INSERT INTO skill_configs (skill_slug, enabled, cadence) VALUES (?, ?, ?)",
        )
        .run("daily-vault-review", 0, "every-other-tuesday"),
    ).toThrow(/CHECK constraint/);

    expect(() =>
      db
        .prepare(
          "INSERT INTO skill_configs (skill_slug, enabled, cadence) VALUES (?, ?, ?)",
        )
        .run("concept-graph-cleanup", 1, "on-trigger"),
    ).not.toThrow();
  });

  it("cascades task_results when its task is deleted", () => {
    const db = getVaultDb("vault_v2");
    db.prepare(
      "INSERT INTO tasks (id, skill_slug, state, title) VALUES (?, ?, ?, ?)",
    ).run("t1", "daily-vault-review", "review", "test");
    db.prepare(
      "INSERT INTO task_results (task_id, artifact_json) VALUES (?, ?)",
    ).run("t1", '{"type":"surface","surfaceText":"hi"}');

    // SQLite requires PRAGMA foreign_keys = ON to enforce cascades; the
    // runner enables it via PRAGMA in db-per-vault.ts.
    db.prepare("PRAGMA foreign_keys = ON").run();
    db.prepare("DELETE FROM tasks WHERE id = ?").run("t1");
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM task_results")
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("is idempotent — re-opening the vault db is a no-op", () => {
    // First open applies migrations.
    getVaultDb("vault_v2");
    closeAllVaultDbs();
    // Second open should not crash on CREATE TABLE — IF NOT EXISTS guards.
    const db = getVaultDb("vault_v2");
    const row = db
      .prepare("SELECT name FROM _migration_state WHERE name = ?")
      .get("002_v2_tasks.sql") as { name: string } | undefined;
    expect(row?.name).toBe("002_v2_tasks.sql");
  });
});

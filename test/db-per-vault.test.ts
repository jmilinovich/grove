import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Test fixtures live under a temp dir; both the control db and the
// per-vault state-db root point inside it. Env vars must be set BEFORE
// importing the db modules so the singletons pick them up.
const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-db-per-vault-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");

import { getDb, resetDb, createSchema } from "../src/db.js";
import {
  getVaultDb,
  forEachVaultDb,
  closeAllVaultDbs,
} from "../src/db-per-vault.js";

function writeFixtureMigrations(): void {
  const dir = process.env.GROVE_VAULT_MIGRATIONS_DIR!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "001_init_vault_state.sql"),
    "CREATE TABLE IF NOT EXISTS _migration_state (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));\n",
  );
  writeFileSync(
    join(dir, "002_test_table.sql"),
    "CREATE TABLE IF NOT EXISTS test_widgets (id TEXT PRIMARY KEY, label TEXT NOT NULL);\n",
  );
}

function seedVault(id: string, slug: string): void {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)").run(
    "user_test", "test", "test@example.com",
  );
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "user_test", slug, slug, join(TEST_DIR, "repos", slug));
}

describe("db-per-vault", () => {
  beforeEach(() => {
    resetDb();
    closeAllVaultDbs();
    // Wipe state-db root + migrations between tests so each starts fresh.
    rmSync(process.env.GROVE_VAULT_STATE_ROOT!, { recursive: true, force: true });
    rmSync(process.env.GROVE_VAULT_MIGRATIONS_DIR!, { recursive: true, force: true });
    rmSync(process.env.GROVE_DB_PATH!, { force: true });
    rmSync(`${process.env.GROVE_DB_PATH!}-wal`, { force: true });
    rmSync(`${process.env.GROVE_DB_PATH!}-shm`, { force: true });

    createSchema();
    writeFixtureMigrations();
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
  });

  it("creates state.db at ~/.grove/vaults/<slug>/state.db on first call", () => {
    seedVault("vault_aaa", "alpha");

    const db = getVaultDb("vault_aaa");
    expect(db.open).toBe(true);

    const expectedPath = join(process.env.GROVE_VAULT_STATE_ROOT!, "alpha", "state.db");
    expect(existsSync(expectedPath)).toBe(true);
  });

  it("returns the same connection on repeated calls (pool reuse)", () => {
    seedVault("vault_bbb", "beta");

    const first = getVaultDb("vault_bbb");
    const second = getVaultDb("vault_bbb");

    expect(second).toBe(first);
  });

  it("isolates per-vault state.db files — write in one is invisible to the other", () => {
    seedVault("vault_aaa", "alpha");
    seedVault("vault_bbb", "beta");

    const a = getVaultDb("vault_aaa");
    const b = getVaultDb("vault_bbb");

    a.prepare("INSERT INTO test_widgets (id, label) VALUES (?, ?)").run("w1", "in-alpha");
    const inB = b.prepare("SELECT COUNT(*) AS n FROM test_widgets").get() as { n: number };
    expect(inB.n).toBe(0);

    const inA = a.prepare("SELECT COUNT(*) AS n FROM test_widgets").get() as { n: number };
    expect(inA.n).toBe(1);
  });

  it("throws when vault_id is not in the control db", () => {
    expect(() => getVaultDb("vault_does_not_exist")).toThrow(/unknown vault_id/);
  });

  it("migration runner applies migrations in lexical order, idempotently", () => {
    seedVault("vault_ccc", "gamma");

    const db = getVaultDb("vault_ccc");
    const appliedFirst = db
      .prepare("SELECT name FROM _migration_state ORDER BY name")
      .all() as { name: string }[];
    expect(appliedFirst.map((r) => r.name)).toEqual([
      "001_init_vault_state.sql",
      "002_test_table.sql",
    ]);

    // Re-running by reopening should be a no-op. Close the pool first so
    // getVaultDb reopens and re-runs the runner.
    closeAllVaultDbs();
    const db2 = getVaultDb("vault_ccc");
    const appliedSecond = db2
      .prepare("SELECT name FROM _migration_state ORDER BY name")
      .all() as { name: string }[];
    expect(appliedSecond).toEqual(appliedFirst);

    // The application table should still exist + be queryable.
    const widgets = db2.prepare("SELECT COUNT(*) AS n FROM test_widgets").get() as { n: number };
    expect(widgets.n).toBe(0);
  });

  it("forEachVaultDb iterates exactly the rows in vaults", () => {
    seedVault("vault_aaa", "alpha");
    seedVault("vault_bbb", "beta");
    seedVault("vault_ccc", "gamma");

    const visited: string[] = [];
    forEachVaultDb((_db, vault) => {
      visited.push(vault.slug);
    });

    expect(visited.sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("forEachVaultDb opens a usable connection for each vault", () => {
    seedVault("vault_aaa", "alpha");
    seedVault("vault_bbb", "beta");

    forEachVaultDb((db, vault) => {
      db.prepare("INSERT INTO test_widgets (id, label) VALUES (?, ?)").run(`w-${vault.slug}`, vault.slug);
    });

    const a = getVaultDb("vault_aaa");
    const b = getVaultDb("vault_bbb");
    const aRow = a.prepare("SELECT label FROM test_widgets WHERE id = ?").get("w-alpha") as { label: string };
    const bRow = b.prepare("SELECT label FROM test_widgets WHERE id = ?").get("w-beta") as { label: string };
    expect(aRow.label).toBe("alpha");
    expect(bRow.label).toBe("beta");
  });
});

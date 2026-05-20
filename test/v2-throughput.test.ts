/**
 * P21-4 — `computeThroughput` helper-direct tests.
 *
 * Validates the math + the SPEC §7 first-14-days hide rule. No HTTP
 * harness — the helper is what P21-3's BacklogPayload will call, so
 * direct-call coverage is the contract that matters. The standalone
 * `/v1/throughput` endpoint was CUT (Scope Cop).
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-v2-throughput-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");

import { getDb, resetDb, createSchema } from "../src/db.js";
import {
  getVaultDb,
  closeAllVaultDbs,
} from "../src/db-per-vault.js";
import { computeThroughput } from "../src/v2-tasks.js";

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
  ).run("user_thru", "thru-tester", "thru@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "user_thru", slug, slug, join(TEST_DIR, "repos", slug));
}

/**
 * Add a vault_members row with an explicit `joined_at` so we can drive
 * the `showCeiling` first-14-days check by clock age, not wall time.
 */
function seedMembership(
  userId: string,
  vaultId: string,
  joinedAt: string,
  role: "owner" | "member" | "viewer" = "owner",
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO vault_members (user_id, vault_id, role, joined_at)
     VALUES (?, ?, ?, ?)`,
  ).run(userId, vaultId, role, joinedAt);
}

/** Insert a `done` task whose completed_at is exactly `daysAgo` ago. */
function insertDoneTask(vaultId: string, id: string, daysAgo: number): void {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  getVaultDb(vaultId)
    .prepare(
      `INSERT INTO tasks (id, skill_slug, state, title, completed_at)
       VALUES (?, ?, 'done', ?, ?)`,
    )
    .run(id, "enrichment", `done-${id}`, ts);
}

function insertPendingTask(vaultId: string, id: string): void {
  getVaultDb(vaultId)
    .prepare(
      `INSERT INTO tasks (id, skill_slug, state, title)
       VALUES (?, ?, 'pending', ?)`,
    )
    .run(id, "enrichment", `pending-${id}`);
}

function insertRunningTask(vaultId: string, id: string): void {
  getVaultDb(vaultId)
    .prepare(
      `INSERT INTO tasks (id, skill_slug, state, title)
       VALUES (?, ?, 'running', ?)`,
    )
    .run(id, "enrichment", `running-${id}`);
}

const VAULT_ID = "vault_thru";

describe("computeThroughput (P21-4)", () => {
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
    rmSync(process.env.GROVE_DB_PATH!, { force: true });
    rmSync(`${process.env.GROVE_DB_PATH!}-wal`, { force: true });
    rmSync(`${process.env.GROVE_DB_PATH!}-shm`, { force: true });
    copyRealMigrations();
    createSchema();
    seedVault(VAULT_ID, "personal");
    getVaultDb(VAULT_ID);
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
  });

  it("returns null velocity + 'warming up' when nothing has completed", () => {
    insertPendingTask(VAULT_ID, "p1");
    insertPendingTask(VAULT_ID, "p2");
    seedMembership("user_thru", VAULT_ID, new Date(Date.now() - 30 * 86400_000).toISOString());

    const view = computeThroughput(VAULT_ID);

    expect(view.rollingWeekVelocity).toBeNull();
    expect(view.estimatedClearText).toBe("warming up");
    expect(view.pending).toBe(2);
    expect(view.cleared7d).toBe(0);
  });

  it("computes rollingWeekVelocity = completed_28d / 4", () => {
    // 8 completed in the last 28 days → 2/week average.
    for (let i = 0; i < 4; i++) insertDoneTask(VAULT_ID, `d-${i}`, 3);
    for (let i = 0; i < 4; i++) insertDoneTask(VAULT_ID, `d2-${i}`, 20);
    // One stale completion outside the 28d window — must not count.
    insertDoneTask(VAULT_ID, "stale", 40);

    insertPendingTask(VAULT_ID, "p1");
    insertPendingTask(VAULT_ID, "p2");

    seedMembership("user_thru", VAULT_ID, new Date(Date.now() - 30 * 86400_000).toISOString());

    const view = computeThroughput(VAULT_ID);

    expect(view.rollingWeekVelocity).toBe(2);
    expect(view.pending).toBe(2);
    expect(view.estimatedClearText).toBe("≈1 week at your pace");
  });

  it("counts only the last 7 days for cleared7d", () => {
    insertDoneTask(VAULT_ID, "recent-1", 1);
    insertDoneTask(VAULT_ID, "recent-2", 6);
    insertDoneTask(VAULT_ID, "older", 10);
    seedMembership("user_thru", VAULT_ID, new Date(Date.now() - 30 * 86400_000).toISOString());

    const view = computeThroughput(VAULT_ID);
    expect(view.cleared7d).toBe(2);
  });

  it("counts both pending and running toward pending", () => {
    insertPendingTask(VAULT_ID, "p1");
    insertRunningTask(VAULT_ID, "r1");
    insertRunningTask(VAULT_ID, "r2");
    insertDoneTask(VAULT_ID, "d1", 1); // done doesn't count as pending
    seedMembership("user_thru", VAULT_ID, new Date(Date.now() - 30 * 86400_000).toISOString());

    const view = computeThroughput(VAULT_ID);
    expect(view.pending).toBe(3);
  });

  it("rounds estimatedClearText weeks up via Math.ceil(pending / velocity)", () => {
    // velocity = 1/week (4 done in last 28d → 4/4 = 1).
    for (let i = 0; i < 4; i++) insertDoneTask(VAULT_ID, `d-${i}`, 5 + i);
    // 5 pending → 5 weeks at your pace.
    for (let i = 0; i < 5; i++) insertPendingTask(VAULT_ID, `p-${i}`);
    seedMembership("user_thru", VAULT_ID, new Date(Date.now() - 30 * 86400_000).toISOString());

    const view = computeThroughput(VAULT_ID);
    expect(view.rollingWeekVelocity).toBe(1);
    expect(view.estimatedClearText).toBe("≈5 weeks at your pace");
  });

  it("hides the ceiling when the vault is younger than 14 days", () => {
    seedMembership("user_thru", VAULT_ID, new Date(Date.now() - 5 * 86400_000).toISOString());
    for (let i = 0; i < 4; i++) insertDoneTask(VAULT_ID, `d-${i}`, 2);

    const view = computeThroughput(VAULT_ID);
    expect(view.showCeiling).toBe(false);
  });

  it("shows the ceiling once the earliest membership is ≥14 days old", () => {
    seedMembership("user_thru", VAULT_ID, new Date(Date.now() - 30 * 86400_000).toISOString());
    for (let i = 0; i < 4; i++) insertDoneTask(VAULT_ID, `d-${i}`, 2);

    const view = computeThroughput(VAULT_ID);
    expect(view.showCeiling).toBe(true);
  });

  it("hides the ceiling when there's no vault_members row at all", () => {
    // Missing membership means we can't prove the vault is ≥14d old —
    // safer to hide the ceiling than to anchor on a noisy reading.
    for (let i = 0; i < 4; i++) insertDoneTask(VAULT_ID, `d-${i}`, 2);
    const view = computeThroughput(VAULT_ID);
    expect(view.showCeiling).toBe(false);
  });
});

/**
 * P23-2 — First-run bootstrap tests.
 *
 * `bootstrapFirstRun(vault)` is the out-of-band first-run choreography
 * triggered by the per-vault scheduler when `vaults.bootstrap_pending=1`.
 * Per the Inbox v2 follow-up, it seeds skill_configs for ALL three
 * default suggestion skills (enrichment, disambiguation, links-suggestion)
 * + one immediate task per skill (+ any starter pending tasks the registry
 * defines for each), then clears the flag. Cadences come from the registry,
 * not hardcoded. Idempotent.
 *
 * Tests run against a real per-vault state.db (migrations applied) and a
 * real control db (grove.db) — no mocks. The scheduler integration test
 * exercises `checkAndRunBootstrap` so we cover the wire from flag→bootstrap.
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-first-run-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");
process.env.GROVE_DISABLE_TASK_WORKER = "1";

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import {
  bootstrapFirstRun,
  nextSixAmPacificUtcIso,
  FIRST_RUN_TOKEN_CEILING,
  FIRST_RUN_SKILL_SLUGS,
} from "../src/skills/first-run.js";
import { SKILL_REGISTRY } from "../src/skills/registry.js";
import { checkAndRunBootstrap } from "../src/scheduler.js";
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

const VAULT_ID = "vault_first_run";
const VAULT_SLUG = "personal";

function seedVault(opts: { bootstrapPending?: 0 | 1 } = {}): VaultContext {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run("user_first", "first-run-tester", "first@example.com");
  db.prepare(
    `INSERT OR IGNORE INTO vaults
       (id, owner_id, slug, display_name, git_repo_path, bootstrap_pending)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    VAULT_ID,
    "user_first",
    VAULT_SLUG,
    "Personal",
    join(TEST_DIR, "repos", VAULT_SLUG),
    opts.bootstrapPending ?? 0,
  );
  // Open + migrate the per-vault state.db before the test runs.
  getVaultDb(VAULT_ID);
  return {
    vaultId: VAULT_ID,
    vaultSlug: VAULT_SLUG,
    vaultPath: join(TEST_DIR, "repos", VAULT_SLUG),
  };
}

function selectTasks(): Array<{
  id: string;
  skill_slug: string;
  state: string;
  title: string;
  scheduled_for: string | null;
}> {
  return getVaultDb(VAULT_ID)
    .prepare(
      `SELECT id, skill_slug, state, title, scheduled_for
         FROM tasks
        ORDER BY created_at ASC, id ASC`,
    )
    .all() as Array<{
    id: string;
    skill_slug: string;
    state: string;
    title: string;
    scheduled_for: string | null;
  }>;
}

function selectSkillConfigs(): Array<{
  skill_slug: string;
  enabled: number;
  cadence: string;
  next_run_at: string | null;
}> {
  return getVaultDb(VAULT_ID)
    .prepare(
      "SELECT skill_slug, enabled, cadence, next_run_at FROM skill_configs ORDER BY skill_slug",
    )
    .all() as Array<{
    skill_slug: string;
    enabled: number;
    cadence: string;
    next_run_at: string | null;
  }>;
}

function readBootstrapPending(): number {
  return (
    getDb()
      .prepare("SELECT bootstrap_pending FROM vaults WHERE id = ?")
      .get(VAULT_ID) as { bootstrap_pending: number }
  ).bootstrap_pending;
}

describe("bootstrapFirstRun (P23-2)", () => {
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
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
  });

  it("inserts skill_configs rows for all 3 default suggestion skills with registry cadences + next_run_at in the future", async () => {
    const vault = seedVault({ bootstrapPending: 1 });

    await bootstrapFirstRun(vault);

    const configs = selectSkillConfigs();
    // 3 skill_configs — enrichment, disambiguation, links-suggestion.
    expect(configs).toHaveLength(3);

    const bySlug = new Map(configs.map((c) => [c.skill_slug, c]));
    for (const slug of FIRST_RUN_SKILL_SLUGS) {
      const row = bySlug.get(slug);
      expect(row, `expected skill_configs row for ${slug}`).toBeDefined();
      expect(row!.enabled).toBe(1);

      // Cadence must match the registry default — not a hardcoded literal.
      const registryEntry = SKILL_REGISTRY.find((s) => s.slug === slug);
      expect(registryEntry, `${slug} must be in SKILL_REGISTRY`).toBeDefined();
      expect(row!.cadence).toBe(registryEntry!.defaultCadence ?? "weekly");

      expect(row!.next_run_at).not.toBeNull();
      // next_run_at must be in the future and within the next ~30 hours
      // (covers DST edge cases on either side of the boundary).
      const nextRun = new Date(row!.next_run_at!).getTime();
      expect(nextRun).toBeGreaterThan(Date.now());
      expect(nextRun).toBeLessThan(Date.now() + 30 * 3600 * 1000);
    }
  });

  it("inserts one immediate task per default skill (+ any registry starter tasks)", async () => {
    const vault = seedVault({ bootstrapPending: 1 });

    await bootstrapFirstRun(vault);

    const tasks = selectTasks();
    // Floor is 3 (one immediate task per default skill). The bootstrap
    // still walks `starterPendingTasks` so future starters drop in for
    // free — leave headroom in the upper bound.
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    expect(tasks.length).toBeLessThanOrEqual(20);

    for (const t of tasks) {
      expect(t.state).toBe("pending");
      // Every task belongs to one of the seeded skills.
      expect(FIRST_RUN_SKILL_SLUGS).toContain(
        t.skill_slug as (typeof FIRST_RUN_SKILL_SLUGS)[number],
      );
    }

    // Exactly one immediate (scheduled_for != NULL) task per seeded skill.
    const immediate = tasks.filter((t) => t.scheduled_for !== null);
    expect(immediate).toHaveLength(FIRST_RUN_SKILL_SLUGS.length);

    const immediateBySlug = new Map(immediate.map((t) => [t.skill_slug, t]));
    expect(immediateBySlug.get("enrichment")?.title).toBe("Enrichment first-run");
    expect(immediateBySlug.get("disambiguation")?.title).toBe(
      "Disambiguation first-run",
    );
    expect(immediateBySlug.get("links-suggestion")?.title).toBe(
      "Links first-run",
    );
  });

  it("clears vaults.bootstrap_pending=0 after running", async () => {
    const vault = seedVault({ bootstrapPending: 1 });
    expect(readBootstrapPending()).toBe(1);

    await bootstrapFirstRun(vault);

    expect(readBootstrapPending()).toBe(0);
  });

  it("is idempotent — second call inserts no new rows", async () => {
    const vault = seedVault({ bootstrapPending: 1 });
    await bootstrapFirstRun(vault);
    const firstTasks = selectTasks();
    const firstConfigs = selectSkillConfigs();

    // Re-flip the flag and run again — the existing skill_configs row
    // short-circuits the bootstrap; only the flag clear runs.
    getDb()
      .prepare("UPDATE vaults SET bootstrap_pending = 1 WHERE id = ?")
      .run(VAULT_ID);
    await bootstrapFirstRun(vault);

    expect(selectTasks()).toHaveLength(firstTasks.length);
    expect(selectSkillConfigs()).toHaveLength(firstConfigs.length);
    expect(readBootstrapPending()).toBe(0);
  });

  it("scheduler.checkAndRunBootstrap picks up the flagged vault, runs bootstrap, and clears the flag", async () => {
    seedVault({ bootstrapPending: 1 });

    const ran = await checkAndRunBootstrap(VAULT_ID);
    expect(ran).toBe(true);
    expect(readBootstrapPending()).toBe(0);

    // Bootstrap path goes through the same code: 3 skill_configs + at
    // least 3 immediate (scheduled_for != NULL) tasks land.
    expect(selectSkillConfigs()).toHaveLength(FIRST_RUN_SKILL_SLUGS.length);
    const tasks = selectTasks();
    const immediate = tasks.filter((t) => t.scheduled_for !== null);
    expect(immediate.length).toBe(FIRST_RUN_SKILL_SLUGS.length);
  });

  it("scheduler.checkAndRunBootstrap is a no-op when the flag is already 0", async () => {
    seedVault({ bootstrapPending: 0 });

    const ran = await checkAndRunBootstrap(VAULT_ID);
    expect(ran).toBe(false);
    expect(selectTasks()).toHaveLength(0);
    expect(selectSkillConfigs()).toHaveLength(0);
  });

  it("exposes FIRST_RUN_TOKEN_CEILING = 50_000 for the executor adapter (P7 cost pattern)", () => {
    expect(FIRST_RUN_TOKEN_CEILING).toBe(50_000);
  });

  describe("nextSixAmPacificUtcIso", () => {
    it("returns today 06:00 LA when called before 06:00 LA", () => {
      // 2026-05-14 13:00 UTC = 06:00 PDT (UTC-7) on the same date.
      // Probe with a time that's 04:00 PDT → expect today 06:00 PDT.
      const now = new Date("2026-05-14T11:00:00Z"); // 04:00 PDT
      const out = nextSixAmPacificUtcIso(now);
      expect(out).toBe("2026-05-14T13:00:00.000Z");
    });

    it("returns tomorrow 06:00 LA when called after 06:00 LA", () => {
      // 2026-05-14 20:00 UTC = 13:00 PDT → expect tomorrow 06:00 PDT.
      const now = new Date("2026-05-14T20:00:00Z");
      const out = nextSixAmPacificUtcIso(now);
      expect(out).toBe("2026-05-15T13:00:00.000Z");
    });

    it("returns a future ISO string from the current moment", () => {
      const before = Date.now();
      const out = nextSixAmPacificUtcIso();
      const parsed = new Date(out).getTime();
      expect(parsed).toBeGreaterThan(before);
      expect(parsed).toBeLessThan(before + 30 * 3600 * 1000);
    });
  });
});

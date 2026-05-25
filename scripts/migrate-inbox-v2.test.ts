/**
 * M-INBOX-1 — falsifier for the one-shot migration script.
 *
 * Locks down the seven behaviors the script must exhibit (see the script's
 * docstring + docs/inbox-v2-plan.md § M-INBOX-1):
 *
 *   1. Dry-run discovers correctly and writes nothing
 *   2. --apply --i-mean-it marks all legacy rows dismissed (and only those)
 *   3. Idempotent re-run: second pass finds 0 rows
 *   4. Sanity ceiling: refuses --apply --i-mean-it when count > 200 without --force
 *   5. Sanity ceiling: proceeds with --force
 *   6. --apply alone (no --i-mean-it) prints reminder and exits without writes
 *   7. Audit log: migration_events table receives one row per dismissed task
 *
 * Fixture pattern mirrors test/decision-writer.test.ts — copy the real
 * migrations into a temp dir, point GROVE_VAULT_MIGRATIONS_DIR at it, seed
 * a vault row, force per-vault state.db init so migrations run.
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-migrate-inbox-v2-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");
process.env.GROVE_DISABLE_TASK_WORKER = "1";

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import { parseArgs, run, runAll, main } from "./migrate-inbox-v2.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_MIGRATIONS_DIR = join(HERE, "..", "src", "migrations", "vault");

const MIGRATIONS = [
  "001_init_vault_state.sql",
  "002_v2_tasks.sql",
  "003_decisions.sql",
  "004_migration_events.sql",
];

function copyRealMigrations(): void {
  const dir = process.env.GROVE_VAULT_MIGRATIONS_DIR!;
  mkdirSync(dir, { recursive: true });
  for (const name of MIGRATIONS) {
    writeFileSync(
      join(dir, name),
      readFileSync(join(REAL_MIGRATIONS_DIR, name), "utf8"),
    );
  }
}

const VAULT_ID = "vault_migrate_inbox_v2";
const VAULT_SLUG = "migrate-inbox-v2";

function seedControl(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run("user_m1", "m1-tester", "m1@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(
    VAULT_ID,
    "user_m1",
    VAULT_SLUG,
    VAULT_SLUG,
    join(TEST_DIR, "repos", VAULT_SLUG),
  );
}

function freshTestState(): void {
  resetDb();
  closeAllVaultDbs();
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

interface SeededTaskOpts {
  id: string;
  state: "pending" | "running" | "review" | "done" | "dismissed" | "failed";
  skillSlug: string;
  title?: string;
  createdAt?: string;
  withDecision?: boolean;
}

function insertTask(opts: SeededTaskOpts): void {
  const db = getVaultDb(VAULT_ID);
  db.prepare(
    `INSERT INTO tasks (id, skill_slug, state, title, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.skillSlug,
    opts.state,
    opts.title ?? `Task ${opts.id}`,
    null,
    opts.createdAt ?? "2026-05-01T00:00:00Z",
    opts.createdAt ?? "2026-05-01T00:00:00Z",
  );
  if (opts.withDecision) {
    db.prepare(
      `INSERT INTO decisions (id, type, skill_run_id, task_id, created_at, status,
                              payload_json, options_json, chosen_option_id, affected_paths_json)
       VALUES (?, 'link', 'SR-x', ?, '2026-05-01T00:00:00Z', 'provisional',
               '{}', '[]', 'opt-1', '[]')`,
    ).run(`D-for-${opts.id}`, opts.id);
  }
}

/** Seed N legacy review-state tasks (the migration targets). */
function seedLegacyReviewTasks(n: number, titles?: string[]): void {
  for (let i = 0; i < n; i++) {
    const title = titles?.[i % titles.length] ?? `Legacy review item ${i + 1}`;
    insertTask({
      id: `legacy_${i + 1}`,
      state: "review",
      skillSlug: "daily-vault-review",
      title,
      createdAt: `2026-04-${String((i % 28) + 1).padStart(2, "0")}T12:00:00Z`,
    });
  }
}

/**
 * Seed a second/third vault in the control db so --all-vaults has more than
 * the default single fixture vault to iterate. Returns the per-vault db so
 * the caller can insert tasks into it.
 */
function seedExtraVault(
  vaultId: string,
  vaultSlug: string,
): ReturnType<typeof getVaultDb> {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run("user_m1", "m1-tester", "m1@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(
    vaultId,
    "user_m1",
    vaultSlug,
    vaultSlug,
    join(TEST_DIR, "repos", vaultSlug),
  );
  return getVaultDb(vaultId);
}

/** Insert a legacy review task into a specific vault by id. */
function insertLegacyTaskInto(
  vaultId: string,
  taskId: string,
  title = `Legacy review in ${vaultId}`,
): void {
  const db = getVaultDb(vaultId);
  db.prepare(
    `INSERT INTO tasks (id, skill_slug, state, title, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    "daily-vault-review",
    "review",
    title,
    null,
    "2026-04-15T12:00:00Z",
    "2026-04-15T12:00:00Z",
  );
}

describe("M-INBOX-1 — migrate-inbox-v2 script", () => {
  let logs: string[];
  let errs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    freshTestState();
    logs = [];
    errs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    });
    errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errs.push(args.map((a) => String(a)).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    closeAllVaultDbs();
    resetDb();
  });

  // --- argv parsing ---

  describe("parseArgs", () => {
    it("defaults to dry-run when neither --dry-run nor --apply is given", () => {
      const args = parseArgs(["--vault", VAULT_SLUG]);
      expect(args.dryRun).toBe(true);
      expect(args.apply).toBe(false);
    });

    it("rejects --dry-run + --apply together", () => {
      expect(() => parseArgs(["--vault", VAULT_SLUG, "--dry-run", "--apply"]))
        .toThrow(/mutually exclusive/);
    });

    it("requires --vault or --all-vaults", () => {
      expect(() => parseArgs(["--apply", "--i-mean-it"]))
        .toThrow(/one of --vault <slug> or --all-vaults is required/);
    });

    it("rejects --vault + --all-vaults together", () => {
      expect(() =>
        parseArgs(["--vault", "foo", "--all-vaults"]),
      ).toThrow(/mutually exclusive/);
    });

    it("accepts --all-vaults as the scope flag", () => {
      const args = parseArgs(["--all-vaults"]);
      expect(args.allVaults).toBe(true);
      expect(args.vault).toBe("");
      expect(args.dryRun).toBe(true);
    });

    it("accepts --vault=<slug> form", () => {
      const args = parseArgs([`--vault=${VAULT_SLUG}`, "--apply", "--i-mean-it"]);
      expect(args.vault).toBe(VAULT_SLUG);
      expect(args.iMeanIt).toBe(true);
    });
  });

  // --- behavioral tests (the 7 in the spec) ---

  it("1. dry-run discovers correctly and writes nothing", () => {
    // 3 legacy, 1 decision-backed review, 1 pending
    seedLegacyReviewTasks(3);
    insertTask({
      id: "decision_backed",
      state: "review",
      skillSlug: "daily-vault-review",
      withDecision: true,
    });
    insertTask({
      id: "pending_task",
      state: "pending",
      skillSlug: "daily-vault-review",
    });

    const result = run(parseArgs(["--vault", VAULT_SLUG, "--dry-run"]));
    expect(result.legacyCount).toBe(3);
    expect(result.applied).toBe(false);
    expect(result.dismissedIds).toEqual([]);
    expect(result.exitCode).toBe(0);

    // Output: "3 legacy review tasks" appears in the summary.
    expect(logs.some((l) => l.includes("3 legacy review tasks"))).toBe(true);

    // No row was mutated.
    const db = getVaultDb(VAULT_ID);
    const reviewCount = db
      .prepare("SELECT COUNT(*) as n FROM tasks WHERE state = 'review'")
      .get() as { n: number };
    expect(reviewCount.n).toBe(4); // 3 legacy + 1 decision-backed
    const dismissed = db
      .prepare("SELECT COUNT(*) as n FROM tasks WHERE state = 'dismissed'")
      .get() as { n: number };
    expect(dismissed.n).toBe(0);
  });

  it("2. --apply --i-mean-it marks legacy rows dismissed; leaves others untouched", () => {
    seedLegacyReviewTasks(3);
    insertTask({
      id: "decision_backed",
      state: "review",
      skillSlug: "daily-vault-review",
      withDecision: true,
    });
    insertTask({
      id: "pending_task",
      state: "pending",
      skillSlug: "daily-vault-review",
    });

    const result = run(
      parseArgs(["--vault", VAULT_SLUG, "--apply", "--i-mean-it"]),
    );
    expect(result.applied).toBe(true);
    expect(result.dismissedIds).toHaveLength(3);
    expect(result.dismissedIds.sort()).toEqual(
      ["legacy_1", "legacy_2", "legacy_3"].sort(),
    );
    expect(result.exitCode).toBe(0);

    const db = getVaultDb(VAULT_ID);
    // 3 dismissed
    const dismissed = db
      .prepare(
        "SELECT id FROM tasks WHERE state = 'dismissed' ORDER BY id",
      )
      .all() as Array<{ id: string }>;
    expect(dismissed.map((r) => r.id)).toEqual([
      "legacy_1",
      "legacy_2",
      "legacy_3",
    ]);

    // completed_at populated on dismissed rows
    const completed = db
      .prepare("SELECT completed_at FROM tasks WHERE id = 'legacy_1'")
      .get() as { completed_at: string | null };
    expect(completed.completed_at).not.toBeNull();

    // decision-backed task still in review (not touched)
    const decisionBacked = db
      .prepare("SELECT state FROM tasks WHERE id = 'decision_backed'")
      .get() as { state: string };
    expect(decisionBacked.state).toBe("review");

    // pending task still pending
    const pending = db
      .prepare("SELECT state FROM tasks WHERE id = 'pending_task'")
      .get() as { state: string };
    expect(pending.state).toBe("pending");
  });

  it("3. idempotent: re-running after success finds 0 rows + makes no changes", () => {
    seedLegacyReviewTasks(3);

    const first = run(
      parseArgs(["--vault", VAULT_SLUG, "--apply", "--i-mean-it"]),
    );
    expect(first.legacyCount).toBe(3);
    expect(first.applied).toBe(true);

    logs.length = 0;

    const second = run(
      parseArgs(["--vault", VAULT_SLUG, "--apply", "--i-mean-it"]),
    );
    expect(second.legacyCount).toBe(0);
    expect(second.applied).toBe(false);
    expect(second.dismissedIds).toEqual([]);
    expect(second.exitCode).toBe(0);
    expect(logs.some((l) => l.includes("0 legacy review tasks"))).toBe(true);
    expect(logs.some((l) => l.includes("nothing to do"))).toBe(true);
  });

  it("4. sanity ceiling: refuses --apply --i-mean-it on >200 rows without --force", () => {
    seedLegacyReviewTasks(201);

    const result = run(
      parseArgs(["--vault", VAULT_SLUG, "--apply", "--i-mean-it"]),
    );
    expect(result.legacyCount).toBe(201);
    expect(result.applied).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(errs.some((e) => e.includes("REFUSE"))).toBe(true);
    expect(errs.some((e) => e.includes("sanity ceiling"))).toBe(true);

    // No rows mutated
    const db = getVaultDb(VAULT_ID);
    const dismissed = db
      .prepare("SELECT COUNT(*) as n FROM tasks WHERE state = 'dismissed'")
      .get() as { n: number };
    expect(dismissed.n).toBe(0);
  });

  it("5. sanity ceiling: proceeds with --force", () => {
    seedLegacyReviewTasks(201);

    const result = run(
      parseArgs([
        "--vault",
        VAULT_SLUG,
        "--apply",
        "--i-mean-it",
        "--force",
      ]),
    );
    expect(result.applied).toBe(true);
    expect(result.dismissedIds).toHaveLength(201);
    expect(result.exitCode).toBe(0);

    const db = getVaultDb(VAULT_ID);
    const dismissed = db
      .prepare("SELECT COUNT(*) as n FROM tasks WHERE state = 'dismissed'")
      .get() as { n: number };
    expect(dismissed.n).toBe(201);
  });

  it("6. --apply without --i-mean-it prints reminder and writes nothing", () => {
    seedLegacyReviewTasks(3);

    const result = run(parseArgs(["--vault", VAULT_SLUG, "--apply"]));
    expect(result.legacyCount).toBe(3);
    expect(result.applied).toBe(false);
    expect(result.dismissedIds).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(
      logs.some((l) => l.includes("--i-mean-it")),
    ).toBe(true);

    const db = getVaultDb(VAULT_ID);
    const dismissed = db
      .prepare("SELECT COUNT(*) as n FROM tasks WHERE state = 'dismissed'")
      .get() as { n: number };
    expect(dismissed.n).toBe(0);
  });

  it("7. audit log: migration_events receives one row per dismissed task", () => {
    seedLegacyReviewTasks(3, ["title-a", "title-b", "title-a"]);

    run(parseArgs(["--vault", VAULT_SLUG, "--apply", "--i-mean-it"]));

    const db = getVaultDb(VAULT_ID);
    const events = db
      .prepare(
        `SELECT id, migration, event, vault_slug, payload_json
           FROM migration_events
          WHERE migration = 'M-INBOX-1'
          ORDER BY id ASC`,
      )
      .all() as Array<{
        id: number;
        migration: string;
        event: string;
        vault_slug: string;
        payload_json: string;
      }>;

    expect(events).toHaveLength(3);
    for (const ev of events) {
      expect(ev.migration).toBe("M-INBOX-1");
      expect(ev.event).toBe("legacy_review_dismissed");
      expect(ev.vault_slug).toBe(VAULT_SLUG);
      const payload = JSON.parse(ev.payload_json);
      expect(typeof payload.task_id).toBe("string");
      expect(payload.task_id.startsWith("legacy_")).toBe(true);
      expect(typeof payload.title).toBe("string");
      expect(payload.skill_slug).toBe("daily-vault-review");
      expect(typeof payload.dismissed_at).toBe("string");
    }
  });

  // --- contract checks: exit code routing, error paths ---

  it("exits 2 (usage) for unknown flag via main()", async () => {
    const code = await main(["--bogus"]);
    expect(code).toBe(2);
  });

  it("exits 1 for unknown vault slug via main()", async () => {
    const code = await main(["--vault", "no-such-vault"]);
    expect(code).toBe(1);
    expect(errs.some((e) => e.includes("vault slug not found"))).toBe(true);
  });

  it("main() returns 0 on a successful default dry-run with seeded fixture", async () => {
    seedLegacyReviewTasks(2);
    const code = await main(["--vault", VAULT_SLUG]);
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("2 legacy review tasks"))).toBe(true);
  });

  // --- --all-vaults sub-tests ---

  describe("--all-vaults", () => {
    it("dry-run reports per-vault counts + aggregate, makes no writes", () => {
      // Default fixture vault + 2 extras: 3 vaults total, 2 with legacy rows.
      seedLegacyReviewTasks(2); // VAULT_SLUG → 2 legacy
      seedExtraVault("vault_b", "bravo");
      insertLegacyTaskInto("vault_b", "legacy_b_1");
      insertLegacyTaskInto("vault_b", "legacy_b_2");
      insertLegacyTaskInto("vault_b", "legacy_b_3");
      seedExtraVault("vault_c", "charlie"); // clean — 0 legacy

      const aggregate = runAll(parseArgs(["--all-vaults", "--dry-run"]));
      expect(aggregate.vaults).toBe(3);
      expect(aggregate.totalLegacy).toBe(5); // 2 + 3 + 0
      expect(aggregate.totalDismissed).toBe(0);
      expect(aggregate.failures).toEqual([]);
      expect(aggregate.exitCode).toBe(0);

      // Per-vault headers were printed (alphabetical order).
      expect(logs.some((l) => l.includes("=== bravo ==="))).toBe(true);
      expect(logs.some((l) => l.includes("=== charlie ==="))).toBe(true);
      expect(logs.some((l) => l.includes(`=== ${VAULT_SLUG} ===`))).toBe(true);

      // Aggregate summary line printed.
      expect(
        logs.some(
          (l) =>
            l.includes("total: 5 legacy tasks across 3 vaults") &&
            l.includes("dismissed 0") &&
            l.includes("failed 0"),
        ),
      ).toBe(true);

      // No vault was mutated.
      for (const [vaultId] of [
        [VAULT_ID],
        ["vault_b"],
        ["vault_c"],
      ] as const) {
        const dismissed = getVaultDb(vaultId)
          .prepare("SELECT COUNT(*) as n FROM tasks WHERE state = 'dismissed'")
          .get() as { n: number };
        expect(dismissed.n).toBe(0);
      }
    });

    it("--apply --i-mean-it dismisses across every vault; aggregate summary correct", () => {
      seedLegacyReviewTasks(2);
      seedExtraVault("vault_b", "bravo");
      insertLegacyTaskInto("vault_b", "legacy_b_1");
      insertLegacyTaskInto("vault_b", "legacy_b_2");
      insertLegacyTaskInto("vault_b", "legacy_b_3");
      seedExtraVault("vault_c", "charlie"); // 0 legacy

      const aggregate = runAll(
        parseArgs(["--all-vaults", "--apply", "--i-mean-it"]),
      );
      expect(aggregate.vaults).toBe(3);
      expect(aggregate.totalLegacy).toBe(5);
      expect(aggregate.totalDismissed).toBe(5);
      expect(aggregate.failures).toEqual([]);
      expect(aggregate.exitCode).toBe(0);

      const dismissedA = getVaultDb(VAULT_ID)
        .prepare("SELECT COUNT(*) as n FROM tasks WHERE state = 'dismissed'")
        .get() as { n: number };
      const dismissedB = getVaultDb("vault_b")
        .prepare("SELECT COUNT(*) as n FROM tasks WHERE state = 'dismissed'")
        .get() as { n: number };
      const dismissedC = getVaultDb("vault_c")
        .prepare("SELECT COUNT(*) as n FROM tasks WHERE state = 'dismissed'")
        .get() as { n: number };
      expect(dismissedA.n).toBe(2);
      expect(dismissedB.n).toBe(3);
      expect(dismissedC.n).toBe(0);

      expect(
        logs.some(
          (l) =>
            l.includes("total: 5 legacy tasks across 3 vaults") &&
            l.includes("dismissed 5"),
        ),
      ).toBe(true);
    });

    it("per-vault failure is isolated; other vaults still complete", () => {
      // Three vaults; we will corrupt vault_b after seeding so resolving its
      // per-vault db fails. The other two should still be processed.
      seedLegacyReviewTasks(2); // VAULT_SLUG: 2 legacy
      seedExtraVault("vault_b", "bravo");
      insertLegacyTaskInto("vault_b", "legacy_b_1");
      seedExtraVault("vault_c", "charlie");
      insertLegacyTaskInto("vault_c", "legacy_c_1");

      // Force-close all open per-vault dbs so we can replace the file
      // backing vault_b (slug "bravo") with garbage. better-sqlite3 will
      // throw on the next open attempt (db-per-vault keys path by slug,
      // not by vault id).
      closeAllVaultDbs();
      const bravoPath = join(
        process.env.GROVE_VAULT_STATE_ROOT!,
        "bravo",
        "state.db",
      );
      // Overwrite + remove sidecar wal/shm so the open path is unambiguous.
      writeFileSync(bravoPath, "not a sqlite database\n");
      rmSync(`${bravoPath}-wal`, { force: true });
      rmSync(`${bravoPath}-shm`, { force: true });

      const aggregate = runAll(
        parseArgs(["--all-vaults", "--apply", "--i-mean-it"]),
      );

      expect(aggregate.vaults).toBe(3);
      expect(aggregate.failures).toHaveLength(1);
      expect(aggregate.failures[0]!.vaultSlug).toBe("bravo");
      expect(aggregate.exitCode).toBe(1);

      // Other vaults still applied successfully.
      const dismissedA = getVaultDb(VAULT_ID)
        .prepare("SELECT COUNT(*) as n FROM tasks WHERE state = 'dismissed'")
        .get() as { n: number };
      const dismissedC = getVaultDb("vault_c")
        .prepare("SELECT COUNT(*) as n FROM tasks WHERE state = 'dismissed'")
        .get() as { n: number };
      expect(dismissedA.n).toBe(2);
      expect(dismissedC.n).toBe(1);

      // Aggregate line mentions the failure.
      expect(
        logs.some(
          (l) => l.includes("failed 1") && l.includes("3 vaults"),
        ),
      ).toBe(true);
    });

    it("main() routes --all-vaults through runAll and returns aggregate exitCode", async () => {
      seedLegacyReviewTasks(1);
      seedExtraVault("vault_b", "bravo");
      insertLegacyTaskInto("vault_b", "legacy_b_1");

      const code = await main(["--all-vaults"]);
      expect(code).toBe(0);
      // Two per-vault sections appeared.
      expect(logs.some((l) => l.includes(`=== ${VAULT_SLUG} ===`))).toBe(true);
      expect(logs.some((l) => l.includes("=== bravo ==="))).toBe(true);
      // Aggregate printed.
      expect(
        logs.some((l) => l.includes("total: 2 legacy tasks across 2 vaults")),
      ).toBe(true);
    });
  });
});

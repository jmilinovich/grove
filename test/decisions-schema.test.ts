/**
 * S-INBOX-1 — schema falsifier for `decisions` + `suppressions`.
 *
 * Locks down what the migration creates so future edits to
 * `src/migrations/vault/003_decisions.sql` either preserve the shape or
 * fail loudly:
 *
 *   - both tables exist after running the real migrations
 *   - both indexes on `decisions` exist
 *   - rows insert + read back cleanly matching DecisionRow /
 *     SuppressionRow snake_case shapes
 *   - CHECK constraints reject bad `type` and bad `status` values
 *   - UNIQUE(suggestion_type, entity_key) on suppressions is enforced
 *
 * Migration runner discovery is filename-lexical (see
 * `runVaultMigrations` in src/db-per-vault.ts), so copying real
 * 001/002/003 into a temp dir and pointing GROVE_VAULT_MIGRATIONS_DIR
 * at it exercises the same code path prod will run.
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-decisions-schema-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");
process.env.GROVE_DISABLE_TASK_WORKER = "1";

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import type { DecisionRow, SuppressionRow } from "../src/db-types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_MIGRATIONS_DIR = join(HERE, "..", "src", "migrations", "vault");

const MIGRATIONS = [
  "001_init_vault_state.sql",
  "002_v2_tasks.sql",
  "003_decisions.sql",
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

const VAULT_ID = "vault_decisions_test";
const VAULT_SLUG = "decisions-test";

function seedControl(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run("user_decisions", "decisions-tester", "decisions@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(
    VAULT_ID,
    "user_decisions",
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
  // Force the per-vault state.db to initialize so migrations run.
  getVaultDb(VAULT_ID);
}

describe("S-INBOX-1 — decisions + suppressions schema", () => {
  beforeEach(() => {
    freshTestState();
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
  });

  it("creates both tables after running 003_decisions.sql", () => {
    const db = getVaultDb(VAULT_ID);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('decisions', 'suppressions')
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(["decisions", "suppressions"]);
  });

  it("creates both indexes on the decisions table", () => {
    const db = getVaultDb(VAULT_ID);
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index'
           AND tbl_name = 'decisions'
           AND name LIKE 'idx_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(idx.map((r) => r.name)).toEqual([
      "idx_decisions_status",
      "idx_decisions_task",
    ]);
  });

  it("inserts and reads back a realistic decisions row matching DecisionRow", () => {
    const db = getVaultDb(VAULT_ID);
    const payload = {
      source_path: "Journal/2026-05-20.md",
      surface_form: "Anna",
      candidates: [
        { note_path: "Resources/People/Anna Chen.md", signals: ["designer"] },
        { note_path: "Resources/People/Anna Kim.md", signals: ["PM"] },
      ],
    };
    const options = [
      { id: "opt-1", label: "Link to Anna Chen", source: "schema" },
      { id: "opt-2", label: "Link to Anna Kim", source: "schema" },
      { id: "opt-3", label: "Keep ambiguous", source: "schema" },
    ];
    const affected = ["Journal/2026-05-20.md"];

    db.prepare(
      `INSERT INTO decisions
         (id, type, skill_run_id, task_id, created_at, status,
          payload_json, options_json, chosen_option_id,
          affected_paths_json, compensated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "D-2026-05-20-001",
      "disambiguation",
      "SR-2026-05-20-abc",
      "task_xyz",
      "2026-05-20T14:33:12Z",
      "provisional",
      JSON.stringify(payload),
      JSON.stringify(options),
      "opt-1",
      JSON.stringify(affected),
      null,
    );

    const row = db
      .prepare("SELECT * FROM decisions WHERE id = ?")
      .get("D-2026-05-20-001") as DecisionRow;

    expect(row.id).toBe("D-2026-05-20-001");
    expect(row.type).toBe("disambiguation");
    expect(row.skill_run_id).toBe("SR-2026-05-20-abc");
    expect(row.task_id).toBe("task_xyz");
    expect(row.created_at).toBe("2026-05-20T14:33:12Z");
    expect(row.status).toBe("provisional");
    expect(row.chosen_option_id).toBe("opt-1");
    expect(row.compensated_by).toBeNull();
    expect(JSON.parse(row.payload_json)).toEqual(payload);
    expect(JSON.parse(row.options_json)).toEqual(options);
    expect(JSON.parse(row.affected_paths_json)).toEqual(affected);
  });

  it("defaults status to 'provisional' when not specified", () => {
    const db = getVaultDb(VAULT_ID);
    db.prepare(
      `INSERT INTO decisions
         (id, type, skill_run_id, created_at,
          payload_json, options_json, chosen_option_id, affected_paths_json)
       VALUES (?, 'link', 'SR-x', '2026-05-20T15:00:00Z', '{}', '[]', 'opt-1', '[]')`,
    ).run("D-default-status");
    const row = db
      .prepare("SELECT status FROM decisions WHERE id = ?")
      .get("D-default-status") as { status: string };
    expect(row.status).toBe("provisional");
  });

  it("inserts and reads back a suppressions row matching SuppressionRow", () => {
    const db = getVaultDb(VAULT_ID);
    db.prepare(
      `INSERT INTO suppressions
         (id, suggestion_type, entity_key, suppressed_at, until)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "S-2026-05-20-001",
      "link",
      "Resources/People/Anna Chen.md",
      "2026-05-20T15:00:00Z",
      "2026-06-03T15:00:00Z",
    );

    const row = db
      .prepare("SELECT * FROM suppressions WHERE id = ?")
      .get("S-2026-05-20-001") as SuppressionRow;

    expect(row.id).toBe("S-2026-05-20-001");
    expect(row.suggestion_type).toBe("link");
    expect(row.entity_key).toBe("Resources/People/Anna Chen.md");
    expect(row.suppressed_at).toBe("2026-05-20T15:00:00Z");
    expect(row.until).toBe("2026-06-03T15:00:00Z");
  });

  it("rejects an unknown decisions.type via CHECK constraint", () => {
    const db = getVaultDb(VAULT_ID);
    expect(() =>
      db
        .prepare(
          `INSERT INTO decisions
             (id, type, skill_run_id, created_at, status,
              payload_json, options_json, chosen_option_id, affected_paths_json)
           VALUES (?, 'nonsense', 'SR-x', '2026-05-20T15:00:00Z', 'provisional',
                   '{}', '[]', 'opt-1', '[]')`,
        )
        .run("D-bad-type"),
    ).toThrow(/CHECK constraint failed/);
  });

  it("rejects an unknown decisions.status via CHECK constraint", () => {
    const db = getVaultDb(VAULT_ID);
    expect(() =>
      db
        .prepare(
          `INSERT INTO decisions
             (id, type, skill_run_id, created_at, status,
              payload_json, options_json, chosen_option_id, affected_paths_json)
           VALUES (?, 'link', 'SR-x', '2026-05-20T15:00:00Z', 'invalid',
                   '{}', '[]', 'opt-1', '[]')`,
        )
        .run("D-bad-status"),
    ).toThrow(/CHECK constraint failed/);
  });

  it("rejects duplicate (suggestion_type, entity_key) pairs in suppressions", () => {
    const db = getVaultDb(VAULT_ID);
    const insert = db.prepare(
      `INSERT INTO suppressions
         (id, suggestion_type, entity_key, suppressed_at, until)
       VALUES (?, 'link', 'Resources/People/Anna Chen.md', '2026-05-20T15:00:00Z',
               '2026-06-03T15:00:00Z')`,
    );
    insert.run("S-first");
    expect(() => insert.run("S-second")).toThrow(/UNIQUE constraint failed/);
  });
});

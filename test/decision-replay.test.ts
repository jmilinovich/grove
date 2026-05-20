/**
 * S-INBOX-4 — falsifier for the projection rebuilder.
 *
 * Covers the contract in src/decision-writer.ts#replayDecisionsFromLog:
 *
 *   1. Round-trip — seed `.grove/decisions.jsonl` with 3 events of
 *      different types, wipe the `decisions` table, replay, assert
 *      `count = 3` and rows match (id, type, status, payload).
 *
 *   2. Idempotent re-run — replay twice in a row, assert count stays
 *      3 (INSERT OR REPLACE doesn't duplicate).
 *
 *   3. Skip malformed — a `{not json` line between two valid entries
 *      yields restored=2, skipped=1, table has 2 rows. One bad write
 *      must not break every future projection-rebuild.
 *
 *   4. Missing file — no `.grove/decisions.jsonl` at all yields
 *      `{ restored: 0, skipped: 0 }` (no throw).
 *
 * Fixture pattern mirrors test/decision-writer.test.ts — real
 * migrations copied into a temp dir, control DB seeded with a single
 * vault row, per-vault state.db initialized via getVaultDb.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-decision-replay-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");
process.env.GROVE_DISABLE_TASK_WORKER = "1";

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import type { DecisionRow } from "../src/db-types.js";
import type { Decision } from "../src/v2-decisions.js";
import {
  decisionsLogPath,
  ensureDecisionsLogDir,
  appendDecisionEvent,
} from "../src/decisions-log.js";
import {
  recordDecision,
  replayDecisionsFromLog,
} from "../src/decision-writer.js";

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

const VAULT_ID = "vault_decision_replay";
const VAULT_SLUG = "decision-replay-test";

function vaultRepoPath(): string {
  return join(TEST_DIR, "repos", VAULT_SLUG);
}

function seedControl(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run("user_dr", "dr-tester", "dr@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(VAULT_ID, "user_dr", VAULT_SLUG, VAULT_SLUG, vaultRepoPath());
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
  rmSync(vaultRepoPath(), { recursive: true, force: true });
  mkdirSync(vaultRepoPath(), { recursive: true });
  copyRealMigrations();
  createSchema();
  seedControl();
  // Force the per-vault state.db to initialize so migrations run.
  getVaultDb(VAULT_ID);
}

function disambiguation(id: string): Decision {
  return {
    id,
    type: "disambiguation",
    skillRunId: "SR-2026-05-20-abc",
    taskId: "task_xyz",
    createdAt: "2026-05-20T14:33:12Z",
    status: "provisional",
    payload: {
      source_path: "Journal/2026-05-20.md",
      surface_form: "Anna",
      candidates: [
        { note_path: "Resources/People/Anna Chen.md", signals: ["designer"] },
        { note_path: "Resources/People/Anna Kim.md", signals: ["PM"] },
      ],
    },
    options: [
      { id: "opt-1", label: "Link to Anna Chen", source: "schema" },
      { id: "opt-2", label: "Link to Anna Kim", source: "schema" },
      { id: "opt-3", label: "Keep ambiguous", source: "schema" },
    ],
    chosenOptionId: "opt-1",
    affectedPaths: ["Journal/2026-05-20.md"],
    compensatedBy: null,
  };
}

function linkDecision(id: string): Decision {
  return {
    id,
    type: "link",
    skillRunId: "SR-2026-05-20-abc",
    taskId: null,
    createdAt: "2026-05-20T14:35:00Z",
    status: "confirmed",
    payload: {
      source_path: "Journal/2026-05-20.md",
      surface_form: "Voyage",
      target_path: "Resources/Companies/Voyage AI.md",
      candidates: [{ note_path: "Resources/Companies/Voyage AI.md" }],
    },
    options: [
      { id: "opt-1", label: "Link to Voyage AI", source: "schema" },
      { id: "opt-2", label: "Do not link", source: "schema" },
    ],
    chosenOptionId: "opt-1",
    affectedPaths: ["Journal/2026-05-20.md"],
    compensatedBy: null,
  };
}

function enrichment(id: string): Decision {
  return {
    id,
    type: "enrichment",
    skillRunId: "SR-2026-05-20-def",
    taskId: "task_enr",
    createdAt: "2026-05-20T14:40:00Z",
    status: "provisional",
    payload: {
      target_path: "Resources/People/Anna Chen.md",
      prior_content: "---\ntype: person\n---\n\nAnna Chen.\n",
      new_content:
        "---\ntype: person\n---\n\nAnna Chen — designer at Canva.\n",
    },
    options: [
      { id: "opt-1", label: "Apply enrichment", source: "schema" },
      { id: "opt-2", label: "Reject", source: "schema" },
    ],
    chosenOptionId: "opt-1",
    affectedPaths: ["Resources/People/Anna Chen.md"],
    compensatedBy: null,
  };
}

function rowsByIdAsc(): DecisionRow[] {
  return getVaultDb(VAULT_ID)
    .prepare("SELECT * FROM decisions ORDER BY id ASC")
    .all() as DecisionRow[];
}

describe("S-INBOX-4 — replayDecisionsFromLog", () => {
  beforeEach(() => {
    freshTestState();
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
  });

  it("round-trip: 3 events written → table wiped → replay restores all 3", () => {
    const d1 = disambiguation("D-2026-05-20-A");
    const d2 = linkDecision("D-2026-05-20-B");
    const d3 = enrichment("D-2026-05-20-C");

    // Use the production write path so JSONL and state.db both reflect
    // the seed, then wipe state.db to simulate corruption/loss.
    recordDecision(vaultRepoPath(), VAULT_ID, d1);
    recordDecision(vaultRepoPath(), VAULT_ID, d2);
    recordDecision(vaultRepoPath(), VAULT_ID, d3);

    getVaultDb(VAULT_ID).prepare("DELETE FROM decisions").run();
    expect(rowsByIdAsc()).toHaveLength(0);

    const result = replayDecisionsFromLog(vaultRepoPath(), VAULT_ID);
    expect(result).toEqual({ restored: 3, skipped: 0 });

    const rows = rowsByIdAsc();
    expect(rows).toHaveLength(3);

    const sources = [d1, d2, d3].sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < 3; i++) {
      const row = rows[i]!;
      const src = sources[i]!;
      expect(row.id).toBe(src.id);
      expect(row.type).toBe(src.type);
      expect(row.status).toBe(src.status);
      expect(row.skill_run_id).toBe(src.skillRunId);
      expect(row.task_id).toBe(src.taskId);
      expect(row.created_at).toBe(src.createdAt);
      expect(row.chosen_option_id).toBe(src.chosenOptionId);
      expect(JSON.parse(row.payload_json)).toEqual(src.payload);
      expect(JSON.parse(row.options_json)).toEqual(src.options);
      expect(JSON.parse(row.affected_paths_json)).toEqual(src.affectedPaths);
    }
  });

  it("idempotent re-run: replay twice in a row keeps count at 3 (no duplicates)", () => {
    const d1 = disambiguation("D-2026-05-20-D");
    const d2 = linkDecision("D-2026-05-20-E");
    const d3 = enrichment("D-2026-05-20-F");

    recordDecision(vaultRepoPath(), VAULT_ID, d1);
    recordDecision(vaultRepoPath(), VAULT_ID, d2);
    recordDecision(vaultRepoPath(), VAULT_ID, d3);

    getVaultDb(VAULT_ID).prepare("DELETE FROM decisions").run();

    const first = replayDecisionsFromLog(vaultRepoPath(), VAULT_ID);
    expect(first).toEqual({ restored: 3, skipped: 0 });
    expect(rowsByIdAsc()).toHaveLength(3);

    // Second replay — no wipe between runs. INSERT OR REPLACE should
    // overwrite each row in place rather than duplicate.
    const second = replayDecisionsFromLog(vaultRepoPath(), VAULT_ID);
    expect(second).toEqual({ restored: 3, skipped: 0 });
    expect(rowsByIdAsc()).toHaveLength(3);
  });

  it("skips malformed lines: bad JSON between two valid entries yields restored=2, skipped=1", () => {
    const d1 = disambiguation("D-2026-05-20-G");
    const d2 = linkDecision("D-2026-05-20-H");

    // Write the JSONL by hand so we can interleave a corrupted line.
    ensureDecisionsLogDir(vaultRepoPath());
    const path = decisionsLogPath(vaultRepoPath());
    appendFileSync(path, `${JSON.stringify(d1)}\n`, { encoding: "utf8" });
    appendFileSync(path, `{not json\n`, { encoding: "utf8" });
    appendFileSync(path, `${JSON.stringify(d2)}\n`, { encoding: "utf8" });

    // Suppress the expected console.warn from the corrupted-line path —
    // it's part of the contract, not a test failure.
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const result = replayDecisionsFromLog(vaultRepoPath(), VAULT_ID);
      expect(result).toEqual({ restored: 2, skipped: 1 });
    } finally {
      console.warn = originalWarn;
    }

    const rows = rowsByIdAsc();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual([d1.id, d2.id].sort());
  });

  it("missing file: no .grove/decisions.jsonl returns { restored: 0, skipped: 0 } (no throw)", () => {
    // Sanity: don't create the log file at all.
    const result = replayDecisionsFromLog(vaultRepoPath(), VAULT_ID);
    expect(result).toEqual({ restored: 0, skipped: 0 });
    expect(rowsByIdAsc()).toHaveLength(0);
  });
});

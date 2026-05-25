/**
 * S-INBOX-3 — falsifier for the atomic decision writer + commit-trailer
 * wiring.
 *
 * Covers the contract in src/decision-writer.ts and the
 * `decisionIds` extension to gitCommit/gitCommitPaths in src/vault-ops.ts:
 *
 *   1. `recordDecision` inserts one row in `decisions` AND appends one
 *      line in `.grove/decisions.jsonl`, both matching the input.
 *
 *   2. `commitSkillRun` with 2 decisionIds produces a commit whose
 *      message carries two `Decision-Id:` trailer lines after the
 *      provenance trailers in the incoming message.
 *
 *   3. `commitSkillRun` throws fast when decisionIds is non-empty but
 *      paths is missing `.grove/decisions.jsonl` (the caller can't
 *      commit decisions without their log entries).
 *
 *   4. `commitSkillRun` with an empty decisionIds list preserves the
 *      existing `gitCommitPaths` behavior — no Decision-Id trailer in
 *      the resulting commit message.
 *
 * Fixture pattern mirrors test/decisions-schema.test.ts (real migrations
 * copied into a temp dir) plus test/vault-ops.test.ts (a `git init`'d
 * vault working tree for the commit tests). The two halves share one
 * temp dir per test so a single recordDecision -> commitSkillRun flow
 * exercises the projection, the log, and the trailer composition.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-decision-writer-"));
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
  readDecisionEvents,
} from "../src/decisions-log.js";
import {
  recordDecision,
  commitSkillRun,
} from "../src/decision-writer.js";
import { exec } from "../src/vault-ops.js";
import {
  composeCommitMessage,
  provenanceToTrailers,
  parseTrailers,
} from "../src/provenance.js";

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

const VAULT_ID = "vault_decision_writer";
const VAULT_SLUG = "decision-writer-test";

function vaultRepoPath(): string {
  return join(TEST_DIR, "repos", VAULT_SLUG);
}

function seedControl(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run("user_dw", "dw-tester", "dw@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(VAULT_ID, "user_dw", VAULT_SLUG, VAULT_SLUG, vaultRepoPath());
}

async function initGitVault(): Promise<void> {
  const vp = vaultRepoPath();
  mkdirSync(vp, { recursive: true });
  await exec("git", ["init", "-b", "main"], vp);
  await exec("git", ["config", "user.email", "dw@test"], vp);
  await exec("git", ["config", "user.name", "dw"], vp);
  // Seed an initial commit so HEAD exists.
  writeFileSync(join(vp, ".gitkeep"), "");
  await exec("git", ["add", "-A"], vp);
  await exec("git", ["commit", "-m", "init"], vp);
}

async function freshTestState(): Promise<void> {
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
  copyRealMigrations();
  createSchema();
  seedControl();
  // Force the per-vault state.db to initialize so migrations run.
  getVaultDb(VAULT_ID);
  await initGitVault();
}

function disambiguation(id = "D-2026-05-20-001"): Decision {
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

function linkDecision(id = "D-2026-05-20-002"): Decision {
  return {
    id,
    type: "link",
    skillRunId: "SR-2026-05-20-abc",
    taskId: null,
    createdAt: "2026-05-20T14:35:00Z",
    status: "provisional",
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

describe("S-INBOX-3 — decision-writer", () => {
  beforeEach(async () => {
    await freshTestState();
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
  });

  it("recordDecision inserts a row in `decisions` AND appends one JSONL line", () => {
    const decision = disambiguation();
    recordDecision(vaultRepoPath(), VAULT_ID, decision);

    // (a) state.db projection
    const db = getVaultDb(VAULT_ID);
    const rows = db
      .prepare("SELECT * FROM decisions")
      .all() as DecisionRow[];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(decision.id);
    expect(row.type).toBe(decision.type);
    expect(row.skill_run_id).toBe(decision.skillRunId);
    expect(row.task_id).toBe(decision.taskId);
    expect(row.created_at).toBe(decision.createdAt);
    expect(row.status).toBe(decision.status);
    expect(row.chosen_option_id).toBe(decision.chosenOptionId);
    expect(row.compensated_by).toBeNull();
    expect(JSON.parse(row.payload_json)).toEqual(decision.payload);
    expect(JSON.parse(row.options_json)).toEqual(decision.options);
    expect(JSON.parse(row.affected_paths_json)).toEqual(decision.affectedPaths);

    // (b) JSONL log
    const events = readDecisionEvents(vaultRepoPath());
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(decision);
    expect(existsSync(decisionsLogPath(vaultRepoPath()))).toBe(true);
  });

  it("commitSkillRun produces a commit with one Decision-Id trailer per id", async () => {
    const d1 = disambiguation("D-2026-05-20-A");
    const d2 = linkDecision("D-2026-05-20-B");
    const vp = vaultRepoPath();

    recordDecision(vp, VAULT_ID, d1);
    recordDecision(vp, VAULT_ID, d2);

    // Skill also wrote a note — create the file so git can add it.
    const notePath = "Resources/People/Anna Chen.md";
    const absNote = join(vp, notePath);
    mkdirSync(dirname(absNote), { recursive: true });
    writeFileSync(absNote, "---\ntype: person\n---\n\nAnna Chen.\n");

    const subject = "grove (test): record 2 decisions";
    const message = composeCommitMessage(
      subject,
      provenanceToTrailers({
        voice: "perishable",
        by: "claude-opus-4-7",
        written_at: "2026-05-20T14:35:00Z",
        reason: "S-INBOX-3 falsifier",
      }),
    );

    const sha = await commitSkillRun(
      vp,
      [".grove/decisions.jsonl", notePath],
      message,
      [d1.id, d2.id],
    );
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const fullMsg = (await exec(
      "git",
      ["log", "-1", "--format=%B", sha],
      vp,
    )).trim();

    // Subject line preserved.
    expect(fullMsg.split("\n")[0]).toBe(subject);

    // Both Decision-Id trailers present, in order, after provenance trailers.
    const trailers = parseTrailers(fullMsg);
    expect(trailers["Decision-Id"]).toEqual([d1.id, d2.id]);
    // Provenance trailers still parse cleanly.
    expect(trailers["Provenance-Voice"]).toEqual(["perishable"]);
    expect(trailers["Provenance-By"]).toEqual(["claude-opus-4-7"]);

    // The commit recorded both the note and the JSONL on disk.
    const tree = (await exec(
      "git",
      ["show", "--name-only", "--format=", sha],
      vp,
    ))
      .trim()
      .split("\n")
      .sort();
    expect(tree).toContain(notePath);
    expect(tree).toContain(".grove/decisions.jsonl");
  });

  it("commitSkillRun throws when decisionIds is non-empty but paths omits .grove/decisions.jsonl", async () => {
    const d1 = disambiguation("D-2026-05-20-C");
    recordDecision(vaultRepoPath(), VAULT_ID, d1);

    // Skill claims decisions were recorded but forgot to include the log
    // file in `paths` — must be rejected before git is touched.
    await expect(
      commitSkillRun(
        vaultRepoPath(),
        ["only-a-note.md"],
        "msg",
        [d1.id],
      ),
    ).rejects.toThrow(/\.grove\/decisions\.jsonl/);
  });

  it("commitSkillRun with empty decisionIds preserves existing commit shape (no Decision-Id trailer)", async () => {
    const vp = vaultRepoPath();
    const notePath = "Notes/legacy.md";
    const absNote = join(vp, notePath);
    mkdirSync(dirname(absNote), { recursive: true });
    writeFileSync(absNote, "legacy content\n");

    const subject = "grove (test): legacy write";
    const message = composeCommitMessage(
      subject,
      provenanceToTrailers({
        voice: "durable",
        by: "human",
        written_at: "2026-05-20T14:40:00Z",
      }),
    );

    const sha = await commitSkillRun(vp, [notePath], message, []);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const fullMsg = (await exec(
      "git",
      ["log", "-1", "--format=%B", sha],
      vp,
    )).trim();
    const trailers = parseTrailers(fullMsg);
    expect(trailers["Decision-Id"]).toBeUndefined();
    expect(trailers["Provenance-Voice"]).toEqual(["durable"]);
  });
});

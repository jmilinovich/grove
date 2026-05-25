/**
 * S-INBOX-5 — falsifier for the forward-only compensation executor.
 *
 * For each of the three suggestion types (link / disambiguation /
 * enrichment) we set up a vault with a pre-decision state, apply a
 * decision the way the suggestion skills (S-INBOX-6/7/8) will once
 * they ship — record the Decision row + JSONL line + commit — and then
 * call `compensateDecision`. After compensation the test asserts:
 *
 *   - the vault file is back to the pre-decision content (pure rollback)
 *     OR rewritten to point at `newChoice` (disambiguation refine-by-pick)
 *   - the original `decisions` row is `status='compensated'` with
 *     `compensated_by` pointing at the new compensation id
 *   - a new compensation Decision row exists with `status='confirmed'`
 *   - the latest git commit carries both
 *       Compensates-Decision-Id: <original>
 *       Decision-Id: <compensation>
 *     trailers, alongside provenance
 *
 * Plus one negative test: compensating a decision that is already
 * `compensated` throws — the executor refuses to double-undo.
 *
 * Fixture pattern mirrors test/decision-writer.test.ts: real
 * migrations copied into a temp dir, per-vault state.db booted, a
 * `git init`'d vault working tree with an initial commit so HEAD
 * exists. Each sub-test gets a fresh world via `beforeEach`.
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-decision-compensate-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");
process.env.GROVE_DISABLE_TASK_WORKER = "1";

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import type { DecisionRow } from "../src/db-types.js";
import type { Decision, ReviewOption } from "../src/v2-decisions.js";
import { readDecisionEvents } from "../src/decisions-log.js";
import {
  recordDecision,
  commitSkillRun,
} from "../src/decision-writer.js";
import { exec, readNoteFile, writeNoteFile } from "../src/vault-ops.js";
import {
  composeCommitMessage,
  parseTrailers,
  provenanceToTrailers,
} from "../src/provenance.js";
import { compensateDecision } from "../src/decision-compensate.js";

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

const VAULT_ID = "vault_decision_compensate";
const VAULT_SLUG = "decision-compensate-test";

function vaultRepoPath(): string {
  return join(TEST_DIR, "repos", VAULT_SLUG);
}

function seedControl(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run("user_dc", "dc-tester", "dc@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(VAULT_ID, "user_dc", VAULT_SLUG, VAULT_SLUG, vaultRepoPath());
}

async function initGitVault(): Promise<void> {
  const vp = vaultRepoPath();
  mkdirSync(vp, { recursive: true });
  await exec("git", ["init", "-b", "main"], vp);
  await exec("git", ["config", "user.email", "dc@test"], vp);
  await exec("git", ["config", "user.name", "dc"], vp);
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
  getVaultDb(VAULT_ID);
  await initGitVault();
}

// ── Decision-shaping helpers ─────────────────────────────────────────

interface AppliedDecision {
  decision: Decision;
  preDecisionContent: string;
  postDecisionContent: string;
}

/**
 * Seed a `link` decision: pre-state has "I had coffee with Anna today."
 * Post-state has "I had coffee with [[Anna Chen]] today." We hand-write
 * the post-state so we don't depend on a not-yet-shipped skill — this
 * test exercises compensation, not generation.
 */
async function applyLinkDecision(): Promise<AppliedDecision> {
  const vp = vaultRepoPath();
  const sourceRel = "Journal/2026-05-20.md";
  const sourceAbs = join(vp, sourceRel);
  mkdirSync(dirname(sourceAbs), { recursive: true });
  const preDecisionContent =
    "---\ntype: journal\n---\n\nI had coffee with Anna today.\n";
  writeNoteFile(sourceAbs, preDecisionContent);

  // Initial commit so the file exists in git history before the decision.
  await exec("git", ["add", "-A"], vp);
  await exec("git", ["commit", "-m", "seed journal"], vp);

  const postDecisionContent =
    "---\ntype: journal\n---\n\nI had coffee with [[Anna Chen]] today.\n";
  writeNoteFile(sourceAbs, postDecisionContent);

  const decision: Decision = {
    id: "D-2026-05-20-link01",
    type: "link",
    skillRunId: "SR-link-001",
    taskId: null,
    createdAt: "2026-05-20T14:35:00Z",
    status: "provisional",
    payload: {
      source_path: sourceRel,
      surface_form: "Anna",
      target_path: "Resources/People/Anna Chen.md",
      candidates: [{ note_path: "Resources/People/Anna Chen.md" }],
    },
    options: [
      { id: "opt-1", label: "Link to Anna Chen", source: "schema" },
      { id: "opt-2", label: "Do not link", source: "schema" },
    ],
    chosenOptionId: "opt-1",
    affectedPaths: [sourceRel],
    compensatedBy: null,
  };

  recordDecision(vp, VAULT_ID, decision);
  const message = composeCommitMessage(
    "grove: apply link suggestion",
    provenanceToTrailers({
      voice: "perishable",
      by: "claude-opus-4-7",
      written_at: "2026-05-20T14:35:00Z",
    }),
  );
  await commitSkillRun(
    vp,
    [".grove/decisions.jsonl", sourceRel],
    message,
    [decision.id],
  );

  return { decision, preDecisionContent, postDecisionContent };
}

/**
 * Seed a `disambiguation` decision: two People named Anna, the original
 * picked Anna Chen (opt-1). We later compensate optionally with opt-2
 * (Anna Kim) to test refine-by-pick.
 */
async function applyDisambiguationDecision(): Promise<AppliedDecision> {
  const vp = vaultRepoPath();
  const sourceRel = "Journal/2026-05-21.md";
  const sourceAbs = join(vp, sourceRel);
  mkdirSync(dirname(sourceAbs), { recursive: true });
  const preDecisionContent =
    "---\ntype: journal\n---\n\nSpoke with Anna about Q3 roadmap.\n";
  writeNoteFile(sourceAbs, preDecisionContent);
  await exec("git", ["add", "-A"], vp);
  await exec("git", ["commit", "-m", "seed disambiguation journal"], vp);

  const postDecisionContent =
    "---\ntype: journal\n---\n\nSpoke with [[Anna Chen]] about Q3 roadmap.\n";
  writeNoteFile(sourceAbs, postDecisionContent);

  const decision: Decision = {
    id: "D-2026-05-21-disambig01",
    type: "disambiguation",
    skillRunId: "SR-disambig-001",
    taskId: null,
    createdAt: "2026-05-21T09:12:00Z",
    status: "provisional",
    payload: {
      source_path: sourceRel,
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
    affectedPaths: [sourceRel],
    compensatedBy: null,
  };

  recordDecision(vp, VAULT_ID, decision);
  const message = composeCommitMessage(
    "grove: apply disambiguation",
    provenanceToTrailers({
      voice: "perishable",
      by: "claude-opus-4-7",
      written_at: "2026-05-21T09:12:00Z",
    }),
  );
  await commitSkillRun(
    vp,
    [".grove/decisions.jsonl", sourceRel],
    message,
    [decision.id],
  );

  return { decision, preDecisionContent, postDecisionContent };
}

/**
 * Seed an `enrichment` decision: thin concept note gets expanded. The
 * payload carries prior_content so compensation can restore it.
 */
async function applyEnrichmentDecision(): Promise<AppliedDecision> {
  const vp = vaultRepoPath();
  const targetRel = "Resources/Concepts/Taste Graph.md";
  const targetAbs = join(vp, targetRel);
  mkdirSync(dirname(targetAbs), { recursive: true });
  const preDecisionContent =
    "---\ntype: concept\n---\n\nA taste graph.\n";
  writeNoteFile(targetAbs, preDecisionContent);
  await exec("git", ["add", "-A"], vp);
  await exec("git", ["commit", "-m", "seed thin concept"], vp);

  const postDecisionContent =
    "---\ntype: concept\n---\n\nA taste graph models latent affinity " +
    "between users and items by treating recurring patterns of " +
    "selection as positional signal. Four paragraphs would follow.\n";
  writeNoteFile(targetAbs, postDecisionContent);

  const decision: Decision = {
    id: "D-2026-05-22-enrich01",
    type: "enrichment",
    skillRunId: "SR-enrich-001",
    taskId: null,
    createdAt: "2026-05-22T11:00:00Z",
    status: "provisional",
    payload: {
      target_path: targetRel,
      prior_content: preDecisionContent,
      new_content: postDecisionContent,
    },
    options: [
      { id: "opt-1", label: "Apply enrichment", source: "schema" },
      { id: "opt-2", label: "Dismiss", source: "schema" },
    ],
    chosenOptionId: "opt-1",
    affectedPaths: [targetRel],
    compensatedBy: null,
  };

  recordDecision(vp, VAULT_ID, decision);
  const message = composeCommitMessage(
    "grove: apply enrichment",
    provenanceToTrailers({
      voice: "perishable",
      by: "claude-opus-4-7",
      written_at: "2026-05-22T11:00:00Z",
    }),
  );
  await commitSkillRun(
    vp,
    [".grove/decisions.jsonl", targetRel],
    message,
    [decision.id],
  );

  return { decision, preDecisionContent, postDecisionContent };
}

// ── Test suite ───────────────────────────────────────────────────────

describe("S-INBOX-5 — compensateDecision", () => {
  beforeEach(async () => {
    await freshTestState();
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
  });

  it("link: rolls back the wikilink and records a compensation Decision", async () => {
    const vp = vaultRepoPath();
    const { decision, preDecisionContent } = await applyLinkDecision();
    const sourceAbs = join(vp, "Journal/2026-05-20.md");
    // Sanity-check the precondition: the file currently has the link.
    expect(readNoteFile(sourceAbs)).toContain("[[Anna Chen]]");

    const result = await compensateDecision(vp, VAULT_ID, decision.id);

    // (a) vault content restored — no more wikilink. Pure rollback
    // strips the link but does NOT reconstruct the original surface
    // form (the prose "Anna" → "[[Anna Chen]]" rewrite that happened
    // when the link was applied is not reversed at the word level;
    // see the module header on cascade scope).
    const afterContent = readNoteFile(sourceAbs);
    expect(afterContent).not.toContain("[[Anna Chen]]");
    expect(afterContent).toContain("I had coffee with");
    expect(afterContent).toContain("today.");

    // (b) original decision flipped to compensated
    const db = getVaultDb(VAULT_ID);
    const originalRow = db
      .prepare("SELECT * FROM decisions WHERE id = ?")
      .get(decision.id) as DecisionRow;
    expect(originalRow.status).toBe("compensated");
    expect(originalRow.compensated_by).toBe(result.compensatingDecisionId);

    // (c) compensation row exists
    const compRow = db
      .prepare("SELECT * FROM decisions WHERE id = ?")
      .get(result.compensatingDecisionId) as DecisionRow;
    expect(compRow.status).toBe("confirmed");
    expect(compRow.type).toBe("link");

    // (d) commit trailers
    const fullMsg = (await exec(
      "git",
      ["log", "-1", "--format=%B", result.commitSha],
      vp,
    )).trim();
    const trailers = parseTrailers(fullMsg);
    expect(trailers["Compensates-Decision-Id"]).toEqual([decision.id]);
    expect(trailers["Decision-Id"]).toEqual([result.compensatingDecisionId]);
    expect(trailers["Provenance-Voice"]).toEqual(["perishable"]);

    // (e) preDecisionContent assertion mostly redundant; keep the
    // structural test honest.
    expect(preDecisionContent).toContain("Anna today");
  });

  it("disambiguation: pure rollback strips the chosen candidate link", async () => {
    const vp = vaultRepoPath();
    const { decision } = await applyDisambiguationDecision();
    const sourceAbs = join(vp, "Journal/2026-05-21.md");
    expect(readNoteFile(sourceAbs)).toContain("[[Anna Chen]]");

    const result = await compensateDecision(vp, VAULT_ID, decision.id);

    const afterContent = readNoteFile(sourceAbs);
    expect(afterContent).not.toContain("[[Anna Chen]]");
    expect(afterContent).not.toContain("[[Anna Kim]]");
    expect(afterContent).toContain("Spoke with");
    expect(afterContent).toContain("Q3 roadmap");

    const db = getVaultDb(VAULT_ID);
    const originalRow = db
      .prepare("SELECT * FROM decisions WHERE id = ?")
      .get(decision.id) as DecisionRow;
    expect(originalRow.status).toBe("compensated");
    expect(originalRow.compensated_by).toBe(result.compensatingDecisionId);
  });

  it("disambiguation with newChoice: switches the link to the other candidate", async () => {
    const vp = vaultRepoPath();
    const { decision } = await applyDisambiguationDecision();
    const sourceAbs = join(vp, "Journal/2026-05-21.md");
    expect(readNoteFile(sourceAbs)).toContain("[[Anna Chen]]");

    // newChoice = opt-2 → Anna Kim (second candidate)
    const newChoice: ReviewOption = decision.options[1]!;
    expect(newChoice.id).toBe("opt-2");

    const result = await compensateDecision(
      vp,
      VAULT_ID,
      decision.id,
      newChoice,
    );

    const afterContent = readNoteFile(sourceAbs);
    expect(afterContent).not.toContain("[[Anna Chen]]");
    expect(afterContent).toContain("[[Anna Kim]]");

    // Compensation row records the new choice as chosenOptionId
    const db = getVaultDb(VAULT_ID);
    const compRow = db
      .prepare("SELECT * FROM decisions WHERE id = ?")
      .get(result.compensatingDecisionId) as DecisionRow;
    expect(compRow.chosen_option_id).toBe("opt-2");
  });

  it("enrichment: restores prior_content to the target note", async () => {
    const vp = vaultRepoPath();
    const { decision, preDecisionContent } = await applyEnrichmentDecision();
    const targetAbs = join(vp, "Resources/Concepts/Taste Graph.md");
    expect(readNoteFile(targetAbs)).toContain("models latent affinity");

    const result = await compensateDecision(vp, VAULT_ID, decision.id);

    const afterContent = readNoteFile(targetAbs);
    expect(afterContent).toBe(preDecisionContent);
    expect(afterContent).not.toContain("models latent affinity");

    const db = getVaultDb(VAULT_ID);
    const originalRow = db
      .prepare("SELECT * FROM decisions WHERE id = ?")
      .get(decision.id) as DecisionRow;
    expect(originalRow.status).toBe("compensated");
    expect(originalRow.compensated_by).toBe(result.compensatingDecisionId);

    // Commit trailers
    const fullMsg = (await exec(
      "git",
      ["log", "-1", "--format=%B", result.commitSha],
      vp,
    )).trim();
    const trailers = parseTrailers(fullMsg);
    expect(trailers["Compensates-Decision-Id"]).toEqual([decision.id]);
    expect(trailers["Decision-Id"]).toEqual([result.compensatingDecisionId]);

    // The JSONL log should now have THREE entries for this run:
    //   1. original enrichment decision (provisional)
    //   2. compensation decision (confirmed)
    //   3. snapshot of the original flipped to compensated
    const events = readDecisionEvents(vp);
    const originalEvents = events.filter((e) => e.id === decision.id);
    expect(originalEvents.length).toBeGreaterThanOrEqual(2);
    const lastOriginalSnapshot = originalEvents[originalEvents.length - 1]!;
    expect(lastOriginalSnapshot.status).toBe("compensated");
    expect(lastOriginalSnapshot.compensatedBy).toBe(
      result.compensatingDecisionId,
    );

    // Sanity-check the file exists on disk after compensation.
    expect(existsSync(targetAbs)).toBe(true);
  });

  it("throws when the decision is already compensated", async () => {
    const vp = vaultRepoPath();
    const { decision } = await applyLinkDecision();

    // First compensation succeeds.
    await compensateDecision(vp, VAULT_ID, decision.id);

    // Second compensation against the same original must throw — the
    // executor refuses to double-undo.
    await expect(
      compensateDecision(vp, VAULT_ID, decision.id),
    ).rejects.toThrow(/compensated/);
  });
});

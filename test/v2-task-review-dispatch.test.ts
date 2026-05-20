/**
 * S-INBOX-10 — per-type review dispatch falsifier.
 *
 * Eight sub-tests covering:
 *   1. New shape apply (matching option_id) → decision confirmed,
 *      task done.
 *   2. New shape apply (different option_id) → compensateDecision
 *      called, original compensated, compensation row recorded, task
 *      done.
 *   3. New shape refine → compensateDecision called, refine-handler
 *      task spawned in pending state with body carrying the refinement,
 *      original task done.
 *   4. New shape dismiss → compensateDecision called, suppression row
 *      inserted with (type, entity_key, 14-day TTL), task dismissed.
 *   5. Legacy shape confirm-durable on a task linked to a decision →
 *      dispatched as apply-matching, decision confirmed.
 *   6. Legacy shape mark-stale on a task linked to a decision →
 *      dispatched as dismiss, suppression created.
 *   7. Legacy task (no decision), confirm-durable → task done, no
 *      decision/compensation/suppression touched.
 *   8. Refine-handler scheduler round-trip → spawn refine task via
 *      refine action, invoke drain, refine-handler executes, task →
 *      done with surface artifact mentioning the refinement.
 *
 * Setup mirrors v2-task-review.test.ts: env-pointed control db + per-
 * vault state root with real migration SQL (including 003_decisions),
 * plus a real git repo seeded with an initial commit so compensateDecision
 * can land commits.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-v2-task-review-dispatch-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");
process.env.GROVE_DISABLE_TASK_WORKER = "1";

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import { handleV2TaskReview } from "../src/v2-tasks.js";
import { recordDecision } from "../src/decision-writer.js";
import { drainOnePendingTask } from "../src/scheduler.js";
import { writeNoteFile } from "../src/vault-ops.js";
import type { VaultContext } from "../src/vault-router.js";
import type { Decision } from "../src/v2-decisions.js";
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

const VAULT_ID = "vault_dispatch";
const VAULT_SLUG = "dispatch-test";
const USER_ID = "user_dispatch";

function vaultRepoPath(): string {
  return join(TEST_DIR, "repos", VAULT_SLUG);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initVaultRepo(vaultPath: string): void {
  mkdirSync(vaultPath, { recursive: true });
  git(vaultPath, ["init", "-q", "-b", "main"]);
  git(vaultPath, ["config", "user.email", "dispatch@grove.local"]);
  git(vaultPath, ["config", "user.name", "Grove Dispatch"]);
  git(vaultPath, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(vaultPath, ".gitkeep"), "");
  git(vaultPath, ["add", ".gitkeep"]);
  git(vaultPath, ["commit", "-q", "-m", "init"]);
}

function seedControl(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run(USER_ID, "dispatch-tester", "dispatch@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(VAULT_ID, USER_ID, VAULT_SLUG, VAULT_SLUG, vaultRepoPath());
}

function ctx(): VaultContext {
  return {
    vaultId: VAULT_ID,
    vaultSlug: VAULT_SLUG,
    vaultPath: vaultRepoPath(),
  };
}

interface CapturedResponse {
  status: number;
  body: unknown;
  res: ServerResponse;
}

function makeRes(): CapturedResponse {
  const captured: CapturedResponse = {
    status: 0,
    body: undefined,
    res: {} as ServerResponse,
  };
  const res = {
    writeHead(status: number, _headers?: Record<string, string>) {
      captured.status = status;
      return this;
    },
    end(payload?: string) {
      if (payload !== undefined) {
        try {
          captured.body = JSON.parse(payload);
        } catch {
          captured.body = payload;
        }
      }
      return this;
    },
    setHeader() {
      return this;
    },
  };
  captured.res = res as unknown as ServerResponse;
  return captured;
}

function makeReq(body?: string): IncomingMessage {
  const chunks = body ? [Buffer.from(body)] : [];
  return Readable.from(chunks) as unknown as IncomingMessage;
}

/**
 * Seed a `link` decision plus a corresponding review-state task linked
 * via decision.task_id and task.id. Pre-state: the source file has the
 * applied wikilink (so compensation has something to roll back).
 *
 * Returns { taskId, decision } so each test can drive the dispatcher
 * against a real linked pair.
 */
function seedLinkDecisionWithTask(opts?: {
  taskId?: string;
  decisionId?: string;
}): { taskId: string; decision: Decision } {
  const vp = vaultRepoPath();
  const sourceRel = "Journal/2026-05-20.md";
  const sourceAbs = join(vp, sourceRel);
  mkdirSync(dirname(sourceAbs), { recursive: true });
  // Post-decision content — the link is already applied.
  const postContent =
    "---\ntype: journal\n---\n\nI had coffee with [[Anna Chen]] today.\n";
  writeNoteFile(sourceAbs, postContent);
  // Initial commit so the file is in git history (compensation makes a
  // follow-up commit).
  git(vp, ["add", "-A"]);
  git(vp, ["commit", "-q", "-m", "seed link source"]);

  const decisionId = opts?.decisionId ?? "D-2026-05-20-linktest";
  const taskId = opts?.taskId ?? "t-link-decision";

  const decision: Decision = {
    id: decisionId,
    type: "link",
    skillRunId: "SR-link-dispatch-test",
    taskId,
    createdAt: "2026-05-20T10:00:00Z",
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

  // Bridge the decision to a review-state task (mirroring what
  // bridgeDecisionsToTasks does in production).
  const db = getVaultDb(VAULT_ID);
  db.prepare(
    `INSERT INTO tasks (id, skill_slug, state, title, body, source_note_path,
                        created_at, updated_at)
     VALUES (?, ?, 'review', ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    "links-suggestion",
    `Link suggestion: Anna in ${sourceRel}`,
    "Grove linked to Anna Chen. Confirm or dismiss.",
    sourceRel,
    decision.createdAt,
    decision.createdAt,
  );
  db.prepare(`UPDATE decisions SET task_id = ? WHERE id = ?`).run(
    taskId,
    decisionId,
  );

  return { taskId, decision };
}

/**
 * Seed a `disambiguation` decision + task — two candidates so refine-by-
 * pick (apply with non-matching option_id) has a meaningful alternative.
 */
function seedDisambiguationWithTask(opts?: {
  taskId?: string;
  decisionId?: string;
}): { taskId: string; decision: Decision } {
  const vp = vaultRepoPath();
  const sourceRel = "Journal/2026-05-21.md";
  const sourceAbs = join(vp, sourceRel);
  mkdirSync(dirname(sourceAbs), { recursive: true });
  const postContent =
    "---\ntype: journal\n---\n\nSpoke with [[Anna Chen]] about roadmap.\n";
  writeNoteFile(sourceAbs, postContent);
  git(vp, ["add", "-A"]);
  git(vp, ["commit", "-q", "-m", "seed disambig source"]);

  const decisionId = opts?.decisionId ?? "D-2026-05-21-disambigtest";
  const taskId = opts?.taskId ?? "t-disambig-decision";

  const decision: Decision = {
    id: decisionId,
    type: "disambiguation",
    skillRunId: "SR-disambig-dispatch-test",
    taskId,
    createdAt: "2026-05-21T10:00:00Z",
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
    ],
    chosenOptionId: "opt-1",
    affectedPaths: [sourceRel],
    compensatedBy: null,
  };

  recordDecision(vp, VAULT_ID, decision);

  const db = getVaultDb(VAULT_ID);
  db.prepare(
    `INSERT INTO tasks (id, skill_slug, state, title, body, source_note_path,
                        created_at, updated_at)
     VALUES (?, ?, 'review', ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    "disambiguation",
    `Disambiguate: Anna in ${sourceRel}`,
    "Grove linked to Anna Chen. Confirm or pick a different candidate.",
    sourceRel,
    decision.createdAt,
    decision.createdAt,
  );
  db.prepare(`UPDATE decisions SET task_id = ? WHERE id = ?`).run(
    taskId,
    decisionId,
  );

  return { taskId, decision };
}

describe("handleV2TaskReview — S-INBOX-10 per-type dispatch", () => {
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
    rmSync(vaultRepoPath(), { recursive: true, force: true });

    copyRealMigrations();
    createSchema();
    seedControl();
    // Force per-vault state.db migration up to 003.
    getVaultDb(VAULT_ID);
    initVaultRepo(vaultRepoPath());
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
    rmSync(vaultRepoPath(), { recursive: true, force: true });
  });

  // ── Test 1: new shape, apply matching ───────────────────────────────

  it("new shape apply with matching option_id confirms decision and closes task", async () => {
    const { taskId, decision } = seedLinkDecisionWithTask();
    const db = getVaultDb(VAULT_ID);

    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ kind: "apply", option_id: "opt-1" })),
      cap.res,
      ctx(),
      taskId,
      USER_ID,
    );

    expect(cap.status).toBe(200);
    const row = db
      .prepare("SELECT state, completed_at FROM tasks WHERE id = ?")
      .get(taskId) as { state: string; completed_at: string | null };
    expect(row.state).toBe("done");
    expect(row.completed_at).not.toBeNull();

    const dRow = db
      .prepare("SELECT status FROM decisions WHERE id = ?")
      .get(decision.id) as DecisionRow;
    expect(dRow.status).toBe("confirmed");

    // No compensation row should have been created.
    const compCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM decisions WHERE status = 'compensated'")
        .get() as { n: number }
    ).n;
    expect(compCount).toBe(0);

    // No suppression row should have been inserted.
    const supCount = (
      db.prepare("SELECT COUNT(*) AS n FROM suppressions").get() as {
        n: number;
      }
    ).n;
    expect(supCount).toBe(0);
  });

  // ── Test 2: new shape, apply different option_id ────────────────────

  it("new shape apply with different option_id compensates + re-applies and closes task", async () => {
    const { taskId, decision } = seedDisambiguationWithTask();
    const db = getVaultDb(VAULT_ID);

    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ kind: "apply", option_id: "opt-2" })),
      cap.res,
      ctx(),
      taskId,
      USER_ID,
    );

    expect(cap.status).toBe(200);
    // Original task closed
    const tRow = db
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get(taskId) as { state: string };
    expect(tRow.state).toBe("done");

    // Original decision compensated
    const dRow = db
      .prepare("SELECT status, compensated_by FROM decisions WHERE id = ?")
      .get(decision.id) as DecisionRow;
    expect(dRow.status).toBe("compensated");
    expect(dRow.compensated_by).not.toBeNull();

    // A compensation Decision exists with status='confirmed' and the
    // new chosen_option_id.
    const compRow = db
      .prepare("SELECT * FROM decisions WHERE id = ?")
      .get(dRow.compensated_by!) as DecisionRow;
    expect(compRow.status).toBe("confirmed");
    expect(compRow.chosen_option_id).toBe("opt-2");

    // The source file should now have Anna Kim instead of Anna Chen.
    const sourceContent = readFileSync(
      join(vaultRepoPath(), "Journal/2026-05-21.md"),
      "utf8",
    );
    expect(sourceContent).not.toContain("[[Anna Chen]]");
    expect(sourceContent).toContain("[[Anna Kim]]");
  });

  // ── Test 3: new shape, refine ───────────────────────────────────────

  it("new shape refine compensates the decision and spawns a refine-handler pending task", async () => {
    const { taskId, decision } = seedLinkDecisionWithTask();
    const db = getVaultDb(VAULT_ID);

    const refinement = "merge into Anna Kim instead";
    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ kind: "refine", refinement })),
      cap.res,
      ctx(),
      taskId,
      USER_ID,
    );

    expect(cap.status).toBe(200);
    const body = cap.body as { refine_task_id?: string };
    expect(typeof body.refine_task_id).toBe("string");

    // Original decision compensated
    const dRow = db
      .prepare("SELECT status FROM decisions WHERE id = ?")
      .get(decision.id) as DecisionRow;
    expect(dRow.status).toBe("compensated");

    // Original task done
    const tRow = db
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get(taskId) as { state: string };
    expect(tRow.state).toBe("done");

    // New refine-handler task in pending state with body carrying the refinement
    const refineTask = db
      .prepare(
        "SELECT id, skill_slug, state, body FROM tasks WHERE skill_slug = 'refine-handler' LIMIT 1",
      )
      .get() as
      | { id: string; skill_slug: string; state: string; body: string | null }
      | undefined;
    expect(refineTask).toBeDefined();
    expect(refineTask!.state).toBe("pending");
    expect(refineTask!.body).toContain(refinement);
    expect(refineTask!.body).toContain(decision.id);
  });

  // ── Test 4: new shape, dismiss ──────────────────────────────────────

  it("new shape dismiss compensates and inserts a 14-day suppression", async () => {
    const { taskId, decision } = seedLinkDecisionWithTask();
    const db = getVaultDb(VAULT_ID);
    const beforeDismissAt = Date.now();

    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ kind: "dismiss" })),
      cap.res,
      ctx(),
      taskId,
      USER_ID,
    );

    expect(cap.status).toBe(200);

    // Task dismissed
    const tRow = db
      .prepare("SELECT state, completed_at FROM tasks WHERE id = ?")
      .get(taskId) as { state: string; completed_at: string | null };
    expect(tRow.state).toBe("dismissed");
    expect(tRow.completed_at).not.toBeNull();

    // Decision compensated
    const dRow = db
      .prepare("SELECT status FROM decisions WHERE id = ?")
      .get(decision.id) as DecisionRow;
    expect(dRow.status).toBe("compensated");

    // Suppression row inserted with correct (type, entity_key)
    const supRow = db
      .prepare("SELECT * FROM suppressions LIMIT 1")
      .get() as SuppressionRow | undefined;
    expect(supRow).toBeDefined();
    expect(supRow!.suggestion_type).toBe("link");
    // For link decisions the entity_key is payload.source_path.
    expect(supRow!.entity_key).toBe("Journal/2026-05-20.md");

    // TTL approximately 14 days into the future (allow 1 minute slack).
    const untilMs = Date.parse(supRow!.until);
    const expectedMs = beforeDismissAt + 14 * 24 * 60 * 60 * 1000;
    expect(untilMs).toBeGreaterThan(expectedMs - 60_000);
    expect(untilMs).toBeLessThan(expectedMs + 5 * 60_000);
  });

  // ── Test 5: legacy shape, confirm-durable on linked task ────────────

  it("legacy confirm-durable on a task with a decision dispatches as apply-matching", async () => {
    const { taskId, decision } = seedLinkDecisionWithTask();
    const db = getVaultDb(VAULT_ID);

    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ action: "confirm-durable" })),
      cap.res,
      ctx(),
      taskId,
      USER_ID,
    );

    expect(cap.status).toBe(200);

    // Decision confirmed (apply-matching path — no compensation)
    const dRow = db
      .prepare("SELECT status FROM decisions WHERE id = ?")
      .get(decision.id) as DecisionRow;
    expect(dRow.status).toBe("confirmed");

    const tRow = db
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get(taskId) as { state: string };
    expect(tRow.state).toBe("done");
  });

  // ── Test 6: legacy shape, mark-stale on linked task → dismiss ───────

  it("legacy mark-stale on a task with a decision dispatches as dismiss + suppression", async () => {
    const { taskId, decision } = seedLinkDecisionWithTask();
    const db = getVaultDb(VAULT_ID);

    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ action: "mark-stale" })),
      cap.res,
      ctx(),
      taskId,
      USER_ID,
    );

    expect(cap.status).toBe(200);

    // Decision compensated, suppression inserted (dismiss semantics)
    const dRow = db
      .prepare("SELECT status FROM decisions WHERE id = ?")
      .get(decision.id) as DecisionRow;
    expect(dRow.status).toBe("compensated");

    const supRow = db
      .prepare("SELECT * FROM suppressions LIMIT 1")
      .get() as SuppressionRow | undefined;
    expect(supRow).toBeDefined();
    expect(supRow!.suggestion_type).toBe("link");

    const tRow = db
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get(taskId) as { state: string };
    expect(tRow.state).toBe("dismissed");
  });

  // ── Test 7: legacy task (no decision), confirm-durable ──────────────

  it("legacy confirm-durable on a task with no decision closes it without touching decisions/suppressions", async () => {
    // Seed a plain review-state task — no decision, no note-change
    // artifact. Mirrors the daily-vault-review surface-only path.
    const db = getVaultDb(VAULT_ID);
    const taskId = "t-legacy-no-decision";
    db.prepare(
      `INSERT INTO tasks (id, skill_slug, state, title, body)
       VALUES (?, ?, 'review', ?, ?)`,
    ).run(
      taskId,
      "daily-vault-review",
      "legacy review task",
      "no decision linked",
    );

    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ action: "confirm-durable" })),
      cap.res,
      ctx(),
      taskId,
      USER_ID,
    );

    expect(cap.status).toBe(200);

    const tRow = db
      .prepare("SELECT state, completed_at FROM tasks WHERE id = ?")
      .get(taskId) as { state: string; completed_at: string | null };
    expect(tRow.state).toBe("done");
    expect(tRow.completed_at).not.toBeNull();

    // No decisions, no compensations, no suppressions touched.
    const decisionCount = (
      db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }
    ).n;
    expect(decisionCount).toBe(0);
    const supCount = (
      db.prepare("SELECT COUNT(*) AS n FROM suppressions").get() as {
        n: number;
      }
    ).n;
    expect(supCount).toBe(0);
  });

  // ── Test 8: refine-handler scheduler round-trip ─────────────────────

  it("refine-handler task spawned by refine executes through the scheduler drain", async () => {
    const { taskId, decision } = seedLinkDecisionWithTask({
      taskId: "t-roundtrip",
      decisionId: "D-roundtrip-link",
    });
    const db = getVaultDb(VAULT_ID);

    const refinement = "swap target to a draft Person note instead";
    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ kind: "refine", refinement })),
      cap.res,
      ctx(),
      taskId,
      USER_ID,
    );
    expect(cap.status).toBe(200);

    // Sanity: original decision is now compensated, original task done.
    const origDecision = db
      .prepare("SELECT status FROM decisions WHERE id = ?")
      .get(decision.id) as DecisionRow;
    expect(origDecision.status).toBe("compensated");

    // Find the spawned refine-handler task.
    const refineTask = db
      .prepare(
        "SELECT id, state FROM tasks WHERE skill_slug = 'refine-handler' LIMIT 1",
      )
      .get() as { id: string; state: string };
    expect(refineTask.state).toBe("pending");

    // Drain a pending task — should pick up the refine-handler task and
    // run it through to done.
    const drained = await drainOnePendingTask(ctx());
    expect(drained).toBe(true);

    // Re-fetch the refine task — should now be done.
    const after = db
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get(refineTask.id) as { state: string };
    expect(after.state).toBe("done");

    // Artifact mentions the refinement text and the original decision id.
    const resultRow = db
      .prepare(
        "SELECT artifact_json FROM task_results WHERE task_id = ? LIMIT 1",
      )
      .get(refineTask.id) as { artifact_json: string } | undefined;
    expect(resultRow).toBeDefined();
    const artifact = JSON.parse(resultRow!.artifact_json) as {
      type: string;
      surfaceText?: string;
    };
    expect(artifact.type).toBe("surface");
    expect(artifact.surfaceText).toContain(refinement);
    expect(artifact.surfaceText).toContain(decision.id);
  });
});

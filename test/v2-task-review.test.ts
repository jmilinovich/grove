/**
 * P22-3 — `handleV2TaskReview` direct-call tests.
 *
 * Verifies the four review actions (`confirm-durable`, `refine`,
 * `dismiss`, `mark-stale`) produce the right state transitions, and
 * that write-producing actions stamp the per-commit-trailer system with
 * the right `Provenance-Voice` and `Provenance-By` values:
 *
 *   - confirm-durable on a note-change artifact → `durable` / <user_id>
 *   - refine                                    → `durable` / `human`
 *   - dismiss with source_flag_id               → cross-DB write-through
 *     (no vault commit) — same path as P22-2 dismiss.
 *   - mark-stale                                → state dismissed, body
 *     gets the stale marker appended (no commit).
 *
 * Setup mirrors `v2-task-dismiss.test.ts`: env-pointed control db + per-
 * vault state root with real migration SQL, plus a real git repo seeded
 * with an initial commit so the trailers land in a parseable HEAD.
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
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-v2-task-review-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import { handleV2TaskReview } from "../src/v2-tasks.js";
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

function seedVault(id: string, slug: string, vaultPath: string): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run("user_v2_review", "review-tester", "review@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "user_v2_review", slug, slug, vaultPath);
}

function seedFlag(id: string, vaultId: string): void {
  getDb()
    .prepare(
      `INSERT INTO graph_health_flags (id, flag_type, source_path, details, vault_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, "missing_frontmatter", "Resources/Concepts/X.md", "{}", vaultId);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initVaultRepo(vaultPath: string): void {
  mkdirSync(vaultPath, { recursive: true });
  git(vaultPath, ["init", "-q", "-b", "main"]);
  git(vaultPath, ["config", "user.email", "test@grove.local"]);
  git(vaultPath, ["config", "user.name", "Grove Test"]);
  git(vaultPath, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(vaultPath, ".gitkeep"), "");
  git(vaultPath, ["add", ".gitkeep"]);
  git(vaultPath, ["commit", "-q", "-m", "init"]);
}

function ctx(id: string, slug: string, vaultPath: string): VaultContext {
  return { vaultId: id, vaultSlug: slug, vaultPath };
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

/** Pull the most recent commit body (subject + trailers) from a repo. */
function headBody(vaultPath: string): string {
  return execFileSync("git", ["log", "-1", "--format=%B", "HEAD"], {
    cwd: vaultPath,
    encoding: "utf8",
  }).trim();
}

function seedReviewTask(
  vaultId: string,
  taskId: string,
  opts: {
    body?: string;
    sourceFlagId?: string | null;
    artifact?: { type: string; notePath?: string; surfaceText?: string };
    noteChange?: { content: string };
  } = {},
): void {
  const db = getVaultDb(vaultId);
  db.prepare(
    `INSERT INTO tasks (id, skill_slug, state, title, body, source_flag_id)
     VALUES (?, ?, 'review', ?, ?, ?)`,
  ).run(
    taskId,
    "daily-vault-review",
    `task ${taskId}`,
    opts.body ?? null,
    opts.sourceFlagId ?? null,
  );
  if (opts.artifact) {
    db.prepare(
      `INSERT INTO task_results (task_id, artifact_json, note_change_json)
       VALUES (?, ?, ?)`,
    ).run(
      taskId,
      JSON.stringify(opts.artifact),
      opts.noteChange ? JSON.stringify(opts.noteChange) : null,
    );
  }
}

const VAULT_ID = "vault_review";
const VAULT_SLUG = "personal";
const USER_ID = "user_v2_review";

describe("handleV2TaskReview (P22-3)", () => {
  let vaultPath: string;

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

    vaultPath = join(TEST_DIR, "repos", `${VAULT_SLUG}-${Date.now()}`);
    rmSync(vaultPath, { recursive: true, force: true });
    initVaultRepo(vaultPath);

    copyRealMigrations();
    createSchema();
    seedVault(VAULT_ID, VAULT_SLUG, vaultPath);
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  // ── confirm-durable ────────────────────────────────────────────────

  it("confirm-durable on a note-change artifact writes the file and stamps Provenance-By: <user_id>", async () => {
    const notePath = "Resources/Concepts/Taste-Graphs.md";
    seedReviewTask(VAULT_ID, "t_confirm", {
      artifact: { type: "note-change", notePath },
      noteChange: { content: "---\ntype: concept\n---\nnew body\n" },
    });

    const cap = makeRes();
    const req = makeReq(JSON.stringify({ action: "confirm-durable" }));
    await handleV2TaskReview(
      req,
      cap.res,
      ctx(VAULT_ID, VAULT_SLUG, vaultPath),
      "t_confirm",
      USER_ID,
    );

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual({ id: "t_confirm", state: "done" });

    // File landed on disk via the write path.
    expect(existsSync(join(vaultPath, notePath))).toBe(true);
    expect(readFileSync(join(vaultPath, notePath), "utf8")).toBe(
      "---\ntype: concept\n---\nnew body\n",
    );

    // Commit body contains the right provenance trailers.
    const body = headBody(vaultPath);
    expect(body).toContain("Provenance-Voice: durable");
    expect(body).toContain(`Provenance-By: ${USER_ID}`);

    // Task is now done in state.db.
    const row = getVaultDb(VAULT_ID)
      .prepare("SELECT state, completed_at FROM tasks WHERE id = ?")
      .get("t_confirm") as { state: string; completed_at: string | null };
    expect(row.state).toBe("done");
    expect(row.completed_at).not.toBeNull();
  });

  it("confirm-durable on a surface-only artifact transitions state with no vault commit", async () => {
    seedReviewTask(VAULT_ID, "t_surface", {
      artifact: { type: "surface", surfaceText: "noticed something" },
    });

    const beforeSha = git(vaultPath, ["rev-parse", "HEAD"]);

    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ action: "confirm-durable" })),
      cap.res,
      ctx(VAULT_ID, VAULT_SLUG, vaultPath),
      "t_surface",
      USER_ID,
    );

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual({ id: "t_surface", state: "done" });
    // No new commit — surface artifacts don't write to the vault repo.
    expect(git(vaultPath, ["rev-parse", "HEAD"])).toBe(beforeSha);
  });

  it("confirm-durable returns 409 when the note-change artifact is incomplete (missing notePath)", async () => {
    seedReviewTask(VAULT_ID, "t_incomplete", {
      artifact: { type: "note-change" },
      noteChange: { content: "stuff" },
    });

    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ action: "confirm-durable" })),
      cap.res,
      ctx(VAULT_ID, VAULT_SLUG, vaultPath),
      "t_incomplete",
      USER_ID,
    );

    expect(cap.status).toBe(409);
    expect(cap.body).toEqual({ error: "incomplete_note_change_artifact" });
  });

  // ── refine ─────────────────────────────────────────────────────────

  it("refine writes the user-authored content and stamps Provenance-By: human", async () => {
    const notePath = "Resources/Concepts/Refined.md";
    seedReviewTask(VAULT_ID, "t_refine", {
      artifact: { type: "note-change", notePath },
      noteChange: { content: "---\ntype: concept\n---\nclaude's draft\n" },
    });

    const cap = makeRes();
    const userEdit = "---\ntype: concept\n---\nhuman rewrote it\n";
    await handleV2TaskReview(
      makeReq(JSON.stringify({ action: "refine", refinement: userEdit })),
      cap.res,
      ctx(VAULT_ID, VAULT_SLUG, vaultPath),
      "t_refine",
      USER_ID,
    );

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual({ id: "t_refine", state: "done" });

    expect(readFileSync(join(vaultPath, notePath), "utf8")).toBe(userEdit);

    const body = headBody(vaultPath);
    expect(body).toContain("Provenance-Voice: durable");
    expect(body).toContain("Provenance-By: human");

    const row = getVaultDb(VAULT_ID)
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get("t_refine") as { state: string };
    expect(row.state).toBe("done");
  });

  it("refine requires the refinement field", async () => {
    seedReviewTask(VAULT_ID, "t_no_refinement", {
      artifact: { type: "note-change", notePath: "Resources/Concepts/X.md" },
      noteChange: { content: "draft" },
    });

    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ action: "refine" })),
      cap.res,
      ctx(VAULT_ID, VAULT_SLUG, vaultPath),
      "t_no_refinement",
      USER_ID,
    );

    expect(cap.status).toBe(400);
    expect(cap.body).toEqual({ error: "refinement_required" });
  });

  it("refine returns 409 when the artifact isn't a note-change", async () => {
    seedReviewTask(VAULT_ID, "t_refine_surface", {
      artifact: { type: "surface", surfaceText: "info" },
    });

    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ action: "refine", refinement: "anything" })),
      cap.res,
      ctx(VAULT_ID, VAULT_SLUG, vaultPath),
      "t_refine_surface",
      USER_ID,
    );

    expect(cap.status).toBe(409);
    expect(cap.body).toEqual({ error: "not_a_note_change_artifact" });
  });

  // ── dismiss ────────────────────────────────────────────────────────

  it("dismiss resolves the originating graph_health_flag via ATTACH when source_flag_id is set", async () => {
    seedFlag("flag_review_dismiss", VAULT_ID);
    seedReviewTask(VAULT_ID, "t_dismiss_flag", {
      sourceFlagId: "flag_review_dismiss",
    });

    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ action: "dismiss" })),
      cap.res,
      ctx(VAULT_ID, VAULT_SLUG, vaultPath),
      "t_dismiss_flag",
      USER_ID,
    );

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual({ id: "t_dismiss_flag", state: "dismissed" });

    const task = getVaultDb(VAULT_ID)
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get("t_dismiss_flag") as { state: string };
    expect(task.state).toBe("dismissed");

    const flag = getDb()
      .prepare("SELECT resolved_at FROM graph_health_flags WHERE id = ?")
      .get("flag_review_dismiss") as { resolved_at: string | null };
    expect(flag.resolved_at).not.toBeNull();
  });

  it("dismiss without source_flag_id just updates task state", async () => {
    seedReviewTask(VAULT_ID, "t_dismiss_plain");

    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ action: "dismiss" })),
      cap.res,
      ctx(VAULT_ID, VAULT_SLUG, vaultPath),
      "t_dismiss_plain",
      USER_ID,
    );

    expect(cap.status).toBe(200);
    const row = getVaultDb(VAULT_ID)
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get("t_dismiss_plain") as { state: string };
    expect(row.state).toBe("dismissed");
  });

  // ── mark-stale ─────────────────────────────────────────────────────

  it("mark-stale dismisses the task and appends the marker to body (NOT description)", async () => {
    seedReviewTask(VAULT_ID, "t_stale", {
      body: "original framing",
    });

    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ action: "mark-stale" })),
      cap.res,
      ctx(VAULT_ID, VAULT_SLUG, vaultPath),
      "t_stale",
      USER_ID,
    );

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual({ id: "t_stale", state: "dismissed" });

    const row = getVaultDb(VAULT_ID)
      .prepare("SELECT state, body FROM tasks WHERE id = ?")
      .get("t_stale") as { state: string; body: string };
    expect(row.state).toBe("dismissed");
    expect(row.body).toContain("original framing");
    expect(row.body).toContain("[stale: marked by user]");
  });

  it("mark-stale works when body is null — initializes from empty", async () => {
    seedReviewTask(VAULT_ID, "t_stale_null"); // no body

    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ action: "mark-stale" })),
      cap.res,
      ctx(VAULT_ID, VAULT_SLUG, vaultPath),
      "t_stale_null",
      USER_ID,
    );

    expect(cap.status).toBe(200);
    const row = getVaultDb(VAULT_ID)
      .prepare("SELECT body FROM tasks WHERE id = ?")
      .get("t_stale_null") as { body: string };
    expect(row.body).toContain("[stale: marked by user]");
  });

  // ── state validation + body validation ─────────────────────────────

  it("returns 409 when the task is not in review state", async () => {
    const db = getVaultDb(VAULT_ID);
    db.prepare(
      "INSERT INTO tasks (id, skill_slug, state, title) VALUES (?, ?, ?, ?)",
    ).run("t_pending", "daily-vault-review", "pending", "not yet review");

    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ action: "confirm-durable" })),
      cap.res,
      ctx(VAULT_ID, VAULT_SLUG, vaultPath),
      "t_pending",
      USER_ID,
    );

    expect(cap.status).toBe(409);
    expect(cap.body).toEqual({ error: "invalid_state", state: "pending" });
  });

  it("returns 404 for an unknown task id", async () => {
    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ action: "dismiss" })),
      cap.res,
      ctx(VAULT_ID, VAULT_SLUG, vaultPath),
      "ghost",
      USER_ID,
    );
    expect(cap.status).toBe(404);
    expect(cap.body).toEqual({ error: "task_not_found" });
  });

  it("returns 400 on invalid JSON body", async () => {
    const cap = makeRes();
    await handleV2TaskReview(
      makeReq("{not json"),
      cap.res,
      ctx(VAULT_ID, VAULT_SLUG, vaultPath),
      "anything",
      USER_ID,
    );
    expect(cap.status).toBe(400);
    expect(cap.body).toEqual({ error: "invalid_json" });
  });

  it("returns 400 on an unknown action", async () => {
    seedReviewTask(VAULT_ID, "t_bad_action");

    const cap = makeRes();
    await handleV2TaskReview(
      makeReq(JSON.stringify({ action: "yeet" })),
      cap.res,
      ctx(VAULT_ID, VAULT_SLUG, vaultPath),
      "t_bad_action",
      USER_ID,
    );
    expect(cap.status).toBe(400);
    expect(cap.body).toEqual({ error: "invalid_action" });
  });
});

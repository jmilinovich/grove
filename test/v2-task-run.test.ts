/**
 * P22-1 — `POST /v/<slug>/v1/tasks/<id>/run` dispatcher tests.
 *
 * Drives `dispatchTaskRun` (state transitions, response envelopes) and
 * `runTaskOnce` (executor invocation, result persistence) against a
 * seeded per-vault state.db. The HTTP wrapper (`handleV2TaskRun`) gets a
 * single smoke test through a fake `ServerResponse` to pin the
 * status/body/headers contract — the rest of the suite exercises the
 * pure-data path so we can assert state transitions without standing up
 * a server.
 *
 * Setup mirrors `v2-task-detail.test.ts`: env-pointed control db and
 * per-vault state.db roots, real migration files copied from the repo so
 * the production SQL stays under test.
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
import type { IncomingMessage, ServerResponse } from "node:http";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-v2-task-run-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");
// Don't auto-start the polling worker — the tests drive runTaskOnce
// directly and a background interval would race the assertions.
process.env.GROVE_DISABLE_TASK_WORKER = "1";

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import {
  dispatchTaskRun,
  runTaskOnce,
  setExecutorForTesting,
  clearExecutorOverrides,
  type SkillExecutor,
} from "../src/v2-task-run.js";
import { handleV2TaskRun } from "../src/v2-tasks.js";
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

function seedVault(id: string, slug: string): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run("user_v2_run", "run-tester", "run@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "user_v2_run", slug, slug, join(TEST_DIR, "repos", slug));
}

function ctx(id: string, slug: string): VaultContext {
  return {
    vaultId: id,
    vaultSlug: slug,
    vaultPath: join(TEST_DIR, "repos", slug),
  };
}

function insertTask(
  vaultId: string,
  overrides: Partial<{
    id: string;
    skill_slug: string;
    state: "pending" | "running" | "review" | "done" | "dismissed" | "failed";
    title: string;
    body: string;
    started_at: string | null;
  }>,
): string {
  const id = overrides.id ?? `task_${Math.random().toString(36).slice(2, 10)}`;
  const db = getVaultDb(vaultId);
  db.prepare(
    `INSERT INTO tasks (id, skill_slug, state, title, body, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.skill_slug ?? "enrichment",
    overrides.state ?? "pending",
    overrides.title ?? "Test task",
    overrides.body ?? null,
    overrides.started_at ?? null,
  );
  return id;
}

interface CapturedResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  res: ServerResponse;
}

function makeRes(): CapturedResponse {
  const captured: CapturedResponse = {
    status: 0,
    body: undefined,
    headers: {},
    res: {} as ServerResponse,
  };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      if (headers) captured.headers = headers;
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

const req = {} as IncomingMessage;

describe("dispatchTaskRun (P22-1)", () => {
  beforeEach(() => {
    resetDb();
    closeAllVaultDbs();
    clearExecutorOverrides();
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
    seedVault("vault_run", "personal");
    // Force the vault state db to initialize so migrations run before
    // the first prepared-statement read.
    getVaultDb("vault_run");
  });

  afterEach(() => {
    closeAllVaultDbs();
    clearExecutorOverrides();
    resetDb();
  });

  it("returns 404 when the task id is unknown", () => {
    const result = dispatchTaskRun(ctx("vault_run", "personal"), "ghost_task");
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "task_not_found" });
  });

  it("transitions a pending task to running and returns 202", () => {
    const id = insertTask("vault_run", {
      state: "pending",
      title: "Review your inbox",
      body: "ten unprocessed captures",
    });

    const result = dispatchTaskRun(ctx("vault_run", "personal"), id);

    expect(result.status).toBe(202);
    const body = result.body as { id: string; state: string; startedAt: string | null };
    expect(body.id).toBe(id);
    expect(body.state).toBe("running");
    expect(body.startedAt).not.toBeNull();

    const row = getVaultDb("vault_run")
      .prepare("SELECT state, started_at FROM tasks WHERE id = ?")
      .get(id) as { state: string; started_at: string };
    expect(row.state).toBe("running");
    expect(row.started_at).not.toBeNull();
  });

  it("returns 200 idempotently when the task is already in review", () => {
    const id = insertTask("vault_run", {
      state: "review",
      title: "Surface a perishable note",
    });

    const result = dispatchTaskRun(ctx("vault_run", "personal"), id);

    expect(result.status).toBe(200);
    const body = result.body as { id: string; state: string };
    expect(body.id).toBe(id);
    expect(body.state).toBe("review");

    // No state change.
    const row = getVaultDb("vault_run")
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get(id) as { state: string };
    expect(row.state).toBe("review");
  });

  it("returns 409 with current state for terminal tasks (done/dismissed/failed)", () => {
    const c = ctx("vault_run", "personal");
    for (const state of ["done", "dismissed", "failed"] as const) {
      const id = insertTask("vault_run", { state, title: `terminal-${state}` });
      const result = dispatchTaskRun(c, id);
      expect(result.status).toBe(409);
      expect(result.body).toEqual({ error: "terminal_state", state });
    }
  });

  it("returns 409 with already_running when the task is already running", () => {
    const id = insertTask("vault_run", {
      state: "running",
      title: "Currently running",
      started_at: new Date().toISOString(),
    });

    const result = dispatchTaskRun(ctx("vault_run", "personal"), id);

    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: "already_running", state: "running" });
  });
});

describe("runTaskOnce (P22-1 worker path)", () => {
  beforeEach(() => {
    resetDb();
    closeAllVaultDbs();
    clearExecutorOverrides();
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
    seedVault("vault_run", "personal");
    getVaultDb("vault_run");
  });

  afterEach(() => {
    closeAllVaultDbs();
    clearExecutorOverrides();
    resetDb();
  });

  it("invokes the executor and transitions to review on success", async () => {
    const executor: SkillExecutor = async (_vault, task) => ({
      artifact: {
        type: "surface",
        surfaceText: `executor ran for ${task.title}`,
      },
      provenance: {
        voice: "perishable",
        by: "test-executor",
        writtenAt: "2026-05-14T00:00:00Z",
      },
      finalState: "review",
    });
    setExecutorForTesting("enrichment", executor);

    const id = insertTask("vault_run", {
      state: "running",
      title: "stub work",
      started_at: new Date().toISOString(),
    });

    await runTaskOnce(ctx("vault_run", "personal"), id);

    const db = getVaultDb("vault_run");
    const taskRow = db
      .prepare("SELECT state, completed_at FROM tasks WHERE id = ?")
      .get(id) as { state: string; completed_at: string | null };
    expect(taskRow.state).toBe("review");
    expect(taskRow.completed_at).toBeNull();

    const resultRow = db
      .prepare(
        "SELECT artifact_json, provenance_json FROM task_results WHERE task_id = ?",
      )
      .get(id) as { artifact_json: string; provenance_json: string };
    expect(resultRow).toBeDefined();
    expect(JSON.parse(resultRow.artifact_json)).toEqual({
      type: "surface",
      surfaceText: "executor ran for stub work",
    });
    expect(JSON.parse(resultRow.provenance_json)).toEqual({
      voice: "perishable",
      by: "test-executor",
      writtenAt: "2026-05-14T00:00:00Z",
    });
  });

  it("transitions to done and stamps completed_at when executor returns finalState=done", async () => {
    setExecutorForTesting("enrichment", async () => ({
      artifact: { type: "surface", surfaceText: "auto-done" },
      provenance: { voice: "perishable", by: "test-executor" },
      finalState: "done",
    }));

    const id = insertTask("vault_run", {
      state: "running",
      title: "auto-done task",
      started_at: new Date().toISOString(),
    });

    await runTaskOnce(ctx("vault_run", "personal"), id);

    const row = getVaultDb("vault_run")
      .prepare("SELECT state, completed_at FROM tasks WHERE id = ?")
      .get(id) as { state: string; completed_at: string | null };
    expect(row.state).toBe("done");
    expect(row.completed_at).not.toBeNull();
  });

  it("records a failed state with error artifact when the executor throws", async () => {
    setExecutorForTesting("enrichment", async () => {
      throw new Error("Anthropic API: 503 Service Unavailable");
    });

    const id = insertTask("vault_run", {
      state: "running",
      title: "doomed task",
      started_at: new Date().toISOString(),
    });

    await runTaskOnce(ctx("vault_run", "personal"), id);

    const db = getVaultDb("vault_run");
    const row = db
      .prepare("SELECT state, completed_at FROM tasks WHERE id = ?")
      .get(id) as { state: string; completed_at: string | null };
    expect(row.state).toBe("failed");
    expect(row.completed_at).not.toBeNull();

    const result = db
      .prepare(
        "SELECT artifact_json, provenance_json FROM task_results WHERE task_id = ?",
      )
      .get(id) as { artifact_json: string; provenance_json: string };
    const artifact = JSON.parse(result.artifact_json);
    expect(artifact.type).toBe("surface");
    expect(artifact.surfaceText).toContain("Anthropic API: 503");
    const provenance = JSON.parse(result.provenance_json);
    expect(provenance.voice).toBe("perishable");
    expect(provenance.reason).toBe("executor_error");
  });

  it("no-ops when the task isn't in running state (avoids double-process)", async () => {
    let executorCalls = 0;
    setExecutorForTesting("enrichment", async () => {
      executorCalls++;
      return {
        artifact: { type: "surface", surfaceText: "should not run" },
        provenance: { voice: "perishable", by: "test-executor" },
        finalState: "review",
      };
    });

    const id = insertTask("vault_run", {
      state: "pending",
      title: "not yet claimed",
    });

    await runTaskOnce(ctx("vault_run", "personal"), id);

    expect(executorCalls).toBe(0);
    const row = getVaultDb("vault_run")
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get(id) as { state: string };
    expect(row.state).toBe("pending");
  });
});

describe("handleV2TaskRun (HTTP wrapper)", () => {
  beforeEach(() => {
    resetDb();
    closeAllVaultDbs();
    clearExecutorOverrides();
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
    seedVault("vault_run", "personal");
    getVaultDb("vault_run");
  });

  afterEach(() => {
    closeAllVaultDbs();
    clearExecutorOverrides();
    resetDb();
  });

  it("writes the 202 envelope with CORS + content-type headers on a pending → running transition", () => {
    const id = insertTask("vault_run", {
      state: "pending",
      title: "smoke test",
    });

    const cap = makeRes();
    handleV2TaskRun(req, cap.res, ctx("vault_run", "personal"), id);

    expect(cap.status).toBe(202);
    expect(cap.headers["Content-Type"]).toBe("application/json");
    expect(cap.headers["Access-Control-Allow-Origin"]).toBeDefined();
    const body = cap.body as { id: string; state: string };
    expect(body.id).toBe(id);
    expect(body.state).toBe("running");
  });

  it("returns 404 through the HTTP wrapper when the task is unknown", () => {
    const cap = makeRes();
    handleV2TaskRun(
      req,
      cap.res,
      ctx("vault_run", "personal"),
      "no_such_task",
    );

    expect(cap.status).toBe(404);
    expect(cap.body).toEqual({ error: "task_not_found" });
  });
});

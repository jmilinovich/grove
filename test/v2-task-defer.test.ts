/**
 * P22-2 — `handleV2TaskDefer` direct-call tests.
 *
 * Mirrors the test setup in `v2-task-detail.test.ts`: env-pointed
 * control db + per-vault state root, real migration files copied from
 * `src/migrations/vault/` so the production SQL stays under test.
 *
 * The endpoint sets `tasks.scheduled_for` for `pending|review` tasks.
 * Tests cover: happy path on pending, happy path on review, 409 on
 * terminal states, 404 on unknown id, 400 on missing/bad ISO body.
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
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-v2-task-defer-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import { handleV2TaskDefer } from "../src/v2-tasks.js";
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
  ).run("user_v2_defer", "defer-tester", "defer@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "user_v2_defer", slug, slug, join(TEST_DIR, "repos", slug));
}

function ctx(id: string, slug: string): VaultContext {
  return {
    vaultId: id,
    vaultSlug: slug,
    vaultPath: join(TEST_DIR, "repos", slug),
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

describe("handleV2TaskDefer (P22-2)", () => {
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
    seedVault("vault_defer", "personal");
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
  });

  it("defers a pending task — sets scheduled_for, returns the updated task", async () => {
    const db = getVaultDb("vault_defer");
    db.prepare(
      `INSERT INTO tasks (id, skill_slug, state, title)
       VALUES (?, ?, ?, ?)`,
    ).run("t_pending", "enrichment", "pending", "Process inbox");

    const cap = makeRes();
    const req = makeReq(JSON.stringify({ until: "2026-06-01T09:00:00Z" }));
    await handleV2TaskDefer(req, cap.res, ctx("vault_defer", "personal"), "t_pending");

    expect(cap.status).toBe(200);
    const body = cap.body as { id: string; state: string; scheduledFor: string };
    expect(body.id).toBe("t_pending");
    expect(body.state).toBe("pending");
    expect(body.scheduledFor).toBe("2026-06-01T09:00:00Z");

    const row = db
      .prepare("SELECT scheduled_for FROM tasks WHERE id = ?")
      .get("t_pending") as { scheduled_for: string };
    expect(row.scheduled_for).toBe("2026-06-01T09:00:00Z");
  });

  it("defers a review task — same path as pending", async () => {
    const db = getVaultDb("vault_defer");
    db.prepare(
      "INSERT INTO tasks (id, skill_slug, state, title) VALUES (?, ?, ?, ?)",
    ).run("t_review", "enrichment", "review", "Confirm taste-graph edit");

    const cap = makeRes();
    const req = makeReq(JSON.stringify({ until: "2026-07-15T12:00:00Z" }));
    await handleV2TaskDefer(req, cap.res, ctx("vault_defer", "personal"), "t_review");

    expect(cap.status).toBe(200);
    const body = cap.body as { state: string; scheduledFor: string };
    expect(body.state).toBe("review");
    expect(body.scheduledFor).toBe("2026-07-15T12:00:00Z");
  });

  it("returns 409 when the task is already done", async () => {
    const db = getVaultDb("vault_defer");
    db.prepare(
      "INSERT INTO tasks (id, skill_slug, state, title) VALUES (?, ?, ?, ?)",
    ).run("t_done", "enrichment", "done", "Already cleared");

    const cap = makeRes();
    const req = makeReq(JSON.stringify({ until: "2026-06-01T09:00:00Z" }));
    await handleV2TaskDefer(req, cap.res, ctx("vault_defer", "personal"), "t_done");

    expect(cap.status).toBe(409);
    expect(cap.body).toEqual({ error: "invalid_state", state: "done" });
  });

  it("returns 409 on dismissed and failed terminal states", async () => {
    const db = getVaultDb("vault_defer");
    db.prepare(
      "INSERT INTO tasks (id, skill_slug, state, title) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
    ).run(
      "t_dismissed", "enrichment", "dismissed", "Dropped",
      "t_failed", "enrichment", "failed", "Errored",
    );

    for (const id of ["t_dismissed", "t_failed"]) {
      const cap = makeRes();
      const req = makeReq(JSON.stringify({ until: "2026-06-01T09:00:00Z" }));
      await handleV2TaskDefer(req, cap.res, ctx("vault_defer", "personal"), id);
      expect(cap.status).toBe(409);
    }
  });

  it("returns 404 for an unknown task id", async () => {
    const cap = makeRes();
    const req = makeReq(JSON.stringify({ until: "2026-06-01T09:00:00Z" }));
    await handleV2TaskDefer(req, cap.res, ctx("vault_defer", "personal"), "ghost");

    expect(cap.status).toBe(404);
    expect(cap.body).toEqual({ error: "task_not_found" });
  });

  it("returns 400 when until is missing", async () => {
    const db = getVaultDb("vault_defer");
    db.prepare(
      "INSERT INTO tasks (id, skill_slug, state, title) VALUES (?, ?, ?, ?)",
    ).run("t_pending", "enrichment", "pending", "Process inbox");

    const cap = makeRes();
    const req = makeReq(JSON.stringify({}));
    await handleV2TaskDefer(req, cap.res, ctx("vault_defer", "personal"), "t_pending");

    expect(cap.status).toBe(400);
    expect(cap.body).toEqual({ error: "until_required" });
  });

  it("returns 400 when until is not a parseable date", async () => {
    const db = getVaultDb("vault_defer");
    db.prepare(
      "INSERT INTO tasks (id, skill_slug, state, title) VALUES (?, ?, ?, ?)",
    ).run("t_pending", "enrichment", "pending", "Process inbox");

    const cap = makeRes();
    const req = makeReq(JSON.stringify({ until: "not-a-date" }));
    await handleV2TaskDefer(req, cap.res, ctx("vault_defer", "personal"), "t_pending");

    expect(cap.status).toBe(400);
    expect(cap.body).toEqual({ error: "invalid_until" });
  });

  it("returns 400 on invalid JSON body", async () => {
    const cap = makeRes();
    const req = makeReq("{this is not json");
    await handleV2TaskDefer(req, cap.res, ctx("vault_defer", "personal"), "t_pending");

    expect(cap.status).toBe(400);
    expect(cap.body).toEqual({ error: "invalid_json" });
  });
});

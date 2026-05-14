/**
 * P22-2 — `handleV2TaskDismiss` direct-call tests.
 *
 * Setup mirrors `v2-task-defer.test.ts` and `v2-task-detail.test.ts`.
 *
 * Three behaviors under test:
 *   1. Idempotent transition to `state='dismissed'` (works on a fresh
 *      task and on a task that's already dismissed).
 *   2. Cross-DB ATTACH write-through to
 *      `control.graph_health_flags.resolved_at` when the task's
 *      `source_flag_id` is non-null — Phase 22 locked design decision #1.
 *   3. No write-through when `source_flag_id` is null.
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-v2-task-dismiss-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import { handleV2TaskDismiss } from "../src/v2-tasks.js";
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
  ).run("user_v2_dismiss", "dismiss-tester", "dismiss@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "user_v2_dismiss", slug, slug, join(TEST_DIR, "repos", slug));
}

function seedFlag(id: string, vaultId: string): void {
  getDb()
    .prepare(
      `INSERT INTO graph_health_flags (id, flag_type, source_path, details, vault_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, "missing_frontmatter", "Resources/Concepts/X.md", "{}", vaultId);
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

describe("handleV2TaskDismiss (P22-2)", () => {
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
    seedVault("vault_dismiss", "personal");
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
  });

  it("transitions a pending task to dismissed", async () => {
    const db = getVaultDb("vault_dismiss");
    db.prepare(
      "INSERT INTO tasks (id, skill_slug, state, title) VALUES (?, ?, ?, ?)",
    ).run("t1", "daily-vault-review", "pending", "Drop this");

    const cap = makeRes();
    await handleV2TaskDismiss(makeReq(), cap.res, ctx("vault_dismiss", "personal"), "t1");

    expect(cap.status).toBe(200);
    const body = cap.body as { id: string; state: string };
    expect(body.id).toBe("t1");
    expect(body.state).toBe("dismissed");

    const row = db
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get("t1") as { state: string };
    expect(row.state).toBe("dismissed");
  });

  it("is idempotent on an already-dismissed task", async () => {
    const db = getVaultDb("vault_dismiss");
    db.prepare(
      "INSERT INTO tasks (id, skill_slug, state, title, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("t1", "daily-vault-review", "dismissed", "Already dropped", "2026-01-01 00:00:00");

    const cap = makeRes();
    await handleV2TaskDismiss(makeReq(), cap.res, ctx("vault_dismiss", "personal"), "t1");

    expect(cap.status).toBe(200);
    const body = cap.body as { state: string };
    expect(body.state).toBe("dismissed");

    // The WHERE state != 'dismissed' guard means updated_at is NOT refreshed
    // on a no-op dismiss — true idempotency, not just same-final-state.
    const row = db
      .prepare("SELECT updated_at FROM tasks WHERE id = ?")
      .get("t1") as { updated_at: string };
    expect(row.updated_at).toBe("2026-01-01 00:00:00");
  });

  it("returns 404 when the task id is unknown", async () => {
    const cap = makeRes();
    await handleV2TaskDismiss(makeReq(), cap.res, ctx("vault_dismiss", "personal"), "ghost");
    expect(cap.status).toBe(404);
    expect(cap.body).toEqual({ error: "task_not_found" });
  });

  it("resolves the originating graph_health_flag via ATTACH when source_flag_id is set", async () => {
    seedFlag("flag_orphan_1", "vault_dismiss");

    const db = getVaultDb("vault_dismiss");
    db.prepare(
      `INSERT INTO tasks (id, skill_slug, state, title, source_flag_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("t_from_flag", "daily-vault-review", "review", "An orphan node", "flag_orphan_1");

    // Pre-state: flag is unresolved.
    const before = getDb()
      .prepare("SELECT resolved_at FROM graph_health_flags WHERE id = ?")
      .get("flag_orphan_1") as { resolved_at: string | null };
    expect(before.resolved_at).toBeNull();

    const cap = makeRes();
    await handleV2TaskDismiss(makeReq(), cap.res, ctx("vault_dismiss", "personal"), "t_from_flag");

    expect(cap.status).toBe(200);

    // Task is now dismissed.
    const task = db
      .prepare("SELECT state FROM tasks WHERE id = ?")
      .get("t_from_flag") as { state: string };
    expect(task.state).toBe("dismissed");

    // Flag in control.db is now resolved.
    const after = getDb()
      .prepare("SELECT resolved_at FROM graph_health_flags WHERE id = ?")
      .get("flag_orphan_1") as { resolved_at: string | null };
    expect(after.resolved_at).not.toBeNull();
  });

  it("does NOT write to graph_health_flags when source_flag_id is null", async () => {
    // Seed an unresolved flag — it should stay unresolved after the dismiss
    // since the task in question isn't linked to it.
    seedFlag("flag_unrelated", "vault_dismiss");

    const db = getVaultDb("vault_dismiss");
    db.prepare(
      "INSERT INTO tasks (id, skill_slug, state, title) VALUES (?, ?, ?, ?)",
    ).run("t_plain", "daily-vault-review", "pending", "Not flag-derived");

    const cap = makeRes();
    await handleV2TaskDismiss(makeReq(), cap.res, ctx("vault_dismiss", "personal"), "t_plain");

    expect(cap.status).toBe(200);

    const row = getDb()
      .prepare("SELECT resolved_at FROM graph_health_flags WHERE id = ?")
      .get("flag_unrelated") as { resolved_at: string | null };
    expect(row.resolved_at).toBeNull();
  });

  it("does not re-resolve a flag that was already resolved", async () => {
    // Seed a flag and resolve it explicitly to a known timestamp.
    seedFlag("flag_prev_resolved", "vault_dismiss");
    getDb()
      .prepare(
        "UPDATE graph_health_flags SET resolved_at = ? WHERE id = ?",
      )
      .run("2026-01-01 00:00:00", "flag_prev_resolved");

    const db = getVaultDb("vault_dismiss");
    db.prepare(
      `INSERT INTO tasks (id, skill_slug, state, title, source_flag_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("t_late", "daily-vault-review", "review", "Late dismiss", "flag_prev_resolved");

    const cap = makeRes();
    await handleV2TaskDismiss(makeReq(), cap.res, ctx("vault_dismiss", "personal"), "t_late");

    expect(cap.status).toBe(200);

    // resolved_at must still be the original timestamp — the
    // `WHERE resolved_at IS NULL` guard means re-dismissing doesn't
    // overwrite the historical resolution time.
    const row = getDb()
      .prepare("SELECT resolved_at FROM graph_health_flags WHERE id = ?")
      .get("flag_prev_resolved") as { resolved_at: string };
    expect(row.resolved_at).toBe("2026-01-01 00:00:00");
  });
});

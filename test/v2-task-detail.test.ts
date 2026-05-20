/**
 * P21-4 — `handleV2TaskDetail` direct-call tests.
 *
 * Drives the handler with a tiny in-memory `ServerResponse` stub and
 * asserts the JSON payload shape, the 404 path, and the note-change
 * blame join from `control.note_blame` via ATTACH.
 *
 * Setup mirrors `db-migration-v2-tasks.test.ts`: env-pointed control db
 * and per-vault state.db roots, real migration files copied from the
 * repo so the production SQL stays under test.
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-v2-task-detail-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");

import { getDb, resetDb, createSchema } from "../src/db.js";
import {
  getVaultDb,
  closeAllVaultDbs,
} from "../src/db-per-vault.js";
import { handleV2TaskDetail } from "../src/v2-task-detail.js";
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
  ).run("user_v2_detail", "detail-tester", "detail@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "user_v2_detail", slug, slug, join(TEST_DIR, "repos", slug));
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

/**
 * Build a minimal `ServerResponse` good enough for `handleV2TaskDetail`'s
 * `sendJson` path (`writeHead(status, headers) + end(body)`). Anything
 * beyond status/body is irrelevant to the contract under test.
 */
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

const req = {} as IncomingMessage;

describe("handleV2TaskDetail (P21-4)", () => {
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
    seedVault("vault_detail", "personal");
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
  });

  it("returns 404 when the task id is unknown", () => {
    // Open the vault db so the migrations run (otherwise the table
    // doesn't exist yet and the SELECT itself would 500).
    getVaultDb("vault_detail");

    const cap = makeRes();
    handleV2TaskDetail(req, cap.res, ctx("vault_detail", "personal"), "ghost_task");

    expect(cap.status).toBe(404);
    expect(cap.body).toEqual({ error: "task_not_found" });
  });

  it("returns the task with result=null when the task has no result row", () => {
    const db = getVaultDb("vault_detail");
    db.prepare(
      `INSERT INTO tasks (id, skill_slug, state, title, body, estimated_minutes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("t_pending", "enrichment", "pending", "Review your inbox", "ten unprocessed captures", 5);

    const cap = makeRes();
    handleV2TaskDetail(req, cap.res, ctx("vault_detail", "personal"), "t_pending");

    expect(cap.status).toBe(200);
    const body = cap.body as Record<string, unknown>;
    expect(body.id).toBe("t_pending");
    expect(body.skillId).toBe("enrichment");
    expect(body.title).toBe("Review your inbox");
    expect(body.description).toBe("ten unprocessed captures");
    expect(body.state).toBe("pending");
    expect(body.estimatedMinutes).toBe(5);
    expect(body.actualMinutes).toBeNull();
    expect(body.result).toBeNull();
  });

  it("parses provenance_json back to a GroveProvenance object on the result", () => {
    const db = getVaultDb("vault_detail");
    db.prepare(
      `INSERT INTO tasks (id, skill_slug, state, title)
       VALUES (?, ?, ?, ?)`,
    ).run("t_done", "enrichment", "done", "Surface a perishable note");
    db.prepare(
      `INSERT INTO task_results (task_id, artifact_json, provenance_json)
       VALUES (?, ?, ?)`,
    ).run(
      "t_done",
      JSON.stringify({ type: "surface", surfaceText: "this idea has gone cold" }),
      JSON.stringify({
        voice: "perishable",
        by: "claude-opus-4-7",
        writtenAt: "2026-05-14T12:00:00Z",
        reason: "single-conversation extraction; needs more cases",
      }),
    );

    const cap = makeRes();
    handleV2TaskDetail(req, cap.res, ctx("vault_detail", "personal"), "t_done");

    expect(cap.status).toBe(200);
    const body = cap.body as { result: { provenance: Record<string, unknown>; artifact: Record<string, unknown> } };
    expect(body.result).not.toBeNull();
    expect(body.result.artifact).toEqual({
      type: "surface",
      surfaceText: "this idea has gone cold",
    });
    expect(body.result.provenance).toEqual({
      voice: "perishable",
      by: "claude-opus-4-7",
      writtenAt: "2026-05-14T12:00:00Z",
      reason: "single-conversation extraction; needs more cases",
    });
  });

  it("falls back to a legacy-unknown provenance when provenance_json is null", () => {
    const db = getVaultDb("vault_detail");
    db.prepare(
      "INSERT INTO tasks (id, skill_slug, state, title) VALUES (?, ?, ?, ?)",
    ).run("t_legacy", "enrichment", "done", "Pre-provenance task");
    db.prepare(
      "INSERT INTO task_results (task_id, artifact_json) VALUES (?, ?)",
    ).run("t_legacy", JSON.stringify({ type: "surface" }));

    const cap = makeRes();
    handleV2TaskDetail(req, cap.res, ctx("vault_detail", "personal"), "t_legacy");

    const body = cap.body as { result: { provenance: { voice: string } } };
    expect(cap.status).toBe(200);
    expect(body.result.provenance).toEqual({ voice: "legacy-unknown" });
  });

  it("joins note_blame from control.db via ATTACH on note-change artifacts", () => {
    const db = getVaultDb("vault_detail");

    db.prepare(
      "INSERT INTO tasks (id, skill_slug, state, title, source_note_path) VALUES (?, ?, ?, ?, ?)",
    ).run("t_change", "concept-graph-cleanup", "review", "Tighten taste-graph note", "Resources/Concepts/Taste Graph.md");
    db.prepare(
      `INSERT INTO task_results (task_id, artifact_json, note_change_json, provenance_json)
       VALUES (?, ?, ?, ?)`,
    ).run(
      "t_change",
      JSON.stringify({
        type: "note-change",
        notePath: "Resources/Concepts/Taste Graph.md",
      }),
      JSON.stringify({ diff: "(unused — test fixture)" }),
      JSON.stringify({ voice: "perishable", by: "claude-opus-4-7" }),
    );

    // Seed note_blame in the control db — two segments authored by different agents.
    const blameJson = JSON.stringify([
      {
        line_start: 1,
        line_end: 12,
        commit_sha: "aaaa1111",
        voice: "durable",
        by: "human",
        written_at: "2026-04-01T09:00:00Z",
      },
      {
        line_start: 13,
        line_end: 20,
        commit_sha: "bbbb2222",
        voice: "perishable",
        by: "claude-opus-4-7",
        written_at: "2026-05-13T18:00:00Z",
        reason: "single-conversation synthesis",
      },
    ]);
    getDb()
      .prepare(
        `INSERT INTO note_blame (path, source_hash, blame_json, computed_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .run("Resources/Concepts/Taste Graph.md", "sha-test", blameJson);

    const cap = makeRes();
    handleV2TaskDetail(req, cap.res, ctx("vault_detail", "personal"), "t_change");

    expect(cap.status).toBe(200);
    const body = cap.body as {
      result: {
        artifact: { type: string; notePath: string };
        provenanceBlame: Array<{
          lineStart: number;
          lineEnd: number;
          provenance: { voice: string; by?: string; reason?: string };
        }>;
      };
      sourceNotes: string[];
    };
    expect(body.result.artifact.type).toBe("note-change");
    expect(body.sourceNotes).toEqual(["Resources/Concepts/Taste Graph.md"]);

    expect(body.result.provenanceBlame).toHaveLength(2);
    expect(body.result.provenanceBlame[0]).toEqual({
      lineStart: 1,
      lineEnd: 12,
      provenance: {
        voice: "durable",
        by: "human",
        writtenAt: "2026-04-01T09:00:00Z",
      },
    });
    expect(body.result.provenanceBlame[1]).toEqual({
      lineStart: 13,
      lineEnd: 20,
      provenance: {
        voice: "perishable",
        by: "claude-opus-4-7",
        writtenAt: "2026-05-13T18:00:00Z",
        reason: "single-conversation synthesis",
      },
    });
  });

  it("omits provenanceBlame when there's no cached blame row for the note", () => {
    const db = getVaultDb("vault_detail");
    db.prepare(
      "INSERT INTO tasks (id, skill_slug, state, title) VALUES (?, ?, ?, ?)",
    ).run("t_uncached", "concept-graph-cleanup", "review", "Edit untracked note");
    db.prepare(
      "INSERT INTO task_results (task_id, artifact_json) VALUES (?, ?)",
    ).run(
      "t_uncached",
      JSON.stringify({
        type: "note-change",
        notePath: "Resources/Concepts/Nothing Here.md",
      }),
    );

    const cap = makeRes();
    handleV2TaskDetail(req, cap.res, ctx("vault_detail", "personal"), "t_uncached");

    expect(cap.status).toBe(200);
    const body = cap.body as { result: Record<string, unknown> };
    expect(body.result).toBeDefined();
    expect("provenanceBlame" in body.result).toBe(false);
  });
});

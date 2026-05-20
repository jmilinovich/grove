/**
 * P21-3 — `GET /v/<slug>/v1/tasks` payload assembly.
 *
 * Tests `buildBacklogPayload(vaultId)` against a seeded per-vault
 * state.db. The HTTP wrapper (`handleV2TasksList`) is a one-liner that
 * delegates to this function and serialises the result; auth/403/401
 * are enforced upstream in `proxy.ts:vaultV1Match` and aren't this
 * module's concern.
 *
 * What we pin down:
 *   - Column aliases — Task rows arrive in grove-www's exact camelCase
 *     shape (skillId, description, scheduledFor, …) without a mapper.
 *   - Order — review newest-first; pending scheduled-ASC with NULLs
 *     last; cleared by completed_at DESC, capped at 20.
 *   - JOIN — `task_results.artifact_json` / `provenance_json` parse
 *     into the typed `Task.result` shape.
 *   - Skills — registry merged with per-vault skill_configs;
 *     installState flips on `enabled = 1`.
 *   - Throughput — pending count, cleared-7d count, velocity over 28d,
 *     showCeiling gated on vault age.
 *   - Isolation — a vault sees only its own tasks.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-v2-tasks-list-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import {
  buildBacklogPayload,
  computeThroughput,
} from "../src/v2-tasks.js";

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

function seedVault(id: string, slug: string, createdAt?: string): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run("user_v2", "tester", "tester@example.com");
  if (createdAt) {
    db.prepare(
      "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, "user_v2", slug, slug, join(TEST_DIR, "repos", slug), createdAt);
    // showCeiling reads from earliest vault_members.joined_at (Phase 21
    // spec D-7). Mirror the createdAt onto the membership row so this
    // helper sets up both halves in one call.
    db.prepare(
      "INSERT OR IGNORE INTO vault_members (user_id, vault_id, role, joined_at) VALUES (?, ?, ?, ?)",
    ).run("user_v2", id, "owner", createdAt);
  } else {
    db.prepare(
      "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
    ).run(id, "user_v2", slug, slug, join(TEST_DIR, "repos", slug));
    db.prepare(
      "INSERT OR IGNORE INTO vault_members (user_id, vault_id, role) VALUES (?, ?, ?)",
    ).run("user_v2", id, "owner");
  }
}

interface TaskSeed {
  id: string;
  skill_slug: string;
  state: string;
  title: string;
  body?: string;
  source_note_path?: string;
  scheduled_for?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  estimated_minutes?: number | null;
  actual_minutes?: number | null;
  created_at?: string;
}

function insertTask(vaultId: string, t: TaskSeed): void {
  const db = getVaultDb(vaultId);
  db.prepare(
    `INSERT INTO tasks (id, skill_slug, state, title, body, source_note_path,
                        scheduled_for, started_at, completed_at,
                        estimated_minutes, actual_minutes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  ).run(
    t.id,
    t.skill_slug,
    t.state,
    t.title,
    t.body ?? null,
    t.source_note_path ?? null,
    t.scheduled_for ?? null,
    t.started_at ?? null,
    t.completed_at ?? null,
    t.estimated_minutes ?? null,
    t.actual_minutes ?? null,
    t.created_at ?? null,
  );
}

function insertTaskResult(
  vaultId: string,
  taskId: string,
  artifact: object,
  provenance?: object,
): void {
  const db = getVaultDb(vaultId);
  db.prepare(
    "INSERT INTO task_results (task_id, artifact_json, provenance_json) VALUES (?, ?, ?)",
  ).run(
    taskId,
    JSON.stringify(artifact),
    provenance ? JSON.stringify(provenance) : null,
  );
}

describe("v2-tasks: buildBacklogPayload", () => {
  beforeEach(() => {
    resetDb();
    closeAllVaultDbs();
    rmSync(process.env.GROVE_VAULT_STATE_ROOT!, { recursive: true, force: true });
    rmSync(process.env.GROVE_VAULT_MIGRATIONS_DIR!, { recursive: true, force: true });
    rmSync(process.env.GROVE_DB_PATH!, { force: true });
    rmSync(`${process.env.GROVE_DB_PATH!}-wal`, { force: true });
    rmSync(`${process.env.GROVE_DB_PATH!}-shm`, { force: true });
    copyRealMigrations();
    createSchema();
  });

  afterEach(() => {
    closeAllVaultDbs();
  });

  it("returns empty arrays + planTier='free' for a fresh vault", () => {
    seedVault("vault_empty", "empty");

    const payload = buildBacklogPayload("vault_empty");

    expect(payload.reviewTasks).toEqual([]);
    expect(payload.pendingTasks).toEqual([]);
    expect(payload.clearedTasks).toEqual([]);
    expect(payload.planTier).toBe("free");
    expect(payload.throughput.pending).toBe(0);
    expect(payload.throughput.cleared7d).toBe(0);
    expect(payload.throughput.rollingWeekVelocity).toBeNull();
    expect(payload.throughput.estimatedClearText).toBe("all clear");
  });

  it("returns the 7 registry skills with installState='available' when no configs exist", () => {
    seedVault("vault_skills", "skills");

    const payload = buildBacklogPayload("vault_skills");

    expect(payload.skills).toHaveLength(7);
    expect(payload.skills.map((s) => s.slug).sort()).toEqual([
      "concept-graph-cleanup",
      "daily-vault-review",
      "disambiguation",
      "dup-people-detection",
      "enrichment",
      "links-suggestion",
      "refine-handler",
    ]);
    for (const skill of payload.skills) {
      expect(skill.installState).toBe("available");
      expect(skill.author).toBe("builtin");
      // grove-www-shape sanity: camelCase plural arrays, never snake.
      expect(Array.isArray(skill.sampleTasks)).toBe(true);
      expect(Array.isArray(skill.cadenceOptions)).toBe(true);
    }
  });

  it("flips skill installState to 'installed' when skill_configs.enabled = 1", () => {
    seedVault("vault_installed", "installed");
    const db = getVaultDb("vault_installed");
    db.prepare(
      "INSERT INTO skill_configs (skill_slug, enabled, cadence) VALUES (?, ?, ?)",
    ).run("daily-vault-review", 1, "daily");
    db.prepare(
      "INSERT INTO skill_configs (skill_slug, enabled, cadence) VALUES (?, ?, ?)",
    ).run("concept-graph-cleanup", 0, "weekly");

    const payload = buildBacklogPayload("vault_installed");
    const bySlug = new Map(payload.skills.map((s) => [s.slug, s]));
    expect(bySlug.get("daily-vault-review")?.installState).toBe("installed");
    expect(bySlug.get("concept-graph-cleanup")?.installState).toBe("available");
    expect(bySlug.get("dup-people-detection")?.installState).toBe("available");
  });

  it("aliases tasks columns to grove-www's camelCase Task shape", () => {
    seedVault("vault_aliases", "aliases");
    insertTask("vault_aliases", {
      id: "task-aliases-1",
      skill_slug: "daily-vault-review",
      state: "review",
      title: "today's patterns",
      body: "Three things stood out today.",
      source_note_path: "Journal/2026-05-14.md",
      scheduled_for: "2026-05-14T16:00:00Z",
      started_at: "2026-05-14T16:00:30Z",
      completed_at: "2026-05-14T16:02:14Z",
      estimated_minutes: 14,
      actual_minutes: 12,
      created_at: "2026-05-14T16:02:15Z",
    });

    const payload = buildBacklogPayload("vault_aliases");
    expect(payload.reviewTasks).toHaveLength(1);
    const task = payload.reviewTasks[0]!;
    // Field names must match grove-api.v2.types.ts Task exactly.
    expect(task.id).toBe("task-aliases-1");
    expect(task.skillId).toBe("daily-vault-review");
    expect(task.description).toBe("Three things stood out today.");
    expect(task.scheduledFor).toBe("2026-05-14T16:00:00Z");
    expect(task.startedAt).toBe("2026-05-14T16:00:30Z");
    expect(task.completedAt).toBe("2026-05-14T16:02:14Z");
    expect(task.estimatedMinutes).toBe(14);
    expect(task.actualMinutes).toBe(12);
    expect(task.state).toBe("review");
    expect(task.sourceNotes).toEqual(["Journal/2026-05-14.md"]);
    expect(task.result).toBeNull();
    // No snake_case keys leak through.
    expect((task as Record<string, unknown>).skill_slug).toBeUndefined();
    expect((task as Record<string, unknown>).scheduled_for).toBeUndefined();
  });

  it("defaults description and estimatedMinutes when DB columns are NULL", () => {
    seedVault("vault_defaults", "defaults");
    insertTask("vault_defaults", {
      id: "task-defaults-1",
      skill_slug: "daily-vault-review",
      state: "pending",
      title: "no body, no estimate",
    });

    const task = buildBacklogPayload("vault_defaults").pendingTasks[0]!;
    expect(task.description).toBe("");
    expect(task.estimatedMinutes).toBe(0);
    expect(task.actualMinutes).toBeNull();
    expect(task.sourceNotes).toBeUndefined();
  });

  it("orders reviewTasks newest-first by created_at", () => {
    seedVault("vault_review_order", "review-order");
    insertTask("vault_review_order", { id: "r-old", skill_slug: "daily-vault-review", state: "review", title: "old", created_at: "2026-05-10T10:00:00Z" });
    insertTask("vault_review_order", { id: "r-new", skill_slug: "daily-vault-review", state: "review", title: "new", created_at: "2026-05-14T10:00:00Z" });
    insertTask("vault_review_order", { id: "r-mid", skill_slug: "daily-vault-review", state: "review", title: "mid", created_at: "2026-05-12T10:00:00Z" });

    const payload = buildBacklogPayload("vault_review_order");
    expect(payload.reviewTasks.map((t) => t.id)).toEqual(["r-new", "r-mid", "r-old"]);
  });

  it("orders pendingTasks scheduled-first ASC, NULLs at the end, ties broken by created_at DESC", () => {
    seedVault("vault_pending_order", "pending-order");
    // Two scheduled (different times) + two unscheduled (different created_at).
    insertTask("vault_pending_order", { id: "p-sched-late", skill_slug: "daily-vault-review", state: "pending", title: "later sched", scheduled_for: "2026-05-20T10:00:00Z", created_at: "2026-05-13T08:00:00Z" });
    insertTask("vault_pending_order", { id: "p-sched-early", skill_slug: "daily-vault-review", state: "pending", title: "earlier sched", scheduled_for: "2026-05-15T10:00:00Z", created_at: "2026-05-13T09:00:00Z" });
    insertTask("vault_pending_order", { id: "p-null-new", skill_slug: "daily-vault-review", state: "pending", title: "unscheduled, new", scheduled_for: null, created_at: "2026-05-14T10:00:00Z" });
    insertTask("vault_pending_order", { id: "p-null-old", skill_slug: "daily-vault-review", state: "pending", title: "unscheduled, old", scheduled_for: null, created_at: "2026-05-10T10:00:00Z" });
    // 'running' is part of the pending bucket per SPEC §4.
    insertTask("vault_pending_order", { id: "p-running", skill_slug: "daily-vault-review", state: "running", title: "running", scheduled_for: "2026-05-14T08:00:00Z", started_at: "2026-05-14T08:00:00Z" });

    const payload = buildBacklogPayload("vault_pending_order");
    expect(payload.pendingTasks.map((t) => t.id)).toEqual([
      "p-running",      // scheduled 05-14 08:00
      "p-sched-early",  // scheduled 05-15 10:00
      "p-sched-late",   // scheduled 05-20 10:00
      "p-null-new",     // unscheduled, created 05-14
      "p-null-old",     // unscheduled, created 05-10
    ]);
  });

  it("orders clearedTasks by completed_at DESC and caps at 20", () => {
    seedVault("vault_cleared", "cleared");
    // Seed 25 done tasks with monotonically increasing completed_at.
    for (let i = 1; i <= 25; i++) {
      const day = String(i).padStart(2, "0");
      insertTask("vault_cleared", {
        id: `done-${day}`,
        skill_slug: "daily-vault-review",
        state: "done",
        title: `done ${day}`,
        completed_at: `2026-05-${day}T12:00:00Z`,
        created_at: `2026-05-${day}T11:59:00Z`,
      });
    }

    const payload = buildBacklogPayload("vault_cleared");
    expect(payload.clearedTasks).toHaveLength(20);
    // First entry must be the latest completed.
    expect(payload.clearedTasks[0]!.id).toBe("done-25");
    // Last entry of the capped slice (25 - 20 + 1 = 6).
    expect(payload.clearedTasks[19]!.id).toBe("done-06");
  });

  it("populates Task.result from task_results JSON join, parsing artifact + provenance", () => {
    seedVault("vault_result", "result");
    insertTask("vault_result", {
      id: "task-with-result",
      skill_slug: "concept-graph-cleanup",
      state: "review",
      title: "merge candidates",
      created_at: "2026-05-14T10:00:00Z",
    });
    insertTaskResult(
      "vault_result",
      "task-with-result",
      { type: "concept-merge", surfaceText: "Pappu ≈ Aparna" },
      {
        voice: "perishable",
        by: "claude-opus-4-7",
        writtenAt: "2026-05-14T10:00:30Z",
        reason: "high-similarity concept pair",
      },
    );

    const payload = buildBacklogPayload("vault_result");
    const task = payload.reviewTasks[0]!;
    expect(task.result).not.toBeNull();
    expect(task.result!.artifact.type).toBe("concept-merge");
    expect(task.result!.artifact.surfaceText).toBe("Pappu ≈ Aparna");
    expect(task.result!.provenance.voice).toBe("perishable");
    expect(task.result!.provenance.by).toBe("claude-opus-4-7");
    expect(task.result!.provenance.reason).toBe("high-similarity concept pair");
  });

  it("falls back to provenance.voice='legacy-unknown' when only artifact is present", () => {
    seedVault("vault_partial", "partial");
    insertTask("vault_partial", {
      id: "task-partial",
      skill_slug: "daily-vault-review",
      state: "done",
      title: "old task",
      completed_at: "2026-05-14T10:00:00Z",
    });
    insertTaskResult("vault_partial", "task-partial", { type: "surface", surfaceText: "n=7" });

    const task = buildBacklogPayload("vault_partial").clearedTasks[0]!;
    expect(task.result!.artifact.type).toBe("surface");
    expect(task.result!.provenance.voice).toBe("legacy-unknown");
  });

  it("computeThroughput: cleared7d, rollingWeekVelocity, pending, and estimatedClearText", () => {
    seedVault("vault_throughput", "throughput");
    const now = new Date();
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86400_000).toISOString();
    // 3 completed in the last 7 days.
    insertTask("vault_throughput", { id: "c1", skill_slug: "daily-vault-review", state: "done", title: "c1", completed_at: daysAgo(1) });
    insertTask("vault_throughput", { id: "c2", skill_slug: "daily-vault-review", state: "done", title: "c2", completed_at: daysAgo(3) });
    insertTask("vault_throughput", { id: "c3", skill_slug: "daily-vault-review", state: "done", title: "c3", completed_at: daysAgo(6) });
    // 5 more completed in the broader 28-day window (so velocity = 8 / 4 = 2).
    for (let i = 0; i < 5; i++) {
      insertTask("vault_throughput", {
        id: `c-old-${i}`,
        skill_slug: "daily-vault-review",
        state: "done",
        title: `c-old-${i}`,
        completed_at: daysAgo(15 + i),
      });
    }
    // 4 pending.
    for (let i = 0; i < 4; i++) {
      insertTask("vault_throughput", { id: `p${i}`, skill_slug: "daily-vault-review", state: "pending", title: `p${i}` });
    }

    const t = computeThroughput("vault_throughput");
    expect(t.cleared7d).toBe(3);
    expect(t.pending).toBe(4);
    expect(t.rollingWeekVelocity).toBe(2); // 8 / 4 weeks
    // 4 pending / 2 per week = 2 weeks.
    expect(t.estimatedClearText).toBe("≈2 weeks at your pace");
    expect(t.planCeiling).toBe(25);
  });

  it("showCeiling is false for a vault less than 14 days old and true once it's older", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86400_000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
    seedVault("vault_new", "new-vault", tenDaysAgo);
    seedVault("vault_old", "old-vault", thirtyDaysAgo);

    expect(computeThroughput("vault_new").showCeiling).toBe(false);
    expect(computeThroughput("vault_old").showCeiling).toBe(true);
  });

  it("a vault sees only its own tasks (per-vault state.db isolation)", () => {
    seedVault("vault_alpha", "alpha");
    seedVault("vault_bravo", "bravo");
    insertTask("vault_alpha", { id: "alpha-only", skill_slug: "daily-vault-review", state: "review", title: "alpha review" });
    insertTask("vault_bravo", { id: "bravo-only", skill_slug: "daily-vault-review", state: "review", title: "bravo review" });

    const alphaPayload = buildBacklogPayload("vault_alpha");
    const bravoPayload = buildBacklogPayload("vault_bravo");

    expect(alphaPayload.reviewTasks.map((t) => t.id)).toEqual(["alpha-only"]);
    expect(bravoPayload.reviewTasks.map((t) => t.id)).toEqual(["bravo-only"]);
  });
});

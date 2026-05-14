/**
 * P22-4 — `handleV2SkillEnable` / `handleV2SkillDisable` direct-call tests.
 *
 * `POST /v/<slug>/v1/skills/<skill-slug>/enable` flips `enabled=1` and
 * materializes `next_run_at` from the cadence (daily → +1d, weekly →
 * +7d, on-demand/on-trigger → NULL).
 *
 * `POST /v/<slug>/v1/skills/<skill-slug>/disable` flips `enabled=0` and
 * clears `next_run_at`.
 *
 * Both are idempotent UPSERTs and round-trip cleanly. Tests cover both
 * verbs against missing/existing rows, cadence-driven next_run_at, the
 * null-for-on-demand contract, slug 404s, and post-update Skill shape.
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-v2-skill-enable-disable-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import {
  handleV2SkillEnable,
  handleV2SkillDisable,
} from "../src/v2-skills.js";
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
  ).run("user_v2_en", "en-tester", "en@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "user_v2_en", slug, slug, join(TEST_DIR, "repos", slug));
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

function fetchRow(
  vaultId: string,
  slug: string,
): { enabled: number; cadence: string; next_run_at: string | null } | undefined {
  return getVaultDb(vaultId)
    .prepare(
      "SELECT enabled, cadence, next_run_at FROM skill_configs WHERE skill_slug = ?",
    )
    .get(slug) as
    | { enabled: number; cadence: string; next_run_at: string | null }
    | undefined;
}

describe("handleV2SkillEnable / handleV2SkillDisable (P22-4)", () => {
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
    seedVault("vault_en", "personal");
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
  });

  // ── enable ───────────────────────────────────────────────────────────

  it("enable on a missing row inserts enabled=1 with registry default cadence", async () => {
    const cap = makeRes();
    const req = makeReq();
    await handleV2SkillEnable(
      req,
      cap.res,
      ctx("vault_en", "personal"),
      "daily-vault-review",
    );

    expect(cap.status).toBe(200);
    const body = cap.body as { installState: string };
    expect(body.installState).toBe("installed");

    const row = fetchRow("vault_en", "daily-vault-review");
    expect(row?.enabled).toBe(1);
    // daily-vault-review's registry default is 'daily'.
    expect(row?.cadence).toBe("daily");
    // daily cadence → next_run_at ~ 24h ahead.
    expect(row?.next_run_at).not.toBeNull();
    const nextRunMs = new Date(row!.next_run_at!.replace(" ", "T") + "Z").getTime();
    const expectedMs = Date.now() + 24 * 60 * 60 * 1000;
    expect(Math.abs(nextRunMs - expectedMs)).toBeLessThan(60 * 1000);
  });

  it("enable preserves a previously-configured cadence", async () => {
    const db = getVaultDb("vault_en");
    // Pre-configured at weekly while still disabled.
    db.prepare(
      "INSERT INTO skill_configs (skill_slug, enabled, cadence) VALUES (?, ?, ?)",
    ).run("daily-vault-review", 0, "weekly");

    const cap = makeRes();
    const req = makeReq();
    await handleV2SkillEnable(
      req,
      cap.res,
      ctx("vault_en", "personal"),
      "daily-vault-review",
    );

    expect(cap.status).toBe(200);
    const row = fetchRow("vault_en", "daily-vault-review");
    expect(row?.enabled).toBe(1);
    expect(row?.cadence).toBe("weekly");
    // weekly cadence → +7 days.
    const nextRunMs = new Date(row!.next_run_at!.replace(" ", "T") + "Z").getTime();
    const expectedMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(nextRunMs - expectedMs)).toBeLessThan(60 * 1000);
  });

  it("enable with on-demand cadence leaves next_run_at NULL", async () => {
    const db = getVaultDb("vault_en");
    db.prepare(
      "INSERT INTO skill_configs (skill_slug, enabled, cadence) VALUES (?, ?, ?)",
    ).run("daily-vault-review", 0, "on-demand");

    const cap = makeRes();
    const req = makeReq();
    await handleV2SkillEnable(
      req,
      cap.res,
      ctx("vault_en", "personal"),
      "daily-vault-review",
    );

    expect(cap.status).toBe(200);
    const row = fetchRow("vault_en", "daily-vault-review");
    expect(row).toEqual({
      enabled: 1,
      cadence: "on-demand",
      next_run_at: null,
    });
  });

  it("enable with on-trigger cadence leaves next_run_at NULL", async () => {
    const db = getVaultDb("vault_en");
    db.prepare(
      "INSERT INTO skill_configs (skill_slug, enabled, cadence) VALUES (?, ?, ?)",
    ).run("daily-vault-review", 0, "on-trigger");

    const cap = makeRes();
    const req = makeReq();
    await handleV2SkillEnable(
      req,
      cap.res,
      ctx("vault_en", "personal"),
      "daily-vault-review",
    );

    expect(cap.status).toBe(200);
    const row = fetchRow("vault_en", "daily-vault-review");
    expect(row).toEqual({
      enabled: 1,
      cadence: "on-trigger",
      next_run_at: null,
    });
  });

  it("enable is idempotent and recomputes next_run_at on each call", async () => {
    const cap1 = makeRes();
    await handleV2SkillEnable(
      makeReq(),
      cap1.res,
      ctx("vault_en", "personal"),
      "concept-graph-cleanup",
    );
    expect(cap1.status).toBe(200);

    const firstRow = fetchRow("vault_en", "concept-graph-cleanup");
    expect(firstRow?.enabled).toBe(1);

    // Second call: still enabled, next_run_at updated to "now + cadence."
    const cap2 = makeRes();
    await handleV2SkillEnable(
      makeReq(),
      cap2.res,
      ctx("vault_en", "personal"),
      "concept-graph-cleanup",
    );
    expect(cap2.status).toBe(200);

    const secondRow = fetchRow("vault_en", "concept-graph-cleanup");
    expect(secondRow?.enabled).toBe(1);
    expect(secondRow?.cadence).toBe("weekly");
    expect(secondRow?.next_run_at).not.toBeNull();
  });

  it("enable returns 404 for an unknown skill slug", async () => {
    const cap = makeRes();
    await handleV2SkillEnable(
      makeReq(),
      cap.res,
      ctx("vault_en", "personal"),
      "not-a-real-skill",
    );

    expect(cap.status).toBe(404);
    expect(cap.body).toEqual({ error: "skill_not_found" });
  });

  // ── disable ──────────────────────────────────────────────────────────

  it("disable on an enabled row flips enabled to 0 and clears next_run_at", async () => {
    // Enable first so we have a non-null next_run_at to clear.
    await handleV2SkillEnable(
      makeReq(),
      makeRes().res,
      ctx("vault_en", "personal"),
      "daily-vault-review",
    );
    expect(fetchRow("vault_en", "daily-vault-review")?.enabled).toBe(1);

    const cap = makeRes();
    await handleV2SkillDisable(
      makeReq(),
      cap.res,
      ctx("vault_en", "personal"),
      "daily-vault-review",
    );

    expect(cap.status).toBe(200);
    const body = cap.body as { installState: string };
    expect(body.installState).toBe("available");

    const row = fetchRow("vault_en", "daily-vault-review");
    expect(row?.enabled).toBe(0);
    expect(row?.next_run_at).toBeNull();
    // Cadence is preserved across enable/disable cycles.
    expect(row?.cadence).toBe("daily");
  });

  it("disable on a missing row creates a disabled row with default cadence", async () => {
    const cap = makeRes();
    await handleV2SkillDisable(
      makeReq(),
      cap.res,
      ctx("vault_en", "personal"),
      "dup-people-detection",
    );

    expect(cap.status).toBe(200);
    const row = fetchRow("vault_en", "dup-people-detection");
    // Registry default for dup-people-detection is 'weekly'.
    expect(row).toEqual({
      enabled: 0,
      cadence: "weekly",
      next_run_at: null,
    });
  });

  it("disable is idempotent", async () => {
    const cap1 = makeRes();
    await handleV2SkillDisable(
      makeReq(),
      cap1.res,
      ctx("vault_en", "personal"),
      "daily-vault-review",
    );
    expect(cap1.status).toBe(200);

    const cap2 = makeRes();
    await handleV2SkillDisable(
      makeReq(),
      cap2.res,
      ctx("vault_en", "personal"),
      "daily-vault-review",
    );
    expect(cap2.status).toBe(200);

    const row = fetchRow("vault_en", "daily-vault-review");
    expect(row?.enabled).toBe(0);
    expect(row?.next_run_at).toBeNull();
  });

  it("disable returns 404 for an unknown skill slug", async () => {
    const cap = makeRes();
    await handleV2SkillDisable(
      makeReq(),
      cap.res,
      ctx("vault_en", "personal"),
      "not-a-real-skill",
    );

    expect(cap.status).toBe(404);
    expect(cap.body).toEqual({ error: "skill_not_found" });
  });

  // ── round-trip ───────────────────────────────────────────────────────

  it("enable → disable → enable round-trip preserves cadence each step", async () => {
    // Enable: cadence falls back to registry default 'daily'.
    await handleV2SkillEnable(
      makeReq(),
      makeRes().res,
      ctx("vault_en", "personal"),
      "daily-vault-review",
    );
    expect(fetchRow("vault_en", "daily-vault-review")).toMatchObject({
      enabled: 1,
      cadence: "daily",
    });

    // Disable: enabled flips off; cadence preserved; next_run_at cleared.
    await handleV2SkillDisable(
      makeReq(),
      makeRes().res,
      ctx("vault_en", "personal"),
      "daily-vault-review",
    );
    expect(fetchRow("vault_en", "daily-vault-review")).toMatchObject({
      enabled: 0,
      cadence: "daily",
      next_run_at: null,
    });

    // Re-enable: cadence still 'daily'; next_run_at re-materialized.
    await handleV2SkillEnable(
      makeReq(),
      makeRes().res,
      ctx("vault_en", "personal"),
      "daily-vault-review",
    );
    const final = fetchRow("vault_en", "daily-vault-review");
    expect(final?.enabled).toBe(1);
    expect(final?.cadence).toBe("daily");
    expect(final?.next_run_at).not.toBeNull();
  });

  it("scopes writes to the calling vault", async () => {
    seedVault("vault_other", "other");
    await handleV2SkillEnable(
      makeReq(),
      makeRes().res,
      ctx("vault_en", "personal"),
      "daily-vault-review",
    );

    const otherCount = (
      getVaultDb("vault_other")
        .prepare("SELECT COUNT(*) AS n FROM skill_configs")
        .get() as { n: number }
    ).n;
    expect(otherCount).toBe(0);
  });
});

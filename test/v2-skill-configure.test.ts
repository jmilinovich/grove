/**
 * P22-4 — `handleV2SkillConfigure` direct-call tests.
 *
 * `POST /v/<slug>/v1/skills/<skill-slug>/configure` updates the per-vault
 * cadence stored in `skill_configs`. The handler UPSERTs:
 *   - missing row → INSERT (enabled=0 default, cadence as posted)
 *   - existing row → UPDATE cadence only (preserves `enabled`)
 *
 * Tests pin: happy-path cadence change; UPSERT-without-flipping-enabled;
 * 404 on unknown slug; 400 on invalid cadence; 400 on malformed body;
 * post-update response matches the Skill wire shape.
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-v2-skill-configure-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import { handleV2SkillConfigure } from "../src/v2-skills.js";
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
  ).run("user_v2_cfg", "configure-tester", "configure@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "user_v2_cfg", slug, slug, join(TEST_DIR, "repos", slug));
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

describe("handleV2SkillConfigure (P22-4)", () => {
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
    seedVault("vault_cfg", "personal");
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
  });

  it("inserts a new skill_configs row on first configure (enabled defaults to 0)", async () => {
    const cap = makeRes();
    const req = makeReq(JSON.stringify({ cadence: "weekly" }));
    await handleV2SkillConfigure(
      req,
      cap.res,
      ctx("vault_cfg", "personal"),
      "enrichment",
    );

    expect(cap.status).toBe(200);
    const body = cap.body as { slug: string; installState: string };
    expect(body.slug).toBe("enrichment");
    // No prior /enable → row exists with enabled=0 → installState='available'.
    expect(body.installState).toBe("available");

    const row = getVaultDb("vault_cfg")
      .prepare(
        "SELECT enabled, cadence FROM skill_configs WHERE skill_slug = ?",
      )
      .get("enrichment") as { enabled: number; cadence: string };
    expect(row).toEqual({ enabled: 0, cadence: "weekly" });
  });

  it("updates cadence on an existing row without flipping enabled", async () => {
    const db = getVaultDb("vault_cfg");
    // Pre-existing enabled row at cadence='daily'.
    db.prepare(
      "INSERT INTO skill_configs (skill_slug, enabled, cadence) VALUES (?, ?, ?)",
    ).run("enrichment", 1, "daily");

    const cap = makeRes();
    const req = makeReq(JSON.stringify({ cadence: "on-demand" }));
    await handleV2SkillConfigure(
      req,
      cap.res,
      ctx("vault_cfg", "personal"),
      "enrichment",
    );

    expect(cap.status).toBe(200);
    const body = cap.body as { installState: string };
    // enabled was 1 → stays installed; configure does not disable.
    expect(body.installState).toBe("installed");

    const row = db
      .prepare("SELECT enabled, cadence FROM skill_configs WHERE skill_slug = ?")
      .get("enrichment") as { enabled: number; cadence: string };
    expect(row).toEqual({ enabled: 1, cadence: "on-demand" });
  });

  it("accepts all four valid cadence values", async () => {
    for (const cadence of ["daily", "weekly", "on-trigger", "on-demand"]) {
      const cap = makeRes();
      const req = makeReq(JSON.stringify({ cadence }));
      await handleV2SkillConfigure(
        req,
        cap.res,
        ctx("vault_cfg", "personal"),
        "enrichment",
      );
      expect(cap.status).toBe(200);
      const row = getVaultDb("vault_cfg")
        .prepare("SELECT cadence FROM skill_configs WHERE skill_slug = ?")
        .get("enrichment") as { cadence: string };
      expect(row.cadence).toBe(cadence);
    }
  });

  it("returns 404 for an unknown skill slug", async () => {
    const cap = makeRes();
    const req = makeReq(JSON.stringify({ cadence: "weekly" }));
    await handleV2SkillConfigure(
      req,
      cap.res,
      ctx("vault_cfg", "personal"),
      "not-a-real-skill",
    );

    expect(cap.status).toBe(404);
    expect(cap.body).toEqual({ error: "skill_not_found" });

    // No row should have been written.
    const row = getVaultDb("vault_cfg")
      .prepare("SELECT COUNT(*) AS n FROM skill_configs")
      .get() as { n: number };
    expect(row.n).toBe(0);
  });

  it("returns 400 on invalid cadence", async () => {
    const cap = makeRes();
    const req = makeReq(JSON.stringify({ cadence: "hourly" }));
    await handleV2SkillConfigure(
      req,
      cap.res,
      ctx("vault_cfg", "personal"),
      "enrichment",
    );

    expect(cap.status).toBe(400);
    expect(cap.body).toEqual({ error: "invalid_cadence" });
  });

  it("returns 400 when cadence is missing", async () => {
    const cap = makeRes();
    const req = makeReq(JSON.stringify({}));
    await handleV2SkillConfigure(
      req,
      cap.res,
      ctx("vault_cfg", "personal"),
      "enrichment",
    );

    expect(cap.status).toBe(400);
    expect(cap.body).toEqual({ error: "invalid_cadence" });
  });

  it("returns 400 on malformed JSON", async () => {
    const cap = makeRes();
    const req = makeReq("{this is not json");
    await handleV2SkillConfigure(
      req,
      cap.res,
      ctx("vault_cfg", "personal"),
      "enrichment",
    );

    expect(cap.status).toBe(400);
    expect(cap.body).toEqual({ error: "invalid_json" });
  });

  it("response body shape matches the canonical Skill interface", async () => {
    const cap = makeRes();
    const req = makeReq(JSON.stringify({ cadence: "weekly" }));
    await handleV2SkillConfigure(
      req,
      cap.res,
      ctx("vault_cfg", "personal"),
      "concept-graph-cleanup",
    );

    expect(cap.status).toBe(200);
    const body = cap.body as Record<string, unknown>;
    expect(body).toMatchObject({
      id: "skill-concept-graph-cleanup",
      slug: "concept-graph-cleanup",
      author: "builtin",
      domain: "knowledge",
      installState: "available",
      // defaultCadence is the *registry* default; it does NOT change with
      // configure. (Configure stores the chosen cadence in skill_configs;
      // the wire shape's defaultCadence reflects the metadata.)
      defaultCadence: "weekly",
    });
    expect(Array.isArray(body.sampleTasks)).toBe(true);
    expect(Array.isArray(body.cadenceOptions)).toBe(true);
  });

  it("scopes the UPSERT to the calling vault", async () => {
    seedVault("vault_other", "other");
    const cap = makeRes();
    const req = makeReq(JSON.stringify({ cadence: "on-demand" }));
    await handleV2SkillConfigure(
      req,
      cap.res,
      ctx("vault_cfg", "personal"),
      "enrichment",
    );
    expect(cap.status).toBe(200);

    const otherCount = (
      getVaultDb("vault_other")
        .prepare("SELECT COUNT(*) AS n FROM skill_configs")
        .get() as { n: number }
    ).n;
    expect(otherCount).toBe(0);
  });
});

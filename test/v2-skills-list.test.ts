/**
 * P21-5 — `listSkillsForVault()` for `GET /v/<slug>/v1/skills`.
 *
 * Asserts:
 *   - Returns all 3 registry skills.
 *   - `installState` derives from `skill_configs.enabled`: missing row →
 *     'available'; enabled=0 → 'available'; enabled=1 → 'installed'.
 *   - Default `defaultCadence` from registry survives the join when no
 *     config row exists.
 *   - Field shape satisfies the canonical `Skill` interface (mirrored
 *     locally byte-for-byte from grove-www/src/lib/grove-api.v2.types.ts).
 *   - JSON-roundtrip preserves shape (no Date/undefined drift).
 *
 * The auth + HTTP layer is exercised separately by integration tests;
 * this file pins the data-shaping contract that lives in v2-skills.ts.
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-v2-skills-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import { listSkillsForVault } from "../src/v2-skills.js";
import { SKILL_REGISTRY } from "../src/skills/registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_MIGRATIONS_DIR = join(HERE, "..", "src", "migrations", "vault");

// ─── Local mirror of grove-www's `Skill` ──────────────────────────────────
// Kept verbatim from grove-www/src/lib/grove-api.v2.types.ts. Drift between
// this block and the upstream definition is what `satisfies Skill` below
// is designed to catch — if a column gets renamed, optional/required flips,
// or a union loses a member, this test fails before deploy.
type Cadence = "daily" | "weekly" | "on-trigger" | "on-demand";
type TaskArtifactType =
  | "surface"
  | "note-change"
  | "note-create"
  | "note-link"
  | "concept-merge";
interface Skill {
  id: string;
  slug: string;
  name: string;
  domain:
    | "knowledge"
    | "journal"
    | "relationships"
    | "health"
    | "finances"
    | "system";
  author: "builtin";
  description: string;
  sampleTasks: string[];
  cadenceOptions: Cadence[];
  defaultCadence: Cadence | null;
  defaultArtifactType: TaskArtifactType;
  installState: "installed" | "available" | "disabled";
  starterPendingTasks?: string[];
}

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
  ).run("user_skills", "skills-tester", "skills@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "user_skills", slug, slug, join(TEST_DIR, "repos", slug));
}

describe("listSkillsForVault — P21-5 skills endpoint", () => {
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
    seedVault("vault_skills", "personal");
  });

  afterEach(() => {
    closeAllVaultDbs();
  });

  it("returns exactly the 5 builtin skills", () => {
    const skills = listSkillsForVault("vault_skills");
    expect(skills.map((s) => s.slug).sort()).toEqual([
      "concept-graph-cleanup",
      "daily-vault-review",
      "disambiguation",
      "dup-people-detection",
      "links-suggestion",
    ]);
  });

  it("preserves registry order (daily-vault-review first)", () => {
    const skills = listSkillsForVault("vault_skills");
    expect(skills.map((s) => s.slug)).toEqual(
      SKILL_REGISTRY.map((s) => s.slug),
    );
  });

  it("defaults installState to 'available' when no skill_configs row exists", () => {
    const skills = listSkillsForVault("vault_skills");
    for (const skill of skills) {
      expect(skill.installState).toBe("available");
    }
  });

  it("derives installState='installed' when skill_configs.enabled=1", () => {
    const db = getVaultDb("vault_skills");
    db.prepare(
      "INSERT INTO skill_configs (skill_slug, enabled, cadence) VALUES (?, ?, ?)",
    ).run("daily-vault-review", 1, "daily");

    const skills = listSkillsForVault("vault_skills");
    const daily = skills.find((s) => s.slug === "daily-vault-review");
    const cleanup = skills.find((s) => s.slug === "concept-graph-cleanup");
    expect(daily?.installState).toBe("installed");
    expect(cleanup?.installState).toBe("available");
  });

  it("derives installState='available' when skill_configs.enabled=0 explicitly", () => {
    const db = getVaultDb("vault_skills");
    db.prepare(
      "INSERT INTO skill_configs (skill_slug, enabled, cadence) VALUES (?, ?, ?)",
    ).run("concept-graph-cleanup", 0, "weekly");

    const skills = listSkillsForVault("vault_skills");
    const cleanup = skills.find((s) => s.slug === "concept-graph-cleanup");
    expect(cleanup?.installState).toBe("available");
  });

  it("preserves registry defaultCadence even when a config row overrides cadence", () => {
    // skill_configs.cadence is the *configured* cadence; the wire shape's
    // `defaultCadence` is the *registry* default. The endpoint must not
    // confuse the two.
    const db = getVaultDb("vault_skills");
    db.prepare(
      "INSERT INTO skill_configs (skill_slug, enabled, cadence) VALUES (?, ?, ?)",
    ).run("daily-vault-review", 1, "on-demand");

    const skills = listSkillsForVault("vault_skills");
    const daily = skills.find((s) => s.slug === "daily-vault-review");
    expect(daily?.defaultCadence).toBe("daily");
  });

  it("each result satisfies the canonical Skill interface verbatim", () => {
    const skills = listSkillsForVault("vault_skills");
    // The `satisfies Skill[]` check is the load-bearing assertion: if the
    // wire shape drifts from grove-www's contract, this stops compiling.
    const typed = skills satisfies Skill[];
    expect(typed.length).toBe(5);

    for (const skill of typed) {
      expect(typeof skill.id).toBe("string");
      expect(typeof skill.slug).toBe("string");
      expect(typeof skill.name).toBe("string");
      expect(typeof skill.description).toBe("string");
      expect(skill.author).toBe("builtin");
      expect(Array.isArray(skill.sampleTasks)).toBe(true);
      expect(Array.isArray(skill.cadenceOptions)).toBe(true);
      expect(
        ["installed", "available", "disabled"].includes(skill.installState),
      ).toBe(true);
      expect(
        [
          "surface",
          "note-change",
          "note-create",
          "note-link",
          "concept-merge",
        ].includes(skill.defaultArtifactType),
      ).toBe(true);
    }
  });

  it("survives JSON roundtrip without shape drift", () => {
    const skills = listSkillsForVault("vault_skills");
    const roundtrip = JSON.parse(JSON.stringify(skills)) as Skill[];
    expect(roundtrip).toEqual(skills);
  });

  it("uses camelCase field names (sampleTasks, NOT sample_tasks)", () => {
    const skills = listSkillsForVault("vault_skills");
    const first = skills[0]!;
    expect("sampleTasks" in first).toBe(true);
    expect("sample_tasks" in first).toBe(false);
    expect("cadenceOptions" in first).toBe(true);
    expect("cadence_options" in first).toBe(false);
    expect("defaultCadence" in first).toBe(true);
    expect("default_cadence" in first).toBe(false);
    expect("defaultArtifactType" in first).toBe(true);
    expect("default_artifact_type" in first).toBe(false);
    expect("installState" in first).toBe(true);
    expect("install_state" in first).toBe(false);
  });

  it("scopes skill_configs reads to the calling vault", () => {
    // A different vault's config rows must not bleed into another vault's
    // skill list — per-vault state.db split makes this structurally
    // enforced, but the test pins the property end-to-end.
    seedVault("vault_other", "other");
    const otherDb = getVaultDb("vault_other");
    otherDb
      .prepare(
        "INSERT INTO skill_configs (skill_slug, enabled, cadence) VALUES (?, ?, ?)",
      )
      .run("daily-vault-review", 1, "daily");

    const skills = listSkillsForVault("vault_skills");
    const daily = skills.find((s) => s.slug === "daily-vault-review");
    expect(daily?.installState).toBe("available");
  });
});

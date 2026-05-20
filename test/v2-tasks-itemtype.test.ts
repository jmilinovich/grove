/**
 * S-INBOX-9 — falsifier for the backlog API's `itemType` + `options`
 * hydration AND the lazy Decision → Task bridge.
 *
 * Two coupled responsibilities, one test file:
 *
 *   1. `bridgeDecisionsToTasks(vaultId)` — for each provisional Decision
 *      whose `task_id IS NULL`, mint a review-state Task and link them.
 *      Idempotent; compensated decisions are skipped.
 *
 *   2. `buildBacklogPayload(vaultId)` — calls the bridge first, then
 *      LEFT JOINs the decisions table on review rows so each review
 *      Task DTO carries `itemType` + `options` (parsed). Legacy review
 *      tasks with no backing decision leave both undefined.
 *
 * Mirrors `test/decision-writer.test.ts` for the fixture pattern (real
 * migrations 001/002/003 copied into a temp dir).
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-v2-tasks-itemtype-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");
process.env.GROVE_DISABLE_TASK_WORKER = "1";

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import { buildBacklogPayload } from "../src/v2-tasks.js";
import { bridgeDecisionsToTasks } from "../src/decision-writer.js";
import type { Decision } from "../src/v2-decisions.js";

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

const VAULT_ID = "vault_itemtype";
const VAULT_SLUG = "itemtype-test";

function seedControl(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run("user_it", "it-tester", "it@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(
    VAULT_ID,
    "user_it",
    VAULT_SLUG,
    VAULT_SLUG,
    join(TEST_DIR, "repos", VAULT_SLUG),
  );
  db.prepare(
    "INSERT OR IGNORE INTO vault_members (user_id, vault_id, role) VALUES (?, ?, ?)",
  ).run("user_it", VAULT_ID, "owner");
}

function insertDecision(decision: Decision): void {
  const db = getVaultDb(VAULT_ID);
  db.prepare(
    `INSERT INTO decisions
       (id, type, skill_run_id, task_id, created_at, status,
        payload_json, options_json, chosen_option_id,
        affected_paths_json, compensated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    decision.id,
    decision.type,
    decision.skillRunId,
    decision.taskId,
    decision.createdAt,
    decision.status,
    JSON.stringify(decision.payload),
    JSON.stringify(decision.options),
    decision.chosenOptionId,
    JSON.stringify(decision.affectedPaths),
    decision.compensatedBy,
  );
}

function disambiguationDecision(id = "D-2026-05-20-001"): Decision {
  return {
    id,
    type: "disambiguation",
    skillRunId: "SR-2026-05-20-aaa",
    taskId: null,
    createdAt: "2026-05-20T14:33:12Z",
    status: "provisional",
    payload: {
      source_path: "Journal/2026-05-20.md",
      surface_form: "Anna",
      candidates: [
        { note_path: "Resources/People/Anna Chen.md", signals: ["designer"] },
        { note_path: "Resources/People/Anna Kim.md", signals: ["PM"] },
      ],
    },
    options: [
      { id: "opt-1", label: "Link to Anna Chen", source: "schema" },
      { id: "opt-2", label: "Link to Anna Kim", source: "schema" },
      { id: "opt-3", label: "Keep ambiguous", source: "schema" },
    ],
    chosenOptionId: "opt-1",
    affectedPaths: ["Journal/2026-05-20.md"],
    compensatedBy: null,
  };
}

function linkDecision(id = "D-2026-05-20-002"): Decision {
  return {
    id,
    type: "link",
    skillRunId: "SR-2026-05-20-bbb",
    taskId: null,
    createdAt: "2026-05-20T14:35:00Z",
    status: "provisional",
    payload: {
      source_path: "Journal/2026-05-20.md",
      surface_form: "Voyage",
      target_path: "Resources/Companies/Voyage AI.md",
      candidates: [{ note_path: "Resources/Companies/Voyage AI.md" }],
    },
    options: [
      { id: "opt-1", label: "link to Voyage AI", source: "schema" },
      { id: "opt-2", label: "do not link", source: "schema" },
    ],
    chosenOptionId: "opt-1",
    affectedPaths: ["Journal/2026-05-20.md"],
    compensatedBy: null,
  };
}

function enrichmentDecision(id = "D-2026-05-20-003"): Decision {
  return {
    id,
    type: "enrichment",
    skillRunId: "SR-2026-05-20-ccc",
    taskId: null,
    createdAt: "2026-05-20T14:37:42Z",
    status: "provisional",
    payload: {
      target_path: "Resources/Concepts/Taste Graph.md",
      prior_content: "# Taste Graph\n\nthin stub.\n",
      new_content:
        "# Taste Graph\n\nthin stub.\n\nExpanded paragraph 1...\n\nExpanded paragraph 2...\n",
    },
    options: [
      { id: "opt-1", label: "apply enrichment", source: "schema" },
      { id: "opt-2", label: "dismiss", source: "schema" },
    ],
    chosenOptionId: "opt-1",
    affectedPaths: ["Resources/Concepts/Taste Graph.md"],
    compensatedBy: null,
  };
}

function freshTestState(): void {
  resetDb();
  closeAllVaultDbs();
  rmSync(process.env.GROVE_VAULT_STATE_ROOT!, { recursive: true, force: true });
  rmSync(process.env.GROVE_VAULT_MIGRATIONS_DIR!, {
    recursive: true,
    force: true,
  });
  rmSync(process.env.GROVE_DB_PATH!, { force: true });
  rmSync(`${process.env.GROVE_DB_PATH!}-wal`, { force: true });
  rmSync(`${process.env.GROVE_DB_PATH!}-shm`, { force: true });
  copyRealMigrations();
  createSchema();
  seedControl();
  // Force per-vault state.db init so migrations run before first read.
  getVaultDb(VAULT_ID);
}

describe("S-INBOX-9 — backlog itemType/options + bridge", () => {
  beforeEach(() => {
    freshTestState();
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
  });

  it("bridge mints review-state Tasks for orphan provisional Decisions", () => {
    insertDecision(disambiguationDecision());
    insertDecision(linkDecision());
    insertDecision(enrichmentDecision());

    const payload = buildBacklogPayload(VAULT_ID);

    expect(payload.reviewTasks).toHaveLength(3);

    // Every minted Task got an id, sits in review state, and carries
    // the right skill_slug for its decision type.
    const bySkill = new Map(payload.reviewTasks.map((t) => [t.skillId, t]));
    expect(bySkill.has("disambiguation")).toBe(true);
    expect(bySkill.has("links-suggestion")).toBe(true);
    expect(bySkill.has("enrichment")).toBe(true);
    for (const t of payload.reviewTasks) {
      expect(typeof t.id).toBe("string");
      expect(t.id.length).toBeGreaterThan(0);
      expect(t.state).toBe("review");
    }

    // The decisions row has been linked back to the new task.
    const db = getVaultDb(VAULT_ID);
    const rows = db
      .prepare(
        "SELECT id, task_id FROM decisions WHERE status = 'provisional'",
      )
      .all() as Array<{ id: string; task_id: string | null }>;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.task_id).not.toBeNull();
    }
  });

  it("review DTOs hydrate itemType + options from the JOINed decision", () => {
    insertDecision(disambiguationDecision());
    insertDecision(linkDecision());
    insertDecision(enrichmentDecision());

    const payload = buildBacklogPayload(VAULT_ID);
    expect(payload.reviewTasks).toHaveLength(3);

    const byItemType = new Map(
      payload.reviewTasks.map((t) => [t.itemType, t]),
    );

    const dis = byItemType.get("disambiguation");
    expect(dis).toBeDefined();
    expect(dis!.itemType).toBe("disambiguation");
    expect(dis!.options).toHaveLength(3);
    expect(dis!.options?.[0]?.id).toBe("opt-1");

    const lnk = byItemType.get("link");
    expect(lnk).toBeDefined();
    expect(lnk!.itemType).toBe("link");
    expect(lnk!.options).toHaveLength(2);

    const enr = byItemType.get("enrichment");
    expect(enr).toBeDefined();
    expect(enr!.itemType).toBe("enrichment");
    expect(enr!.options).toHaveLength(2);
  });

  it("legacy review tasks with no decision surface with itemType/options undefined", () => {
    // Seed a review-state Task directly (no Decision row).
    const db = getVaultDb(VAULT_ID);
    db.prepare(
      `INSERT INTO tasks (id, skill_slug, state, title, body)
       VALUES ('legacy_1', 'daily-vault-review', 'review', 'Legacy review item', '.')`,
    ).run();

    const payload = buildBacklogPayload(VAULT_ID);
    expect(payload.reviewTasks).toHaveLength(1);

    const t = payload.reviewTasks[0]!;
    expect(t.id).toBe("legacy_1");
    expect(t.itemType).toBeUndefined();
    expect(t.options).toBeUndefined();

    // And the serialized JSON should not carry the keys at all so the
    // wire shape matches grove-www's "field is absent vs null" choice.
    const wire = JSON.parse(JSON.stringify(t));
    expect("itemType" in wire).toBe(false);
    expect("options" in wire).toBe(false);
  });

  it("bridge is idempotent — second call creates no duplicate Tasks", () => {
    insertDecision(disambiguationDecision());
    insertDecision(linkDecision());

    const first = buildBacklogPayload(VAULT_ID);
    expect(first.reviewTasks).toHaveLength(2);
    const firstIds = first.reviewTasks.map((t) => t.id).sort();

    // Second call exercises the lazy bridge again. Both Decisions
    // already have task_id non-null, so no new Task is inserted.
    const second = buildBacklogPayload(VAULT_ID);
    expect(second.reviewTasks).toHaveLength(2);
    const secondIds = second.reviewTasks.map((t) => t.id).sort();
    expect(secondIds).toEqual(firstIds);

    // And the underlying tasks table has exactly 2 rows.
    const count = getVaultDb(VAULT_ID)
      .prepare("SELECT COUNT(*) AS n FROM tasks")
      .get() as { n: number };
    expect(count.n).toBe(2);

    // Direct bridge call also returns 0 created on a second pass.
    const bridged = bridgeDecisionsToTasks(VAULT_ID);
    expect(bridged.created).toBe(0);
  });

  it("compensated decisions are not bridged", () => {
    const compensated = disambiguationDecision("D-compensated-001");
    compensated.status = "compensated";
    compensated.compensatedBy = "D-some-other-001";
    insertDecision(compensated);

    const payload = buildBacklogPayload(VAULT_ID);
    expect(payload.reviewTasks).toHaveLength(0);

    const count = getVaultDb(VAULT_ID)
      .prepare("SELECT COUNT(*) AS n FROM tasks")
      .get() as { n: number };
    expect(count.n).toBe(0);

    // Decision still has no task_id (bridge skipped it).
    const row = getVaultDb(VAULT_ID)
      .prepare("SELECT task_id FROM decisions WHERE id = ?")
      .get("D-compensated-001") as { task_id: string | null };
    expect(row.task_id).toBeNull();
  });

  it("synthesizes per-type title + description per spec", () => {
    insertDecision(disambiguationDecision());
    insertDecision(linkDecision());
    insertDecision(enrichmentDecision());

    const payload = buildBacklogPayload(VAULT_ID);
    const byType = new Map(payload.reviewTasks.map((t) => [t.itemType, t]));

    const dis = byType.get("disambiguation")!;
    expect(dis.title).toBe("Disambiguate: Anna in 2026-05-20.md");
    expect(dis.description).toBe(
      "Grove linked to Anna Chen. Confirm or pick a different candidate.",
    );

    const lnk = byType.get("link")!;
    expect(lnk.title).toBe("Link suggestion: Voyage in 2026-05-20.md");
    expect(lnk.description).toBe(
      "Grove linked to Voyage AI. Confirm or dismiss.",
    );

    const enr = byType.get("enrichment")!;
    expect(enr.title).toBe("Enrich: Taste Graph.md");
    expect(enr.description).toBe(
      "Grove drafted an expansion. Apply, dismiss, or refine.",
    );
  });
});

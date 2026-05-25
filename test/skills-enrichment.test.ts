/**
 * S-INBOX-8 — Enrichment skill falsifier.
 *
 * Seven sub-tests per the spec:
 *
 *   1. Single thin Concept with 3 backlinks → 1 decision recorded with
 *      type='enrichment', payload.prior_content captured as the EXACT
 *      pre-enrichment file content (frontmatter + body), Concept note
 *      now has the drafted paragraphs appended.
 *
 *   2. Concept with < 3 backlinks skipped — thin body but only 1
 *      backlink → 0 decisions.
 *
 *   3. Already-thick Concept skipped — body > 200 chars → 0 decisions
 *      even with many backlinks.
 *
 *   4. Cost ceiling hit — `tokenCeiling` set absurdly low → 0 decisions,
 *      `ceilingHit: true`, no Anthropic call attempted (the mock's
 *      `create` spy is never invoked).
 *
 *   5. `surface-only` mode — LLM is called, decisions are recorded, but
 *      the Concept note on disk is NOT mutated and no skill-run commit
 *      lands.
 *
 *   6. `maxDecisions` cap — seed 8 thin Concepts (each with 3
 *      backlinks), `maxDecisions: 3` → exactly 3 decisions.
 *
 *   7. Compensation round-trip — seed 1 thin Concept, run enrichment,
 *      call `compensateDecision`, assert the Concept file matches
 *      `payload.prior_content` BYTE-FOR-BYTE. This is the load-bearing
 *      test for the spec's "restore on rollback" contract.
 *
 * Mock pattern: a single `setClientForTesting(...)` injection of a
 * vi.fn-backed `messages.create` returning a structured `tool_use`
 * payload. The git vault is initialized end-to-end so the
 * `writes-allowed` path can call `commitSkillRun` without mocking git.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-enrich-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");
process.env.GROVE_DISABLE_TASK_WORKER = "1";

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import {
  runEnrichment,
  setClientForTesting,
} from "../src/skills/enrichment.js";
import { resetCostLedger } from "../src/skills/cost-ceiling.js";
import { compensateDecision } from "../src/decision-compensate.js";
import { exec } from "../src/vault-ops.js";
import { readDecisionEvents, decisionsLogPath } from "../src/decisions-log.js";
import type { VaultContext } from "../src/vault-router.js";

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

const VAULT_ID = "vault_enrich";
const VAULT_SLUG = "enrich";

function vaultRepoPath(): string {
  return join(TEST_DIR, "repos", VAULT_SLUG);
}

function ctx(): VaultContext {
  return {
    vaultId: VAULT_ID,
    vaultSlug: VAULT_SLUG,
    vaultPath: vaultRepoPath(),
  };
}

function seedControl(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)",
  ).run("user_enrich", "enrich-tester", "enrich@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(VAULT_ID, "user_enrich", VAULT_SLUG, VAULT_SLUG, vaultRepoPath());
}

function writeVaultFile(relPath: string, content: string): void {
  const abs = join(vaultRepoPath(), relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function readVaultFile(relPath: string): string {
  return readFileSync(join(vaultRepoPath(), relPath), "utf8");
}

async function initGitVault(): Promise<void> {
  const vp = vaultRepoPath();
  mkdirSync(vp, { recursive: true });
  await exec("git", ["init", "-b", "main"], vp);
  await exec("git", ["config", "user.email", "enrich@test"], vp);
  await exec("git", ["config", "user.name", "enrich"], vp);
  writeFileSync(join(vp, ".gitkeep"), "");
  await exec("git", ["add", "-A"], vp);
  await exec("git", ["commit", "-m", "init"], vp);
}

async function commitSeed(message: string): Promise<void> {
  const vp = vaultRepoPath();
  await exec("git", ["add", "-A"], vp);
  await exec("git", ["commit", "-m", message], vp);
}

async function freshTestState(): Promise<void> {
  resetDb();
  closeAllVaultDbs();
  resetCostLedger();
  setClientForTesting(null);
  rmSync(process.env.GROVE_VAULT_STATE_ROOT!, { recursive: true, force: true });
  rmSync(process.env.GROVE_VAULT_MIGRATIONS_DIR!, {
    recursive: true,
    force: true,
  });
  rmSync(process.env.GROVE_DB_PATH!, { force: true });
  rmSync(`${process.env.GROVE_DB_PATH!}-wal`, { force: true });
  rmSync(`${process.env.GROVE_DB_PATH!}-shm`, { force: true });
  rmSync(vaultRepoPath(), { recursive: true, force: true });
  copyRealMigrations();
  createSchema();
  seedControl();
  getVaultDb(VAULT_ID);
  await initGitVault();
}

/**
 * Inject a mock Anthropic client that always returns the same drafted
 * paragraphs via a `draft_enrichment` tool-use response. Returns the
 * spy so tests can assert call counts.
 */
function mockAnthropic(
  paragraphs: string,
): { create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue({
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "toolu_test",
        name: "draft_enrichment",
        input: { paragraphs },
      },
    ],
    usage: { input_tokens: 600, output_tokens: 200 },
  });
  setClientForTesting({ messages: { create } } as never);
  return { create };
}

describe("S-INBOX-8 — enrichment skill", () => {
  beforeEach(async () => {
    await freshTestState();
  });

  afterEach(() => {
    closeAllVaultDbs();
    setClientForTesting(null);
    resetDb();
    resetCostLedger();
  });

  it("records 1 enrichment decision and appends drafted paragraphs for a thin Concept with 3 backlinks", async () => {
    writeVaultFile(
      "Resources/Concepts/Taste Graph.md",
      "---\ntype: concept\n---\n\nProduct discovery primitive.\n",
    );
    writeVaultFile(
      "Journal/2026-05-18.md",
      "---\ntype: journal\n---\n\nNotes on [[Taste Graph]] from the brand brief.\n",
    );
    writeVaultFile(
      "Journal/2026-05-19.md",
      "---\ntype: journal\n---\n\nDiscussed [[Taste Graph]] with the team.\n",
    );
    writeVaultFile(
      "Journal/2026-05-20.md",
      "---\ntype: journal\n---\n\n[[Taste Graph]] mentioned in launch review.\n",
    );
    await commitSeed("seed: thin Concept with 3 backlinks");

    // Capture the EXACT pre-enrichment file content for byte-for-byte
    // comparison against payload.prior_content.
    const priorContentOnDisk = readVaultFile("Resources/Concepts/Taste Graph.md");

    const { create } = mockAnthropic(
      "Para 1.\n\nPara 2.\n\nPara 3.\n\nPara 4.",
    );

    const result = await runEnrichment(ctx(), { tokenCeiling: 50_000 });

    expect(create).toHaveBeenCalledOnce();
    expect(result.ceilingHit).toBe(false);
    expect(result.decisions).toHaveLength(1);

    const d = result.decisions[0]!;
    expect(d.type).toBe("enrichment");
    expect(d.status).toBe("provisional");
    expect(d.chosenOptionId).toBe("opt-1");
    expect(d.options).toHaveLength(2);
    expect(d.options[0]!.label).toBe("apply enrichment");
    expect(d.options[1]!.label).toBe("dismiss");

    const payload = d.payload as {
      target_path: string;
      prior_content: string;
      new_content: string;
    };
    expect(payload.target_path).toBe("Resources/Concepts/Taste Graph.md");
    // The load-bearing assertion: prior_content is byte-for-byte the
    // complete pre-enrichment file (frontmatter + body). Compensation
    // depends on this.
    expect(payload.prior_content).toBe(priorContentOnDisk);
    expect(payload.prior_content).toContain("---\ntype: concept\n---");
    expect(payload.prior_content).toContain("Product discovery primitive.");
    expect(payload.new_content).toContain("Para 1.");
    expect(payload.new_content).toContain("Para 4.");

    // Concept note on disk now has the appended paragraphs (existing
    // body preserved).
    const updated = readVaultFile("Resources/Concepts/Taste Graph.md");
    expect(updated).toContain("Product discovery primitive.");
    expect(updated).toContain("Para 1.");
    expect(updated).toContain("Para 4.");

    // state.db projection has 1 enrichment row.
    const rows = getVaultDb(VAULT_ID)
      .prepare("SELECT id, type FROM decisions")
      .all() as Array<{ id: string; type: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("enrichment");

    // JSONL log has 1 line.
    expect(existsSync(decisionsLogPath(vaultRepoPath()))).toBe(true);
    const events = readDecisionEvents(vaultRepoPath());
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(d.id);

    // Skill-run commit landed.
    const subject = (
      await exec("git", ["log", "-1", "--format=%s", "HEAD"], vaultRepoPath())
    ).trim();
    expect(subject).toBe("enrichment: 1 provisional enrichment");
  });

  it("skips a thin Concept with < 3 backlinks", async () => {
    writeVaultFile(
      "Resources/Concepts/Taste Graph.md",
      "---\ntype: concept\n---\n\nProduct discovery primitive.\n",
    );
    writeVaultFile(
      "Journal/2026-05-18.md",
      "---\ntype: journal\n---\n\nNotes on [[Taste Graph]] from the brief.\n",
    );
    await commitSeed("seed: thin Concept with 1 backlink");

    const { create } = mockAnthropic("Para 1.\n\nPara 2.\n\nPara 3.\n\nPara 4.");

    const result = await runEnrichment(ctx(), { tokenCeiling: 50_000 });

    expect(create).not.toHaveBeenCalled();
    expect(result.decisions).toHaveLength(0);
    expect(result.scanned.thin).toBe(0);

    const rows = getVaultDb(VAULT_ID)
      .prepare("SELECT COUNT(*) AS n FROM decisions")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("skips an already-thick Concept even with many backlinks", async () => {
    const thickBody =
      "This is a thick concept note with plenty of body content. ".repeat(10);
    writeVaultFile(
      "Resources/Concepts/Taste Graph.md",
      `---\ntype: concept\n---\n\n${thickBody}\n`,
    );
    for (let i = 1; i <= 5; i++) {
      const day = String(i).padStart(2, "0");
      writeVaultFile(
        `Journal/2026-05-${day}.md`,
        `---\ntype: journal\n---\n\nMention of [[Taste Graph]] on day ${i}.\n`,
      );
    }
    await commitSeed("seed: thick Concept with 5 backlinks");

    const { create } = mockAnthropic("Para 1.\n\nPara 2.\n\nPara 3.\n\nPara 4.");

    const result = await runEnrichment(ctx(), { tokenCeiling: 50_000 });

    expect(create).not.toHaveBeenCalled();
    expect(result.decisions).toHaveLength(0);
    expect(result.scanned.thin).toBe(0);
  });

  it("hard-fails on cost ceiling — 0 decisions, ceilingHit: true, no LLM call", async () => {
    writeVaultFile(
      "Resources/Concepts/Taste Graph.md",
      "---\ntype: concept\n---\n\nProduct discovery primitive.\n",
    );
    writeVaultFile(
      "Journal/2026-05-18.md",
      "---\ntype: journal\n---\n\n[[Taste Graph]] notes.\n",
    );
    writeVaultFile(
      "Journal/2026-05-19.md",
      "---\ntype: journal\n---\n\n[[Taste Graph]] discussed.\n",
    );
    writeVaultFile(
      "Journal/2026-05-20.md",
      "---\ntype: journal\n---\n\n[[Taste Graph]] launched.\n",
    );
    await commitSeed("seed: ceiling fixture");

    const create = vi.fn();
    setClientForTesting({ messages: { create } } as never);

    const result = await runEnrichment(ctx(), { tokenCeiling: 100 });

    expect(create).not.toHaveBeenCalled();
    expect(result.ceilingHit).toBe(true);
    expect(result.decisions).toHaveLength(0);

    // No state.db rows, no commits.
    const rows = getVaultDb(VAULT_ID)
      .prepare("SELECT COUNT(*) AS n FROM decisions")
      .get() as { n: number };
    expect(rows.n).toBe(0);

    // Concept note untouched.
    const updated = readVaultFile("Resources/Concepts/Taste Graph.md");
    expect(updated).not.toContain("Para 1.");
  });

  it("surface-only mode records decisions but does not mutate vault files or commit", async () => {
    writeVaultFile(
      "Resources/Concepts/Taste Graph.md",
      "---\ntype: concept\n---\n\nProduct discovery primitive.\n",
    );
    writeVaultFile(
      "Journal/2026-05-18.md",
      "---\ntype: journal\n---\n\n[[Taste Graph]] notes.\n",
    );
    writeVaultFile(
      "Journal/2026-05-19.md",
      "---\ntype: journal\n---\n\n[[Taste Graph]] discussed.\n",
    );
    writeVaultFile(
      "Journal/2026-05-20.md",
      "---\ntype: journal\n---\n\n[[Taste Graph]] launched.\n",
    );
    await commitSeed("seed: surface-only fixture");
    const headBefore = (
      await exec("git", ["rev-parse", "HEAD"], vaultRepoPath())
    ).trim();
    const fileBefore = readVaultFile("Resources/Concepts/Taste Graph.md");

    const { create } = mockAnthropic(
      "Para 1.\n\nPara 2.\n\nPara 3.\n\nPara 4.",
    );

    const result = await runEnrichment(ctx(), {
      mode: "surface-only",
      tokenCeiling: 50_000,
    });

    expect(create).toHaveBeenCalledOnce();
    expect(result.decisions).toHaveLength(1);

    // Concept file is untouched on disk.
    const fileAfter = readVaultFile("Resources/Concepts/Taste Graph.md");
    expect(fileAfter).toBe(fileBefore);
    expect(fileAfter).not.toContain("Para 1.");

    // No new commit landed.
    const headAfter = (
      await exec("git", ["rev-parse", "HEAD"], vaultRepoPath())
    ).trim();
    expect(headAfter).toBe(headBefore);

    // But the decision IS recorded into projection + JSONL.
    expect(existsSync(decisionsLogPath(vaultRepoPath()))).toBe(true);
    const events = readDecisionEvents(vaultRepoPath());
    expect(events).toHaveLength(1);
    const rows = getVaultDb(VAULT_ID)
      .prepare("SELECT COUNT(*) AS n FROM decisions")
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("caps the run at maxDecisions=3 when 8 thin Concepts qualify", async () => {
    for (let i = 1; i <= 8; i++) {
      const title = `Concept ${i}`;
      writeVaultFile(
        `Resources/Concepts/${title}.md`,
        `---\ntype: concept\n---\n\nShort blurb ${i}.\n`,
      );
      // Three backlinks per Concept so all 8 qualify.
      for (let j = 1; j <= 3; j++) {
        writeVaultFile(
          `Journal/concept-${i}-link-${j}.md`,
          `---\ntype: journal\n---\n\nMention of [[${title}]] in entry ${j}.\n`,
        );
      }
    }
    await commitSeed("seed: 8 thin Concepts");

    const { create } = mockAnthropic(
      "Para 1.\n\nPara 2.\n\nPara 3.\n\nPara 4.",
    );

    const result = await runEnrichment(ctx(), {
      maxDecisions: 3,
      tokenCeiling: 50_000,
    });

    expect(result.decisions).toHaveLength(3);
    // Cap is enforced BEFORE the LLM call — only 3 calls made.
    expect(create).toHaveBeenCalledTimes(3);

    const rows = getVaultDb(VAULT_ID)
      .prepare("SELECT COUNT(*) AS n FROM decisions")
      .get() as { n: number };
    expect(rows.n).toBe(3);
  });

  it("skips a malformed-frontmatter Concept and continues scanning", async () => {
    // Prod incident 2026-05-19: a single note with malformed YAML
    // (unquoted @-alias) crashed the whole scan because parseNote threw
    // before any candidate was produced. Defensive wrap keeps the rest
    // of the vault scannable.

    // 1) Valid thin concept with 3 backlinks — should be enriched.
    writeVaultFile(
      "Resources/Concepts/Taste Graph.md",
      "---\ntype: concept\n---\n\nProduct discovery primitive.\n",
    );
    writeVaultFile(
      "Journal/2026-05-18.md",
      "---\ntype: journal\n---\n\n[[Taste Graph]] notes.\n",
    );
    writeVaultFile(
      "Journal/2026-05-19.md",
      "---\ntype: journal\n---\n\n[[Taste Graph]] discussed.\n",
    );
    writeVaultFile(
      "Journal/2026-05-20.md",
      "---\ntype: journal\n---\n\n[[Taste Graph]] launched.\n",
    );

    // 2) Broken Concept — `@` is a reserved YAML indicator; throws on parse.
    writeVaultFile(
      "Resources/Concepts/Broken Concept.md",
      "---\ntype: concept\naliases:\n  - @ericwilliamrea\n---\n\nMalformed concept.\n",
    );

    // 3) Thick concept — too long to qualify, but should also not crash.
    const thickBody =
      "This is a thick concept with plenty of body content. ".repeat(10);
    writeVaultFile(
      "Resources/Concepts/Thick Concept.md",
      `---\ntype: concept\n---\n\n${thickBody}\n`,
    );

    await commitSeed("seed: valid thin + broken-YAML + thick concepts");

    const { create } = mockAnthropic(
      "Para 1.\n\nPara 2.\n\nPara 3.\n\nPara 4.",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runEnrichment(ctx(), { tokenCeiling: 50_000 });

      // Scan continued — the valid thin concept still got enriched.
      expect(create).toHaveBeenCalledOnce();
      expect(result.ceilingHit).toBe(false);
      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0]!.payload).toMatchObject({
        target_path: "Resources/Concepts/Taste Graph.md",
      });
      const updated = readVaultFile("Resources/Concepts/Taste Graph.md");
      expect(updated).toContain("Para 1.");

      // The broken note was logged + skipped.
      const skipLogs = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes(
          "[enrichment] skipping Resources/Concepts/Broken Concept.md",
        ),
      );
      expect(skipLogs).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("compensation round-trip restores the Concept file byte-for-byte to prior_content", async () => {
    writeVaultFile(
      "Resources/Concepts/Taste Graph.md",
      "---\ntype: concept\n---\n\nProduct discovery primitive.\n",
    );
    writeVaultFile(
      "Journal/2026-05-18.md",
      "---\ntype: journal\n---\n\n[[Taste Graph]] notes.\n",
    );
    writeVaultFile(
      "Journal/2026-05-19.md",
      "---\ntype: journal\n---\n\n[[Taste Graph]] discussed.\n",
    );
    writeVaultFile(
      "Journal/2026-05-20.md",
      "---\ntype: journal\n---\n\n[[Taste Graph]] launched.\n",
    );
    await commitSeed("seed: compensation round-trip fixture");

    const priorOnDisk = readVaultFile("Resources/Concepts/Taste Graph.md");

    mockAnthropic("Para 1.\n\nPara 2.\n\nPara 3.\n\nPara 4.");
    const result = await runEnrichment(ctx(), { tokenCeiling: 50_000 });
    expect(result.decisions).toHaveLength(1);
    const d = result.decisions[0]!;

    // Confirm the file actually got enriched before we roll back.
    const afterEnrich = readVaultFile("Resources/Concepts/Taste Graph.md");
    expect(afterEnrich).not.toBe(priorOnDisk);
    expect(afterEnrich).toContain("Para 1.");

    // Compensate. This is the load-bearing call — payload.prior_content
    // must be byte-for-byte the original file for the compensation to
    // restore correctly.
    const compensation = await compensateDecision(
      vaultRepoPath(),
      VAULT_ID,
      d.id,
    );
    expect(compensation.compensatingDecisionId).toMatch(/^D-/);

    const afterCompensate = readVaultFile("Resources/Concepts/Taste Graph.md");
    expect(afterCompensate).toBe(priorOnDisk);

    // Original decision marked compensated; new compensation decision recorded.
    const rows = getVaultDb(VAULT_ID)
      .prepare(
        "SELECT id, status, compensated_by FROM decisions ORDER BY created_at ASC",
      )
      .all() as Array<{
        id: string;
        status: string;
        compensated_by: string | null;
      }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe("compensated");
    expect(rows[0]!.compensated_by).toBe(compensation.compensatingDecisionId);
    expect(rows[1]!.status).toBe("confirmed");
  });
});

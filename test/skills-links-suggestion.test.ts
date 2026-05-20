/**
 * S-INBOX-7 — Links-suggestion skill falsifier.
 *
 * Six sub-tests per the spec:
 *
 *   1. Single unambiguous mention — 1 Person "Anna Chen", 1 Journal
 *      entry with "Anna Chen mentioned" raw → 1 decision recorded,
 *      type='link', Journal entry now contains `[[Anna Chen]]`.
 *
 *   2. Already-linked mention skipped — `[[Anna Chen]]` already in
 *      entry → 0 decisions.
 *
 *   3. Ambiguous mention skipped (S-6 territory) — seed 2 Annas + raw
 *      mention of "Anna" → 0 decisions. This skill only handles the
 *      single-candidate case.
 *
 *   4. Multiple distinct surface forms across multiple notes — 3
 *      separate distinct entities mentioned across 3 distinct notes →
 *      3 decisions, each link applied in place.
 *
 *   5. `maxDecisions` cap — seed 30 unambiguous mentions,
 *      `maxDecisions: 10` → exactly 10 decisions.
 *
 *   6. `surface-only` mode — no writes to vault, no git commit, but
 *      decisions are still recorded into the projection + JSONL.
 *
 * Mirrors the fixture pattern from `test/skills-disambiguation.test.ts`
 * (mkdtemp + git init + seed control db) so the `writes-allowed` path
 * can call `commitSkillRun` end-to-end without mocking git.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-links-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");
process.env.GROVE_DISABLE_TASK_WORKER = "1";

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import { runLinksSuggestion } from "../src/skills/links-suggestion.js";
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

const VAULT_ID = "vault_links";
const VAULT_SLUG = "links";

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
  ).run("user_links", "links-tester", "links@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(VAULT_ID, "user_links", VAULT_SLUG, VAULT_SLUG, vaultRepoPath());
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
  await exec("git", ["config", "user.email", "links@test"], vp);
  await exec("git", ["config", "user.name", "links"], vp);
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

describe("S-INBOX-7 — links-suggestion skill", () => {
  beforeEach(async () => {
    await freshTestState();
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
  });

  it("records 1 decision and applies [[Anna Chen]] when a single Person matches", async () => {
    writeVaultFile(
      "Resources/People/Anna Chen.md",
      "---\ntype: person\n---\n\nDesigner; partners with the brand team.\n",
    );
    writeVaultFile(
      "Journal/2026-05-20.md",
      "---\ntype: journal\n---\n\nQuick chat with Anna Chen about the project.\n",
    );
    await commitSeed("seed: single Anna + journal");

    const result = await runLinksSuggestion(ctx());

    expect(result.decisions).toHaveLength(1);
    const d = result.decisions[0]!;
    expect(d.type).toBe("link");
    expect(d.status).toBe("provisional");
    expect(d.chosenOptionId).toBe("opt-1");
    expect(d.options).toHaveLength(2);
    expect(d.options[0]!.source).toBe("schema");
    expect(d.options[0]!.label).toBe("link to Anna Chen");
    expect(d.options[1]!.label).toBe("do not link");

    // Payload shape — LinkPayload, single candidate.
    const payload = d.payload as {
      source_path: string;
      surface_form: string;
      target_path: string;
      candidates: Array<{ note_path: string }>;
    };
    expect(payload.source_path).toBe("Journal/2026-05-20.md");
    expect(payload.target_path).toBe("Resources/People/Anna Chen.md");
    expect(payload.candidates).toHaveLength(1);
    expect(payload.candidates[0]!.note_path).toBe(
      "Resources/People/Anna Chen.md",
    );
    expect(payload.surface_form).toBe("Anna Chen");

    // Journal entry rewritten in place — surface form equals title, so
    // no alias pipe is needed.
    const updated = readVaultFile("Journal/2026-05-20.md");
    expect(updated).toContain("[[Anna Chen]]");
    // No bare "Anna Chen" left outside the link.
    expect(updated.replace(/\[\[Anna Chen\]\]/g, "")).not.toContain(
      "Anna Chen",
    );

    // state.db projection has one row of the right shape.
    const rows = getVaultDb(VAULT_ID)
      .prepare("SELECT id, type, chosen_option_id FROM decisions")
      .all() as Array<{ id: string; type: string; chosen_option_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("link");
    expect(rows[0]!.chosen_option_id).toBe("opt-1");

    // JSONL log got one line.
    expect(existsSync(decisionsLogPath(vaultRepoPath()))).toBe(true);
    const events = readDecisionEvents(vaultRepoPath());
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(d.id);

    // Skill-run commit landed.
    const fullMsg = (
      await exec("git", ["log", "-1", "--format=%B", "HEAD"], vaultRepoPath())
    ).trim();
    expect(fullMsg.split("\n")[0]).toBe("links-suggestion: 1 provisional link");
    expect(fullMsg).toContain(`Decision-Id: ${d.id}`);
    expect(fullMsg).toContain("Provenance-Voice: perishable");
  });

  it("skips already-linked mentions (no decisions recorded)", async () => {
    writeVaultFile(
      "Resources/People/Anna Chen.md",
      "---\ntype: person\n---\n\nDesigner.\n",
    );
    writeVaultFile(
      "Journal/2026-05-20.md",
      "---\ntype: journal\n---\n\nChat with [[Anna Chen]] today, all good.\n",
    );
    await commitSeed("seed: already-linked");

    const result = await runLinksSuggestion(ctx());

    expect(result.decisions).toHaveLength(0);
    const rows = getVaultDb(VAULT_ID)
      .prepare("SELECT COUNT(*) AS n FROM decisions")
      .get() as { n: number };
    expect(rows.n).toBe(0);

    // Journal untouched.
    const body = readVaultFile("Journal/2026-05-20.md");
    expect(body).toContain("Chat with [[Anna Chen]] today");
  });

  it("skips ambiguous (2+ candidate) mentions — that's S-6 territory", async () => {
    // Two Annas — derived first-name "Anna" maps to both. The raw "Anna"
    // mention is ambiguous, so this skill must skip it.
    writeVaultFile(
      "Resources/People/Anna Chen.md",
      "---\ntype: person\n---\n\nDesigner.\n",
    );
    writeVaultFile(
      "Resources/People/Anna Kim.md",
      "---\ntype: person\n---\n\nPM.\n",
    );
    writeVaultFile(
      "Journal/2026-05-20.md",
      "---\ntype: journal\n---\n\nQuick chat with Anna about the project.\n",
    );
    await commitSeed("seed: two Annas + ambiguous journal");

    const result = await runLinksSuggestion(ctx());

    expect(result.decisions).toHaveLength(0);
    const rows = getVaultDb(VAULT_ID)
      .prepare("SELECT COUNT(*) AS n FROM decisions")
      .get() as { n: number };
    expect(rows.n).toBe(0);

    // Journal untouched — no provisional link.
    const body = readVaultFile("Journal/2026-05-20.md");
    expect(body).toContain("Quick chat with Anna about the project.");
    expect(body).not.toContain("[[Anna");
  });

  it("links 3 distinct entities across 3 distinct notes", async () => {
    writeVaultFile(
      "Resources/People/Anna Chen.md",
      "---\ntype: person\n---\n\nDesigner.\n",
    );
    writeVaultFile(
      "Resources/Concepts/Taste Graph.md",
      "---\ntype: concept\n---\n\nProduct discovery primitive.\n",
    );
    writeVaultFile(
      "Resources/Companies/Anthropic.md",
      "---\ntype: company\n---\n\nAI lab.\n",
    );
    writeVaultFile(
      "Journal/2026-05-18.md",
      "---\ntype: journal\n---\n\nMet with Anna Chen on the brand brief.\n",
    );
    writeVaultFile(
      "Journal/2026-05-19.md",
      "---\ntype: journal\n---\n\nDrafted notes on the Taste Graph idea.\n",
    );
    writeVaultFile(
      "Journal/2026-05-20.md",
      "---\ntype: journal\n---\n\nAnthropic shipped a new model release.\n",
    );
    await commitSeed("seed: 3 distinct entities + 3 journals");

    const result = await runLinksSuggestion(ctx());

    expect(result.decisions).toHaveLength(3);
    for (const d of result.decisions) {
      expect(d.type).toBe("link");
      expect(d.options).toHaveLength(2);
      expect(d.chosenOptionId).toBe("opt-1");
    }

    expect(readVaultFile("Journal/2026-05-18.md")).toContain("[[Anna Chen]]");
    expect(readVaultFile("Journal/2026-05-19.md")).toContain("[[Taste Graph]]");
    expect(readVaultFile("Journal/2026-05-20.md")).toContain("[[Anthropic]]");

    // state.db projection holds 3 rows.
    const rows = getVaultDb(VAULT_ID)
      .prepare("SELECT id, type FROM decisions")
      .all() as Array<{ id: string; type: string }>;
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.type).toBe("link");
  });

  it("caps the run at maxDecisions=10 when 30 unambiguous mentions exist", async () => {
    writeVaultFile(
      "Resources/People/Anna Chen.md",
      "---\ntype: person\n---\n\nDesigner.\n",
    );
    // 30 journal entries, each mentioning "Anna Chen" raw (full title,
    // unambiguous — single candidate). Walk order is sorted by file
    // name, so the cap should keep the first 10 entries.
    for (let i = 1; i <= 30; i++) {
      const day = String(i).padStart(2, "0");
      writeVaultFile(
        `Journal/2026-04-${day}.md`,
        `---\ntype: journal\n---\n\nEntry ${i}: Anna Chen mentioned the launch.\n`,
      );
    }
    await commitSeed("seed: 30 unambiguous mentions");

    const result = await runLinksSuggestion(ctx(), { maxDecisions: 10 });

    expect(result.decisions).toHaveLength(10);
    const rows = getVaultDb(VAULT_ID)
      .prepare("SELECT COUNT(*) AS n FROM decisions")
      .get() as { n: number };
    expect(rows.n).toBe(10);

    // First 10 journals got linked.
    for (let i = 1; i <= 10; i++) {
      const day = String(i).padStart(2, "0");
      const body = readVaultFile(`Journal/2026-04-${day}.md`);
      expect(body).toContain("[[Anna Chen]]");
    }
    // Last 20 are untouched.
    for (let i = 11; i <= 30; i++) {
      const day = String(i).padStart(2, "0");
      const body = readVaultFile(`Journal/2026-04-${day}.md`);
      expect(body).not.toContain("[[Anna Chen]]");
    }
  });

  it("surface-only mode records decisions but writes no files and emits no commit", async () => {
    writeVaultFile(
      "Resources/People/Anna Chen.md",
      "---\ntype: person\n---\n\nDesigner.\n",
    );
    writeVaultFile(
      "Journal/2026-05-20.md",
      "---\ntype: journal\n---\n\nQuick chat with Anna Chen about the project.\n",
    );
    await commitSeed("seed: surface-only fixture");
    const headBefore = (
      await exec("git", ["rev-parse", "HEAD"], vaultRepoPath())
    ).trim();

    const result = await runLinksSuggestion(ctx(), { mode: "surface-only" });

    // Decisions returned but no provisional link applied.
    expect(result.decisions).toHaveLength(1);
    const body = readVaultFile("Journal/2026-05-20.md");
    expect(body).toContain("Quick chat with Anna Chen about the project.");
    expect(body).not.toContain("[[Anna");

    // No new commit landed.
    const headAfter = (
      await exec("git", ["rev-parse", "HEAD"], vaultRepoPath())
    ).trim();
    expect(headAfter).toBe(headBefore);

    // surface-only still calls recordDecision (the distinction is that
    // the vault file is NOT mutated and no skill-run commit lands). The
    // JSONL log + state.db projection both reflect the recorded decision.
    expect(existsSync(decisionsLogPath(vaultRepoPath()))).toBe(true);
    const events = readDecisionEvents(vaultRepoPath());
    expect(events).toHaveLength(1);
    const rows = getVaultDb(VAULT_ID)
      .prepare("SELECT COUNT(*) AS n FROM decisions")
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

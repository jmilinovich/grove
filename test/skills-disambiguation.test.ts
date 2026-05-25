/**
 * S-INBOX-6 — Disambiguation suggestion skill falsifier.
 *
 * Five sub-tests per the spec:
 *
 *   1. Ambiguous mention, two candidates — Anna Chen (2 backlinks) and
 *      Anna Kim (1 backlink); Journal entry mentions "Anna" raw → ONE
 *      decision recorded with two options, Journal entry now contains
 *      `[[Anna Chen]]` (top candidate by backlink heuristic).
 *
 *   2. Already-linked mention skipped — Journal contains `[[Anna Chen]]`
 *      already → 0 decisions.
 *
 *   3. Unambiguous (single candidate) skipped — only one "Anna" exists →
 *      0 decisions.
 *
 *   4. `surface-only` mode — no writes to vault, no git commit, but the
 *      decisions are returned by `runDisambiguation`.
 *
 *   5. Per-run cap — seed 15 ambiguous mentions, `maxDecisions: 5` →
 *      exactly 5 decisions recorded.
 *
 * Fixture pattern mirrors `test/decision-writer.test.ts` (real
 * migrations copied into a temp dir + a `git init`'d vault working
 * tree) so the `writes-allowed` path can call `commitSkillRun` end-to-
 * end without mocking git.
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

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-disambig-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_VAULT_STATE_ROOT = join(TEST_DIR, "vaults");
process.env.GROVE_VAULT_MIGRATIONS_DIR = join(TEST_DIR, "migrations");
process.env.GROVE_DISABLE_TASK_WORKER = "1";

import { getDb, resetDb, createSchema } from "../src/db.js";
import { getVaultDb, closeAllVaultDbs } from "../src/db-per-vault.js";
import { runDisambiguation } from "../src/skills/disambiguation.js";
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

const VAULT_ID = "vault_disambig";
const VAULT_SLUG = "disambig";

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
  ).run("user_disambig", "disambig-tester", "disambig@example.com");
  db.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)",
  ).run(VAULT_ID, "user_disambig", VAULT_SLUG, VAULT_SLUG, vaultRepoPath());
}

/** Write a file in the vault, creating intermediate dirs. */
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
  await exec("git", ["config", "user.email", "disambig@test"], vp);
  await exec("git", ["config", "user.name", "disambig"], vp);
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
  // Force the per-vault state.db to initialize so migrations run before
  // the first prepared-statement read.
  getVaultDb(VAULT_ID);
  await initGitVault();
}

/** Seed two People notes ("Anna Chen" 2 backlinks, "Anna Kim" 1 backlink). */
function seedTwoAnnas(): void {
  writeVaultFile(
    "Resources/People/Anna Chen.md",
    "---\ntype: person\n---\n\nAnna Chen — designer.\n",
  );
  writeVaultFile(
    "Resources/People/Anna Kim.md",
    "---\ntype: person\n---\n\nAnna Kim — PM.\n",
  );
  // Backlink seeds (2 for Chen, 1 for Kim).
  writeVaultFile(
    "Resources/Concepts/Design Reviews.md",
    "---\ntype: concept\n---\n\nWe ran a session with [[Anna Chen]] last week.\n",
  );
  writeVaultFile(
    "Resources/Concepts/Onboarding.md",
    "---\ntype: concept\n---\n\nKickoff doc co-authored with [[Anna Chen]].\n",
  );
  writeVaultFile(
    "Resources/Concepts/PM Council.md",
    "---\ntype: concept\n---\n\nNotes from [[Anna Kim]] sync.\n",
  );
}

describe("S-INBOX-6 — disambiguation skill", () => {
  beforeEach(async () => {
    await freshTestState();
  });

  afterEach(() => {
    closeAllVaultDbs();
    resetDb();
  });

  it("records 1 decision and applies [[Anna Chen]] when 'Anna' is ambiguous", async () => {
    seedTwoAnnas();
    writeVaultFile(
      "Journal/2026-05-20.md",
      "---\ntype: journal\n---\n\nQuick chat with Anna about the project.\n",
    );
    await commitSeed("seed: two Annas + journal");

    const result = await runDisambiguation(ctx());

    expect(result.decisions).toHaveLength(1);
    const d = result.decisions[0]!;
    expect(d.type).toBe("disambiguation");
    expect(d.status).toBe("provisional");
    expect(d.options).toHaveLength(2);
    // Both options are schema-sourced.
    for (const opt of d.options) expect(opt.source).toBe("schema");
    // Top candidate is Anna Chen (2 backlinks vs 1).
    expect(d.chosenOptionId).toBe("opt-1");
    expect(d.options[0].label).toBe("link to Anna Chen");
    expect(d.options[1].label).toBe("link to Anna Kim");
    expect(d.payload.candidates[0].note_path).toBe(
      "Resources/People/Anna Chen.md",
    );

    // Journal entry rewritten in place.
    const updated = readVaultFile("Journal/2026-05-20.md");
    expect(updated).toContain("[[Anna Chen|Anna]]");
    expect(updated).not.toMatch(/(^|[^\[])\bAnna\b(?!\])/);

    // state.db projection has one decisions row of the right shape.
    const rows = getVaultDb(VAULT_ID)
      .prepare("SELECT id, type, chosen_option_id FROM decisions")
      .all() as Array<{
        id: string;
        type: string;
        chosen_option_id: string;
      }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("disambiguation");
    expect(rows[0].chosen_option_id).toBe("opt-1");

    // JSONL log got one line.
    expect(existsSync(decisionsLogPath(vaultRepoPath()))).toBe(true);
    const events = readDecisionEvents(vaultRepoPath());
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(d.id);

    // The skill-run commit landed with a Decision-Id trailer.
    const fullMsg = (
      await exec("git", ["log", "-1", "--format=%B", "HEAD"], vaultRepoPath())
    ).trim();
    expect(fullMsg.split("\n")[0]).toBe(
      "disambiguation: 1 provisional link",
    );
    expect(fullMsg).toContain(`Decision-Id: ${d.id}`);
    expect(fullMsg).toContain("Provenance-Voice: perishable");
  });

  it("skips already-linked mentions (no decisions recorded)", async () => {
    seedTwoAnnas();
    writeVaultFile(
      "Journal/2026-05-20.md",
      "---\ntype: journal\n---\n\nChat with [[Anna Chen]] today, all good.\n",
    );
    await commitSeed("seed: already-linked journal");

    const result = await runDisambiguation(ctx());

    expect(result.decisions).toHaveLength(0);
    const rows = getVaultDb(VAULT_ID)
      .prepare("SELECT COUNT(*) AS n FROM decisions")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("skips unambiguous mentions (only one matching Person)", async () => {
    // Just one Anna — no ambiguity.
    writeVaultFile(
      "Resources/People/Anna Chen.md",
      "---\ntype: person\n---\n\nAnna Chen — designer.\n",
    );
    writeVaultFile(
      "Resources/Concepts/Design Reviews.md",
      "---\ntype: concept\n---\n\nRan a session with [[Anna Chen]].\n",
    );
    writeVaultFile(
      "Journal/2026-05-20.md",
      "---\ntype: journal\n---\n\nQuick chat with Anna about the project.\n",
    );
    await commitSeed("seed: single Anna");

    const result = await runDisambiguation(ctx());

    expect(result.decisions).toHaveLength(0);
    // Journal entry untouched.
    const body = readVaultFile("Journal/2026-05-20.md");
    expect(body).toContain("Quick chat with Anna about the project.");
    expect(body).not.toContain("[[Anna");
  });

  it("surface-only mode records decisions but writes no files and emits no commit", async () => {
    seedTwoAnnas();
    writeVaultFile(
      "Journal/2026-05-20.md",
      "---\ntype: journal\n---\n\nQuick chat with Anna about the project.\n",
    );
    await commitSeed("seed: surface-only fixture");
    const headBefore = (
      await exec("git", ["rev-parse", "HEAD"], vaultRepoPath())
    ).trim();

    const result = await runDisambiguation(ctx(), { mode: "surface-only" });

    // Decisions returned but no provisional link applied.
    expect(result.decisions).toHaveLength(1);
    const body = readVaultFile("Journal/2026-05-20.md");
    expect(body).toContain("Quick chat with Anna about the project.");
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

  it("skips a malformed-frontmatter Person note and continues scanning", async () => {
    // Prod incident 2026-05-19: a single People note with malformed YAML
    // (unquoted @-alias) crashed the whole scan because parseNote threw
    // before any candidate was produced. Defensive wrap keeps the rest
    // of the vault scannable.
    seedTwoAnnas();
    // A third Person note with broken YAML — the `@` indicator at the
    // start of a YAML scalar is reserved and the `yaml` lib throws on it.
    writeVaultFile(
      "Resources/People/Broken Person.md",
      "---\ntype: person\naliases:\n  - @ericwilliamrea\n---\n\nMalformed note.\n",
    );
    writeVaultFile(
      "Journal/2026-05-20.md",
      "---\ntype: journal\n---\n\nQuick chat with Anna about the project.\n",
    );
    await commitSeed("seed: two Annas + broken-YAML Person");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runDisambiguation(ctx());

      // Scan continued — the two valid Annas still produced the ambiguity decision.
      expect(result.decisions).toHaveLength(1);
      const d = result.decisions[0]!;
      expect(d.type).toBe("disambiguation");
      expect(d.chosenOptionId).toBe("opt-1");

      // The broken note was logged + skipped.
      const skipLogs = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes("[disambiguation] skipping Resources/People/Broken Person.md"),
      );
      expect(skipLogs).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("caps the run at maxDecisions=5 when 15 ambiguous mentions exist", async () => {
    seedTwoAnnas();
    // 15 journal entries, each with an "Anna" ambiguity. Walk order is
    // sorted by file name, so the cap should keep entries 1..5 and
    // leave 6..15 alone.
    for (let i = 1; i <= 15; i++) {
      const day = String(i).padStart(2, "0");
      writeVaultFile(
        `Journal/2026-04-${day}.md`,
        `---\ntype: journal\n---\n\nEntry ${i}: Anna mentioned the launch plan.\n`,
      );
    }
    await commitSeed("seed: 15 ambiguous mentions");

    const result = await runDisambiguation(ctx(), { maxDecisions: 5 });

    expect(result.decisions).toHaveLength(5);

    const rows = getVaultDb(VAULT_ID)
      .prepare("SELECT COUNT(*) AS n FROM decisions")
      .get() as { n: number };
    expect(rows.n).toBe(5);

    // First 5 journals got linked.
    for (let i = 1; i <= 5; i++) {
      const day = String(i).padStart(2, "0");
      const body = readVaultFile(`Journal/2026-04-${day}.md`);
      expect(body).toContain("[[Anna Chen|Anna]]");
    }
    // Last 10 are untouched.
    for (let i = 6; i <= 15; i++) {
      const day = String(i).padStart(2, "0");
      const body = readVaultFile(`Journal/2026-04-${day}.md`);
      expect(body).not.toContain("[[Anna");
    }
  });
});

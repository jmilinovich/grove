// Real-git integration tests for handleMoveNote.
//
// rest-lifecycle.test.ts mocks gitMv / gitCommitPaths, so it never catches
// regressions in the actual git command sequence. This file exercises the
// real `git` binary against a temp repo. The bug it was written for:
// `git mv A B` already stages the rename, after which `git add -A -- A`
// errors with "pathspec did not match any files" — the move handler used
// to include srcRel in the post-mv `git add` paths and that broke every
// move in production (echo vault, 2026-05-18).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import { handleMoveNote, defaultVaultContext } from "../src/rest.js";
import { createSchema, resetDb } from "../src/db.js";

let vaultPath: string;

function git(args: string[], cwd = vaultPath): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function seed(path: string, body: string): void {
  const abs = join(vaultPath, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

beforeAll(() => {
  vaultPath = mkdtempSync(join(tmpdir(), "grove-move-real-git-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@grove.local"]);
  git(["config", "user.name", "Grove Test"]);
  git(["config", "commit.gpgsign", "false"]);
  process.env.GROVE_VAULT = vaultPath;
  // Keep the test DB outside the vault so its WAL files don't show up as
  // dirty paths when we assert `git status --porcelain == ""`.
  process.env.GROVE_DB_PATH = join(mkdtempSync(join(tmpdir(), "grove-move-real-git-db-")), "test.db");
});

afterAll(() => {
  delete process.env.GROVE_VAULT;
  delete process.env.GROVE_DB_PATH;
  rmSync(vaultPath, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test starts from a clean git tree.
  execFileSync("git", ["clean", "-fdq"], { cwd: vaultPath });
  try { git(["reset", "--hard"]); } catch { /* no commits yet */ }
  resetDb();
  createSchema();
});

describe("handleMoveNote against real git", () => {
  it("moves a note with a space in its filename without git pathspec errors", async () => {
    // Reproduces the 2026-05-18 production bug: every move-via-PATCH failed
    // because `git add -A -- <srcRel>` couldn't match a path that `git mv`
    // had already staged as part of a rename. Filenames with spaces just
    // made it more visible because most discovery-created stubs had them.
    seed(
      "Resources/Concepts/Hadal Zone.md",
      "---\ntype: concept\ntags: [test]\n---\n# Hadal Zone\nbody",
    );
    seed(
      "Resources/Concepts/referrer.md",
      "---\ntype: concept\ntags: [test]\n---\nSee [[Hadal Zone]] and [[Resources/Concepts/Hadal Zone|caps]].",
    );
    git(["add", "."]);
    git(["commit", "-qm", "seed"]);

    const result = await handleMoveNote(
      defaultVaultContext(),
      "Resources/Concepts/Hadal Zone.md",
      "Resources/Concepts/hadal-zone.md",
      { keyName: "test-key" },
    );

    expect(result.from).toBe("Resources/Concepts/Hadal Zone.md");
    expect(result.to).toBe("Resources/Concepts/hadal-zone.md");
    expect(existsSync(join(vaultPath, "Resources/Concepts/Hadal Zone.md"))).toBe(false);
    expect(existsSync(join(vaultPath, "Resources/Concepts/hadal-zone.md"))).toBe(true);

    // Working tree must be clean — no half-staged state from a failed commit.
    const status = git(["status", "--porcelain"]);
    expect(status).toBe("");

    // Wikilinks pointing at the old name were rewritten in the same commit.
    const ref = readFileSync(join(vaultPath, "Resources/Concepts/referrer.md"), "utf-8");
    expect(ref).toContain("[[hadal-zone]]");
    expect(ref).not.toContain("[[Hadal Zone]]");
    expect(ref).toContain("[[Resources/Concepts/hadal-zone|caps]]");
  });

  it("commits the rename even when no other files reference it (modified is empty)", async () => {
    // Edge case: when the wikilink-rewrite step produces no modified files,
    // `paths` is empty and gitCommitPaths skips `git add` entirely. The
    // commit must still succeed because `git mv` already staged the rename.
    seed(
      "Resources/Concepts/orphan.md",
      "---\ntype: concept\ntags: [test]\n---\nNothing links to me.",
    );
    git(["add", "."]);
    git(["commit", "-qm", "seed"]);

    const result = await handleMoveNote(
      defaultVaultContext(),
      "Resources/Concepts/orphan.md",
      "Resources/Concepts/lone.md",
      {},
    );

    expect(existsSync(join(vaultPath, "Resources/Concepts/orphan.md"))).toBe(false);
    expect(existsSync(join(vaultPath, "Resources/Concepts/lone.md"))).toBe(true);
    expect(result.links_updated).toBe(0);
    expect(git(["status", "--porcelain"])).toBe("");
  });
});

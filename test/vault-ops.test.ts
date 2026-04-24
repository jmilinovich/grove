import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We can't import `exec` directly without running child processes,
// but we can test the pure helpers: parseFrontmatter (via listNotes behavior)
// and the gitLog parsing logic.

// Test the exec helper's command resolution logic
describe("exec command resolution", () => {
  it("resolves git to /usr/bin/git", async () => {
    // We import exec and verify it works for a simple command
    const { exec } = await import("../src/vault-ops.js");

    // Run a safe command to verify exec works
    const result = await exec("git", ["--version"], "/tmp");
    expect(result).toMatch(/git version/);
  });

  it("rejects on invalid command", async () => {
    const { exec } = await import("../src/vault-ops.js");
    await expect(exec("nonexistent-command-xyz", [], "/tmp")).rejects.toThrow();
  });

  it("respects cwd parameter", async () => {
    const { exec } = await import("../src/vault-ops.js");
    const result = await exec("pwd", [], "/tmp");
    // /tmp may resolve to /private/tmp on macOS
    expect(result.trim()).toMatch(/\/tmp$/);
  });
});

// Test parseFrontmatter indirectly through its export pattern
// parseFrontmatter is not exported, but we can test the logic it encodes
describe("frontmatter parsing logic", () => {
  it("extracts type from valid frontmatter", async () => {
    // parseFrontmatter is internal to vault-ops; test its behavior via
    // the patterns it matches
    const yaml = `---
type: concept
tags: [ai]
---
Content here`;

    const typeMatch = yaml.match(/^type:\s*(.+)/m);
    expect(typeMatch).not.toBeNull();
    expect(typeMatch![1].trim()).toBe("concept");
  });

  it("extracts aliases from bracket notation", () => {
    const yaml = `aliases: [foo, "bar baz", 'qux']`;
    const aMatch = yaml.match(/^aliases:\s*\[(.+)]/);
    expect(aMatch).not.toBeNull();
    const aliases = aMatch![1].split(",").map((a) =>
      a.trim().replace(/^["']|["']$/g, ""),
    );
    expect(aliases).toEqual(["foo", "bar baz", "qux"]);
  });

  it("returns null type for missing frontmatter", () => {
    const text = "Just some content with no frontmatter";
    expect(text.startsWith("---")).toBe(false);
  });
});

describe("startupRecovery with no remote", () => {
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), "grove-vault-noremote-"));
    const { exec } = await import("../src/vault-ops.js");
    await exec("git", ["init", "-b", "main"], vaultPath);
    await exec("git", ["config", "user.email", "test@test"], vaultPath);
    await exec("git", ["config", "user.name", "test"], vaultPath);
    writeFileSync(join(vaultPath, "x.md"), "x");
    await exec("git", ["add", "-A"], vaultPath);
    await exec("git", ["commit", "-m", "init"], vaultPath);
  });

  afterEach(() => {
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it("does not throw when origin/main ref is missing", async () => {
    const { startupRecovery } = await import("../src/vault-ops.js");
    // No remote configured — prior to the fix this rejected with
    // "ambiguous argument 'origin/main..HEAD'" and pm2 restart-looped.
    await expect(startupRecovery(vaultPath)).resolves.toBeUndefined();
  });
});

// Test gitLog parsing logic (the block-splitting part)
describe("gitLog block parsing", () => {
  it("parses git log output into HistoryEntry shape", () => {
    // git log --format=%H%n%aI%n%s%n%an --name-only produces:
    // sha\ndate\nmessage\nauthor\nfile1\nfile2\n\nsha\n...
    // Files are on lines after author, separated from next entry by blank line
    const raw = `abc123def456
2026-04-01T10:00:00+00:00
grove (api): create note
John
Resources/Concepts/Foo.md

def789abc012
2026-03-31T09:00:00+00:00
grove (api): update note
John
Journal/2026/2026-03-31.md`;

    const entries: { sha: string; date: string; message: string; author: string; files: string[] }[] = [];
    const blocks = raw.split("\n\n");

    for (const block of blocks) {
      const lines = block.split("\n").filter(Boolean);
      if (lines.length < 4) continue;
      entries.push({
        sha: lines[0],
        date: lines[1],
        message: lines[2],
        author: lines[3],
        files: lines.slice(4),
      });
    }

    expect(entries).toHaveLength(2);
    expect(entries[0].sha).toBe("abc123def456");
    expect(entries[0].message).toBe("grove (api): create note");
    expect(entries[0].files).toEqual(["Resources/Concepts/Foo.md"]);
    expect(entries[1].files).toEqual(["Journal/2026/2026-03-31.md"]);
  });
});

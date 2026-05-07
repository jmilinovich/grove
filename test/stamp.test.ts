// Integration tests for the stamp override mechanism. Spins up a real git
// repo, creates a note via a "legacy" untrailered commit, then stamps a
// fresh provenance override and asserts blame surfaces the new voice.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { recomputeProvenanceBlame } from "../src/blame.js";
import { stampMany, stampOne } from "../scripts/provenance/stamp.js";

let vaultPath: string;
function git(args: string[]): string {
  return execFileSync("git", args, { cwd: vaultPath, encoding: "utf8" }).trim();
}

beforeAll(() => {
  vaultPath = mkdtempSync(join(tmpdir(), "grove-stamp-test-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@grove.local"]);
  git(["config", "user.name", "Grove Stamp Test"]);
  git(["config", "commit.gpgsign", "false"]);
});

afterAll(() => {
  rmSync(vaultPath, { recursive: true, force: true });
});

function createLegacyNote(rel: string, body: string): void {
  const full = join(vaultPath, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
  git(["add", rel]);
  git(["commit", "-q", "-m", `external: pre-rollout ${rel}`]);
}

describe("stampOne", () => {
  it("rewrites blame voice from legacy-unknown to perishable", async () => {
    const file = "Resources/Concepts/contaminated.md";
    createLegacyNote(
      file,
      "# Contaminated note\n\nThis was synthesized by Claude.\n",
    );

    // Pre-stamp: blame shows legacy-unknown.
    const before = await recomputeProvenanceBlame(vaultPath, file);
    expect(before).toHaveLength(1);
    expect(before[0].voice).toBe("legacy-unknown");

    // Stamp it.
    const result = await stampOne({
      vaultPath,
      notePath: file,
      provenance: {
        voice: "perishable",
        by: "claude-opus-4-6",
        written_at: "2026-04-30T22:15:00Z",
        reason: "synthesis from interview-prep session",
      },
    });
    expect(result.commit_sha).toMatch(/^[0-9a-f]{40}$/);

    // Post-stamp: blame shows perishable, attributed to the stamp commit.
    const after = await recomputeProvenanceBlame(vaultPath, file);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      voice: "perishable",
      by: "claude-opus-4-6",
      written_at: "2026-04-30T22:15:00Z",
      reason: "synthesis from interview-prep session",
      commit_sha: result.commit_sha,
    });
  });

  it("preserves file content byte-for-byte", async () => {
    const file = "Resources/Concepts/preserve.md";
    const original = "Line 1\nLine 2 with trailing whitespace   \n\n  Indented line\n";
    createLegacyNote(file, original);

    await stampOne({
      vaultPath,
      notePath: file,
      provenance: {
        voice: "perishable",
        by: "claude-opus-4-6",
        written_at: "2026-04-30T22:15:00Z",
      },
    });

    // Read back; must be identical.
    const after = execFileSync("cat", [join(vaultPath, file)], { encoding: "utf8" });
    expect(after).toBe(original);
  });

  it("rejects callers passing legacy-unknown", async () => {
    const file = "Resources/Concepts/badcaller.md";
    createLegacyNote(file, "x\n");
    await expect(
      stampOne({
        vaultPath,
        notePath: file,
        provenance: {
          voice: "legacy-unknown" as never,
          by: "human",
          written_at: "2026-05-07T18:00:00Z",
        },
      }),
    ).rejects.toThrow(/server-internal/);
  });

  it("rejects malformed timestamps", async () => {
    const file = "Resources/Concepts/badtime.md";
    createLegacyNote(file, "x\n");
    await expect(
      stampOne({
        vaultPath,
        notePath: file,
        provenance: {
          voice: "perishable",
          by: "claude-opus-4-7",
          written_at: "yesterday",
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects missing files", async () => {
    await expect(
      stampOne({
        vaultPath,
        notePath: "Resources/Concepts/does-not-exist.md",
        provenance: {
          voice: "perishable",
          by: "claude-opus-4-7",
          written_at: "2026-05-07T18:00:00Z",
        },
      }),
    ).rejects.toThrow(/cannot read/);
  });

  it("creates an empty commit (no content change) carrying trailers", async () => {
    const file = "Resources/Concepts/empty-commit-test.md";
    createLegacyNote(file, "stable content\n");
    const result = await stampOne({
      vaultPath,
      notePath: file,
      provenance: {
        voice: "perishable",
        by: "claude-opus-4-7",
        written_at: "2026-05-07T18:00:00Z",
      },
    });

    // Verify the commit shows zero changed files via --stat.
    const stat = execFileSync("git", ["show", "--stat", result.commit_sha], {
      cwd: vaultPath,
      encoding: "utf8",
    });
    // git show --stat output ends with a summary like "1 file changed, ..."
    // for non-empty commits; for empty commits, no file-change line.
    expect(stat).not.toMatch(/file changed/);
    // The commit message must carry the trailer.
    const msg = execFileSync("git", ["show", "-s", "--format=%B", result.commit_sha], {
      cwd: vaultPath,
      encoding: "utf8",
    });
    expect(msg).toContain("Provenance-Voice: perishable");
    expect(msg).toContain("Provenance-By: claude-opus-4-7");
  });
});

describe("stampMany", () => {
  it("applies a list of stamps in order", async () => {
    const a = "Resources/Concepts/many-a.md";
    const b = "Resources/Concepts/many-b.md";
    createLegacyNote(a, "a\n");
    createLegacyNote(b, "b\n");

    const { results, error } = await stampMany([
      {
        vaultPath,
        notePath: a,
        provenance: {
          voice: "perishable",
          by: "claude-opus-4-7",
          written_at: "2026-05-07T18:00:00Z",
        },
      },
      {
        vaultPath,
        notePath: b,
        provenance: {
          voice: "durable",
          by: "human",
          written_at: "2026-05-07T18:00:00Z",
        },
      },
    ]);

    expect(error).toBeUndefined();
    expect(results).toHaveLength(2);

    const blameA = await recomputeProvenanceBlame(vaultPath, a);
    const blameB = await recomputeProvenanceBlame(vaultPath, b);
    expect(blameA[0].voice).toBe("perishable");
    expect(blameB[0].voice).toBe("durable");
  });

  it("stops on first error and returns partial results", async () => {
    const ok = "Resources/Concepts/partial-ok.md";
    createLegacyNote(ok, "ok\n");
    const { results, error } = await stampMany([
      {
        vaultPath,
        notePath: ok,
        provenance: {
          voice: "perishable",
          by: "claude-opus-4-7",
          written_at: "2026-05-07T18:00:00Z",
        },
      },
      {
        vaultPath,
        notePath: "Resources/Concepts/missing.md",
        provenance: {
          voice: "perishable",
          by: "claude-opus-4-7",
          written_at: "2026-05-07T18:00:00Z",
        },
      },
    ]);

    expect(results).toHaveLength(1);
    expect(error).toBeDefined();
    expect(error?.index).toBe(1);
    expect(error?.message).toMatch(/cannot read/);
  });
});

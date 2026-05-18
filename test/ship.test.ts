import { describe, it, expect } from "vitest";

import {
  EXIT_MERGE_CONFLICT,
  MergeConflictError,
  findOverlappingTargets,
  parseTaskIds,
  shouldWarnHooksPath,
} from "../scripts/ship.ts";

describe("ship.ts — pure helpers", () => {
  describe("parseTaskIds", () => {
    it("pulls a single task id out of a feat() title", () => {
      expect(parseTaskIds("feat(P22-1): task run + defer/dismiss"))
        .toEqual(["P22-1"]);
    });

    it("pulls multiple comma-separated ids", () => {
      expect(parseTaskIds("feat(P22-1, P22-2): task run + defer/dismiss"))
        .toEqual(["P22-1", "P22-2"]);
    });

    it("handles longer phase prefixes (P8-A1, P4-API-2)", () => {
      expect(parseTaskIds("feat(P8-A1, P8-A5): schema migration + graceful shutdown"))
        .toEqual(["P8-A1", "P8-A5"]);
      expect(parseTaskIds("feat(P4-API-2): per-vault auth"))
        .toEqual(["P4-API-2"]);
    });

    it("accepts CLI- and REST- prefixed ids", () => {
      expect(parseTaskIds("fix(CLI-A3): keys list pagination"))
        .toEqual(["CLI-A3"]);
      expect(parseTaskIds("feat(REST-7): write queue exposure"))
        .toEqual(["REST-7"]);
    });

    it("uppercases lowercase ids", () => {
      expect(parseTaskIds("feat(p22-1, p22-2): mixed-case input"))
        .toEqual(["P22-1", "P22-2"]);
    });

    it("returns [] for titles without conventional-commit shape", () => {
      expect(parseTaskIds("just a freeform sentence")).toEqual([]);
      expect(parseTaskIds("")).toEqual([]);
      expect(parseTaskIds("feat: missing parens")).toEqual([]);
    });

    it("ignores tokens that aren't task ids", () => {
      // 'ship' is not an id; the regex throws it out.
      expect(parseTaskIds("chore(ship): not a task id")).toEqual([]);
      // Mixed: valid + invalid; only the valid ones survive.
      expect(parseTaskIds("feat(P22-1, not-a-task): mixed")).toEqual(["P22-1"]);
    });

    it("matches the regex used by check-plan-drift / mark-plan hook", () => {
      // Same shapes the post-commit hook's regex accepts.
      expect(parseTaskIds("feat(P21-2): v2 tasks schema")).toEqual(["P21-2"]);
      expect(parseTaskIds("feat(P7-COST-7): batch API")).toEqual(["P7-COST-7"]);
    });
  });

  describe("shouldWarnHooksPath", () => {
    it("warns when core.hooksPath is unset", () => {
      expect(shouldWarnHooksPath(null)).toBe(true);
    });

    it("warns when core.hooksPath points elsewhere", () => {
      expect(shouldWarnHooksPath("/usr/local/share/hooks")).toBe(true);
      expect(shouldWarnHooksPath(".husky")).toBe(true);
    });

    it("stays quiet when core.hooksPath is .claude/hooks", () => {
      expect(shouldWarnHooksPath(".claude/hooks")).toBe(false);
    });

    it("tolerates whitespace around the value", () => {
      // git config --get sometimes emits a trailing newline.
      expect(shouldWarnHooksPath(" .claude/hooks ")).toBe(false);
      expect(shouldWarnHooksPath(".claude/hooks\n")).toBe(false);
    });
  });

  describe("findOverlappingTargets", () => {
    it("returns empty when nothing overlaps", () => {
      const got = findOverlappingTargets([
        { branch: "a", targetFiles: ["src/foo.ts"] },
        { branch: "b", targetFiles: ["src/bar.ts"] },
      ]);
      expect(got.size).toBe(0);
    });

    it("identifies the p21-3 case (2 entries on v2-tasks.ts)", () => {
      const got = findOverlappingTargets([
        { branch: "tasks-list", targetFiles: ["src/v2-tasks.ts", "src/proxy.ts"] },
        { branch: "task-detail", targetFiles: ["src/v2-tasks.ts", "src/proxy.ts"] },
        { branch: "skills-list", targetFiles: ["src/v2-skills.ts", "src/proxy.ts"] },
      ]);
      expect(got.size).toBe(2);
      expect(got.get("src/v2-tasks.ts")).toEqual(["tasks-list", "task-detail"]);
      expect(got.get("src/proxy.ts")).toEqual(["tasks-list", "task-detail", "skills-list"]);
      // The non-overlapping file is not in the map.
      expect(got.has("src/v2-skills.ts")).toBe(false);
    });

    it("skips entries missing targetFiles", () => {
      const got = findOverlappingTargets([
        { branch: "a", targetFiles: ["src/foo.ts"] },
        { branch: "b" }, // declared no files — caller can't reason about it
        { branch: "c", targetFiles: ["src/foo.ts"] },
      ]);
      // Only the two entries with declared overlap show up.
      expect(got.get("src/foo.ts")).toEqual(["a", "c"]);
    });

    it("handles a single entry (no overlap by definition)", () => {
      const got = findOverlappingTargets([
        { branch: "solo", targetFiles: ["src/foo.ts", "src/bar.ts"] },
      ]);
      expect(got.size).toBe(0);
    });
  });

  describe("MergeConflictError", () => {
    it("carries the merged branches, conflicted branch, and files", () => {
      const err = new MergeConflictError(
        ["worktree-a"],
        "worktree-b",
        ["src/v2-tasks.ts"],
      );
      expect(err.name).toBe("MergeConflictError");
      expect(err.mergedBranches).toEqual(["worktree-a"]);
      expect(err.conflictBranch).toBe("worktree-b");
      expect(err.files).toEqual(["src/v2-tasks.ts"]);
      expect(err.message).toContain("worktree-a");
      expect(err.message).toContain("worktree-b");
      expect(err.message).toContain("src/v2-tasks.ts");
    });

    it("survives instanceof check (catch block in ship.ts depends on this)", () => {
      const err: unknown = new MergeConflictError([], "worktree-x", []);
      expect(err instanceof MergeConflictError).toBe(true);
      expect(err instanceof Error).toBe(true);
    });
  });

  describe("EXIT_MERGE_CONFLICT", () => {
    it("is 78 — distinct from generic 1 so operators can grep for it", () => {
      expect(EXIT_MERGE_CONFLICT).toBe(78);
    });
  });
});

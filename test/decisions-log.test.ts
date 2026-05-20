/**
 * S-INBOX-2 — falsifier for the `.grove/decisions.jsonl` writer.
 *
 * Covers the contract in src/decisions-log.ts:
 *
 *   1. Append 3 distinct-type decisions → readDecisionEvents returns 3
 *      in append order.
 *   2. Predicate filter → returns only matches.
 *   3. ensureDecisionsLogDir creates .grove/ on an empty vault (no file
 *      yet) — idempotent.
 *   4. Read on a missing file returns [] (no throw).
 *   5. Read tolerates a manually-inserted corrupted line — returns the
 *      two flanking valid decisions and warns on stderr.
 *
 * Each test uses an isolated temp vault dir (mkdtempSync + tmpdir) and
 * cleans it up afterwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendDecisionEvent,
  decisionsLogPath,
  ensureDecisionsLogDir,
  readDecisionEvents,
} from "../src/decisions-log.js";
import type { Decision } from "../src/v2-decisions.js";

let VAULT: string;

beforeEach(() => {
  VAULT = mkdtempSync(join(tmpdir(), "grove-decisions-log-"));
});

afterEach(() => {
  rmSync(VAULT, { recursive: true, force: true });
});

function disambiguation(): Decision {
  return {
    id: "D-2026-05-20-001",
    type: "disambiguation",
    skillRunId: "SR-2026-05-20-abc",
    taskId: "task_xyz",
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

function link(): Decision {
  return {
    id: "D-2026-05-20-002",
    type: "link",
    skillRunId: "SR-2026-05-20-abc",
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
      { id: "opt-1", label: "Link to Voyage AI", source: "schema" },
      { id: "opt-2", label: "Do not link", source: "schema" },
    ],
    chosenOptionId: "opt-1",
    affectedPaths: ["Journal/2026-05-20.md"],
    compensatedBy: null,
  };
}

function enrichment(): Decision {
  return {
    id: "D-2026-05-20-003",
    type: "enrichment",
    skillRunId: "SR-2026-05-20-abc",
    taskId: "task_enrich",
    createdAt: "2026-05-20T14:40:00Z",
    status: "provisional",
    payload: {
      target_path: "Resources/People/Anna Chen.md",
      prior_content: "---\ntype: person\n---\n\nAnna Chen is a designer.\n",
      new_content:
        "---\ntype: person\n---\n\nAnna Chen is a designer at [[Voyage AI]].\n",
    },
    options: [
      { id: "opt-1", label: "Apply enrichment", source: "schema" },
      { id: "opt-2", label: "Skip", source: "schema" },
    ],
    chosenOptionId: "opt-1",
    affectedPaths: ["Resources/People/Anna Chen.md"],
    compensatedBy: null,
  };
}

describe("S-INBOX-2 — .grove/decisions.jsonl writer", () => {
  it("appends 3 different decision types and reads them back in order", () => {
    const d1 = disambiguation();
    const d2 = link();
    const d3 = enrichment();

    appendDecisionEvent(VAULT, d1);
    appendDecisionEvent(VAULT, d2);
    appendDecisionEvent(VAULT, d3);

    const path = decisionsLogPath(VAULT);
    expect(path).toBe(join(VAULT, ".grove", "decisions.jsonl"));
    expect(existsSync(path)).toBe(true);

    const events = readDecisionEvents(VAULT);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual(d1);
    expect(events[1]).toEqual(d2);
    expect(events[2]).toEqual(d3);

    // File ends with a newline and has exactly 3 lines (plus trailing).
    const raw = readFileSync(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").filter((l) => l.length > 0)).toHaveLength(3);
  });

  it("readDecisionEvents filters by predicate when provided", () => {
    appendDecisionEvent(VAULT, disambiguation());
    appendDecisionEvent(VAULT, link());
    appendDecisionEvent(VAULT, enrichment());

    const linksOnly = readDecisionEvents(VAULT, (d) => d.type === "link");
    expect(linksOnly).toHaveLength(1);
    expect(linksOnly[0]!.type).toBe("link");
    expect(linksOnly[0]!.id).toBe("D-2026-05-20-002");
  });

  it("ensureDecisionsLogDir creates .grove/ on an empty vault without a file", () => {
    ensureDecisionsLogDir(VAULT);
    const dir = join(VAULT, ".grove");
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
    // No file yet — only the dir.
    expect(existsSync(decisionsLogPath(VAULT))).toBe(false);

    // Idempotent — second call doesn't throw or alter contents.
    ensureDecisionsLogDir(VAULT);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it("readDecisionEvents on a missing file returns [] without throwing", () => {
    // Fresh VAULT has no .grove dir at all.
    expect(readDecisionEvents(VAULT)).toEqual([]);
    // Also tolerates the dir existing but no file.
    ensureDecisionsLogDir(VAULT);
    expect(readDecisionEvents(VAULT)).toEqual([]);
  });

  it("readDecisionEvents skips a corrupted line and warns on stderr", () => {
    const d1 = disambiguation();
    const d2 = link();

    appendDecisionEvent(VAULT, d1);
    // Inject a corrupt line between two valid ones.
    appendFileSync(decisionsLogPath(VAULT), "{not json\n", { encoding: "utf8" });
    appendDecisionEvent(VAULT, d2);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const events = readDecisionEvents(VAULT);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(d1);
      expect(events[1]).toEqual(d2);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0]![0]);
      expect(msg).toMatch(/corrupted line/);
      expect(msg).toMatch(/line 2/);
    } finally {
      warn.mockRestore();
    }
  });
});

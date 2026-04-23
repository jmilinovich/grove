import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Regression for the "search result 404" bug — QMD's indexer slugs Unicode
// characters as their hex codepoint (`-1faf6-` for 🫶), but grove's
// `toKebab` drops non-ASCII entirely. The two slug schemes don't round-
// trip, so any note with an emoji in its filename would fail to resolve
// when clicked from a search result.

vi.mock("../src/vault-ops.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault-ops.js")>();
  return {
    ...actual,
    gitCommit: vi.fn().mockResolvedValue("abc123"),
    gitPush: vi.fn().mockResolvedValue(undefined),
    qmdReindex: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("../src/embed-single.js", () => ({
  embedFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/vault-stats.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault-stats.js")>();
  return { ...actual, refreshStats: vi.fn().mockResolvedValue(undefined) };
});

let tempVault: string;

beforeEach(() => {
  tempVault = mkdtempSync(join(tmpdir(), "grove-resolve-emoji-"));
  process.env.GROVE_VAULT = tempVault;
  process.env.GROVE_DB_PATH = join(tempVault, "grove.db");
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.GROVE_VAULT;
  delete process.env.GROVE_DB_PATH;
});

async function loadRest() {
  vi.resetModules();
  const db = await import("../src/db.js");
  db.resetDb();
  db.createSchema();
  return import("../src/rest.js");
}

describe("resolveNote — QMD codepoint-slug compatibility", () => {
  it("resolves a QMD slug with a -<codepoint>- segment back to the real emoji filename", async () => {
    // Disk filename: `...have fun 🫶 SYSTEM.md`
    // QMD index emits: `...have-fun-1faf6-system.md`  (🫶 = U+1FAF6)
    const sourcesDir = join(tempVault, "Sources");
    mkdirSync(sourcesDir, { recursive: true });
    const diskName = "2025-12-29 @IamEmily2050 - The system prompt is out, have fun 🫶 SYSTEM.md";
    writeFileSync(join(sourcesDir, diskName), "---\ntype: concept\n---\nBody");

    const { handleGetNote } = await loadRest();

    const qmdPath = "sources/2025-12-29-iamemily2050-the-system-prompt-is-out-have-fun-1faf6-system.md";
    const note = await handleGetNote(qmdPath);
    expect(note).not.toBeNull();
    expect(note!.path).toBe(`Sources/${diskName}`);
  });

  it("works for globe emoji (🌐 = U+1F310) too — ensures the match is general, not fixture-specific", async () => {
    const sourcesDir = join(tempVault, "Sources");
    mkdirSync(sourcesDir, { recursive: true });
    const diskName = "2026-03-16 @pelaseyed - Introducing Infinite Monitor 🌐 Monitor any situat.md";
    writeFileSync(join(sourcesDir, diskName), "---\ntype: concept\n---\nBody");

    const { handleGetNote } = await loadRest();

    const qmdPath = "sources/2026-03-16-pelaseyed-introducing-infinite-monitor-1f310-monitor-any-situat.md";
    const note = await handleGetNote(qmdPath);
    expect(note).not.toBeNull();
    expect(note!.path).toBe(`Sources/${diskName}`);
  });

  it("doesn't confuse year-date segments (-2026-) with codepoint encodings", async () => {
    // Year-only sequences are digits with no letters, so the codepoint-
    // collapse branch shouldn't touch them. Verify a filename with a year
    // still resolves via the regular kebab step.
    const dir = join(tempVault, "Areas/Meal Planning/Weekly Plans");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Week of 2026-03-02.md"), "---\ntype: journal\n---\nNotes");

    const { handleGetNote } = await loadRest();
    const note = await handleGetNote("areas/meal-planning/weekly-plans/week-of-2026-03-02.md");
    expect(note).not.toBeNull();
    expect(note!.path).toBe("Areas/Meal Planning/Weekly Plans/Week of 2026-03-02.md");
  });
});

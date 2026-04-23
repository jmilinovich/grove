import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defaultVaultContext } from "../src/rest.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

let tempVault: string;

function writeNote(rel: string, frontmatter: Record<string, unknown>, body: string = "") {
  const abs = join(tempVault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const fmYaml = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}`;
      }
      return `${k}: ${v}`;
    })
    .join("\n");
  const content = `---\n${fmYaml}\n---\n${body}`;
  writeFileSync(abs, content, "utf-8");
}

beforeEach(() => {
  tempVault = mkdtempSync(join(tmpdir(), "grove-trail-preview-"));
  process.env.GROVE_VAULT = tempVault;

  writeNote("Resources/Concepts/RAG.md", { type: "concept", tags: ["ai", "ml"] });
  writeNote("Resources/Concepts/Taste Graph.md", { type: "concept", tags: ["ai", "design"] });
  writeNote("Resources/Concepts/Cooking.md", { type: "concept", tags: ["food"] });
  writeNote("Resources/People/Karpathy.md", { type: "person", tags: ["ai"] });
  writeNote("Resources/People/Friend.md", { type: "person", tags: ["personal"] });
  writeNote("Journal/2026/2026-04-01.md", { type: "journal", tags: ["journal"] });
  writeNote("Journal/2026/2026-04-02.md", { type: "journal", tags: ["journal", "private"] });
  writeNote("Areas/Finances/Budget.md", { type: "area", tags: ["finance"] });
  writeNote("Inbox/private-draft.md", { type: "note", tags: ["draft"], private: true });
});

afterEach(() => {
  delete process.env.GROVE_VAULT;
  rmSync(tempVault, { recursive: true, force: true });
});

async function loadRest() {
  vi.resetModules();
  return import("../src/rest.js");
}

describe("handleTrailPreview", () => {
  it("returns count and samples for unfiltered scope", async () => {
    const { handleTrailPreview } = await loadRest();
    const result = handleTrailPreview(defaultVaultContext(), {});
    expect(result.total_notes).toBe(9);
    // private:true note is excluded by filterByTrail
    expect(result.match_count).toBe(8);
    expect(result.samples.length).toBeGreaterThan(0);
    expect(result.samples.every((s) => !s.path.includes("private-draft"))).toBe(true);
  });

  it("counts only notes matching allow_paths", async () => {
    const { handleTrailPreview } = await loadRest();
    const result = handleTrailPreview(defaultVaultContext(), { allow_paths: ["Resources/"] });
    expect(result.match_count).toBe(5);
    expect(result.samples.every((s) => s.path.startsWith("Resources/"))).toBe(true);
  });

  it("excludes notes matching deny_paths", async () => {
    const { handleTrailPreview } = await loadRest();
    const result = handleTrailPreview(defaultVaultContext(), { deny_paths: ["Journal/", "Areas/"] });
    // 9 total - 1 private - 2 journal - 1 area = 5
    expect(result.match_count).toBe(5);
  });

  it("filters by allow_tags (OR logic across tags)", async () => {
    const { handleTrailPreview } = await loadRest();
    const result = handleTrailPreview(defaultVaultContext(), { allow_tags: ["ai"] });
    expect(result.match_count).toBe(3); // RAG, Taste Graph, Karpathy
  });

  it("filters by allow_types", async () => {
    const { handleTrailPreview } = await loadRest();
    const result = handleTrailPreview(defaultVaultContext(), { allow_types: ["concept"] });
    expect(result.match_count).toBe(3);
    expect(result.samples.every((s) => s.type === "concept")).toBe(true);
  });

  it("combines multiple filters with AND logic", async () => {
    const { handleTrailPreview } = await loadRest();
    const result = handleTrailPreview(defaultVaultContext(), {
      allow_paths: ["Resources/"],
      allow_tags: ["ai"],
      allow_types: ["concept"],
    });
    expect(result.match_count).toBe(2); // RAG, Taste Graph
  });

  it("returns all_tags and all_types for the vault", async () => {
    const { handleTrailPreview } = await loadRest();
    const result = handleTrailPreview(defaultVaultContext(), {});
    expect(result.all_tags).toContain("ai");
    expect(result.all_tags).toContain("journal");
    expect(result.all_tags).toContain("finance");
    expect(result.all_types).toContain("concept");
    expect(result.all_types).toContain("person");
    expect(result.all_types).toContain("journal");
  });

  it("respects sampleLimit", async () => {
    const { handleTrailPreview } = await loadRest();
    const result = handleTrailPreview(defaultVaultContext(), {}, 2);
    expect(result.samples.length).toBe(2);
    expect(result.match_count).toBe(8);
  });

  it("deny_tags overrides allow_tags match", async () => {
    const { handleTrailPreview } = await loadRest();
    const result = handleTrailPreview(defaultVaultContext(), {
      allow_tags: ["journal"],
      deny_tags: ["private"],
    });
    // 2026-04-01 (journal, no private) matches; 2026-04-02 has 'private' → denied
    expect(result.match_count).toBe(1);
  });
});

describe("handleTrailPreviewTest", () => {
  it("returns null for non-existent note", async () => {
    const { handleTrailPreviewTest } = await loadRest();
    const result = handleTrailPreviewTest(defaultVaultContext(), "Nowhere/nope.md", {});
    expect(result).toBeNull();
  });

  it("reports visible for matching note", async () => {
    const { handleTrailPreviewTest } = await loadRest();
    const result = handleTrailPreviewTest(defaultVaultContext(), "Resources/Concepts/RAG.md", {
      allow_paths: ["Resources/"],
      allow_tags: ["ai"],
    });
    expect(result?.visible).toBe(true);
    expect(result?.note.tags).toContain("ai");
  });

  it("reports blocked with path reason", async () => {
    const { handleTrailPreviewTest } = await loadRest();
    const result = handleTrailPreviewTest(defaultVaultContext(), "Journal/2026/2026-04-01.md", {
      allow_paths: ["Resources/"],
    });
    expect(result?.visible).toBe(false);
    expect(result?.reason).toContain("allow_paths");
  });

  it("reports blocked with deny_paths reason", async () => {
    const { handleTrailPreviewTest } = await loadRest();
    const result = handleTrailPreviewTest(defaultVaultContext(), "Journal/2026/2026-04-01.md", {
      deny_paths: ["Journal/"],
    });
    expect(result?.visible).toBe(false);
    expect(result?.reason).toContain("deny_paths");
  });

  it("reports blocked by deny_tags", async () => {
    const { handleTrailPreviewTest } = await loadRest();
    const result = handleTrailPreviewTest(defaultVaultContext(), "Journal/2026/2026-04-02.md", {
      deny_tags: ["private"],
    });
    expect(result?.visible).toBe(false);
    expect(result?.reason).toContain("deny_tags");
  });

  it("reports blocked by type filter", async () => {
    const { handleTrailPreviewTest } = await loadRest();
    const result = handleTrailPreviewTest(defaultVaultContext(), "Resources/People/Karpathy.md", {
      allow_types: ["concept"],
    });
    expect(result?.visible).toBe(false);
    expect(result?.reason).toContain("allow_types");
  });

  it("reports blocked for private notes", async () => {
    const { handleTrailPreviewTest } = await loadRest();
    const result = handleTrailPreviewTest(defaultVaultContext(), "Inbox/private-draft.md", {});
    expect(result?.visible).toBe(false);
    expect(result?.reason).toContain("private");
  });
});

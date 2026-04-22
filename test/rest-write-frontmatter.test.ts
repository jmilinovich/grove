/**
 * Frontmatter validation surface test.
 *
 * The write_note tool and REST handler route all writes through
 * validateNote() in src/notes-validate.ts. That function is currently
 * covered only in passing (rest-write.test.ts hits one missing-type case
 * via handleWriteNote, but the other rejection paths are implicit).
 * This test covers each rejection path as a named surface — a reader
 * can see, at a glance, every way a malformed note is rejected before
 * it reaches the write queue.
 *
 * These are unit tests against validateNote directly: no vault setup,
 * no database, no git. Fast and deterministic. The full integration
 * path (handleWriteNote → validateNote) is covered separately in
 * rest-write.test.ts.
 */

import { describe, it, expect } from "vitest";
import { validateNote } from "../src/notes-validate.js";
import type { VaultConfig } from "../src/vault-config.js";

// Minimal config. The validator uses structure.type_paths for
// path/type consistency; an empty record skips folder enforcement,
// which keeps these tests focused on frontmatter shape alone.
const MINIMAL_CONFIG: VaultConfig = {
  name: "test",
  structure: {
    type_paths: {},
    journal_filename: null,
    prefix_tags: [],
  },
} as VaultConfig;

function fm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "concept", tags: ["test"], ...overrides };
}

describe("validateNote — frontmatter rejection surface", () => {
  describe("type", () => {
    it("accepts a valid concept note", () => {
      const { errors } = validateNote(
        "Inbox/ok.md",
        fm(),
        "body",
        MINIMAL_CONFIG,
      );
      expect(errors).toEqual([]);
    });

    it("rejects missing type field", () => {
      const { errors } = validateNote(
        "Inbox/bad.md",
        { tags: ["test"] },
        "body",
        MINIMAL_CONFIG,
      );
      expect(errors).toContain("Missing required field 'type'");
    });

    it("rejects empty-string type", () => {
      const { errors } = validateNote(
        "Inbox/bad.md",
        { type: "", tags: ["test"] },
        "body",
        MINIMAL_CONFIG,
      );
      expect(errors).toContain("Missing required field 'type'");
    });

    it("rejects non-string type (number)", () => {
      const { errors } = validateNote(
        "Inbox/bad.md",
        { type: 123, tags: ["test"] },
        "body",
        MINIMAL_CONFIG,
      );
      expect(errors).toContain("Missing required field 'type'");
    });

    it("rejects null type", () => {
      const { errors } = validateNote(
        "Inbox/bad.md",
        { type: null, tags: ["test"] },
        "body",
        MINIMAL_CONFIG,
      );
      expect(errors).toContain("Missing required field 'type'");
    });
  });

  describe("tags", () => {
    it("rejects missing tags", () => {
      const { errors } = validateNote(
        "Inbox/bad.md",
        { type: "concept" },
        "body",
        MINIMAL_CONFIG,
      );
      expect(errors).toContain("At least one tag is required");
    });

    it("rejects empty-array tags", () => {
      const { errors } = validateNote(
        "Inbox/bad.md",
        { type: "concept", tags: [] },
        "body",
        MINIMAL_CONFIG,
      );
      expect(errors).toContain("At least one tag is required");
    });

    it("rejects non-array non-string tags (object)", () => {
      const { errors } = validateNote(
        "Inbox/bad.md",
        { type: "concept", tags: { foo: "bar" } },
        "body",
        MINIMAL_CONFIG,
      );
      expect(errors).toContain("At least one tag is required");
    });

    it("accepts a single string tag (normalized to array)", () => {
      const { errors } = validateNote(
        "Inbox/ok.md",
        { type: "concept", tags: "alone" },
        "body",
        MINIMAL_CONFIG,
      );
      expect(errors).toEqual([]);
    });
  });

  describe("journal filename", () => {
    const JOURNAL_CONFIG: VaultConfig = {
      name: "test",
      structure: {
        type_paths: {},
        journal_filename: "YYYY-MM-DD.md",
        prefix_tags: [],
      },
    } as VaultConfig;

    it("accepts a valid YYYY-MM-DD journal filename", () => {
      const { errors } = validateNote(
        "Journal/2026/2026-04-21.md",
        fm({ type: "journal", tags: ["journal"], date: "2026-04-21" }),
        "body",
        JOURNAL_CONFIG,
      );
      expect(errors).toEqual([]);
    });

    it("accepts YYYY-MM-DD-N for multi-entry days", () => {
      const { errors } = validateNote(
        "Journal/2026/2026-04-21-2.md",
        fm({ type: "journal", tags: ["journal"], date: "2026-04-21" }),
        "body",
        JOURNAL_CONFIG,
      );
      expect(errors).toEqual([]);
    });

    it("rejects a malformed journal filename", () => {
      const { errors } = validateNote(
        "Journal/2026/april-21.md",
        fm({ type: "journal", tags: ["journal"], date: "2026-04-21" }),
        "body",
        JOURNAL_CONFIG,
      );
      expect(errors.some((e) => e.includes("Journal entries must match"))).toBe(
        true,
      );
    });

    it("rejects journal note missing the required date field", () => {
      const { errors } = validateNote(
        "Journal/2026/2026-04-21.md",
        fm({ type: "journal", tags: ["journal"] }),
        "body",
        JOURNAL_CONFIG,
      );
      expect(errors).toContain("Missing required field 'date' for type 'journal'");
    });
  });

  describe("path/type consistency", () => {
    const TYPED_CONFIG: VaultConfig = {
      name: "test",
      structure: {
        type_paths: {
          concept: "Resources/Concepts/",
          recipe: "Resources/Recipes/",
        },
        journal_filename: null,
        prefix_tags: [],
      },
    } as VaultConfig;

    it("accepts a concept in the concept folder", () => {
      const { errors } = validateNote(
        "Resources/Concepts/Flow.md",
        fm({ type: "concept" }),
        "body",
        TYPED_CONFIG,
      );
      expect(errors).toEqual([]);
    });

    it("rejects a concept placed in the recipe folder", () => {
      const { errors } = validateNote(
        "Resources/Recipes/ShouldBeRecipe.md",
        fm({ type: "concept" }),
        "body",
        TYPED_CONFIG,
      );
      expect(
        errors.some((e) =>
          e.includes("cannot be placed under Resources/Recipes"),
        ),
      ).toBe(true);
    });
  });

  describe("content size", () => {
    it("rejects content over 100KB", () => {
      const huge = "x".repeat(150_000);
      const { errors } = validateNote(
        "Inbox/huge.md",
        fm(),
        huge,
        MINIMAL_CONFIG,
      );
      expect(errors).toContain("Content exceeds 100KB limit");
    });
  });
});

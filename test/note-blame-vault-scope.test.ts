/**
 * Regression test: getNoteVoicesAndAges must not return blame data from a
 * different vault that happens to share the same note path.
 *
 * Without vault scoping, two vaults with `Resources/People/Alice.md` would
 * each see the other's provenance metadata — whichever was computed most
 * recently would win. This test seeded two vaults' blame rows at the same
 * path and asserts isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-blame-vault-scope-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");

import { createSchema, resetDb, setNoteBlame, getNoteVoicesAndAges } from "../src/db.js";

describe("getNoteVoicesAndAges — vault isolation", () => {
  beforeEach(() => {
    resetDb();
    createSchema();
  });

  afterEach(() => {
    resetDb();
  });

  it("returns only blame rows tagged with the requesting vault_id", () => {
    const sharedPath = "Resources/People/Alice.md";
    const hash = "abc123";

    const vaultASegments = JSON.stringify([
      { voice: "durable", written_at: "2026-01-01T00:00:00Z" },
    ]);
    const vaultBSegments = JSON.stringify([
      { voice: "perishable", written_at: "2026-06-01T00:00:00Z" },
    ]);

    // Vault B wrote its blame row most recently — without scoping, vault A
    // would return vault B's "perishable" voice because it has the higher
    // computed_at timestamp.
    setNoteBlame(sharedPath, hash + "-a", vaultASegments, "vault_aaa");
    setNoteBlame(sharedPath, hash + "-b", vaultBSegments, "vault_bbb");

    const resultA = getNoteVoicesAndAges(
      ["resources/people/alice.md"],
      "vault_aaa",
    );
    const resultB = getNoteVoicesAndAges(
      ["resources/people/alice.md"],
      "vault_bbb",
    );

    // Vault A should see its own "durable" row only.
    expect(resultA.size).toBe(1);
    const entryA = resultA.get("resources/people/alice.md");
    expect(entryA?.voice).toBe("durable");

    // Vault B should see its own "perishable" row only.
    expect(resultB.size).toBe(1);
    const entryB = resultB.get("resources/people/alice.md");
    expect(entryB?.voice).toBe("perishable");
  });

  it("falls back to unscoped rows when no vault_id is provided (legacy compat)", () => {
    const path = "Resources/Concepts/Design.md";
    const legacySegments = JSON.stringify([
      { voice: "durable", written_at: "2025-01-01T00:00:00Z" },
    ]);
    // Insert a row with no vault_id (pre-migration legacy row).
    setNoteBlame(path, "legacy-hash", legacySegments, undefined);

    // Without vaultId filter, the legacy row is visible.
    const result = getNoteVoicesAndAges(["resources/concepts/design.md"]);
    expect(result.size).toBe(1);
    expect(result.get("resources/concepts/design.md")?.voice).toBe("durable");
  });

  it("returns empty map when vaultId is supplied but no rows match that vault", () => {
    const path = "Resources/Concepts/Design.md";
    const segments = JSON.stringify([
      { voice: "durable", written_at: "2025-01-01T00:00:00Z" },
    ]);
    setNoteBlame(path, "hash-x", segments, "vault_other");

    // Vault that owns no blame rows returns empty.
    const result = getNoteVoicesAndAges(
      ["resources/concepts/design.md"],
      "vault_requesting",
    );
    expect(result.size).toBe(0);
  });
});

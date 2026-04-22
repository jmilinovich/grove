import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createSchema,
  getDb,
  resetDb,
  recordWrite,
  getSourceHash,
  getProvenance,
  deleteProvenance,
  renameProvenance,
} from "../src/db.js";

describe("write_provenance", () => {
  let dbDir: string;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "grove-prov-"));
    process.env.GROVE_DB_PATH = join(dbDir, "grove.db");
    resetDb();
    createSchema();
  });

  afterEach(() => {
    resetDb();
    rmSync(dbDir, { recursive: true, force: true });
    delete process.env.GROVE_DB_PATH;
  });

  it("returns null for a path with no recorded write", () => {
    expect(getSourceHash("Resources/Concepts/Missing.md")).toBe(null);
    expect(getProvenance("Resources/Concepts/Missing.md")).toBe(null);
  });

  it("records and retrieves source hash", () => {
    recordWrite("Resources/Concepts/X.md", "hash-abc", "sha-1111", "jm");
    expect(getSourceHash("Resources/Concepts/X.md")).toBe("hash-abc");

    const row = getProvenance("Resources/Concepts/X.md");
    expect(row).not.toBe(null);
    expect(row!.path).toBe("Resources/Concepts/X.md");
    expect(row!.source_hash).toBe("hash-abc");
    expect(row!.commit_sha).toBe("sha-1111");
    expect(row!.actor).toBe("jm");
    expect(row!.written_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("upserts on subsequent writes to the same path", () => {
    recordWrite("Resources/Concepts/X.md", "hash-1", "sha-1", "jm");
    recordWrite("Resources/Concepts/X.md", "hash-2", "sha-2", "jm");
    recordWrite("Resources/Concepts/X.md", "hash-3", "sha-3", "automation");

    expect(getSourceHash("Resources/Concepts/X.md")).toBe("hash-3");
    const row = getProvenance("Resources/Concepts/X.md");
    expect(row!.commit_sha).toBe("sha-3");
    expect(row!.actor).toBe("automation");

    // Only one row per path.
    const rows = getDb()
      .prepare("SELECT COUNT(*) as n FROM write_provenance WHERE path = ?")
      .get("Resources/Concepts/X.md") as { n: number };
    expect(rows.n).toBe(1);
  });

  it("stores null actor when not provided", () => {
    recordWrite("Resources/Concepts/Y.md", "hash-y", "sha-y");
    const row = getProvenance("Resources/Concepts/Y.md");
    expect(row!.actor).toBe(null);
  });

  it("deletes provenance by path", () => {
    recordWrite("Resources/Concepts/Z.md", "hash-z", "sha-z");
    expect(getSourceHash("Resources/Concepts/Z.md")).toBe("hash-z");

    deleteProvenance("Resources/Concepts/Z.md");
    expect(getSourceHash("Resources/Concepts/Z.md")).toBe(null);
  });

  it("is a no-op to delete a non-existent path", () => {
    expect(() => deleteProvenance("Resources/Concepts/never-existed.md")).not.toThrow();
  });

  it("renames provenance from one path to another", () => {
    recordWrite("Inbox/draft.md", "hash-draft", "sha-d", "jm");
    renameProvenance("Inbox/draft.md", "Resources/Concepts/final.md");

    expect(getSourceHash("Inbox/draft.md")).toBe(null);
    expect(getSourceHash("Resources/Concepts/final.md")).toBe("hash-draft");
  });

  it("isolates writes across different paths", () => {
    recordWrite("A.md", "hash-a", "sha-a");
    recordWrite("B.md", "hash-b", "sha-b");

    expect(getSourceHash("A.md")).toBe("hash-a");
    expect(getSourceHash("B.md")).toBe("hash-b");
  });
});

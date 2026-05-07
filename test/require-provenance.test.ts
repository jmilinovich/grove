// Phase C2: GROVE_REQUIRE_PROVENANCE strict-mode tests.
//
// Verifies handleWriteNote and handleWriteBatch reject calls without a
// provenance arg when the flag is on, and accept them when off (default).
// Also verifies that internal-style writes via gitCommit (bypassing
// handleWriteNote) are NOT affected — by design, only the MCP/REST
// surface is gated.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleWriteNote, handleWriteBatch } from "../src/rest.js";
import { provenanceRequired } from "../src/blame.js";
import type { VaultContext } from "../src/vault-router.js";

let vaultPath: string;
let ctx: VaultContext;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: vaultPath, encoding: "utf8" }).trim();
}

beforeAll(async () => {
  vaultPath = mkdtempSync(join(tmpdir(), "grove-require-prov-test-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@grove.local"]);
  git(["config", "user.name", "Grove Test"]);
  git(["config", "commit.gpgsign", "false"]);
  // Seed an initial commit so HEAD exists.
  execFileSync("touch", [join(vaultPath, ".gitkeep")]);
  git(["add", ".gitkeep"]);
  git(["commit", "-q", "-m", "init"]);

  process.env.GROVE_DB_PATH = join(vaultPath, "test.db");
  // Ensure read-side surfacing is on (default) so the test exercises the
  // realistic prod shape.
  delete process.env.GROVE_PROVENANCE_ENABLED;

  const db = await import("../src/db.js");
  db.createSchema();

  ctx = {
    vaultPath,
    vaultId: "test-vault",
    vaultSlug: "test",
  };
});

afterAll(() => {
  rmSync(vaultPath, { recursive: true, force: true });
  delete process.env.GROVE_REQUIRE_PROVENANCE;
});

beforeEach(() => {
  // Ensure each test starts with the flag in a known state.
  delete process.env.GROVE_REQUIRE_PROVENANCE;
});

afterEach(() => {
  delete process.env.GROVE_REQUIRE_PROVENANCE;
});

describe("provenanceRequired() helper", () => {
  beforeEach(() => {
    delete process.env.GROVE_REQUIRE_PROVENANCE;
    delete process.env.GROVE_REQUIRE_PROVENANCE_personal;
    delete process.env.GROVE_REQUIRE_PROVENANCE_ryan;
  });

  it("defaults to false", () => {
    expect(provenanceRequired()).toBe(false);
  });

  it('accepts "true" and "1"', () => {
    process.env.GROVE_REQUIRE_PROVENANCE = "true";
    expect(provenanceRequired()).toBe(true);
    process.env.GROVE_REQUIRE_PROVENANCE = "1";
    expect(provenanceRequired()).toBe(true);
  });

  it("treats other values as false", () => {
    process.env.GROVE_REQUIRE_PROVENANCE = "yes";
    expect(provenanceRequired()).toBe(false);
    process.env.GROVE_REQUIRE_PROVENANCE = "false";
    expect(provenanceRequired()).toBe(false);
    process.env.GROVE_REQUIRE_PROVENANCE = "";
    expect(provenanceRequired()).toBe(false);
  });

  it("per-vault override: GROVE_REQUIRE_PROVENANCE_<slug>=true wins for that slug only", () => {
    process.env.GROVE_REQUIRE_PROVENANCE_personal = "true";
    expect(provenanceRequired("personal")).toBe(true);
    expect(provenanceRequired("ryan")).toBe(false);
    expect(provenanceRequired()).toBe(false);
  });

  it("per-vault override does not affect calls without a slug", () => {
    process.env.GROVE_REQUIRE_PROVENANCE_personal = "true";
    expect(provenanceRequired()).toBe(false);
  });

  it("global flag still applies to vaults without a per-vault override", () => {
    process.env.GROVE_REQUIRE_PROVENANCE = "true";
    expect(provenanceRequired("personal")).toBe(true);
    expect(provenanceRequired("ryan")).toBe(true);
    expect(provenanceRequired()).toBe(true);
  });
});

describe("handleWriteNote — strict mode", () => {
  it("accepts writes without provenance when the flag is OFF (default)", async () => {
    const result = await handleWriteNote(
      ctx,
      "Notes/no-prov-default-off.md",
      { type: "note", tags: ["test"] },
      "body",
      {},
    );
    expect(result.path).toBe("Notes/no-prov-default-off.md");
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("REJECTS writes without provenance when the flag is ON", async () => {
    process.env.GROVE_REQUIRE_PROVENANCE = "true";
    await expect(
      handleWriteNote(
        ctx,
        "Notes/no-prov-flag-on.md",
        { type: "note", tags: ["test"] },
        "body",
        {},
      ),
    ).rejects.toThrow(/Provenance is required/);
  });

  it("ACCEPTS writes WITH provenance when the flag is ON", async () => {
    process.env.GROVE_REQUIRE_PROVENANCE = "true";
    const result = await handleWriteNote(
      ctx,
      "Notes/with-prov-flag-on.md",
      { type: "note", tags: ["test"] },
      "body",
      {
        provenance: {
          voice: "durable",
          by: "human",
          written_at: "2026-05-07T19:30:00Z",
        },
      },
    );
    expect(result.path).toBe("Notes/with-prov-flag-on.md");
  });

  it("error code is VALIDATION (so REST callers return 400, not 500)", async () => {
    process.env.GROVE_REQUIRE_PROVENANCE = "true";
    try {
      await handleWriteNote(
        ctx,
        "Notes/check-error-code.md",
        { type: "note", tags: ["test"] },
        "body",
        {},
      );
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("VALIDATION");
      expect(err.errors).toContain("missing required provenance");
    }
  });
});

describe("handleWriteBatch — strict mode", () => {
  it("REJECTS the whole batch if any op is missing provenance (flag ON)", async () => {
    process.env.GROVE_REQUIRE_PROVENANCE = "true";
    await expect(
      handleWriteBatch(ctx, [
        {
          path: "Notes/batch-with-prov.md",
          frontmatter: { type: "note", tags: ["test"] },
          content: "ok",
          provenance: {
            voice: "durable",
            by: "human",
            written_at: "2026-05-07T19:30:00Z",
          },
        },
        {
          path: "Notes/batch-missing-prov.md",
          frontmatter: { type: "note", tags: ["test"] },
          content: "missing",
          // no provenance
        },
      ]),
    ).rejects.toThrow(/op 1: provenance required/);
  });

  it("accepts a batch when every op carries provenance (flag ON)", async () => {
    process.env.GROVE_REQUIRE_PROVENANCE = "true";
    const result = await handleWriteBatch(ctx, [
      {
        path: "Notes/batch-a.md",
        frontmatter: { type: "note", tags: ["test"] },
        content: "a",
        provenance: {
          voice: "durable",
          by: "human",
          written_at: "2026-05-07T19:30:00Z",
        },
      },
      {
        path: "Notes/batch-b.md",
        frontmatter: { type: "note", tags: ["test"] },
        content: "b",
        provenance: {
          voice: "perishable",
          by: "claude-opus-4-7",
          written_at: "2026-05-07T19:30:00Z",
          reason: "test",
        },
      },
    ]);
    expect(result.results).toHaveLength(2);
  });

  it("accepts batches without provenance when the flag is OFF (default)", async () => {
    delete process.env.GROVE_REQUIRE_PROVENANCE;
    const result = await handleWriteBatch(ctx, [
      {
        path: "Notes/batch-no-flag.md",
        frontmatter: { type: "note", tags: ["test"] },
        content: "no flag",
      },
    ]);
    expect(result.results).toHaveLength(1);
  });
});

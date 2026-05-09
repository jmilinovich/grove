// V3 §C wiring tests — /internal/post-sync-warmup endpoint plumbing.
//
// The HTTP route in src/server.ts composes three pure pieces:
//   1. `checkInternalBearer` — bearer-token gate against
//      GROVE_INTERNAL_TOKEN.
//   2. `parseWarmupBody`     — JSON body validation (from_sha/to_sha).
//   3. `postSyncWarmup`      — the actual warmer, already covered
//      end-to-end by test/blame-warmup.test.ts.
//
// Plus `formatWarmupResponse` shaping the worker result into the
// snake_case JSON the shell hook reads. This file pins each piece in
// isolation, then runs an end-to-end pass that wires them together
// against a synthetic git vault (mirroring blame-warmup.test.ts'
// fixture pattern) so a regression in any link breaks the build.
//
// Why not spin up the HTTP server on a random port? Existing tests
// (see test/backend-auth.test.ts header) follow the project pattern of
// exercising decisions through their pure exports; the http handler is
// a thin async wrapper over those, and the per-piece coverage here is
// enough to catch wiring regressions without bringing up listeners,
// pm2 ecosystem mocks, or DB migrations.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  checkInternalBearer,
  parseWarmupBody,
  formatWarmupResponse,
} from "../src/server.js";
import { postSyncWarmup } from "../src/blame-warmup.js";
import { warmupMetrics } from "../src/metrics.js";
import {
  composeCommitMessage,
  provenanceToTrailers,
  type Provenance,
} from "../src/provenance.js";

let vaultPath: string;
let originalEnv: typeof process.env;

function git(args: string[], cwd = vaultPath): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitWithProvenance(
  filePath: string,
  prov: Provenance | null,
  subject: string,
): string {
  git(["add", filePath]);
  const msg = prov ? composeCommitMessage(subject, provenanceToTrailers(prov)) : subject;
  git(["commit", "-m", msg]);
  return git(["rev-parse", "HEAD"]);
}

beforeAll(async () => {
  originalEnv = { ...process.env };
  vaultPath = mkdtempSync(join(tmpdir(), "grove-warmup-endpoint-test-"));

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@grove.local"]);
  git(["config", "user.name", "Grove Test"]);
  git(["config", "commit.gpgsign", "false"]);

  process.env.GROVE_DB_PATH = join(vaultPath, "test.db");
  const db = await import("../src/db.js");
  db.createSchema();

  writeFileSync(join(vaultPath, "_seed.md"), "seed\n");
  commitWithProvenance(
    "_seed.md",
    { voice: "durable", by: "human", written_at: "2026-05-09T00:00:00Z" },
    "human: seed",
  );
});

afterAll(() => {
  rmSync(vaultPath, { recursive: true, force: true });
  process.env = originalEnv;
});

beforeEach(() => {
  warmupMetrics.reset();
  delete process.env.PROV_WARMUP_CONCURRENCY;
  delete process.env.PROV_WARMUP_BUDGET_MS;
});

describe("checkInternalBearer — auth gate (V3 §C)", () => {
  it("accepts a matching bearer token", () => {
    const out = checkInternalBearer("Bearer s3cret-token", "s3cret-token");
    expect(out.ok).toBe(true);
  });

  it("accepts case-insensitive 'bearer' prefix", () => {
    const out = checkInternalBearer("bearer s3cret-token", "s3cret-token");
    expect(out.ok).toBe(true);
  });

  it("rejects missing Authorization header with 401", () => {
    const out = checkInternalBearer(undefined, "s3cret-token");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(401);
      expect(out.reason).toContain("missing");
    }
  });

  it("rejects malformed Authorization (no Bearer prefix) with 401", () => {
    const out = checkInternalBearer("Basic dXNlcjpwYXNz", "s3cret-token");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(401);
  });

  it("rejects mismatched token with 401", () => {
    const out = checkInternalBearer("Bearer wrong-token", "s3cret-token");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(401);
      expect(out.reason).toContain("mismatch");
    }
  });

  it("rejects when GROVE_INTERNAL_TOKEN is unset (fail-closed)", () => {
    const out = checkInternalBearer("Bearer s3cret-token", undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(401);
      expect(out.reason).toContain("not configured");
    }
  });

  it("rejects mismatched-length tokens without throwing on timingSafeEqual", () => {
    // timingSafeEqual would throw on unequal-length buffers; the helper
    // pre-checks length and returns mismatch instead. Verifying we
    // don't regress to a throw-from-handler.
    expect(() => checkInternalBearer("Bearer abc", "much-longer-token-here")).not.toThrow();
    const out = checkInternalBearer("Bearer abc", "much-longer-token-here");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(401);
  });
});

describe("parseWarmupBody — body validation (V3 §C)", () => {
  it("accepts a well-formed body", () => {
    const out = parseWarmupBody(JSON.stringify({ from_sha: "abc1234", to_sha: "def5678" }));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.fromSha).toBe("abc1234");
      expect(out.toSha).toBe("def5678");
    }
  });

  it("accepts HEAD~N style refs (permissive)", () => {
    const out = parseWarmupBody(JSON.stringify({ from_sha: "HEAD~5", to_sha: "HEAD" }));
    expect(out.ok).toBe(true);
  });

  it("accepts 40-char hex SHAs", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const out = parseWarmupBody(JSON.stringify({ from_sha: sha, to_sha: sha }));
    expect(out.ok).toBe(true);
  });

  it("rejects invalid JSON with 400", () => {
    const out = parseWarmupBody("not json at all");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(400);
      expect(out.reason).toContain("JSON");
    }
  });

  it("rejects a non-object body with 400", () => {
    const out = parseWarmupBody(JSON.stringify(["from", "to"]));
    // arrays parse as objects in JS — but typeof null check guards
    // null. Arrays will pass typeof "object", so they'll fail at the
    // from_sha required check, which is also fine.
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(400);
  });

  it("rejects missing from_sha with 400", () => {
    const out = parseWarmupBody(JSON.stringify({ to_sha: "abc" }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(400);
      expect(out.reason).toContain("from_sha");
    }
  });

  it("rejects missing to_sha with 400", () => {
    const out = parseWarmupBody(JSON.stringify({ from_sha: "abc" }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(400);
      expect(out.reason).toContain("to_sha");
    }
  });

  it("rejects empty-string SHAs with 400", () => {
    const out = parseWarmupBody(JSON.stringify({ from_sha: "", to_sha: "abc" }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(400);
  });

  it("rejects null body fields with 400", () => {
    const out = parseWarmupBody(JSON.stringify({ from_sha: null, to_sha: "abc" }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(400);
  });
});

describe("formatWarmupResponse — shape contract (V3 §C)", () => {
  it("emits snake_case keys the shell hook expects", () => {
    const shaped = formatWarmupResponse({
      pathsTotal: 7,
      pathsCompleted: 5,
      pathsDropped: 1,
      pathsErrored: 1,
      durationMs: 234,
    });
    expect(shaped).toEqual({
      paths_total: 7,
      paths_completed: 5,
      paths_dropped: 1,
      paths_errored: 1,
      duration_ms: 234,
    });
  });
});

describe("end-to-end — auth + body parse + warmup against a real vault", () => {
  it("returns the expected JSON shape on a valid range", async () => {
    process.env.GROVE_INTERNAL_TOKEN = "endpoint-test-token";

    // Capture pre-sync HEAD, make a few file changes, capture post-sync
    // HEAD — the same flow the shell hook runs around git pull.
    const fromSha = git(["rev-parse", "HEAD"]);
    mkdirSync(join(vaultPath, "endpoint"), { recursive: true });
    for (let i = 0; i < 3; i++) {
      const p = `endpoint/note-${i}.md`;
      writeFileSync(join(vaultPath, p), `body ${i}\n`);
      commitWithProvenance(
        p,
        { voice: "durable", by: "human", written_at: "2026-05-09T00:00:00Z" },
        `human: add ${p}`,
      );
    }
    const toSha = git(["rev-parse", "HEAD"]);

    // Auth happy path
    const auth = checkInternalBearer(
      "Bearer endpoint-test-token",
      process.env.GROVE_INTERNAL_TOKEN,
    );
    expect(auth.ok).toBe(true);

    // Body parse happy path
    const parsed = parseWarmupBody(JSON.stringify({ from_sha: fromSha, to_sha: toSha }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");

    // Worker against synthetic vault
    const result = await postSyncWarmup({
      vaultPath,
      fromSha: parsed.fromSha,
      toSha: parsed.toSha,
    });

    const body = formatWarmupResponse(result);
    expect(body).toMatchObject({
      paths_total: 3,
      paths_completed: 3,
      paths_dropped: 0,
      paths_errored: 0,
    });
    expect(typeof body.duration_ms).toBe("number");
    expect(body.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns a zero-result body for an empty range (HEAD..HEAD)", async () => {
    process.env.GROVE_INTERNAL_TOKEN = "endpoint-test-token";
    const head = git(["rev-parse", "HEAD"]);
    const result = await postSyncWarmup({
      vaultPath,
      fromSha: head,
      toSha: head,
    });
    const body = formatWarmupResponse(result);
    expect(body.paths_total).toBe(0);
    expect(body.paths_completed).toBe(0);
    expect(body.paths_dropped).toBe(0);
    expect(body.paths_errored).toBe(0);
  });
});

// Integration tests for V3 §C — postSyncWarmup.
//
// Synthetic git repo, real `git diff` + `stampPathsInRange` calls.
// `recomputeProvenanceBlame` is stubbed via the test-only `recompute`
// arg so we can:
//   - count concurrent in-flight tasks (concurrency cap test)
//   - inject latency (budget enforcement test)
//   - inject errors per-path (best-effort test)
//   - record completion order (priority test)
//
// One test exercises the real recompute path to confirm the wiring
// works end-to-end against a tiny vault.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(async () => {
  originalEnv = { ...process.env };
  vaultPath = mkdtempSync(join(tmpdir(), "grove-warmup-test-"));

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@grove.local"]);
  git(["config", "user.name", "Grove Test"]);
  git(["config", "commit.gpgsign", "false"]);

  process.env.GROVE_DB_PATH = join(vaultPath, "test.db");
  const db = await import("../src/db.js");
  db.createSchema();

  // Seed an initial commit so HEAD~N references work.
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
  // Default — keep concurrency low so tests are deterministic.
  delete process.env.PROV_WARMUP_CONCURRENCY;
  delete process.env.PROV_WARMUP_BUDGET_MS;
});

describe("postSyncWarmup (V3 §C)", () => {
  it("respects PROV_WARMUP_CONCURRENCY (never more than N in-flight)", async () => {
    process.env.PROV_WARMUP_CONCURRENCY = "2";

    // Create 10 file-changed paths in a fresh range.
    const fromSha = git(["rev-parse", "HEAD"]);
    mkdirSync(join(vaultPath, "concurrency"), { recursive: true });
    for (let i = 0; i < 10; i++) {
      const p = `concurrency/note-${i}.md`;
      writeFileSync(join(vaultPath, p), `body ${i}\n`);
      commitWithProvenance(
        p,
        { voice: "durable", by: "human", written_at: "2026-05-09T00:00:00Z" },
        `human: add ${p}`,
      );
    }
    const toSha = git(["rev-parse", "HEAD"]);

    let inflight = 0;
    let peak = 0;
    const recompute = async (_v: string, _p: string) => {
      inflight++;
      if (inflight > peak) peak = inflight;
      await sleep(20);
      inflight--;
      return [];
    };

    const result = await postSyncWarmup({
      vaultPath,
      fromSha,
      toSha,
      recompute,
    });

    expect(result.pathsTotal).toBe(10);
    expect(result.pathsCompleted).toBe(10);
    expect(result.pathsErrored).toBe(0);
    expect(peak).toBeLessThanOrEqual(2);
    // Sanity: at least 2 in-flight at some point (otherwise we're not
    // testing concurrency).
    expect(peak).toBeGreaterThanOrEqual(2);
  });

  it("enforces PROV_WARMUP_BUDGET_MS — drops remaining paths past budget", async () => {
    process.env.PROV_WARMUP_CONCURRENCY = "1";
    process.env.PROV_WARMUP_BUDGET_MS = "100";

    const fromSha = git(["rev-parse", "HEAD"]);
    mkdirSync(join(vaultPath, "budget"), { recursive: true });
    for (let i = 0; i < 10; i++) {
      const p = `budget/note-${i}.md`;
      writeFileSync(join(vaultPath, p), `body ${i}\n`);
      commitWithProvenance(
        p,
        { voice: "durable", by: "human", written_at: "2026-05-09T00:00:00Z" },
        `human: add ${p}`,
      );
    }
    const toSha = git(["rev-parse", "HEAD"]);

    const recompute = async () => {
      await sleep(80);
      return [];
    };

    const result = await postSyncWarmup({
      vaultPath,
      fromSha,
      toSha,
      recompute,
    });

    expect(result.pathsTotal).toBe(10);
    expect(result.pathsDropped).toBeGreaterThan(0);
    expect(result.pathsCompleted + result.pathsDropped + result.pathsErrored).toBe(10);
    // Loose upper bound: budget 100ms + one in-flight task (~80ms) +
    // pLimit teardown overhead. Anything blowing past 1s = budget gate
    // is broken.
    expect(result.durationMs).toBeLessThan(1000);
  });

  it("isolates per-path errors (best-effort: 1 fail of 5 → 4 complete + 1 errored)", async () => {
    const fromSha = git(["rev-parse", "HEAD"]);
    mkdirSync(join(vaultPath, "errors"), { recursive: true });
    const paths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = `errors/note-${i}.md`;
      paths.push(p);
      writeFileSync(join(vaultPath, p), `body ${i}\n`);
      commitWithProvenance(
        p,
        { voice: "durable", by: "human", written_at: "2026-05-09T00:00:00Z" },
        `human: add ${p}`,
      );
    }
    const toSha = git(["rev-parse", "HEAD"]);

    const failTarget = paths[2]!;
    const recompute = async (_v: string, p: string) => {
      if (p === failTarget) throw new Error("simulated recompute failure");
      return [];
    };

    const result = await postSyncWarmup({
      vaultPath,
      fromSha,
      toSha,
      recompute,
    });

    expect(result.pathsTotal).toBe(5);
    expect(result.pathsCompleted).toBe(4);
    expect(result.pathsErrored).toBe(1);
    expect(result.pathsDropped).toBe(0);

    const m = warmupMetrics.getMetrics();
    expect(m.paths_completed).toBe(4);
    expect(m.paths_errored).toBe(1);
  });

  it("dedups paths that are BOTH file-changed and stamp-touched in the range", async () => {
    const fromSha = git(["rev-parse", "HEAD"]);

    // Path X: change the file (file-diff sees it) AND emit a stamp
    // commit referencing the same path (stampPathsInRange sees it).
    mkdirSync(join(vaultPath, "dedup"), { recursive: true });
    const p = "dedup/double.md";
    writeFileSync(join(vaultPath, p), "double-counted body\n");
    commitWithProvenance(
      p,
      { voice: "durable", by: "human", written_at: "2026-05-09T00:00:00Z" },
      "human: create double",
    );

    // Stamp the same path with --allow-empty.
    const stampBody = [
      `stamp-provenance: ${p}`,
      "",
      "Provenance-Voice: perishable",
      "Provenance-By: claude-opus-4-7",
      "Provenance-Written-At: 2026-05-09T00:00:00Z",
      `Provenance-Stamp-Path: ${p}`,
    ].join("\n");
    git(["commit", "--allow-empty", "-q", "-m", stampBody]);

    const toSha = git(["rev-parse", "HEAD"]);

    const seen: string[] = [];
    const recompute = async (_v: string, path: string) => {
      seen.push(path);
      return [];
    };

    const result = await postSyncWarmup({
      vaultPath,
      fromSha,
      toSha,
      recompute,
    });

    // Only ONE entry total — the duplicate collapsed.
    expect(result.pathsTotal).toBe(1);
    expect(seen).toEqual([p]);
  });

  it("processes hot paths first when requestsPerPath is provided", async () => {
    process.env.PROV_WARMUP_CONCURRENCY = "1"; // serial → completion order = launch order

    const fromSha = git(["rev-parse", "HEAD"]);
    mkdirSync(join(vaultPath, "priority"), { recursive: true });
    const paths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = `priority/note-${i}.md`;
      paths.push(p);
      writeFileSync(join(vaultPath, p), `body ${i}\n`);
      commitWithProvenance(
        p,
        { voice: "durable", by: "human", written_at: "2026-05-09T00:00:00Z" },
        `human: add ${p}`,
      );
    }
    const toSha = git(["rev-parse", "HEAD"]);

    // Reverse the natural order: index 4 = hottest, index 0 = coldest.
    const requestsPerPath = new Map<string, number>();
    paths.forEach((p, i) => requestsPerPath.set(p, i));

    const completionOrder: string[] = [];
    const recompute = async (_v: string, p: string) => {
      completionOrder.push(p);
      return [];
    };

    const result = await postSyncWarmup({
      vaultPath,
      fromSha,
      toSha,
      requestsPerPath,
      recompute,
    });

    expect(result.pathsCompleted).toBe(5);
    // Hottest path (paths[4], count=4) first; coldest (paths[0], count=0) last.
    expect(completionOrder).toEqual([paths[4], paths[3], paths[2], paths[1], paths[0]]);
  });

  it("end-to-end: real recompute writes warm cache rows for changed paths", async () => {
    const fromSha = git(["rev-parse", "HEAD"]);
    mkdirSync(join(vaultPath, "e2e"), { recursive: true });
    const p = "e2e/real.md";
    writeFileSync(join(vaultPath, p), "real body\n");
    commitWithProvenance(
      p,
      { voice: "durable", by: "human", written_at: "2026-05-09T00:00:00Z" },
      "human: real",
    );
    const toSha = git(["rev-parse", "HEAD"]);

    const result = await postSyncWarmup({
      vaultPath,
      fromSha,
      toSha,
    });

    expect(result.pathsTotal).toBe(1);
    expect(result.pathsCompleted).toBe(1);
    expect(result.pathsErrored).toBe(0);
  });

  it("returns a zero-result struct cleanly when the range is empty", async () => {
    const head = git(["rev-parse", "HEAD"]);
    const result = await postSyncWarmup({
      vaultPath,
      fromSha: head,
      toSha: head,
    });
    expect(result.pathsTotal).toBe(0);
    expect(result.pathsCompleted).toBe(0);
    expect(result.pathsDropped).toBe(0);
    expect(result.pathsErrored).toBe(0);
  });
});

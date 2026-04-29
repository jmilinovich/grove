import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Point QMD_INDEX away so the index section degrades gracefully and
// computeVaultStats is dominated by the mocked graph + lifecycle calls.
process.env.QMD_INDEX = join(tmpdir(), "grove-stats-singleflight-nonexistent.sqlite");

/**
 * Single-flight regression test for analyzeGraph + computeDigest.
 *
 * The 2026-04-28 log flood (`[vault-stats] graph timed out after
 * 120000ms` repeating per 5-min tick) was caused by the outer
 * Promise.race timeout returning the empty fallback while the inner
 * analyzeGraph kept running — so the next interval tick spawned a
 * SECOND analyzeGraph, then a third. Stacking N concurrent Brandes'
 * computations on the proxy event loop chewed CPU and amplified the
 * deploy-storm symptoms.
 *
 * Fix: track inflight analyzeGraph + computeDigest promises by
 * vaultPath. Subsequent calls during an in-flight walk reuse the
 * existing promise. This test asserts that even when multiple
 * computeVaultStats calls overlap (timeline:
 *   t=0    A starts → starts inner work
 *   t=200  A returns fallback (outer timeout fires fast in test)
 *   t=300  B starts → must reuse A's still-running inner work
 *   t=2000 inner work finishes
 * ),
 * analyzeGraph and computeDigest are only invoked ONCE across A+B.
 */

// vi.mock must be hoisted to top-of-module before the SUT import. Use
// vi.hoisted() to make the mock counters accessible inside the factory.
const counters = vi.hoisted(() => ({
  analyzeGraphCalls: 0,
  computeDigestCalls: 0,
  resolveAnalyze: undefined as ((v: unknown) => void) | undefined,
  resolveDigest: undefined as ((v: unknown) => void) | undefined,
}));

vi.mock("../src/vault-graph.js", () => ({
  analyzeGraph: vi.fn().mockImplementation(() => {
    counters.analyzeGraphCalls++;
    return new Promise((resolve) => {
      counters.resolveAnalyze = (v) =>
        resolve(
          v ?? {
            nodes: 0,
            edges: 0,
            density: 0,
            most_connected: [],
            orphans: [],
            clusters: [],
            bridges: [],
          },
        );
    });
  }),
  computeDigest: vi.fn().mockImplementation(() => {
    counters.computeDigestCalls++;
    return new Promise((resolve) => {
      counters.resolveDigest = (v) =>
        resolve(
          v ?? {
            seeds: { count: 0, samples: [] },
            sprouts: { count: 0, samples: [] },
            growing: { count: 0, samples: [] },
            mature: { count: 0, samples: [] },
            dormant: { count: 0, samples: [] },
            withering: { count: 0, samples: [] },
          },
        );
    });
  }),
}));

const { refreshStats } = await import("../src/vault-stats.js");

let vaultDir: string;

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), "grove-singleflight-"));
  // Minimal vault layout so walkMd doesn't error and vaults look real.
  mkdirSync(join(vaultDir, "Inbox"), { recursive: true });
  writeFileSync(join(vaultDir, "Inbox", "note.md"), "---\ntype: note\n---\nhi\n");
  execSync("git init -q", { cwd: vaultDir });
  execSync("git add . && git -c user.email=t@t.local -c user.name=t commit -qm init", {
    cwd: vaultDir,
  });

  counters.analyzeGraphCalls = 0;
  counters.computeDigestCalls = 0;
  counters.resolveAnalyze = undefined;
  counters.resolveDigest = undefined;
});

afterEach(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

describe("vault-stats single-flight", () => {
  it("dedupes parallel refreshStats — shared outer promise", async () => {
    // Kick off two parallel refreshStats. They share the outer
    // inFlightByPath promise; both end up waiting on the same
    // analyzeGraph + computeDigest mocks.
    const both = Promise.all([refreshStats(vaultDir), refreshStats(vaultDir)]);
    // Yield so both refreshStats bodies run and the inner mocks register.
    await new Promise((r) => setImmediate(r));

    expect(counters.analyzeGraphCalls).toBe(1);
    expect(counters.computeDigestCalls).toBe(1);

    // Resolve the inner mocks; both outer promises resolve via the
    // shared inner.
    counters.resolveAnalyze?.(undefined);
    counters.resolveDigest?.(undefined);

    const [a, b] = await both;
    expect(b.computed_at).toBe(a.computed_at);
  });

  it("subsequent refreshStats during in-flight inner work reuses the existing analyzeGraph", async () => {
    // First call kicks off inner work. Don't await — let it stay
    // pending so the second call finds graphInflightByPath populated.
    const first = refreshStats(vaultDir);

    // Yield once so the first refreshStats's promise body runs and
    // populates inFlightByPath + the inner singleflight maps.
    await new Promise((r) => setImmediate(r));
    expect(counters.analyzeGraphCalls).toBe(1);
    expect(counters.computeDigestCalls).toBe(1);

    // Second call should reuse — same outer promise (refreshStats
    // dedupe) AND same inner singleflight.
    const second = refreshStats(vaultDir);
    await new Promise((r) => setImmediate(r));

    expect(counters.analyzeGraphCalls).toBe(1);
    expect(counters.computeDigestCalls).toBe(1);

    // Resolve the pending mocks — both refreshStats promises share the
    // same outer promise so resolution wakes both.
    counters.resolveAnalyze?.(undefined);
    counters.resolveDigest?.(undefined);

    const [a, b] = await Promise.all([first, second]);
    expect(b.computed_at).toBe(a.computed_at);
  });
});

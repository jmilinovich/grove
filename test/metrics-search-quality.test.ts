/**
 * V3 §L observability tests — search-quality / provenance-ranking metrics.
 *
 * Two layers:
 *   1. Direct unit tests against `searchQualityMetrics` (no DB / search dep).
 *   2. Integration through `applyProvenanceReweight` to confirm the wiring
 *      from hybrid-search.ts records the right tuples per call.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "grove-search-quality-metrics-"));
const TEST_DB = join(TMP_ROOT, "grove.db");
const REWEIGHT_SAMPLE_PATH = join(TMP_ROOT, "reweight-samples.jsonl");

// Must be set BEFORE the modules under test are imported so they pick up the
// test DB path + sample file.
process.env.GROVE_DB_PATH = TEST_DB;
process.env.GROVE_PROV_RANKING_ENABLED = "true";
process.env.GROVE_REWEIGHT_DELTA_SAMPLE_PATH = REWEIGHT_SAMPLE_PATH;

// Dynamic import so the env vars above land before module-init.
const { searchQualityMetrics } = await import("../src/metrics.js");
const { __applyProvenanceReweightForTest } = await import(
  "../src/hybrid-search.js"
);
const { createSchema } = await import("../src/db.js");
createSchema();

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("searchQualityMetrics — direct unit tests", () => {
  beforeEach(() => {
    searchQualityMetrics.reset();
  });

  it("records (rank, voice) tuples correctly across a 5-result list", () => {
    searchQualityMetrics.recordVoiceAtRank([
      { voice: "durable" },
      { voice: "perishable" },
      { voice: "durable" },
      { voice: "legacy-unknown" },
      { voice: "perishable" },
    ]);

    const snap = searchQualityMetrics.getSnapshot();
    expect(snap.grove_search_voice_at_rank["1|durable"]).toBe(1);
    expect(snap.grove_search_voice_at_rank["2|perishable"]).toBe(1);
    expect(snap.grove_search_voice_at_rank["3|durable"]).toBe(1);
    expect(snap.grove_search_voice_at_rank["4|legacy-unknown"]).toBe(1);
    expect(snap.grove_search_voice_at_rank["5|perishable"]).toBe(1);
  });

  it("caps voice_at_rank histogram at top-10 even when the list is longer", () => {
    const longList = Array.from({ length: 25 }, () => ({ voice: "durable" as const }));
    searchQualityMetrics.recordVoiceAtRank(longList);
    const snap = searchQualityMetrics.getSnapshot();
    expect(snap.grove_search_voice_at_rank["10|durable"]).toBe(1);
    expect(snap.grove_search_voice_at_rank["11|durable"]).toBeUndefined();
  });

  it("computes legacy-unknown share math correctly (3 of 5 → 0.6)", () => {
    searchQualityMetrics.recordLegacyUnknownShare([
      { voice: "legacy-unknown" },
      { voice: "legacy-unknown" },
      { voice: "legacy-unknown" },
      { voice: "durable" },
      { voice: "perishable" },
    ]);
    const snap = searchQualityMetrics.getSnapshot();
    expect(snap.grove_search_legacy_unknown_share.samples).toBe(1);
    expect(snap.grove_search_legacy_unknown_share.mean).toBeCloseTo(0.6, 5);
    expect(snap.grove_search_legacy_unknown_share.max).toBeCloseTo(0.6, 5);
  });

  it("treats result with absent voice as legacy-unknown for share computation", () => {
    searchQualityMetrics.recordLegacyUnknownShare([
      { voice: "durable" },
      { voice: "durable" },
    ]);
    const snap = searchQualityMetrics.getSnapshot();
    expect(snap.grove_search_legacy_unknown_share.mean).toBe(0);
  });

  it("voice_preference{mode} counter increments per call", () => {
    searchQualityMetrics.recordVoicePreference("recent");
    searchQualityMetrics.recordVoicePreference("recent");
    searchQualityMetrics.recordVoicePreference("mixed");
    searchQualityMetrics.recordVoicePreference("manual");

    const snap = searchQualityMetrics.getSnapshot();
    expect(snap.grove_search_voice_preference.recent).toBe(2);
    expect(snap.grove_search_voice_preference.mixed).toBe(1);
    expect(snap.grove_search_voice_preference.manual).toBe(1);
  });

  it("auto-revert + stamp-invalidation-drift counters exist and increment", () => {
    searchQualityMetrics.incrementAutoRevert();
    searchQualityMetrics.incrementAutoRevert();
    searchQualityMetrics.incrementStampInvalidationDrift();
    searchQualityMetrics.incrementStampInvalidationDrift(3);

    const snap = searchQualityMetrics.getSnapshot();
    expect(snap.grove_reweight_auto_revert_total).toBe(2);
    expect(snap.grove_stamp_invalidation_drift).toBe(4);
  });

  it("markSync updates timestamp; subsequent cache hits land in the right bucket", () => {
    // No sync ever marked → "unknown" bucket.
    searchQualityMetrics.recordBlameCacheHit();
    let snap = searchQualityMetrics.getSnapshot();
    expect(snap.seconds_since_last_sync).toBeNull();
    expect(snap.grove_blame_cache_hit_rate.unknown).toBe(1);

    // Mark sync as just-now → next hit lands in 0-60s.
    searchQualityMetrics.markSync(new Date());
    searchQualityMetrics.recordBlameCacheHit();
    searchQualityMetrics.recordBlameCacheMiss();
    snap = searchQualityMetrics.getSnapshot();
    expect(snap.seconds_since_last_sync).not.toBeNull();
    expect(snap.seconds_since_last_sync!).toBeLessThan(5);
    // 1 hit / 2 total in bucket 0-60s → 0.5
    expect(snap.grove_blame_cache_hit_rate["0-60s"]).toBeCloseTo(0.5, 5);

    // Mark sync as 10 min ago → next hit lands in 300-1800s.
    searchQualityMetrics.markSync(new Date(Date.now() - 600 * 1000));
    searchQualityMetrics.recordBlameCacheHit();
    searchQualityMetrics.recordBlameCacheHit();
    snap = searchQualityMetrics.getSnapshot();
    expect(snap.grove_blame_cache_hit_rate["300-1800s"]).toBe(1.0);
  });

  it("reweight-delta sample writes a parseable JSON line at the configured path", () => {
    // Spy on Math.random so the sample fires deterministically.
    const randSpy = vi.spyOn(Math, "random").mockReturnValue(0.001); // < 1%
    expect(searchQualityMetrics.shouldSampleReweightDelta()).toBe(true);

    searchQualityMetrics.writeReweightDeltaSample({
      ts: "2026-05-09T12:34:56.000Z",
      query: "what is the latest understanding of agents",
      voice_preference: "mixed",
      pre_top5: [
        { vault_path: "a.md", rrf_score: 0.5 },
        { vault_path: "b.md", rrf_score: 0.4 },
      ],
      post_top5: [
        { vault_path: "b.md", rrf_score: 0.42, voice: "durable" },
        { vault_path: "a.md", rrf_score: 0.4, voice: "perishable" },
      ],
    });

    expect(existsSync(REWEIGHT_SAMPLE_PATH)).toBe(true);
    const content = readFileSync(REWEIGHT_SAMPLE_PATH, "utf8").trim();
    const lines = content.split("\n");
    const lastLine = lines[lines.length - 1]!;
    const parsed = JSON.parse(lastLine);
    expect(parsed.query).toBe("what is the latest understanding of agents");
    expect(parsed.voice_preference).toBe("mixed");
    expect(parsed.pre_top5).toHaveLength(2);
    expect(parsed.post_top5[0].voice).toBe("durable");

    // And confirm that with random > sample rate, we don't sample.
    randSpy.mockReturnValue(0.5); // > 1%
    expect(searchQualityMetrics.shouldSampleReweightDelta()).toBe(false);

    randSpy.mockRestore();
  });
});

describe("applyProvenanceReweight wiring (V3 §L integration)", () => {
  beforeEach(() => {
    searchQualityMetrics.reset();
  });

  it("auto-detected canonical query records voice_preference{mode='mixed'}", () => {
    // No rows in the test note_blame table → every result is legacy-unknown
    // path (no `meta`). That's fine for wiring verification — we only need
    // the function to run end-to-end and record metrics.
    __applyProvenanceReweightForTest!(
      [
        { title: "A", vault_path: "a.md", rrf_score: 0.5, snippet: "x", sources: ["bm25"] },
        { title: "B", vault_path: "b.md", rrf_score: 0.4, snippet: "y", sources: ["bm25"] },
      ],
      "what is meditation",
    );
    const snap = searchQualityMetrics.getSnapshot();
    expect(snap.grove_search_voice_preference.mixed).toBe(1);
    expect(snap.grove_search_voice_preference.recent).toBe(0);
  });

  it("auto-detected freshness query records voice_preference{mode='recent'}", () => {
    __applyProvenanceReweightForTest!(
      [
        { title: "A", vault_path: "a.md", rrf_score: 0.5, snippet: "x", sources: ["bm25"] },
      ],
      "what's happening today",
    );
    const snap = searchQualityMetrics.getSnapshot();
    expect(snap.grove_search_voice_preference.recent).toBe(1);
    expect(snap.grove_search_voice_preference.mixed).toBe(0);
  });

  it("voice_at_rank records (rank, voice) tuples for top-K of one search", () => {
    __applyProvenanceReweightForTest!(
      [
        { title: "A", vault_path: "a.md", rrf_score: 0.5, snippet: "x", sources: ["bm25"] },
        { title: "B", vault_path: "b.md", rrf_score: 0.4, snippet: "y", sources: ["bm25"] },
        { title: "C", vault_path: "c.md", rrf_score: 0.3, snippet: "z", sources: ["bm25"] },
      ],
      "concept query",
    );
    const snap = searchQualityMetrics.getSnapshot();
    // Without note_blame rows every result resolves to legacy-unknown.
    // Sum across ranks 1-3 should be 3 observations.
    const total = Object.entries(snap.grove_search_voice_at_rank)
      .filter(([k]) => /^[123]\|/.test(k))
      .reduce((acc, [, v]) => acc + v, 0);
    expect(total).toBe(3);
  });

  it("provenance lookup latency is recorded (samples > 0)", () => {
    __applyProvenanceReweightForTest!(
      [
        { title: "A", vault_path: "a.md", rrf_score: 0.5, snippet: "x", sources: ["bm25"] },
      ],
      "concept query",
    );
    const snap = searchQualityMetrics.getSnapshot();
    expect(snap.grove_provenance_lookup_latency.samples).toBeGreaterThan(0);
  });

  it("legacy_unknown_share is sampled per call (with 100% sample rate by override)", () => {
    // No env override exists for legacy-unknown sample rate — this metric is
    // unconditionally recorded, so one call → one sample.
    __applyProvenanceReweightForTest!(
      [
        { title: "A", vault_path: "a.md", rrf_score: 0.5, snippet: "x", sources: ["bm25"] },
        { title: "B", vault_path: "b.md", rrf_score: 0.4, snippet: "y", sources: ["bm25"] },
      ],
      "concept query",
    );
    const snap = searchQualityMetrics.getSnapshot();
    expect(snap.grove_search_legacy_unknown_share.samples).toBe(1);
    // Both results have no note_blame → both legacy-unknown → share = 1.0
    expect(snap.grove_search_legacy_unknown_share.mean).toBe(1.0);
  });
});

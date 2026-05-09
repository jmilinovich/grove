/**
 * In-memory metrics collector for Grove.
 *
 * Tracks request counts, latency percentiles, and error rates.
 * Exposed via /metrics endpoint as JSON.
 */

interface MetricBucket {
  count: number;
  errors: number;
  latencies: number[]; // raw ms values, capped at 10000 entries
}

interface TrailBucket {
  requests: number;
  reads: number;
  writes: number;
  last_request_at: string | null;
}

const WINDOW_MS = 60_000 * 60; // 1 hour window
const MAX_LATENCIES = 10_000;

class MetricsCollector {
  private buckets = new Map<string, MetricBucket>();
  private trailBuckets = new Map<string, TrailBucket>();
  private startedAt = new Date().toISOString();
  private totalRequests = 0;
  private totalErrors = 0;

  record(tool: string, latencyMs: number, isError: boolean): void {
    this.totalRequests++;
    if (isError) this.totalErrors++;

    let bucket = this.buckets.get(tool);
    if (!bucket) {
      bucket = { count: 0, errors: 0, latencies: [] };
      this.buckets.set(tool, bucket);
    }
    bucket.count++;
    if (isError) bucket.errors++;
    if (bucket.latencies.length < MAX_LATENCIES) {
      bucket.latencies.push(latencyMs);
    }
  }

  recordRequest(method: string, path: string, status: number, latencyMs: number): void {
    const key = `${method} ${path}`;
    this.record(key, latencyMs, status >= 400);
  }

  /** Record a request attributed to a specific trail (or "none" for non-trail requests). */
  recordTrailRequest(trailId: string, isWrite: boolean): void {
    let bucket = this.trailBuckets.get(trailId);
    if (!bucket) {
      bucket = { requests: 0, reads: 0, writes: 0, last_request_at: null };
      this.trailBuckets.set(trailId, bucket);
    }
    bucket.requests++;
    if (isWrite) bucket.writes++;
    else bucket.reads++;
    bucket.last_request_at = new Date().toISOString();
  }

  getTrailMetrics(trailId: string): TrailBucket | null {
    return this.trailBuckets.get(trailId) ?? null;
  }

  getMetrics(): Record<string, unknown> {
    const byTool: Record<string, unknown> = {};
    for (const [tool, bucket] of this.buckets) {
      const sorted = [...bucket.latencies].sort((a, b) => a - b);
      byTool[tool] = {
        count: bucket.count,
        errors: bucket.errors,
        error_rate: bucket.count > 0 ? (bucket.errors / bucket.count) : 0,
        latency_p50: percentile(sorted, 0.5),
        latency_p95: percentile(sorted, 0.95),
        latency_p99: percentile(sorted, 0.99),
      };
    }
    const byTrail: Record<string, unknown> = {};
    for (const [trailId, bucket] of this.trailBuckets) {
      byTrail[trailId] = { ...bucket };
    }
    return {
      started_at: this.startedAt,
      uptime_seconds: Math.floor((Date.now() - new Date(this.startedAt).getTime()) / 1000),
      total_requests: this.totalRequests,
      total_errors: this.totalErrors,
      error_rate: this.totalRequests > 0 ? (this.totalErrors / this.totalRequests) : 0,
      by_tool: byTool,
      by_trail: byTrail,
    };
  }

  reset(): void {
    this.buckets.clear();
    this.trailBuckets.clear();
    this.totalRequests = 0;
    this.totalErrors = 0;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, idx)]!;
}

// Singleton
export const metrics = new MetricsCollector();

/* --- Search-specific analytics --- */

interface SearchEntry {
  query: string;
  result_count: number;
  latency_ms: number;
  timestamp: number;
}

interface SearchStats {
  queries_1h: number;
  avg_latency_ms: number;
  zero_result_rate: number;
  top_queries: string[];
}

const SEARCH_BUFFER_SIZE = 1000;

class SearchTracker {
  private buffer: SearchEntry[] = [];
  private cursor = 0;
  private full = false;

  recordSearch(query: string, resultCount: number, latencyMs: number): void {
    const entry: SearchEntry = {
      query,
      result_count: resultCount,
      latency_ms: latencyMs,
      timestamp: Date.now(),
    };
    this.buffer[this.cursor] = entry;
    this.cursor = (this.cursor + 1) % SEARCH_BUFFER_SIZE;
    if (!this.full && this.cursor === 0) this.full = true;
  }

  getSearchStats(): SearchStats {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const recent: SearchEntry[] = [];

    const len = this.full ? SEARCH_BUFFER_SIZE : this.cursor;
    for (let i = 0; i < len; i++) {
      const entry = this.buffer[i]!;
      if (entry.timestamp >= cutoff) {
        recent.push(entry);
      }
    }

    if (recent.length === 0) {
      return { queries_1h: 0, avg_latency_ms: 0, zero_result_rate: 0, top_queries: [] };
    }

    const totalLatency = recent.reduce((sum, e) => sum + e.latency_ms, 0);
    const zeroCount = recent.filter((e) => e.result_count === 0).length;

    // Top 5 most frequent queries (lowercased, deduplicated)
    const freq = new Map<string, number>();
    for (const e of recent) {
      const key = e.query.toLowerCase();
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
    const topQueries = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([q]) => q);

    return {
      queries_1h: recent.length,
      avg_latency_ms: Math.round(totalLatency / recent.length),
      zero_result_rate: zeroCount / recent.length,
      top_queries: topQueries,
    };
  }

  reset(): void {
    this.buffer = [];
    this.cursor = 0;
    this.full = false;
  }
}

export const searchMetrics = new SearchTracker();

/* --- Post-sync warm-up worker metrics (V3 §L) --- */
//
// Counters + a "seconds since last completion" gauge for the V3 §C
// post-sync warm-up worker. Exposed for /metrics + alert rules:
//
//   - grove_warmup_paths_completed   (counter, increments per success)
//   - grove_warmup_paths_dropped     (counter, increments per budget-skip)
//   - grove_warmup_paths_errored     (counter, increments per recompute throw —
//                                     covers V3 §B2's body-parse false-positive
//                                     case where a non-existent path is queued)
//   - grove_warmup_seconds_since_last_completion (gauge, liveness signal)
//
// Read-only access via getWarmupMetrics(); reset() exists for tests.

interface WarmupCounters {
  paths_completed: number;
  paths_dropped: number;
  paths_errored: number;
  /** Epoch ms of the last successful per-path recompute. null until first one. */
  last_completion_ms: number | null;
}

class WarmupTracker {
  private counters: WarmupCounters = {
    paths_completed: 0,
    paths_dropped: 0,
    paths_errored: 0,
    last_completion_ms: null,
  };

  recordCompleted(): void {
    this.counters.paths_completed++;
    this.counters.last_completion_ms = Date.now();
  }

  recordDropped(): void {
    this.counters.paths_dropped++;
  }

  recordErrored(): void {
    this.counters.paths_errored++;
  }

  /**
   * Snapshot suitable for /metrics serialization. The
   * `seconds_since_last_completion` field is computed at read-time so
   * it stays accurate without a separate ticker.
   */
  getMetrics(): {
    paths_completed: number;
    paths_dropped: number;
    paths_errored: number;
    seconds_since_last_completion: number | null;
  } {
    const last = this.counters.last_completion_ms;
    return {
      paths_completed: this.counters.paths_completed,
      paths_dropped: this.counters.paths_dropped,
      paths_errored: this.counters.paths_errored,
      seconds_since_last_completion:
        last === null ? null : Math.floor((Date.now() - last) / 1000),
    };
  }

  reset(): void {
    this.counters = {
      paths_completed: 0,
      paths_dropped: 0,
      paths_errored: 0,
      last_completion_ms: null,
    };
  }
}

export const warmupMetrics = new WarmupTracker();

/* --- V3 §L: Search-quality / provenance-ranking observability ---
 *
 * A separate, opt-in tracker for the V3 ranking layer. Lives alongside
 * `searchMetrics` instead of merging in to keep two concerns honest:
 *   - searchMetrics: "did we serve a search and how fast"
 *   - searchQualityMetrics: "after V3 reweight, did we silently regress to
 *     identity, did §G over-fire, did legacy-unknown share spike"
 *
 * Designed so the soak harness + a future Prometheus exporter can read the
 * snapshot without reaching into hybrid-search.ts. Counters are unbounded
 * across the process lifetime; gauges report the most-recent sample.
 *
 * Alert rules wired separately in /health (V3_PLAN.md §L); this module
 * just exposes the data.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

export type Voice = "durable" | "perishable" | "legacy-unknown";
export type VoicePreferenceMode = "recent" | "mixed" | "manual";

const VOICE_AT_RANK_MAX_RANK = 10;
const LEGACY_UNKNOWN_SHARE_BUFFER = 1000; // last-N reservoir for the gauge
const PROV_LOOKUP_LATENCY_MAX = 10_000;
const REWEIGHT_DELTA_SAMPLE_RATE = parseFloat(
  process.env.GROVE_REWEIGHT_DELTA_SAMPLE_RATE ?? "0.01",
);
const REWEIGHT_DELTA_SAMPLE_PATH =
  process.env.GROVE_REWEIGHT_DELTA_SAMPLE_PATH ?? "/tmp/grove/reweight-samples.jsonl";

// Sync-recency buckets (V3 §L cache-hit-rate-by-sync-recency).
//   bucket label → upper bound in seconds. Order matters: first match wins.
const SYNC_RECENCY_BUCKETS: { label: string; maxSeconds: number }[] = [
  { label: "0-60s", maxSeconds: 60 },
  { label: "60-300s", maxSeconds: 300 },
  { label: "300-1800s", maxSeconds: 1800 },
  { label: ">1800s", maxSeconds: Number.POSITIVE_INFINITY },
];

function bucketForSecondsSinceSync(seconds: number | null): string {
  if (seconds === null) return "unknown";
  for (const b of SYNC_RECENCY_BUCKETS) {
    if (seconds <= b.maxSeconds) return b.label;
  }
  return ">1800s";
}

export interface ReweightDeltaSample {
  ts: string;
  query: string;
  voice_preference: VoicePreferenceMode;
  pre_top5: { vault_path: string; rrf_score: number }[];
  post_top5: { vault_path: string; rrf_score: number; voice?: Voice }[];
}

class SearchQualityMetrics {
  // grove_search_voice_at_rank — histogram counts keyed by `${rank}|${voice}`
  private voiceAtRank = new Map<string, number>();

  // grove_search_legacy_unknown_share — last-N legacy/total ratios.
  // Sampled at the call site (1% of searches per spec).
  private legacyShareSamples: number[] = [];
  private legacyShareCursor = 0;

  // grove_provenance_lookup_latency — raw ms values, capped reservoir.
  private lookupLatencies: number[] = [];

  // grove_search_voice_preference{mode} — counters
  private voicePrefCounts: Record<VoicePreferenceMode, number> = {
    recent: 0,
    mixed: 0,
    manual: 0,
  };

  // grove_reweight_auto_revert_total — V3 §J auto-revert counter. Increment
  // wiring lives in the soak harness (deferred to next session, task #17 per
  // V3_PLAN.md "Items deferred"). The counter exists now so the harness can
  // write to it without an additional code change.
  private reweightAutoRevertTotal = 0;

  // grove_stamp_invalidation_drift — V3 §B falsifier #2 counter. Wiring to
  // the actual reconciliation logic ships with the warm-up worker (other
  // subagent's territory). Counter exists so production can record it.
  private stampInvalidationDrift = 0;

  // grove_blame_cache_hit_rate{seconds_since_last_sync_bucket} — derived
  // from running hit/miss counters per bucket.
  private blameCacheHits = new Map<string, number>();
  private blameCacheMisses = new Map<string, number>();

  // sync recency tracker
  private lastSyncAt: Date | null = null;

  /** Record (rank, voice) pairs for the top-K results of one search. */
  recordVoiceAtRank(results: { voice?: Voice }[]): void {
    const limit = Math.min(results.length, VOICE_AT_RANK_MAX_RANK);
    for (let i = 0; i < limit; i++) {
      const rank = i + 1;
      const voice = results[i]?.voice ?? "legacy-unknown";
      const key = `${rank}|${voice}`;
      this.voiceAtRank.set(key, (this.voiceAtRank.get(key) ?? 0) + 1);
    }
  }

  /**
   * Record one sampled legacy-unknown share value (legacy / total). Caller
   * decides sample rate (spec: 1% per query).
   */
  recordLegacyUnknownShare(results: { voice?: Voice }[]): void {
    if (results.length === 0) return;
    const legacy = results.filter((r) => r.voice === "legacy-unknown").length;
    const share = legacy / results.length;
    if (this.legacyShareSamples.length < LEGACY_UNKNOWN_SHARE_BUFFER) {
      this.legacyShareSamples.push(share);
    } else {
      this.legacyShareSamples[this.legacyShareCursor] = share;
      this.legacyShareCursor =
        (this.legacyShareCursor + 1) % LEGACY_UNKNOWN_SHARE_BUFFER;
    }
  }

  /** Record provenance-lookup latency (time inside getNoteVoicesAndAges). */
  recordProvenanceLookupLatency(ms: number): void {
    if (this.lookupLatencies.length < PROV_LOOKUP_LATENCY_MAX) {
      this.lookupLatencies.push(ms);
    }
  }

  /** Record one voice_preference detection. */
  recordVoicePreference(mode: VoicePreferenceMode): void {
    this.voicePrefCounts[mode]++;
  }

  /** Increment the auto-revert counter. Called by V3 §J soak harness (deferred). */
  incrementAutoRevert(): void {
    this.reweightAutoRevertTotal++;
  }

  /** Increment the stamp-invalidation drift counter. Called by warm-up worker. */
  incrementStampInvalidationDrift(by = 1): void {
    this.stampInvalidationDrift += by;
  }

  /**
   * Record a blame-cache hit, bucketed by seconds since the last sync.
   * Call from getNoteBlame in db.ts. (TODO comment landed there — wiring
   * the increment to the actual cache call is part of the warm-up worker
   * task being done in parallel.)
   */
  recordBlameCacheHit(): void {
    const bucket = bucketForSecondsSinceSync(this.secondsSinceLastSync());
    this.blameCacheHits.set(bucket, (this.blameCacheHits.get(bucket) ?? 0) + 1);
  }

  recordBlameCacheMiss(): void {
    const bucket = bucketForSecondsSinceSync(this.secondsSinceLastSync());
    this.blameCacheMisses.set(
      bucket,
      (this.blameCacheMisses.get(bucket) ?? 0) + 1,
    );
  }

  /**
   * Mark a sync as just-completed. Wiring this to the actual sync hook is a
   * separate task (probably the same place the warm-up worker registers its
   * post-sync callback — other subagent's territory). The function is
   * exported so that wiring can land later without a metrics.ts churn.
   */
  markSync(at: Date = new Date()): void {
    this.lastSyncAt = at;
  }

  /** Seconds since `markSync()` was last called, or null if never. */
  secondsSinceLastSync(): number | null {
    if (!this.lastSyncAt) return null;
    return (Date.now() - this.lastSyncAt.getTime()) / 1000;
  }

  /**
   * Sample a reweight-delta event. Caller decides whether to sample based on
   * shouldSampleReweightDelta(). Writes one JSON line to
   * /tmp/grove/reweight-samples.jsonl (or GROVE_REWEIGHT_DELTA_SAMPLE_PATH).
   * Best-effort — failures are swallowed; observability MUST NOT break search.
   */
  writeReweightDeltaSample(sample: ReweightDeltaSample): void {
    try {
      mkdirSync(dirname(REWEIGHT_DELTA_SAMPLE_PATH), { recursive: true });
      appendFileSync(REWEIGHT_DELTA_SAMPLE_PATH, JSON.stringify(sample) + "\n");
    } catch {
      // Swallow.
    }
  }

  /** True iff this call should sample the reweight-delta log (1% by default). */
  shouldSampleReweightDelta(): boolean {
    return Math.random() < REWEIGHT_DELTA_SAMPLE_RATE;
  }

  /** Snapshot for /metrics or test introspection. */
  getSnapshot(): {
    grove_search_voice_at_rank: Record<string, number>;
    grove_search_legacy_unknown_share: { mean: number; max: number; samples: number };
    grove_provenance_lookup_latency: { p50: number; p95: number; p99: number; samples: number };
    grove_search_voice_preference: Record<VoicePreferenceMode, number>;
    grove_reweight_auto_revert_total: number;
    grove_stamp_invalidation_drift: number;
    grove_blame_cache_hit_rate: Record<string, number>;
    seconds_since_last_sync: number | null;
  } {
    const voiceAtRank: Record<string, number> = {};
    for (const [k, v] of this.voiceAtRank) voiceAtRank[k] = v;

    const shareSamples = this.legacyShareSamples;
    const shareSummary =
      shareSamples.length === 0
        ? { mean: 0, max: 0, samples: 0 }
        : {
            mean:
              shareSamples.reduce((a, b) => a + b, 0) / shareSamples.length,
            max: Math.max(...shareSamples),
            samples: shareSamples.length,
          };

    const sortedLat = [...this.lookupLatencies].sort((a, b) => a - b);
    const latencySummary = {
      p50: percentile(sortedLat, 0.5),
      p95: percentile(sortedLat, 0.95),
      p99: percentile(sortedLat, 0.99),
      samples: sortedLat.length,
    };

    const blameRate: Record<string, number> = {};
    const buckets = new Set<string>([
      ...this.blameCacheHits.keys(),
      ...this.blameCacheMisses.keys(),
    ]);
    for (const b of buckets) {
      const hits = this.blameCacheHits.get(b) ?? 0;
      const misses = this.blameCacheMisses.get(b) ?? 0;
      const total = hits + misses;
      blameRate[b] = total === 0 ? 0 : hits / total;
    }

    return {
      grove_search_voice_at_rank: voiceAtRank,
      grove_search_legacy_unknown_share: shareSummary,
      grove_provenance_lookup_latency: latencySummary,
      grove_search_voice_preference: { ...this.voicePrefCounts },
      grove_reweight_auto_revert_total: this.reweightAutoRevertTotal,
      grove_stamp_invalidation_drift: this.stampInvalidationDrift,
      grove_blame_cache_hit_rate: blameRate,
      seconds_since_last_sync: this.secondsSinceLastSync(),
    };
  }

  reset(): void {
    this.voiceAtRank.clear();
    this.legacyShareSamples = [];
    this.legacyShareCursor = 0;
    this.lookupLatencies = [];
    this.voicePrefCounts = { recent: 0, mixed: 0, manual: 0 };
    this.reweightAutoRevertTotal = 0;
    this.stampInvalidationDrift = 0;
    this.blameCacheHits.clear();
    this.blameCacheMisses.clear();
    this.lastSyncAt = null;
  }
}

export const searchQualityMetrics = new SearchQualityMetrics();

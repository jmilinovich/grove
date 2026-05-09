// Metrics for the search-quality eval.
//
// Three measurable rates over the candidate-fixture layer:
//
//   PPR     — % of dual-match queries where durable outranks perishable
//   RPR-p   — % of dual-perishable queries where recent outranks stale
//   RI-d    — % of dual-durable queries where age does NOT swap relevance
//
// Plus shared utilities for reweight pipelines and threshold checks.

import { rrfFuse } from "../../src/hybrid-search.js";
import type { Voice } from "../../src/provenance.js";
import type {
  CandidateFixture,
  FixtureCandidate,
} from "./test-set.js";

// ── Types ────────────────────────────────────────────────────────────

/**
 * Note-level provenance lookup. In production: derived from blame segments
 * (modal voice, max written_at). Here: synthesized from fixture candidates.
 */
export interface ProvenanceMeta {
  voice: Voice;
  written_at: string;
}

/** A reweighted hit. The eval only cares about ordering by `score`. */
export interface RankedHit {
  vault_path: string;
  title: string;
  score: number;
  voice: Voice;
  written_at: string;
  /** Pre-reweight RRF score; preserved for inspection. */
  rrf_score: number;
}

/**
 * A reweight implementation. Takes the fused-by-RRF result list and a
 * lookup of per-key provenance, returns a new ordering by descending score.
 *
 * The baseline implementation is `identityReweight` — leave RRF order alone.
 * Provenance-aware implementations multiply by per-voice / per-age factors.
 */
export type ReweightFn = (
  fused: { vault_path: string; title: string; rrf_score: number }[],
  provenance: Map<string, ProvenanceMeta>,
  /** Reference time for age calculations. ISO-8601. Defaults to now. */
  referenceTime?: Date,
) => RankedHit[];

// ── Reweight implementations ─────────────────────────────────────────

/** Pass-through. Used to measure baseline (current production behavior). */
export const identityReweight: ReweightFn = (fused, provenance) =>
  fused.map((r) => {
    const p = provenance.get(r.vault_path);
    return {
      vault_path: r.vault_path,
      title: r.title,
      score: r.rrf_score,
      voice: p?.voice ?? "legacy-unknown",
      written_at: p?.written_at ?? "1970-01-01T00:00:00Z",
      rrf_score: r.rrf_score,
    };
  });

/**
 * A simple v1 reweight scheme — kept here so the eval can run end-to-end
 * before any production implementation lands. Tunable via env so `sweep.ts`
 * can search the space.
 *
 *   final_score = rrf_score
 *               * voice_multiplier(voice)
 *               * age_multiplier(voice, age_days)
 *
 * voice_multiplier:
 *   durable        → PROV_DURABLE_BOOST  (default 1.30)
 *   perishable     → PROV_PERISHABLE_PENALTY  (default 0.85)
 *   legacy-unknown → 1.00 (transparent — matches read-side directive)
 *
 * age_multiplier:
 *   durable        → 1.0  (age irrelevant — RI-d invariant)
 *   perishable     → exp(-age_days / PROV_PERISHABLE_HALFLIFE_DAYS)
 *                    (default halflife = 90 days)
 *   legacy-unknown → 1.0
 */
export const v1ProvenanceReweight: ReweightFn = (fused, provenance, referenceTime) => {
  const ref = referenceTime ?? new Date();
  const durableBoost = parseFloat(process.env.PROV_DURABLE_BOOST ?? "1.30");
  const perishablePenalty = parseFloat(process.env.PROV_PERISHABLE_PENALTY ?? "0.85");
  const halflifeDays = parseFloat(process.env.PROV_PERISHABLE_HALFLIFE_DAYS ?? "90");

  return fused
    .map((r) => {
      const p = provenance.get(r.vault_path) ?? {
        voice: "legacy-unknown" as Voice,
        written_at: "1970-01-01T00:00:00Z",
      };
      let score = r.rrf_score;
      if (p.voice === "durable") score *= durableBoost;
      else if (p.voice === "perishable") {
        score *= perishablePenalty;
        const ageDays = Math.max(0, (ref.getTime() - new Date(p.written_at).getTime()) / 86_400_000);
        score *= Math.exp(-ageDays / halflifeDays);
      }
      return {
        vault_path: r.vault_path,
        title: r.title,
        score,
        voice: p.voice,
        written_at: p.written_at,
        rrf_score: r.rrf_score,
      };
    })
    .sort((a, b) => b.score - a.score);
};

// ── Pipeline: candidates → fused → reweighted ────────────────────────

/**
 * Run a fixture through the real rrfFuse + chosen reweight implementation.
 * Returns the ranked output and the provenance lookup it was evaluated against.
 */
export function evaluateFixture(
  fixture: CandidateFixture,
  reweight: ReweightFn,
  referenceTime?: Date,
): { ranked: RankedHit[]; provenance: Map<string, ProvenanceMeta> } {
  const BM25_WEIGHT = parseFloat(process.env.BM25_WEIGHT ?? "1.2");
  const VEC_WEIGHT = parseFloat(process.env.VEC_WEIGHT ?? "1.2");
  const TITLE_WEIGHT = 3.0;

  const lists = [
    { results: stripProvenance(fixture.bm25), weight: BM25_WEIGHT, label: "bm25" },
    { results: stripProvenance(fixture.title), weight: TITLE_WEIGHT, label: "title" },
    { results: stripProvenance(fixture.vector), weight: VEC_WEIGHT, label: "vector" },
  ];

  const fused = rrfFuse(lists, 25);

  const provenance = new Map<string, ProvenanceMeta>();
  for (const list of [fixture.bm25, fixture.vector, fixture.title]) {
    for (const cand of list) {
      provenance.set(cand.vault_path, {
        voice: cand.voice,
        written_at: cand.written_at,
      });
    }
  }

  const ranked = reweight(
    fused.map((r) => ({ vault_path: r.vault_path, title: r.title, rrf_score: r.rrf_score })),
    provenance,
    referenceTime,
  );

  return { ranked, provenance };
}

/**
 * The synthetic candidates carry voice/written_at for the eval's bookkeeping.
 * The real rrfFuse signature doesn't include those, so we strip before fusion.
 */
function stripProvenance(cands: FixtureCandidate[]): {
  title: string;
  vault_path: string;
  score: number;
  snippet: string;
}[] {
  return cands.map((c) => ({
    title: c.title,
    vault_path: c.vault_path,
    score: c.score,
    snippet: c.snippet,
  }));
}

// ── Aggregate metrics ────────────────────────────────────────────────

export interface FixtureResult {
  id: string;
  kind: "ppr" | "rpr-perishable" | "ri-durable";
  query: string;
  expected_top: string;
  loser: string;
  actual_top: string;
  actual_loser_rank: number;
  passed: boolean;
  ranked_top5: { vault_path: string; voice: Voice; score: number }[];
}

export interface AggregateMetrics {
  ppr: { passed: number; total: number; rate: number };
  rpr_perishable: { passed: number; total: number; rate: number };
  ri_durable: { passed: number; total: number; rate: number };
  by_fixture: FixtureResult[];
}

export function runFixtures(
  fixtures: CandidateFixture[],
  reweight: ReweightFn,
  referenceTime?: Date,
): AggregateMetrics {
  const results: FixtureResult[] = [];

  for (const fx of fixtures) {
    const { ranked } = evaluateFixture(fx, reweight, referenceTime);
    const top = ranked[0];
    const loserIdx = ranked.findIndex((r) => r.vault_path === fx.loser);
    const passed = top?.vault_path === fx.expected_top;
    results.push({
      id: fx.id,
      kind: fx.kind,
      query: fx.query,
      expected_top: fx.expected_top,
      loser: fx.loser,
      actual_top: top?.vault_path ?? "(none)",
      actual_loser_rank: loserIdx,
      passed,
      ranked_top5: ranked.slice(0, 5).map((r) => ({
        vault_path: r.vault_path,
        voice: r.voice,
        score: Math.round(r.score * 10000) / 10000,
      })),
    });
  }

  const tally = (kind: FixtureResult["kind"]) => {
    const subset = results.filter((r) => r.kind === kind);
    const passed = subset.filter((r) => r.passed).length;
    return { passed, total: subset.length, rate: subset.length === 0 ? 0 : passed / subset.length };
  };

  return {
    ppr: tally("ppr"),
    rpr_perishable: tally("rpr-perishable"),
    ri_durable: tally("ri-durable"),
    by_fixture: results,
  };
}

// ── Threshold gates ─────────────────────────────────────────────────

export const THRESHOLDS = {
  ppr_min: 0.85,
  rpr_perishable_min: 0.75,
  ri_durable_min: 0.80,
  /** Δ p@5 / Δ MRR allowance vs eval-vector-search baseline. Negative = regression. */
  relevance_regression_max: -0.02,
  envelope_completeness_min: 1.0,
  /** p99 latency multiplier vs pre-provenance baseline. */
  latency_multiplier_max: 1.10,
} as const;

export interface ThresholdReport {
  ppr: { value: number; threshold: number; pass: boolean };
  rpr_perishable: { value: number; threshold: number; pass: boolean };
  ri_durable: { value: number; threshold: number; pass: boolean };
  all_pass: boolean;
}

export function checkRankingThresholds(m: AggregateMetrics): ThresholdReport {
  const ppr = { value: m.ppr.rate, threshold: THRESHOLDS.ppr_min, pass: m.ppr.rate >= THRESHOLDS.ppr_min };
  const rpr_perishable = {
    value: m.rpr_perishable.rate,
    threshold: THRESHOLDS.rpr_perishable_min,
    pass: m.rpr_perishable.rate >= THRESHOLDS.rpr_perishable_min,
  };
  const ri_durable = {
    value: m.ri_durable.rate,
    threshold: THRESHOLDS.ri_durable_min,
    pass: m.ri_durable.rate >= THRESHOLDS.ri_durable_min,
  };
  return {
    ppr,
    rpr_perishable,
    ri_durable,
    all_pass: ppr.pass && rpr_perishable.pass && ri_durable.pass,
  };
}

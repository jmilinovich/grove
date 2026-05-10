// Metrics for the search-quality eval.
//
// Rates measured over the candidate-fixture layer:
//
//   PPR     — % of dual-match queries where durable outranks perishable
//   RPR-p   — % of dual-perishable queries where recent outranks stale
//   RI-d    — % of dual-durable queries where age does NOT swap relevance
//   FIR     — % of freshness-intent queries where the right answer (recent
//             perishable, OR durable when negative-gate fires) reaches top-3
//
// Plus shared utilities for reweight pipelines, freshness-intent
// auto-detection, threshold checks, and canonical/adversarial split
// reporting.

import { rrfFuse } from "../../src/hybrid-search.js";
import type { Voice } from "../../src/provenance.js";
import { priorVoice } from "../../src/provenance-prior.js";
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

/** Per-call voice preference — surfaces from §G regex or caller param. */
export type VoicePreference = "canonical" | "recent" | "mixed";

/**
 * A reweight implementation. Takes the fused-by-RRF result list and a
 * lookup of per-key provenance, returns a new ordering by descending score.
 *
 * The baseline implementation is `identityReweight` — leave RRF order alone.
 * Provenance-aware implementations multiply by per-voice / per-age factors.
 *
 * `voicePreference` is forwarded from the query's auto-detection (or from
 * an explicit caller param). Reweight implementations may use it to
 * suppress age decay (`recent`) or down-weight perishable harder (`canonical`).
 */
export type ReweightFn = (
  fused: { vault_path: string; title: string; rrf_score: number }[],
  provenance: Map<string, ProvenanceMeta>,
  /** Reference time for age calculations. Defaults to now. */
  referenceTime?: Date,
  voicePreference?: VoicePreference,
) => RankedHit[];

// ── §G freshness-intent auto-detect ───────────────────────────────────

const FRESHNESS_TERMS =
  /\b(today|yesterday|right now|this (week|month|quarter)|latest|recent(ly)?|lately|\d{4}-\d{2}-\d{2}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4})\b/i;

const DURABLE_INTENT_TERMS =
  /\b(understanding|theory|definition|concept|history|origin|principles?|fundamentals?|thinking|approach|view|stance|framework|philosophy|paradigm|methodology|model of|take on)\b/i;

/** §G — Auto-detect voice preference from query text. */
export function detectVoicePreference(query: string): VoicePreference {
  if (DURABLE_INTENT_TERMS.test(query)) return "mixed";
  if (FRESHNESS_TERMS.test(query)) return "recent";
  return "mixed";
}

// ── §A piecewise age curve ────────────────────────────────────────────
//
// V3 §A — single source of truth for perishable age. §2's voice_factor
// is the asymptotic FLOOR; the curve interpolates toward it as age grows.
// Day 0-7 = full trust (1.0). Day 7-90 linear toward floor. Day 90+ at floor.

interface PiecewiseConfig {
  freshDays: number;        // 0..freshDays = freshFactor (slight perishable damp; see below)
  decayEndDays: number;     // freshDays..decayEndDays = linear ramp toward floor
  freshFactor: number;      // value during the fresh window — defaults to 0.97 per round-3 IR
  floor: number;            // asymptotic minimum (per-list voice factor for perishable)
}

/**
 * §A piecewise + round-3 IR fold-in: the fresh-window factor is 0.97 (not 1.0)
 * to preserve voice signal for same-age durable-vs-perishable comparisons.
 * IR panel's exact note: "perishable-from-yesterday at 1.00 and durable at
 * 1.00 means voice provides zero signal for 7 days."
 */
function piecewiseFactor(ageDays: number, cfg: PiecewiseConfig): number {
  if (ageDays <= cfg.freshDays) return cfg.freshFactor;
  if (ageDays >= cfg.decayEndDays) return cfg.floor;
  const span = cfg.decayEndDays - cfg.freshDays;
  const into = ageDays - cfg.freshDays;
  return cfg.freshFactor - (cfg.freshFactor - cfg.floor) * (into / span);
}

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
 * v1 reweight — exponential decay, voice multiplier × age multiplier.
 * Kept for historical comparison and sweep.ts. Superseded by v3.
 *
 *   final_score = rrf_score * voice_multiplier(voice) * age_multiplier(voice, age_days)
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

/**
 * v3 reweight — asymptotic floor + piecewise age curve + per-note prior
 * for legacy-unknown.
 *
 *   factor(durable, *)         = PROV_DURABLE_FACTOR (default 1.0)
 *   factor(perishable, age)    = piecewise(age, fresh=7, decayEnd=90,
 *                                          floor=PROV_PERISHABLE_FLOOR)
 *   factor(legacy-unknown, .)  = priorVoice-blended weighted average
 *
 * Voice preference modulates:
 *   - "recent"    → perishable factor forced to 1.0 (decay disabled)
 *   - "canonical" → perishable factor multiplied by an extra 0.5
 *   - "mixed"     → default behavior
 *
 * Per-list voice factors (§2 from V2): production version applies factors
 * INSIDE rrfFuse so each backend can carry asymmetric voice bias. The
 * harness layer here approximates with a single post-fusion factor —
 * mathematically close enough to validate the formula shape; the E2E
 * layer measures the true per-list version against the real index.
 */
export const v3ProvenanceReweight: ReweightFn = (
  fused,
  provenance,
  referenceTime,
  voicePreference = "mixed",
) => {
  const ref = referenceTime ?? new Date();
  const durableFactor = parseFloat(process.env.PROV_DURABLE_FACTOR ?? "1.0");
  const cfg: PiecewiseConfig = {
    freshDays: parseFloat(process.env.PROV_AGE_FRESH_DAYS ?? "7"),
    decayEndDays: parseFloat(process.env.PROV_AGE_DECAY_END_DAYS ?? "90"),
    freshFactor: parseFloat(process.env.PROV_PERISHABLE_FRESH_FACTOR ?? "0.95"),
    floor: parseFloat(process.env.PROV_PERISHABLE_FLOOR ?? "0.85"),
  };

  function perishableFactor(ageDays: number): number {
    // §A piecewise stays applied across all voice_preference modes —
    // disabling decay under "recent" loses the signal we need to surface
    // recent perishables over stale ones (rpr-p-005 "Canva priorities right
    // now" failure mode). Instead, voicePreference modulates an absolute
    // multiplier on top of the curve.
    const base = piecewiseFactor(ageDays, cfg);
    if (voicePreference === "recent") return base * 1.3;
    if (voicePreference === "canonical") return base * 0.5;
    return base;
  }

  return fused
    .map((r) => {
      const p = provenance.get(r.vault_path) ?? {
        voice: "legacy-unknown" as Voice,
        written_at: "1970-01-01T00:00:00Z",
      };
      const ageDays = Math.max(
        0,
        (ref.getTime() - new Date(p.written_at).getTime()) / 86_400_000,
      );

      let factor: number;
      if (p.voice === "durable") {
        factor = durableFactor;
      } else if (p.voice === "perishable") {
        factor = perishableFactor(ageDays);
      } else {
        // legacy-unknown: blend §E priorVoice with the same factors.
        // priorVoice covariates that need body text / frontmatter aren't
        // available at the harness layer; we use the cheap subset (path +
        // age). Production E2E will pass full covariates.
        const prior = priorVoice({
          path: r.vault_path,
          ageDays,
          frontmatterTags: [],
          bodyText: "",
        });
        factor = prior.p_durable * durableFactor + prior.p_perishable * perishableFactor(ageDays);
      }

      return {
        vault_path: r.vault_path,
        title: r.title,
        score: r.rrf_score * factor,
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

  const voicePreference = detectVoicePreference(fixture.query);
  const ranked = reweight(
    fused.map((r) => ({ vault_path: r.vault_path, title: r.title, rrf_score: r.rrf_score })),
    provenance,
    referenceTime,
    voicePreference,
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

export type FixtureKind = "ppr" | "rpr-perishable" | "ri-durable" | "fir";

export interface FixtureResult {
  id: string;
  kind: FixtureKind;
  query: string;
  expected_top: string;
  loser: string;
  actual_top: string;
  actual_loser_rank: number;
  /** True iff actual_top === expected_top. For FIR also true if expected_top is in top 3. */
  passed: boolean;
  ranked_top5: { vault_path: string; voice: Voice; score: number }[];
}

export interface SubsetRate {
  passed: number;
  total: number;
  rate: number;
}

export interface AggregateMetrics {
  /** Per-kind rates over WHATEVER subset was passed in. */
  ppr: SubsetRate;
  rpr_perishable: SubsetRate;
  ri_durable: SubsetRate;
  fir: SubsetRate;
  by_fixture: FixtureResult[];
}

/**
 * FIR's pass rule is different: instead of "top-1 == expected_top", we
 * check "expected_top is in top-3" because a freshness query may have
 * multiple legitimately-current results and ranking among them is
 * less important than ensuring the right kind of result surfaces.
 */
function fixturePassRule(fx: CandidateFixture, top1: string, top3: string[]): boolean {
  if (fx.kind === "fir") return top3.includes(fx.expected_top);
  return top1 === fx.expected_top;
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
    const top3 = ranked.slice(0, 3).map((r) => r.vault_path);
    const loserIdx = ranked.findIndex((r) => r.vault_path === fx.loser);
    const passed = fixturePassRule(fx, top?.vault_path ?? "(none)", top3);
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

  const tally = (kind: FixtureKind): SubsetRate => {
    const subset = results.filter((r) => r.kind === kind);
    const passed = subset.filter((r) => r.passed).length;
    return { passed, total: subset.length, rate: subset.length === 0 ? 0 : passed / subset.length };
  };

  return {
    ppr: tally("ppr"),
    rpr_perishable: tally("rpr-perishable"),
    ri_durable: tally("ri-durable"),
    fir: tally("fir"),
    by_fixture: results,
  };
}

// ── Threshold gates (V3 12-threshold A+) ────────────────────────────

export const THRESHOLDS = {
  // Canonical-set thresholds (the ship-readiness bar)
  ppr_min: 0.85,
  rpr_perishable_min: 0.75,
  ri_durable_min: 0.80,
  // Adversarial-set thresholds (the no-collapse bar)
  ppr_adversarial_min: 0.70,
  rpr_perishable_adversarial_min: 0.65,
  ri_durable_adversarial_min: 0.70,
  // Freshness-intent
  fir_min: 0.80,
  // Other A+ thresholds
  relevance_regression_max: -0.02,
  envelope_completeness_min: 1.0,
  latency_multiplier_max: 1.10,
  /** PPR-cold: PPR within this absolute gap of warm PPR right after cache flush. V3 §I tightened from 0.10 to 0.05. */
  ppr_cold_gap_max: 0.05,
} as const;

export interface ThresholdReport {
  ppr: { value: number; threshold: number; pass: boolean };
  rpr_perishable: { value: number; threshold: number; pass: boolean };
  ri_durable: { value: number; threshold: number; pass: boolean };
  fir: { value: number; threshold: number; pass: boolean };
  all_pass: boolean;
}

/** A subset with zero fixtures of a given kind passes vacuously. */
function checkRate(rate: SubsetRate, threshold: number) {
  return {
    value: rate.rate,
    threshold,
    pass: rate.total === 0 ? true : rate.rate >= threshold,
  };
}

export function checkRankingThresholds(
  m: AggregateMetrics,
  subset: "canonical" | "adversarial" = "canonical",
): ThresholdReport {
  const pprT =
    subset === "canonical" ? THRESHOLDS.ppr_min : THRESHOLDS.ppr_adversarial_min;
  const rprT =
    subset === "canonical"
      ? THRESHOLDS.rpr_perishable_min
      : THRESHOLDS.rpr_perishable_adversarial_min;
  const riT =
    subset === "canonical"
      ? THRESHOLDS.ri_durable_min
      : THRESHOLDS.ri_durable_adversarial_min;
  const ppr = checkRate(m.ppr, pprT);
  const rpr_perishable = checkRate(m.rpr_perishable, rprT);
  const ri_durable = checkRate(m.ri_durable, riT);
  const fir = checkRate(m.fir, THRESHOLDS.fir_min);
  return {
    ppr,
    rpr_perishable,
    ri_durable,
    fir,
    all_pass: ppr.pass && rpr_perishable.pass && ri_durable.pass && fir.pass,
  };
}

/**
 * Compute FIR explicitly over a fixture set's "fir"-kind entries.
 * Convenience wrapper — runFixtures already produces fir.rate.
 */
export function computeFIR(metrics: AggregateMetrics): SubsetRate {
  return metrics.fir;
}

/**
 * Segment Voice Fidelity — measured at the E2E layer only, where real
 * blame data exists. For the synthetic candidate layer we report 1.0 by
 * convention because every candidate carries a single voice.
 */
export function computeSVF(args: {
  hits: Array<{ envelope_voice: Voice | undefined; matched_segment_voice: Voice }>;
}): SubsetRate {
  const total = args.hits.length;
  if (total === 0) return { passed: 0, total: 0, rate: 1.0 };
  const passed = args.hits.filter(
    (h) => h.envelope_voice === h.matched_segment_voice,
  ).length;
  return { passed, total, rate: passed / total };
}

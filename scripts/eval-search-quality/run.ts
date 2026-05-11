#!/usr/bin/env tsx
/**
 * Search-quality eval runner.
 *
 * Three layers:
 *
 *   1. Ranking unit (always runs): synthetic candidate fixtures → real
 *      rrfFuse + chosen reweight implementation → PPR / RPR-p / RI-d / FIR.
 *      Reports canonical and adversarial subsets independently.
 *
 *   2. Regression sweep (--full): wraps `scripts/eval-vector-search.ts`
 *      and reports Δ p@5 / Δ MRR vs a stored baseline. Requires the local
 *      QMD index. Skipped in --quick mode.
 *
 *   3. End-to-end (--full): materializes a tiny synthetic vault, queries
 *      it through hybridSearch, measures p99 latency + envelope completeness +
 *      SVF on multi-segment notes. Skipped in --quick mode.
 *
 * Modes:
 *   --quick     run layer 1 only (fast, deterministic, no network) — DEFAULT
 *   --full      run all three layers (requires QMD index + Voyage API key)
 *   --json      machine-readable output to stdout
 *   --reweight  one of: identity | v1 | v3 (default: v3)
 *   --cold      truncate note_blame BEFORE measurement to test PPR-cold (V3 §I).
 *               No-op at the synthetic-candidate layer (no DB to truncate);
 *               meaningful only with --full when a real index is in play.
 *   --out=DIR   write results.json to this directory (optional)
 *
 * Examples:
 *   tsx scripts/eval-search-quality/run.ts --quick
 *   tsx scripts/eval-search-quality/run.ts --quick --json
 *   tsx scripts/eval-search-quality/run.ts --quick --reweight=identity
 *   tsx scripts/eval-search-quality/run.ts --full --cold --out=./eval-out
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CANDIDATE_FIXTURES,
  ADVERSARIAL_FIXTURES,
  FRESHNESS_INTENT_FIXTURES,
  ALL_CANDIDATE_FIXTURES,
} from "./test-set.js";
import {
  identityReweight,
  v1ProvenanceReweight,
  v3ProvenanceReweight,
  runFixtures,
  checkRankingThresholds,
  THRESHOLDS,
  type AggregateMetrics,
  type ReweightFn,
  type ThresholdReport,
} from "./metrics.js";

interface Args {
  quick: boolean;
  full: boolean;
  json: boolean;
  cold: boolean;
  reweight: "identity" | "v1" | "v3";
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    quick: false,
    full: false,
    json: false,
    cold: false,
    reweight: "v3",
  };
  for (const a of argv) {
    if (a === "--quick") args.quick = true;
    else if (a === "--full") args.full = true;
    else if (a === "--json") args.json = true;
    else if (a === "--cold") args.cold = true;
    else if (a === "--reweight=identity") args.reweight = "identity";
    else if (a === "--reweight=v1") args.reweight = "v1";
    else if (a === "--reweight=v3") args.reweight = "v3";
    else if (a.startsWith("--out=")) args.out = a.slice("--out=".length);
  }
  if (!args.quick && !args.full) args.quick = true;
  return args;
}

function pickReweight(name: Args["reweight"]): ReweightFn {
  switch (name) {
    case "identity":
      return identityReweight;
    case "v1":
      return v1ProvenanceReweight;
    case "v3":
      return v3ProvenanceReweight;
  }
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function row(
  label: string,
  t: { value: number; threshold: number; pass: boolean },
): string {
  const icon = t.pass ? "✓" : "✗";
  return `  ${icon} ${label.padEnd(28)}  ${fmtPct(t.value).padStart(7)}  (≥ ${fmtPct(t.threshold)})`;
}

function printSection(
  title: string,
  metrics: AggregateMetrics,
  thresholds: ThresholdReport,
): string[] {
  const out: string[] = [];
  out.push(title);
  out.push("-".repeat(60));
  out.push(row("PPR (durable > perishable)", thresholds.ppr));
  out.push(row("RPR-p (recent > stale)", thresholds.rpr_perishable));
  out.push(row("RI-d (relevance > age)", thresholds.ri_durable));
  if (metrics.fir.total > 0) out.push(row("FIR (freshness intent)", thresholds.fir));
  out.push(
    `   counts: PPR ${metrics.ppr.passed}/${metrics.ppr.total}, RPR-p ${metrics.rpr_perishable.passed}/${metrics.rpr_perishable.total}, RI-d ${metrics.ri_durable.passed}/${metrics.ri_durable.total}, FIR ${metrics.fir.passed}/${metrics.fir.total}`,
  );
  return out;
}

function printFailures(metrics: AggregateMetrics, label: string): string[] {
  const failed = metrics.by_fixture.filter((f) => !f.passed);
  if (failed.length === 0) return [];
  const out: string[] = [];
  out.push("");
  out.push(`Failures in ${label} (${failed.length}):`);
  for (const f of failed) {
    out.push(`  [${f.kind}] ${f.id}`);
    out.push(`    query:    "${f.query}"`);
    out.push(`    expected: ${f.expected_top}`);
    out.push(`    got top:  ${f.actual_top}`);
    out.push(`    top5:`);
    for (const h of f.ranked_top5) {
      out.push(`      ${h.score.toFixed(4)}  [${h.voice.padEnd(14)}] ${h.vault_path}`);
    }
    out.push("");
  }
  return out;
}

interface SplitReport {
  canonical: { metrics: AggregateMetrics; thresholds: ThresholdReport };
  adversarial: { metrics: AggregateMetrics; thresholds: ThresholdReport };
  freshness: { metrics: AggregateMetrics; thresholds: ThresholdReport };
  /** Gate: BOTH canonical AND adversarial must pass; FIR also gates if any FIR fixtures exist. */
  all_pass: boolean;
}

function runRankingUnit(
  reweight: ReweightFn,
  referenceTime: Date,
): SplitReport {
  // Canonical: original 28 fixtures (PPR + RPR-p + RI-d, no FIR)
  const canonicalMetrics = runFixtures(CANDIDATE_FIXTURES, reweight, referenceTime);
  const canonicalThresholds = checkRankingThresholds(canonicalMetrics, "canonical");

  // Adversarial: 20 fixtures testing voice/age signal isolation under the
  // relaxed thresholds. Same metric semantics, looser bars.
  const adversarialMetrics = runFixtures(ADVERSARIAL_FIXTURES, reweight, referenceTime);
  const adversarialThresholds = checkRankingThresholds(adversarialMetrics, "adversarial");

  // Freshness: 12 FIR fixtures. Pass = expected_top in top-3.
  const freshnessMetrics = runFixtures(FRESHNESS_INTENT_FIXTURES, reweight, referenceTime);
  const freshnessThresholds = checkRankingThresholds(freshnessMetrics, "canonical");

  return {
    canonical: { metrics: canonicalMetrics, thresholds: canonicalThresholds },
    adversarial: { metrics: adversarialMetrics, thresholds: adversarialThresholds },
    freshness: { metrics: freshnessMetrics, thresholds: freshnessThresholds },
    all_pass:
      canonicalThresholds.all_pass &&
      adversarialThresholds.all_pass &&
      freshnessThresholds.fir.pass,
  };
}

function printHumanReport(report: SplitReport, reweightName: string, cold: boolean): void {
  const out: string[] = [];
  out.push("");
  out.push(
    `Search-Quality Eval (reweight=${reweightName}${cold ? ", cold" : ""})`,
  );
  out.push("=".repeat(60));
  out.push("");
  out.push(...printSection("Canonical (28 fixtures)", report.canonical.metrics, report.canonical.thresholds));
  out.push("");
  out.push(...printSection("Adversarial (20 fixtures, relaxed bars)", report.adversarial.metrics, report.adversarial.thresholds));
  out.push("");
  out.push(...printSection("Freshness Intent (12 fixtures)", report.freshness.metrics, report.freshness.thresholds));
  out.push("");
  out.push(...printFailures(report.canonical.metrics, "canonical"));
  out.push(...printFailures(report.adversarial.metrics, "adversarial"));
  out.push(...printFailures(report.freshness.metrics, "freshness"));
  out.push(report.all_pass ? "RESULT: PASS" : "RESULT: FAIL");
  out.push("");
  console.log(out.join("\n"));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const reweight = pickReweight(args.reweight);
  // Pin reference time so the eval is deterministic — fixture ages are
  // dated relative to "now" = 2026-05-09 (matches GOAL.md lock date).
  const referenceTime = new Date("2026-05-09T12:00:00Z");

  if (args.cold && args.quick) {
    // Synthetic-candidate layer has no cache to flush. The flag is
    // meaningful only with --full + a real QMD index. Surface a warning
    // so callers don't think they're testing PPR-cold when they aren't.
    console.error(
      "[warn] --cold is a no-op without --full (no DB cache to truncate at the synthetic layer).",
    );
  }

  const ranking = runRankingUnit(reweight, referenceTime);

  const report = {
    schema_version: 2,
    reweight: args.reweight,
    reference_time: referenceTime.toISOString(),
    cold: args.cold,
    thresholds: THRESHOLDS,
    ranking_unit: {
      canonical: ranking.canonical,
      adversarial: ranking.adversarial,
      freshness: ranking.freshness,
      all_pass: ranking.all_pass,
    },
    layers: {
      ranking_unit: "ran",
      regression_sweep: args.full ? "TODO: wraps eval-vector-search" : "skipped (use --full)",
      end_to_end: args.full ? "TODO: latency + envelope + SVF" : "skipped (use --full)",
    },
    fixture_counts: {
      canonical: CANDIDATE_FIXTURES.length,
      adversarial: ADVERSARIAL_FIXTURES.length,
      freshness: FRESHNESS_INTENT_FIXTURES.length,
      total: ALL_CANDIDATE_FIXTURES.length,
    },
  };

  if (args.out) {
    mkdirSync(args.out, { recursive: true });
    writeFileSync(join(args.out, "results.json"), JSON.stringify(report, null, 2));
  }

  if (args.json) {
    console.log(JSON.stringify(report));
  } else {
    printHumanReport(ranking, args.reweight, args.cold);
  }

  if (!ranking.all_pass) process.exit(1);
}

main().catch((err) => {
  console.error("eval-search-quality failed:", err);
  process.exit(2);
});

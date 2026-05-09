#!/usr/bin/env tsx
/**
 * Search-quality eval runner.
 *
 * Three layers:
 *
 *   1. Ranking unit (always runs): synthetic candidate fixtures → real
 *      rrfFuse + chosen reweight implementation → PPR / RPR-p / RI-d.
 *
 *   2. Regression sweep (--full): wraps `scripts/eval-vector-search.ts`
 *      and reports Δ p@5 / Δ MRR vs a stored baseline. Requires the local
 *      QMD index. Skipped in --quick mode.
 *
 *   3. End-to-end (--full): materializes a tiny synthetic vault, queries
 *      it through hybridSearch, measures p99 latency + envelope completeness.
 *      Skipped in --quick mode.
 *
 * Modes:
 *   --quick     run layer 1 only (fast, deterministic, no network)
 *   --full      run all three layers (requires QMD index + Voyage API key)
 *   --json      machine-readable output to stdout
 *   --reweight  one of: identity | v1 (default: v1)
 *   --out=DIR   write results.json to this directory (optional)
 *
 * Examples:
 *   tsx scripts/eval-search-quality/run.ts --quick
 *   tsx scripts/eval-search-quality/run.ts --quick --json
 *   tsx scripts/eval-search-quality/run.ts --quick --reweight=identity
 *   tsx scripts/eval-search-quality/run.ts --full --out=./eval-out
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CANDIDATE_FIXTURES } from "./test-set.js";
import {
  identityReweight,
  v1ProvenanceReweight,
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
  reweight: "identity" | "v1";
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { quick: false, full: false, json: false, reweight: "v1" };
  for (const a of argv) {
    if (a === "--quick") args.quick = true;
    else if (a === "--full") args.full = true;
    else if (a === "--json") args.json = true;
    else if (a === "--reweight=identity") args.reweight = "identity";
    else if (a === "--reweight=v1") args.reweight = "v1";
    else if (a.startsWith("--out=")) args.out = a.slice("--out=".length);
  }
  // default to --quick if neither flag given
  if (!args.quick && !args.full) args.quick = true;
  return args;
}

function pickReweight(name: Args["reweight"]): ReweightFn {
  return name === "identity" ? identityReweight : v1ProvenanceReweight;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function printHumanReport(
  metrics: AggregateMetrics,
  thresholds: ThresholdReport,
  reweightName: string,
): void {
  const out: string[] = [];
  out.push("");
  out.push(`Search-Quality Eval (reweight=${reweightName})`);
  out.push("=".repeat(60));
  out.push("");

  const row = (label: string, t: { value: number; threshold: number; pass: boolean }) => {
    const icon = t.pass ? "✓" : "✗";
    return `  ${icon} ${label.padEnd(28)}  ${fmtPct(t.value).padStart(7)}  (≥ ${fmtPct(t.threshold)})`;
  };
  out.push(row("PPR (durable > perishable)", thresholds.ppr));
  out.push(row("RPR-p (recent > stale)", thresholds.rpr_perishable));
  out.push(row("RI-d (relevance > age)", thresholds.ri_durable));
  out.push("");
  out.push(`  PPR             ${metrics.ppr.passed}/${metrics.ppr.total}`);
  out.push(`  RPR-perishable  ${metrics.rpr_perishable.passed}/${metrics.rpr_perishable.total}`);
  out.push(`  RI-durable      ${metrics.ri_durable.passed}/${metrics.ri_durable.total}`);
  out.push("");

  const failed = metrics.by_fixture.filter((f) => !f.passed);
  if (failed.length > 0) {
    out.push(`Failures (${failed.length}):`);
    for (const f of failed) {
      out.push(`  [${f.kind}] ${f.id}`);
      out.push(`    query:    "${f.query}"`);
      out.push(`    expected: ${f.expected_top}`);
      out.push(`    got top:  ${f.actual_top}`);
      out.push(`    top5:`);
      for (const h of f.ranked_top5) {
        out.push(`      ${h.score.toFixed(4)}  [${h.voice.padEnd(10)}] ${h.vault_path}`);
      }
      out.push("");
    }
  }

  out.push(thresholds.all_pass ? "RESULT: PASS" : "RESULT: FAIL");
  out.push("");
  console.log(out.join("\n"));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const reweight = pickReweight(args.reweight);
  // Pin reference time so the eval is deterministic — fixture ages are
  // dated relative to "now" = 2026-05-09 (matches GOAL.md lock date).
  const referenceTime = new Date("2026-05-09T12:00:00Z");

  const metrics = runFixtures(CANDIDATE_FIXTURES, reweight, referenceTime);
  const thresholds = checkRankingThresholds(metrics);

  const report = {
    schema_version: 1,
    reweight: args.reweight,
    reference_time: referenceTime.toISOString(),
    thresholds: THRESHOLDS,
    threshold_report: thresholds,
    metrics,
    layers: {
      ranking_unit: "ran",
      regression_sweep: args.full ? "TODO: wraps eval-vector-search" : "skipped (use --full)",
      end_to_end: args.full ? "TODO: latency + envelope" : "skipped (use --full)",
    },
  };

  if (args.out) {
    mkdirSync(args.out, { recursive: true });
    writeFileSync(join(args.out, "results.json"), JSON.stringify(report, null, 2));
  }

  if (args.json) {
    console.log(JSON.stringify(report));
  } else {
    printHumanReport(metrics, thresholds, args.reweight);
  }

  if (!thresholds.all_pass) process.exit(1);
}

main().catch((err) => {
  console.error("eval-search-quality failed:", err);
  process.exit(2);
});

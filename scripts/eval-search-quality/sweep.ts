#!/usr/bin/env tsx
/**
 * Tunability sweep — runs the ranking-unit layer across multiple reweight
 * configs and prints a per-config delta table. Used to find good defaults
 * for PROV_DURABLE_BOOST / PROV_PERISHABLE_PENALTY / PROV_PERISHABLE_HALFLIFE_DAYS
 * before they get wired into production.
 *
 * Edit `CONFIGS` to add candidates. Each config inherits process env, so
 * you can pin BM25_WEIGHT / VEC_WEIGHT here too if you want a wider sweep.
 *
 * Usage:
 *   tsx scripts/eval-search-quality/sweep.ts
 *   tsx scripts/eval-search-quality/sweep.ts --json
 */

import { ALL_CANDIDATE_FIXTURES, CANDIDATE_FIXTURES, ADVERSARIAL_FIXTURES, FRESHNESS_INTENT_FIXTURES } from "./test-set.js";
import {
  v1ProvenanceReweight,
  v3ProvenanceReweight,
  identityReweight,
  runFixtures,
  type ReweightFn,
} from "./metrics.js";

interface ConfigEnv {
  // v1 knobs
  PROV_DURABLE_BOOST?: string;
  PROV_PERISHABLE_PENALTY?: string;
  PROV_PERISHABLE_HALFLIFE_DAYS?: string;
  // v3 knobs
  PROV_DURABLE_FACTOR?: string;
  PROV_PERISHABLE_FRESH_FACTOR?: string;
  PROV_PERISHABLE_FLOOR?: string;
  PROV_AGE_FRESH_DAYS?: string;
  PROV_AGE_DECAY_END_DAYS?: string;
}

interface Config {
  label: string;
  reweight: ReweightFn;
  env?: ConfigEnv;
}

const CONFIGS: Config[] = [
  { label: "baseline-identity", reweight: identityReweight },
  {
    label: "v1-default",
    reweight: v1ProvenanceReweight,
    env: { PROV_DURABLE_BOOST: "1.30", PROV_PERISHABLE_PENALTY: "0.85", PROV_PERISHABLE_HALFLIFE_DAYS: "90" },
  },
  {
    label: "v1-aggressive",
    reweight: v1ProvenanceReweight,
    env: { PROV_DURABLE_BOOST: "1.60", PROV_PERISHABLE_PENALTY: "0.70", PROV_PERISHABLE_HALFLIFE_DAYS: "45" },
  },
  {
    label: "v1-conservative",
    reweight: v1ProvenanceReweight,
    env: { PROV_DURABLE_BOOST: "1.15", PROV_PERISHABLE_PENALTY: "0.95", PROV_PERISHABLE_HALFLIFE_DAYS: "180" },
  },
  {
    label: "v1-decay-only",
    reweight: v1ProvenanceReweight,
    env: { PROV_DURABLE_BOOST: "1.00", PROV_PERISHABLE_PENALTY: "1.00", PROV_PERISHABLE_HALFLIFE_DAYS: "60" },
  },
  {
    label: "v1-voice-only",
    reweight: v1ProvenanceReweight,
    env: { PROV_DURABLE_BOOST: "1.40", PROV_PERISHABLE_PENALTY: "0.75", PROV_PERISHABLE_HALFLIFE_DAYS: "9999" },
  },
  // V3 configs — asymptotic floor + piecewise interpolation, no exponential decay
  {
    label: "v3-default",
    reweight: v3ProvenanceReweight,
    env: {
      PROV_DURABLE_FACTOR: "1.0",
      PROV_PERISHABLE_FRESH_FACTOR: "0.95",
      PROV_PERISHABLE_FLOOR: "0.85",
      PROV_AGE_FRESH_DAYS: "7",
      PROV_AGE_DECAY_END_DAYS: "90",
    },
  },
  {
    label: "v3-aggressive-floor",
    reweight: v3ProvenanceReweight,
    env: {
      PROV_DURABLE_FACTOR: "1.0",
      PROV_PERISHABLE_FRESH_FACTOR: "0.92",
      PROV_PERISHABLE_FLOOR: "0.70",
      PROV_AGE_FRESH_DAYS: "3",
      PROV_AGE_DECAY_END_DAYS: "60",
    },
  },
  {
    label: "v3-conservative-floor",
    reweight: v3ProvenanceReweight,
    env: {
      PROV_DURABLE_FACTOR: "1.0",
      PROV_PERISHABLE_FRESH_FACTOR: "0.97",
      PROV_PERISHABLE_FLOOR: "0.92",
      PROV_AGE_FRESH_DAYS: "14",
      PROV_AGE_DECAY_END_DAYS: "180",
    },
  },
  {
    label: "v3-with-durable-boost",
    reweight: v3ProvenanceReweight,
    env: {
      PROV_DURABLE_FACTOR: "1.05",
      PROV_PERISHABLE_FRESH_FACTOR: "0.95",
      PROV_PERISHABLE_FLOOR: "0.85",
      PROV_AGE_FRESH_DAYS: "7",
      PROV_AGE_DECAY_END_DAYS: "90",
    },
  },
];

function withEnv<T>(env: ConfigEnv | undefined, fn: () => T): T {
  if (!env) return fn();
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    process.env[k] = (env as Record<string, string>)[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function fmt(n: number): string {
  return (n * 100).toFixed(1).padStart(5);
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const referenceTime = new Date("2026-05-09T12:00:00Z");

  interface Row {
    label: string;
    canonical: { ppr: number; rpr_p: number; ri_d: number };
    adversarial: { ppr: number; rpr_p: number; ri_d: number };
    fir: number;
  }
  const rows: Row[] = [];
  for (const cfg of CONFIGS) {
    const canonical = withEnv(cfg.env, () => runFixtures(CANDIDATE_FIXTURES, cfg.reweight, referenceTime));
    const adversarial = withEnv(cfg.env, () => runFixtures(ADVERSARIAL_FIXTURES, cfg.reweight, referenceTime));
    const freshness = withEnv(cfg.env, () => runFixtures(FRESHNESS_INTENT_FIXTURES, cfg.reweight, referenceTime));
    rows.push({
      label: cfg.label,
      canonical: { ppr: canonical.ppr.rate, rpr_p: canonical.rpr_perishable.rate, ri_d: canonical.ri_durable.rate },
      adversarial: { ppr: adversarial.ppr.rate, rpr_p: adversarial.rpr_perishable.rate, ri_d: adversarial.ri_durable.rate },
      fir: freshness.fir.rate,
    });
  }

  if (json) {
    console.log(JSON.stringify({ schema_version: 2, reference_time: referenceTime.toISOString(), rows }, null, 2));
    return;
  }

  console.log("");
  console.log("Sweep — search-quality reweight configs (canonical | adversarial | FIR)");
  console.log("=".repeat(110));
  console.log(`  ${"config".padEnd(26)}  c.PPR  c.RPR-p c.RI-d  a.PPR  a.RPR-p a.RI-d  FIR     overall`);
  console.log(`  ${"-".repeat(26)}  ------ ------- ------- ------ ------- ------- ------- -------`);
  for (const r of rows) {
    const overall = (r.canonical.ppr + r.canonical.rpr_p + r.canonical.ri_d +
                     r.adversarial.ppr + r.adversarial.rpr_p + r.fir) / 6;
    console.log(
      `  ${r.label.padEnd(26)}  ${fmt(r.canonical.ppr)}% ${fmt(r.canonical.rpr_p)}%  ${fmt(r.canonical.ri_d)}%  ${fmt(r.adversarial.ppr)}% ${fmt(r.adversarial.rpr_p)}%  ${fmt(r.adversarial.ri_d)}%  ${fmt(r.fir)}%  ${fmt(overall)}%`,
    );
  }
  console.log("");
}

main().catch((err) => {
  console.error("sweep failed:", err);
  process.exit(2);
});

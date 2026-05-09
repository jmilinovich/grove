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

import { CANDIDATE_FIXTURES } from "./test-set.js";
import {
  v1ProvenanceReweight,
  identityReweight,
  runFixtures,
  type ReweightFn,
} from "./metrics.js";

interface ConfigEnv {
  PROV_DURABLE_BOOST?: string;
  PROV_PERISHABLE_PENALTY?: string;
  PROV_PERISHABLE_HALFLIFE_DAYS?: string;
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

  const rows: { label: string; ppr: number; rpr_p: number; ri_d: number }[] = [];
  for (const cfg of CONFIGS) {
    const m = withEnv(cfg.env, () => runFixtures(CANDIDATE_FIXTURES, cfg.reweight, referenceTime));
    rows.push({ label: cfg.label, ppr: m.ppr.rate, rpr_p: m.rpr_perishable.rate, ri_d: m.ri_durable.rate });
  }

  if (json) {
    console.log(JSON.stringify({ schema_version: 1, reference_time: referenceTime.toISOString(), rows }, null, 2));
    return;
  }

  console.log("");
  console.log("Sweep — search-quality reweight configs");
  console.log("=".repeat(72));
  console.log(`  ${"config".padEnd(24)}  PPR     RPR-p   RI-d    overall`);
  console.log(`  ${"-".repeat(24)}  ------  ------  ------  -------`);
  for (const r of rows) {
    const overall = (r.ppr + r.rpr_p + r.ri_d) / 3;
    console.log(`  ${r.label.padEnd(24)}  ${fmt(r.ppr)}%  ${fmt(r.rpr_p)}%  ${fmt(r.ri_d)}%  ${fmt(overall)}%`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("sweep failed:", err);
  process.exit(2);
});

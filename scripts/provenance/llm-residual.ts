#!/usr/bin/env tsx
// CLI: take a manifest from classify.ts, run Sonnet on every entry
// with proposed_voice="unknown" or signals.length==0, write an
// enriched manifest. Caches by (path, source_hash) in a sidecar JSON
// so re-runs only re-classify changed files.
//
// Usage:
//   tsx scripts/provenance/llm-residual.ts <manifest.jsonl> <vault-path> \
//     [--out=enriched.jsonl] [--cache=cache.json] [--limit=N] [--dry-run]
//
// Cost: ~$0.001 per call at Sonnet rates × ~350 unknown notes for a
// 1750-note vault ≈ $0.35 total. Cheap. Run after classify.ts, before
// report.ts.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { classifyNoteWithLLM, applyLLMVerdict, type LLMVerdict } from "./llm-classify.js";
import type { ClassifierResult } from "./rules.js";

interface CliArgs {
  manifestPath: string;
  vaultPath: string;
  outPath: string;
  cachePath: string;
  limit: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let outPath = "/tmp/provenance-manifest-llm.jsonl";
  let cachePath = "/tmp/provenance-llm-cache.json";
  let limit = Number.MAX_SAFE_INTEGER;
  let dryRun = false;
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--out=")) outPath = arg.slice(6);
    else if (arg.startsWith("--cache=")) cachePath = arg.slice(8);
    else if (arg.startsWith("--limit=")) limit = Number(arg.slice(8));
    else positional.push(arg);
  }
  if (positional.length < 2) {
    console.error(
      "Usage: llm-residual <manifest.jsonl> <vault-path> [--out=...] [--cache=...] [--limit=N] [--dry-run]",
    );
    process.exit(2);
  }
  return {
    manifestPath: positional[0],
    vaultPath: positional[1],
    outPath,
    cachePath,
    limit,
    dryRun,
  };
}

interface LLMCache {
  /** Map of (path|byte_length) → cached verdict. */
  entries: Record<string, LLMVerdict>;
}

function loadCache(path: string): LLMCache {
  if (!existsSync(path)) return { entries: {} };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LLMCache;
  } catch {
    return { entries: {} };
  }
}

function saveCache(path: string, cache: LLMCache): void {
  writeFileSync(path, JSON.stringify(cache, null, 2));
}

function readManifest(path: string): ClassifierResult[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ClassifierResult);
}

function needsResidual(r: ClassifierResult): boolean {
  return r.proposed_voice === "unknown" || r.signals.length === 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const manifest = readManifest(args.manifestPath);
  const cache = loadCache(args.cachePath);

  const targets = manifest.filter(needsResidual);
  console.log(`Manifest: ${manifest.length} entries`);
  console.log(`Residual (unknown / no-signal): ${targets.length}`);

  if (args.dryRun) {
    console.log("Dry-run — would classify these:");
    for (const r of targets.slice(0, 20)) {
      console.log(`  ${r.path}  [${r.proposed_voice}/${r.confidence}]`);
    }
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY required for --execute mode");
    process.exit(1);
  }

  const out = new Map<string, ClassifierResult>();
  for (const r of manifest) out.set(r.path, r);

  let processed = 0;
  let cacheHits = 0;
  let llmCalls = 0;
  for (const target of targets.slice(0, args.limit)) {
    processed++;
    const cacheKey = `${target.path}|${target.byte_length}`;
    let verdict = cache.entries[cacheKey];

    if (verdict) {
      cacheHits++;
    } else {
      try {
        verdict = await classifyNoteWithLLM({
          vaultPath: args.vaultPath,
          notePath: target.path,
        });
        cache.entries[cacheKey] = verdict;
        llmCalls++;
        if (llmCalls % 25 === 0) saveCache(args.cachePath, cache);
      } catch (err: any) {
        console.error(`[${processed}/${targets.length}] ERROR ${target.path}: ${err.message}`);
        continue;
      }
    }

    const enriched = applyLLMVerdict(target, verdict);
    out.set(target.path, enriched);

    if (processed <= 5 || processed % 50 === 0) {
      console.log(
        `[${processed}/${targets.length}] ${enriched.proposed_voice}/${enriched.confidence}  ${target.path}`,
      );
    }
  }

  saveCache(args.cachePath, cache);

  // Write the enriched manifest preserving original order.
  const ordered = manifest.map((r) => out.get(r.path) ?? r);
  writeFileSync(args.outPath, ordered.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const counts = countByVoice(ordered);
  console.log(`\nDone.`);
  console.log(`  cache hits: ${cacheHits}`);
  console.log(`  llm calls:  ${llmCalls}`);
  console.log(`  Final counts: durable=${counts.durable} perishable=${counts.perishable} unknown=${counts.unknown}`);
  console.log(`  Enriched manifest: ${args.outPath}`);
  console.log(`  Cache: ${args.cachePath}`);
}

function countByVoice(rs: ClassifierResult[]): Record<string, number> {
  const c = { durable: 0, perishable: 0, unknown: 0 };
  for (const r of rs) c[r.proposed_voice]++;
  return c;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env tsx
// Review-report formatter: takes a JSONL manifest from classify.ts and
// produces a human-readable markdown document John can review and
// annotate (then re-feed to apply.ts to actually stamp).
//
// Why a markdown report and not a TUI: the annotation panel design said
// keyboard-driven bulk-confirmation. A simple markdown file with
// checkbox-style "confirm" markers serves the same role at much less
// engineering cost — John reads it in his editor, edits the
// confirmation lines, saves, runs apply. No state machine, no curses,
// no kb-binding maintenance.
//
// Usage:
//   tsx scripts/provenance/report.ts <manifest.jsonl> [--out=review.md]
//
// Output structure:
//   ## Resources/Concepts/ — perishable (10 notes, medium+high confidence)
//
//   - [ ] Resources/Concepts/conviction-then-leave-pattern.md
//         excerpt: "A behavioral pattern identified in [[Sample Subject]]..."
//         signals: interview_prep_concept (medium)
//         > To confirm: leave the - [ ] as-is. To override: replace with
//         > one of - [d] (durable), - [p] (perishable), - [u] (unknown).
//
// John runs apply.ts against the same file; apply.ts parses the
// checkboxes and stamps the confirmed entries. Bucket-confirmation is
// supported: a "## ALL → perishable" section header at the top can
// flip every box in the section.

import { readFileSync, writeFileSync } from "node:fs";

import type { ClassifierResult } from "./rules.js";

interface CliArgs {
  manifestPath: string;
  outPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let outPath = "/tmp/provenance-review.md";
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--out=")) outPath = arg.slice(6);
    else positional.push(arg);
  }
  if (positional.length === 0) {
    console.error("Usage: report <manifest.jsonl> [--out=review.md]");
    process.exit(2);
  }
  return { manifestPath: positional[0], outPath };
}

function readManifest(path: string): ClassifierResult[] {
  const raw = readFileSync(path, "utf8");
  const out: ClassifierResult[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line));
  }
  return out;
}

function topFolder(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return "/";
  if (parts[0] === "Resources" && parts.length >= 2) return `Resources/${parts[1]}`;
  if (parts[0] === "Areas" && parts.length >= 2) return `Areas/${parts[1]}`;
  if (parts[0] === "Journal") return "Journal";
  return parts[0];
}

interface Bucket {
  folder: string;
  voice: string;
  results: ClassifierResult[];
}

function bucketize(results: ClassifierResult[]): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const r of results) {
    const folder = topFolder(r.path);
    const key = `${folder}|${r.proposed_voice}`;
    if (!map.has(key)) {
      map.set(key, { folder, voice: r.proposed_voice, results: [] });
    }
    map.get(key)!.results.push(r);
  }
  // Sort: perishable buckets first (highest-stakes review), then by folder.
  const voiceRank = (v: string): number =>
    v === "perishable" ? 0 : v === "unknown" ? 1 : 2;
  return [...map.values()].sort((a, b) => {
    if (voiceRank(a.voice) !== voiceRank(b.voice)) {
      return voiceRank(a.voice) - voiceRank(b.voice);
    }
    return a.folder.localeCompare(b.folder);
  });
}

function renderHeader(): string {
  return `# Provenance review

This is a per-note proposal from the rules-based classifier. Each box
controls how that note will be stamped when you run \`apply.ts\` against
this file.

## How to review

For each entry, the leading checkbox declares the proposed voice:

- \`- [p]\` — perishable (will get a perishable stamp)
- \`- [d]\` — durable (will get a durable stamp)
- \`- [u]\` — unknown / skip (apply.ts will not stamp this one)
- \`- [ ]\` — UNREVIEWED — apply.ts will reject the manifest until you
  resolve every entry. Replace with one of the three above.

To confirm the classifier's proposal, replace \`- [ ]\` with the
character matching that proposal (shown next to "proposed:" on each
line). To override, use a different character.

## Bucket-confirm shortcut

To accept ALL entries in a section as their proposed voice, change the
section's \`status:\` line from \`unreviewed\` to \`confirmed\`. apply.ts
will treat every \`- [ ]\` in a confirmed section as if it had been set
to its proposed voice.

---
`;
}

function renderBucket(bucket: Bucket): string {
  const high = bucket.results.filter((r) => r.confidence === "high").length;
  const medium = bucket.results.filter((r) => r.confidence === "medium").length;
  const low = bucket.results.filter((r) => r.confidence === "low").length;

  const stakeNote =
    bucket.voice === "perishable" && bucket.folder.startsWith("Resources/")
      ? "  HIGH-STAKES: bucket-confirm only after spot-checking individual entries below."
      : "";

  let out = `\n## ${bucket.folder} → ${bucket.voice} (${bucket.results.length} notes; high=${high} med=${medium} low=${low})\n\n`;
  out += `status: unreviewed${stakeNote}\n\n`;

  for (const r of bucket.results) {
    out += `- [ ] proposed: ${r.proposed_voice} (${r.confidence}) — \`${r.path}\`\n`;
    out += `  > excerpt: ${truncate(r.excerpt, 180)}\n`;
    if (r.signals.length > 0) {
      out += `  > signals: ${r.signals.map((s) => `${s.rule} (${s.confidence})`).join(", ")}\n`;
    } else {
      out += `  > signals: (no rule fired)\n`;
    }
    out += "\n";
  }

  return out;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function main(): void {
  const args = parseArgs(process.argv);
  const results = readManifest(args.manifestPath);
  const buckets = bucketize(results);

  let out = renderHeader();
  for (const bucket of buckets) {
    out += renderBucket(bucket);
  }

  // Trailing summary so John knows the total at a glance.
  const counts = {
    perishable: results.filter((r) => r.proposed_voice === "perishable").length,
    durable: results.filter((r) => r.proposed_voice === "durable").length,
    unknown: results.filter((r) => r.proposed_voice === "unknown").length,
  };
  out += `\n---\n\n## Summary\n\n`;
  out += `- ${counts.perishable} proposed perishable\n`;
  out += `- ${counts.durable} proposed durable\n`;
  out += `- ${counts.unknown} proposed unknown (no stamp)\n`;
  out += `- ${results.length} total\n`;

  writeFileSync(args.outPath, out);
  console.log(`Wrote ${out.length} bytes to ${args.outPath}`);
  console.log(`  ${counts.perishable} perishable, ${counts.durable} durable, ${counts.unknown} unknown`);
}

main();

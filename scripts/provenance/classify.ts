#!/usr/bin/env tsx
// Classifier CLI — walks a vault, applies the rules in rules.ts to every
// note, emits a JSONL manifest of proposed_voice + signals + excerpt.
//
// Usage:
//   tsx scripts/provenance/classify.ts <vault-path> [--out=manifest.jsonl] [--include=glob] [--exclude=glob]
//
// Examples:
//   tsx scripts/provenance/classify.ts ~/clones/grove-vault \
//     --out=/tmp/provenance-manifest.jsonl
//
//   tsx scripts/provenance/classify.ts ./test-vault \
//     --include='Resources/Concepts/**' \
//     --out=/tmp/concepts-only.jsonl
//
// The manifest is the input to the review TUI / report (B1.2). The CLI
// never modifies the vault — it's a pure read-and-classify pass.

import { lstatSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { classifyNote, type ClassifierResult } from "./rules.js";

interface CliArgs {
  vaultPath: string;
  out: string;
  include: RegExp | null;
  exclude: RegExp | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {
    out: "/tmp/provenance-manifest.jsonl",
    include: null,
    exclude: null,
  };
  const positional: string[] = [];
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--out=")) args.out = arg.slice(6);
    else if (arg.startsWith("--include=")) args.include = globToRegex(arg.slice(10));
    else if (arg.startsWith("--exclude=")) args.exclude = globToRegex(arg.slice(10));
    else positional.push(arg);
  }
  if (positional.length === 0) {
    console.error("Usage: classify <vault-path> [--out=...] [--include=glob] [--exclude=glob]");
    process.exit(2);
  }
  args.vaultPath = positional[0];
  return args as CliArgs;
}

function globToRegex(glob: string): RegExp {
  // Tiny glob: ** = any-depth wildcard, * = single-segment wildcard, ? = single char.
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+()|^$[]{}\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(re + "$");
}

function* walkMd(root: string, current = root): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(current);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === ".git" || entry === ".obsidian" || entry === "_media") continue;
    if (entry.startsWith(".")) continue; // skip dotfiles/dotdirs
    const full = join(current, entry);
    let stat;
    try {
      // lstatSync: don't follow symlinks (broken symlinks would crash).
      stat = lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue; // skip symlinks entirely
    if (stat.isDirectory()) {
      yield* walkMd(root, full);
    } else if (stat.isFile() && entry.endsWith(".md")) {
      yield relative(root, full).split(sep).join("/");
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const start = Date.now();
  const out: ClassifierResult[] = [];
  let scanned = 0;
  let skipped = 0;

  for (const notePath of walkMd(args.vaultPath)) {
    scanned++;
    if (args.include && !args.include.test(notePath)) {
      skipped++;
      continue;
    }
    if (args.exclude && args.exclude.test(notePath)) {
      skipped++;
      continue;
    }
    try {
      const result = classifyNote({ vaultPath: args.vaultPath, notePath });
      out.push(result);
    } catch (err) {
      console.error(`error on ${notePath}:`, (err as Error).message);
    }
  }

  // Write JSONL.
  writeFileSync(args.out, out.map((r) => JSON.stringify(r)).join("\n") + "\n");

  // Summary.
  const elapsed = Date.now() - start;
  const counts = countByVoice(out);
  console.log(`Scanned: ${scanned} (${skipped} excluded)`);
  console.log(`Classified: ${out.length}`);
  console.log(`  durable:    ${counts.durable}`);
  console.log(`  perishable: ${counts.perishable}`);
  console.log(`  unknown:    ${counts.unknown}`);
  console.log(`Manifest written to: ${args.out}`);
  console.log(`(${elapsed}ms)`);
}

function countByVoice(results: ClassifierResult[]): Record<string, number> {
  const counts = { durable: 0, perishable: 0, unknown: 0 };
  for (const r of results) counts[r.proposed_voice]++;
  return counts;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

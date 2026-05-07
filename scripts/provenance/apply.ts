#!/usr/bin/env tsx
// Apply-from-review: parses a confirmed review.md (the output of
// report.ts after John has resolved checkboxes) and calls stampOne per
// entry. Bulk override pass for B3.
//
// Usage:
//   tsx scripts/provenance/apply.ts <review.md> <vault-path> \
//     [--by=claude-opus-4-6] [--written-at-source=git-earliest|now|fixed:DATE] \
//     [--source=...] [--dry-run]
//
// Behavior:
//   - Parses the review file into per-section bucket-status + per-note
//     decisions.
//   - For each note with a resolved decision (p / d / u or section
//     status="confirmed"), composes a Provenance and either prints it
//     (--dry-run) or calls stampOne to write the override commit.
//   - "u" entries are skipped (no stamp).
//   - If the file has any unresolved "- [ ]" entry in a section that's
//     not "confirmed", apply REFUSES to start. Forces full review.
//
// The default written_at source is "git-earliest" — for a backfill
// stamp, the most truthful written_at is when the content was
// originally drafted, which `git log` records as the file's earliest
// author-time.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

import { stampOne } from "./stamp.js";
import type { Provenance } from "../../src/provenance.js";

const execFileP = promisify(execFile);

interface CliArgs {
  reviewPath: string;
  vaultPath: string;
  by: string;
  writtenAtSource: WrittenAtSource;
  source?: string;
  dryRun: boolean;
}

type WrittenAtSource =
  | { kind: "git-earliest" }
  | { kind: "now" }
  | { kind: "fixed"; iso: string };

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let by = "claude-opus-4-6";
  let writtenAtSource: WrittenAtSource = { kind: "git-earliest" };
  let source: string | undefined;
  let dryRun = false;
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--by=")) by = arg.slice(5);
    else if (arg.startsWith("--source=")) source = arg.slice(9);
    else if (arg.startsWith("--written-at-source=")) {
      const v = arg.slice(20);
      if (v === "git-earliest") writtenAtSource = { kind: "git-earliest" };
      else if (v === "now") writtenAtSource = { kind: "now" };
      else if (v.startsWith("fixed:")) writtenAtSource = { kind: "fixed", iso: v.slice(6) };
      else {
        console.error(`unrecognized --written-at-source: ${v}`);
        process.exit(2);
      }
    } else positional.push(arg);
  }
  if (positional.length < 2) {
    console.error("Usage: apply <review.md> <vault-path> [opts]");
    process.exit(2);
  }
  return {
    reviewPath: positional[0],
    vaultPath: positional[1],
    by,
    writtenAtSource,
    source,
    dryRun,
  };
}

interface Decision {
  path: string;
  voice: "durable" | "perishable";
  proposedVoice: string;
  rationale: string;
}

interface SkipDecision {
  path: string;
  reason: string;
}

interface ReviewParseResult {
  decisions: Decision[];
  skips: SkipDecision[];
  unresolved: string[]; // paths with [ ] in unconfirmed sections
}

function parseReview(text: string): ReviewParseResult {
  const decisions: Decision[] = [];
  const skips: SkipDecision[] = [];
  const unresolved: string[] = [];

  let inSectionConfirmed = false;
  let currentSection: string | null = null;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Section header: ## <folder> → <voice> (...)
    const sectionMatch = /^##\s+([\w/]+)\s+→\s+(\w+)/.exec(line);
    if (sectionMatch) {
      currentSection = `${sectionMatch[1]} → ${sectionMatch[2]}`;
      inSectionConfirmed = false;
      continue;
    }

    // Status line: status: confirmed | unreviewed (followed maybe by note text)
    const statusMatch = /^\s*status:\s*(confirmed|unreviewed)\b/.exec(line);
    if (statusMatch) {
      inSectionConfirmed = statusMatch[1] === "confirmed";
      continue;
    }

    // Entry line: - [c] proposed: <voice> (<conf>) — `<path>`
    const entryMatch = /^-\s*\[([ pdu])\]\s+proposed:\s+(\w+)\s+\(\w+\)\s+—\s+`([^`]+)`/.exec(line);
    if (!entryMatch) continue;
    const [, char, proposedVoice, path] = entryMatch;

    if (char === "p" || char === "d") {
      decisions.push({
        path,
        voice: char === "p" ? "perishable" : "durable",
        proposedVoice,
        rationale: `explicit checkbox: ${char}`,
      });
    } else if (char === "u") {
      skips.push({ path, reason: "marked unknown" });
    } else if (char === " ") {
      if (inSectionConfirmed) {
        // Bucket-confirm: use proposed voice
        if (proposedVoice === "perishable" || proposedVoice === "durable") {
          decisions.push({
            path,
            voice: proposedVoice,
            proposedVoice,
            rationale: `bucket-confirmed (section status: confirmed)`,
          });
        } else {
          skips.push({ path, reason: `bucket-confirmed but proposed=${proposedVoice}` });
        }
      } else {
        unresolved.push(path);
      }
    }
  }

  return { decisions, skips, unresolved };
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function resolveWrittenAt(
  source: WrittenAtSource,
  vaultPath: string,
  notePath: string,
): Promise<string> {
  if (source.kind === "now") return new Date().toISOString();
  if (source.kind === "fixed") return source.iso;
  // git-earliest: earliest author-time of any commit touching this file.
  try {
    const { stdout } = await execFileP(
      "git",
      ["log", "--reverse", "--format=%aI", "--", notePath],
      { cwd: vaultPath, maxBuffer: 4 * 1024 * 1024 },
    );
    const first = stdout.split("\n").find((s) => s.trim());
    if (first) return first.trim();
  } catch {
    // fall through
  }
  return new Date().toISOString();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  let text: string;
  try {
    text = readFileSync(args.reviewPath, "utf8");
  } catch (err: any) {
    console.error(`apply: cannot read ${args.reviewPath}: ${err.message}`);
    process.exit(1);
  }

  const parsed = parseReview(text);

  if (parsed.unresolved.length > 0) {
    console.error(`REFUSED — ${parsed.unresolved.length} entries are still unresolved:`);
    for (const p of parsed.unresolved.slice(0, 10)) console.error(`  - ${p}`);
    if (parsed.unresolved.length > 10) {
      console.error(`  ... and ${parsed.unresolved.length - 10} more`);
    }
    console.error(
      "\nResolve every checkbox to [p], [d], or [u], or set the section's `status:` to `confirmed`.",
    );
    process.exit(1);
  }

  console.log(`Decisions: ${parsed.decisions.length} stamps + ${parsed.skips.length} skips`);
  if (args.dryRun) {
    for (const d of parsed.decisions.slice(0, 20)) {
      console.log(`  [DRY] ${d.voice.padEnd(10)} ${d.path} (${d.rationale})`);
    }
    if (parsed.decisions.length > 20) {
      console.log(`  ... and ${parsed.decisions.length - 20} more`);
    }
    return;
  }

  // Apply each decision via stampOne. Fail-fast on first error so a
  // half-applied batch can be inspected + reverted before continuing.
  let stamped = 0;
  let errors = 0;
  for (const [i, d] of parsed.decisions.entries()) {
    const written_at = await resolveWrittenAt(args.writtenAtSource, args.vaultPath, d.path);
    const prov: Provenance = {
      voice: d.voice,
      by: args.by,
      written_at,
      reason: `bulk-stamp from manifest (${d.rationale})`,
      ...(args.source && { source: args.source }),
    };
    try {
      const r = await stampOne({
        vaultPath: args.vaultPath,
        notePath: d.path,
        provenance: prov,
      });
      stamped++;
      if (i < 5 || (i + 1) % 20 === 0) {
        console.log(`[${i + 1}/${parsed.decisions.length}] stamped ${d.path} as ${d.voice} (${r.commit_sha.slice(0, 7)})`);
      }
    } catch (err: any) {
      errors++;
      console.error(`[${i + 1}/${parsed.decisions.length}] FAILED ${d.path}: ${err.message}`);
      console.error(
        `\nStopping after first failure. ${stamped} stamps already committed; ` +
          `revert with \`git reset --hard HEAD~${stamped}\` if you want to undo.`,
      );
      process.exit(1);
    }
  }

  console.log(`\nDone. ${stamped} stamps committed, ${errors} errors.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

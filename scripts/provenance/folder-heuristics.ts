// Folder-path heuristics for legacy backfill — DRAFT.
//
// John flagged this as a separate concern from the content rules in
// rules.ts: "There are some heuristics we can use to label provenance
// even for the legacy stuff based on the folder path they are in. I
// can help with this after the rest." (2026-05-07)
//
// This file is the draft starting point. Each entry is annotated with
// a confidence + a "John, confirm?" comment. Folder rules are HIGH-
// PRECISION DEFAULTS for the bulk backfill — they fire when no other
// content rule fires, so they're the catch-all for the long tail.
//
// Once John signs off (replace TODO comments with locked-in
// rationales), wire these into rules.ts as a final set of rules
// applied AFTER the content rules. Order matters: content rules win
// over folder rules so e.g. an interview-prep tag in Resources/People/
// still classifies as perishable even though the folder default is
// durable.

import type { ClassifyInput, NoteSignals, RuleHit } from "./rules.js";

interface FolderRule {
  prefix: string;
  voice: "durable" | "perishable" | "unknown";
  confidence: "low" | "medium" | "high";
  rationale: string;
  /** Free-text questions for John before this rule ships. */
  questions?: string;
}

export const FOLDER_RULES: FolderRule[] = [
  // ── Sources/ ──────────────────────────────────────────────────────
  // Public material curated by John. The X-bookmark subset is already
  // covered in rules.ts via `sources_research`. This is the catch-all
  // for non-bookmark Sources/ entries.
  {
    prefix: "Sources/",
    voice: "durable",
    confidence: "high",
    rationale: "Sources/ — curated public material; durable cited research",
    questions: "Confirm? Anything in Sources/ ever NOT durable (e.g. Sources/working/)?",
  },

  // ── Areas/ — long-running life domains ────────────────────────────
  // These are John's own ongoing notes. Not Claude-synthesized.
  {
    prefix: "Areas/Health/",
    voice: "durable",
    confidence: "high",
    rationale: "Areas/Health/ — John's own health tracking and notes",
    questions: "Confirm? Any AI-generated health summaries here?",
  },
  {
    prefix: "Areas/Finances/",
    voice: "durable",
    confidence: "high",
    rationale: "Areas/Finances/ — John's own financial planning notes",
    questions: "Confirm? Any AI-generated comp/finance analyses?",
  },
  {
    prefix: "Areas/Meal Planning/",
    voice: "durable",
    confidence: "high",
    rationale: "Areas/Meal Planning/ — John's own meal planning",
  },

  // ── Areas/Business/ExecuSystems — has its own provenance system ──
  // ExecuSystems already uses prose_by + last_edited_by + confidence
  // frontmatter. The content rule in rules.ts catches `prose_by:
  // Claude` already. This folder rule is the default for entries
  // WITHOUT explicit prose_by — they're John's own.
  {
    prefix: "Areas/Business/ExecuSystems/",
    voice: "durable",
    confidence: "medium",
    rationale: "Areas/Business/ExecuSystems/ — has rich provenance frontmatter; default to durable when no explicit prose_by",
    questions:
      "Confirm? Should we instead leave these unknown so the existing prose_by/confidence frontmatter is the only signal?",
  },

  // ── Areas/Business/Legacy Holdings ───────────────────────────────
  {
    prefix: "Areas/Business/Legacy Holdings/",
    voice: "durable",
    confidence: "low",
    rationale: "Areas/Business/Legacy Holdings/ — John's own strategy vault",
    questions:
      "Low confidence — John, do these atomic notes have any AI-synthesized content that should be perishable?",
  },

  // ── Resources/Pantry/ — kitchen inventory ────────────────────────
  {
    prefix: "Resources/Pantry/",
    voice: "durable",
    confidence: "high",
    rationale: "Resources/Pantry/ — John's kitchen inventory",
  },

  // ── Resources/Places/ — named locations ──────────────────────────
  {
    prefix: "Resources/Places/",
    voice: "durable",
    confidence: "medium",
    rationale: "Resources/Places/ — geographic / venue notes; John's own observations",
    questions: "Confirm? Could a place note be Claude-summarized from a web search?",
  },

  // ── Resources/Companies/ — orgs in John's orbit ─────────────────
  {
    prefix: "Resources/Companies/",
    voice: "durable",
    confidence: "medium",
    rationale: "Resources/Companies/ — companies John has touched professionally",
    questions:
      "Confirm? Some company notes may be Claude-synthesized from public material — should those still be durable (cited research) or perishable (Claude-pattern)?",
  },

  // ── Resources/Projects/ — active personal projects ──────────────
  {
    prefix: "Resources/Projects/",
    voice: "durable",
    confidence: "medium",
    rationale: "Resources/Projects/ — John's projects (Grove, Aesthetic, etc.)",
  },

  // ── Notes/working/ — working scratchpad ─────────────────────────
  {
    prefix: "Notes/working/",
    voice: "perishable",
    confidence: "medium",
    rationale: "Notes/working/ — in-progress thinking, often AI-assisted",
    questions: "Confirm? Or should working notes be unknown (no stamp, leave for human)?",
  },

  // ── Notes/pinch/ — ??? unknown to me ─────────────────────────────
  {
    prefix: "Notes/pinch/",
    voice: "unknown",
    confidence: "low",
    rationale: "Notes/pinch/ — DRAFT: I don't know what this is. John, please define.",
    questions:
      "What is Notes/pinch/? Looks like a project (PLAN.md + beats/ + outreach/). Voice should depend on what kind of content lives here.",
  },

  // ── Archives/ — cold storage ─────────────────────────────────────
  {
    prefix: "Archives/",
    voice: "unknown",
    confidence: "high",
    rationale: "Archives/ — preserve historical voice; archive is a marker not a re-classification",
    questions:
      "Confirm? Or should we trust the original frontmatter to declare voice (e.g. archived_from + the original note's voice)?",
  },

  // ── Inbox/ — already in content rules but doubling here ─────────
  {
    prefix: "Inbox/",
    voice: "unknown",
    confidence: "high",
    rationale: "Inbox/ — scratchpad; needs human review for promotion to a typed folder",
  },
];

/**
 * Apply the folder rules. Returns the FIRST matching rule (rules are
 * ordered specific-prefix first, generic-prefix last). Use as a
 * fallback in rules.ts:classifyNote() AFTER all content rules have
 * been tried.
 *
 * UNFINISHED: this function is exported but NOT yet wired into
 * rules.ts:classifyNote(). Wire after John signs off on the rule
 * table above.
 */
export function applyFolderHeuristic(
  input: ClassifyInput,
  _sig: NoteSignals,
): RuleHit | null {
  // Order rules by prefix length descending so more-specific rules win.
  const ordered = [...FOLDER_RULES].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const rule of ordered) {
    if (input.notePath.startsWith(rule.prefix)) {
      return {
        rule: `folder:${rule.prefix}`,
        voice: rule.voice,
        confidence: rule.confidence,
        rationale: rule.rationale,
      };
    }
  }
  return null;
}

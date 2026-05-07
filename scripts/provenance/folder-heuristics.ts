// Folder-path heuristics for legacy backfill.
//
// John signed off on the rule table 2026-05-07 (AskUserQuestion round).
// These rules fire as a fallback in classifyNote() AFTER content rules,
// so e.g. an interview-prep tag in Resources/People/ still classifies
// as perishable even though the folder default is durable.

import type { ClassifyInput, NoteSignals, RuleHit } from "./rules.js";

interface FolderRule {
  prefix: string;
  voice: "durable" | "perishable" | "unknown";
  confidence: "low" | "medium" | "high";
  rationale: string;
}

export const FOLDER_RULES: FolderRule[] = [
  // ── Sources/ — curated public material ───────────────────────────
  // X-bookmark subset is already covered in rules.ts via
  // sources_research; this catches non-bookmark Sources/ entries.
  {
    prefix: "Sources/",
    voice: "durable",
    confidence: "high",
    rationale: "Sources/ — curated public material; durable cited research",
  },

  // ── Areas/ — long-running life domains John writes himself ──────
  {
    prefix: "Areas/Health/",
    voice: "durable",
    confidence: "high",
    rationale: "Areas/Health/ — John's own health tracking",
  },
  {
    prefix: "Areas/Finances/",
    voice: "durable",
    confidence: "high",
    rationale: "Areas/Finances/ — John's own financial planning",
  },
  {
    prefix: "Areas/Meal Planning/",
    voice: "durable",
    confidence: "high",
    rationale: "Areas/Meal Planning/ — John's own meal planning",
  },

  // ── Areas/Business/ExecuSystems/ — has its own provenance system ──
  // The content rule prose_by_claude in rules.ts catches notes with
  // explicit prose_by frontmatter. This folder default fires only on
  // notes WITHOUT prose_by — those are John's own.
  {
    prefix: "Areas/Business/ExecuSystems/",
    voice: "durable",
    confidence: "medium",
    rationale: "Areas/Business/ExecuSystems/ — durable when no explicit prose_by frontmatter (rich provenance system handles the AI-authored cases via content rule)",
  },

  // ── Areas/Business/Legacy Holdings/ — John's own strategy vault ──
  {
    prefix: "Areas/Business/Legacy Holdings/",
    voice: "durable",
    confidence: "low",
    rationale: "Areas/Business/Legacy Holdings/ — John's own strategy vault (low confidence; flag for manual review during backfill)",
  },

  // ── Resources/Pantry/ — kitchen inventory ────────────────────────
  {
    prefix: "Resources/Pantry/",
    voice: "durable",
    confidence: "high",
    rationale: "Resources/Pantry/ — kitchen inventory",
  },

  // ── Resources/Places/ — Claude-summarized public info OK ────────
  // John signed off: AI-summarized public info is durable (cited
  // research), same framing as Sources/.
  {
    prefix: "Resources/Places/",
    voice: "durable",
    confidence: "medium",
    rationale: "Resources/Places/ — geographic/venue notes; AI-summarized public info treated as cited research (durable)",
  },

  // ── Resources/Companies/ — same framing as Places/ ──────────────
  {
    prefix: "Resources/Companies/",
    voice: "durable",
    confidence: "medium",
    rationale: "Resources/Companies/ — orgs in John's orbit; AI-summarized public info treated as cited research (durable)",
  },

  // ── Resources/Projects/ — John's active personal projects ───────
  {
    prefix: "Resources/Projects/",
    voice: "durable",
    confidence: "medium",
    rationale: "Resources/Projects/ — John's own projects (Grove, Aesthetic, etc.)",
  },

  // ── Notes/pinch/ — Pinch agent project ───────────────────────────
  // John (2026-05-07): Notes/pinch/ holds work for an agent named
  // Pinch — PLAN.md, market research, beats, outreach. All
  // project-related; default durable. Pinch's outputs (e.g. beats/)
  // ARE Claude-generated but they're factual machine outputs, not
  // synthesis — durable is the right call.
  {
    prefix: "Notes/pinch/",
    voice: "durable",
    confidence: "medium",
    rationale: "Notes/pinch/ — Pinch agent project documentation, plans, and outputs",
  },

  // ── Archives/ — cold storage; preserve original voice ───────────
  // Don't blindly stamp archived content — it carries its pre-archival
  // voice. Leave as unknown so backfill defers to whatever the
  // archived_from path's voice was (or human review).
  {
    prefix: "Archives/",
    voice: "unknown",
    confidence: "high",
    rationale: "Archives/ — preserves historical voice; archive is a marker, not a re-classification",
  },

  // ── Inbox/ — content rule already covers this ────────────────────
  {
    prefix: "Inbox/",
    voice: "unknown",
    confidence: "high",
    rationale: "Inbox/ — scratchpad; needs human review for promotion",
  },
];

/**
 * Apply the folder rules. Returns the FIRST matching rule (rules are
 * ordered specific-prefix first, generic-prefix last). Used as a
 * fallback in rules.ts:classifyNote() AFTER all content rules have
 * been tried.
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

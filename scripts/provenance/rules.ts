// Classifier rules — high-precision signals from the Agent B vault
// catalog (2026-05-07). Each rule fires only when its predicate is
// confidently satisfied; ambiguous cases emit "unknown" for human
// review (the bulk of the work happens at review time, not here).
//
// Why rules-first (vs LLM-first): rules are deterministic, cheap,
// and perfectly precise on the patterns we already understand. The
// long tail goes to LLM (Phase B follow-up) or human review. This
// keeps the project shippable at 1,750 notes in ~3h of human time
// per the annotation panel.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type ClassifierVoice = "durable" | "perishable" | "unknown";
export type Confidence = "low" | "medium" | "high";

export interface ClassifyInput {
  /** Vault root absolute path. */
  vaultPath: string;
  /** Note path relative to vault root. */
  notePath: string;
}

export interface RuleHit {
  /** Rule identifier (stable across versions). */
  rule: string;
  voice: ClassifierVoice;
  confidence: Confidence;
  /** One-line human-readable rationale. */
  rationale: string;
}

export interface NoteSignals {
  frontmatter: Record<string, string>;
  body: string;
  byteLength: number;
  /** Filesystem mtime as ISO. */
  mtime: string;
}

/**
 * Read a note and parse its frontmatter + body into a signals struct.
 * Lightweight YAML parse — only top-level scalar fields, which is all
 * the rules need.
 */
export function readSignals(input: ClassifyInput): NoteSignals {
  const full = join(input.vaultPath, input.notePath);
  const raw = readFileSync(full, "utf8");
  const stat = statSync(full);

  const frontmatterMatch = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  const frontmatter: Record<string, string> = {};
  let body = raw;
  if (frontmatterMatch) {
    const fmRaw = frontmatterMatch[1];
    body = raw.slice(frontmatterMatch[0].length);
    for (const line of fmRaw.split("\n")) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (m) frontmatter[m[1]] = m[2].trim();
    }
  }

  return {
    frontmatter,
    body,
    byteLength: Buffer.byteLength(raw, "utf8"),
    mtime: stat.mtime.toISOString(),
  };
}

// ── Rules ───────────────────────────────────────────────────────────

const PERISHABLE_REASON = "Pattern matches known contamination signal from Agent B catalog (2026-05-07).";

interface Rule {
  id: string;
  apply: (input: ClassifyInput, sig: NoteSignals) => RuleHit | null;
}

const RULES: Rule[] = [
  // ── Highest-precision: explicit `prose_by: Claude` frontmatter ──
  {
    id: "prose_by_claude",
    apply: (_input, sig) => {
      const v = sig.frontmatter.prose_by ?? sig.frontmatter.last_edited_by ?? "";
      if (/Claude/i.test(v)) {
        return {
          rule: "prose_by_claude",
          voice: "perishable",
          confidence: "high",
          rationale: `frontmatter.prose_by = ${JSON.stringify(v)} — explicit Claude authorship`,
        };
      }
      return null;
    },
  },

  // ── Sources/ folder + research tag → research (collapsed to durable) ──
  {
    id: "sources_research",
    apply: (input, sig) => {
      if (!input.notePath.startsWith("Sources/")) return null;
      const tags = (sig.frontmatter.tags ?? "").toLowerCase();
      if (
        tags.includes("from-x-bookmarks") ||
        tags.includes("research") ||
        tags.includes("source") ||
        tags.includes("bookmark")
      ) {
        return {
          rule: "sources_research",
          voice: "durable",
          confidence: "high",
          rationale: "Sources/ path + research/bookmark tag — durable cited research",
        };
      }
      return null;
    },
  },

  // ── Inbox/ → keep as unknown — these are scratchpad ──
  {
    id: "inbox_unknown",
    apply: (input) => {
      if (!input.notePath.startsWith("Inbox/")) return null;
      return {
        rule: "inbox_unknown",
        voice: "unknown",
        confidence: "high",
        rationale: "Inbox/ path — scratchpad, requires human review",
      };
    },
  },

  // ── Stub note (<200 chars) → skip ──
  {
    id: "stub_skip",
    apply: (_input, sig) => {
      if (sig.byteLength < 200) {
        return {
          rule: "stub_skip",
          voice: "unknown",
          confidence: "high",
          rationale: `byteLength=${sig.byteLength} — too short to classify confidently`,
        };
      }
      return null;
    },
  },

  // ── Same-day archived_from + archived_at + interview-prep → perishable ──
  {
    id: "same_day_archive_interview_prep",
    apply: (_input, sig) => {
      const archivedFrom = sig.frontmatter.archived_from;
      const archivedAt = sig.frontmatter.archived_at;
      const created = sig.frontmatter.created;
      const tags = (sig.frontmatter.tags ?? "").toLowerCase();
      if (!archivedFrom || !archivedAt || !created) return null;
      if (!tags.includes("interview-prep")) return null;
      const createdDate = created.slice(0, 10);
      const archivedDate = archivedAt.slice(0, 10);
      const dayDiff =
        Math.abs(Date.parse(archivedDate) - Date.parse(createdDate)) /
        (1000 * 60 * 60 * 24);
      if (dayDiff < 2) {
        return {
          rule: "same_day_archive_interview_prep",
          voice: "perishable",
          confidence: "high",
          rationale: `interview-prep tag + archived within ${Math.round(dayDiff)} day(s) of creation — single-session extraction`,
        };
      }
      return null;
    },
  },

  // ── Concept tagged interview-prep / competitive-intel / operating-values ──
  // The most load-bearing rule for the third-bucket failure mode. Per
  // Agent B's catalog: "type: concept + interview-prep tag" is the
  // single most dangerous pattern — moment-in-time tactical claims
  // filed as durable concepts. We fire on the tag alone (no date
  // requirement) because the contamination was created in clusters
  // that don't all have explicit `created:` frontmatter.
  {
    id: "interview_prep_concept",
    apply: (input, sig) => {
      if (!input.notePath.startsWith("Resources/Concepts/")) return null;
      const tags = (sig.frontmatter.tags ?? "").toLowerCase();
      const isInterviewPrep =
        tags.includes("interview-prep") ||
        tags.includes("competitive-intel") ||
        tags.includes("operating-values") ||
        tags.includes("compensation") ||
        tags.includes("decision-pattern") ||
        tags.includes("organizational-design");
      if (!isInterviewPrep) return null;
      // Higher confidence when there's also a date marker (in path or frontmatter).
      const dateMarker =
        /\d{4}-\d{2}\b/.test(input.notePath) ||
        !!sig.frontmatter.created;
      return {
        rule: "interview_prep_concept",
        voice: "perishable",
        confidence: dateMarker ? "high" : "medium",
        rationale: dateMarker
          ? "Resources/Concepts/ + interview-prep cluster tag + dated — panel-prep crystallization"
          : "Resources/Concepts/ + interview-prep cluster tag — likely panel-prep",
      };
    },
  },

  // ── Person notes with interview-prep / recruiter / comp-negotiation tags ──
  // Person notes in this corpus are mostly durable. But when they're
  // tagged as interview-prep / recruiter / etc., they're the artifact
  // of a single-call extraction (per Agent B: "single-conversation
  // extraction frozen as durable identity"). Treat as perishable.
  {
    id: "person_interview_prep",
    apply: (input, sig) => {
      if (!input.notePath.startsWith("Resources/People/")) return null;
      const tags = (sig.frontmatter.tags ?? "").toLowerCase();
      const flagged =
        tags.includes("interview-prep") ||
        tags.includes("recruiter") ||
        tags.includes("comp-negotiation") ||
        tags.includes("competitive-intel");
      if (!flagged) return null;
      return {
        rule: "person_interview_prep",
        voice: "perishable",
        confidence: "medium",
        rationale: "Resources/People/ + interview-prep/recruiter tag — single-call extraction framed as durable identity",
      };
    },
  },

  // ── Person note with third-person body about a "John" subject ──
  // High-signal contamination: a note named "Resources/People/John …"
  // whose body refers to "John" in third person was ALWAYS Claude-
  // written (a human typing about themselves doesn't talk like that).
  {
    id: "person_third_person_self",
    apply: (input, sig) => {
      if (!input.notePath.startsWith("Resources/People/")) return null;
      const filename = input.notePath.split("/").pop() ?? "";
      // Match "John.md", "John Milinovich.md", etc.
      if (!/^John(\b| )/.test(filename)) return null;
      // Look for "## John's POV" or third-person prose ("John carries", "John has", etc.)
      if (/##\s*John'?s\s*POV/i.test(sig.body)) {
        return {
          rule: "person_third_person_self",
          voice: "perishable",
          confidence: "high",
          rationale: '`## John\'s POV` header on a note ABOUT John — third-person Claude prose, not John\'s voice',
        };
      }
      return null;
    },
  },

  // ── Generic interview-prep tag in notes/ ──
  {
    id: "notes_interview_prep",
    apply: (input, sig) => {
      if (!input.notePath.startsWith("notes/") && !input.notePath.startsWith("Notes/")) return null;
      const tags = (sig.frontmatter.tags ?? "").toLowerCase();
      if (!tags.includes("interview-prep")) return null;
      return {
        rule: "notes_interview_prep",
        voice: "perishable",
        confidence: "medium",
        rationale: "notes/ path + interview-prep tag — likely live-build prep doc, moment-in-time",
      };
    },
  },

  // ── Recipe → durable ──
  {
    id: "recipe_durable",
    apply: (_input, sig) => {
      if (sig.frontmatter.type === "recipe") {
        return {
          rule: "recipe_durable",
          voice: "durable",
          confidence: "high",
          rationale: "type: recipe — durable lifestyle content",
        };
      }
      return null;
    },
  },

  // ── Journal at file level → durable (section-level handling deferred) ──
  {
    id: "journal_file_level_durable",
    apply: (input) => {
      if (!input.notePath.startsWith("Journal/")) return null;
      return {
        rule: "journal_file_level_durable",
        voice: "durable",
        confidence: "low",
        rationale: "Journal/ — file-level durable, but mixed-voice sections exist; section-level work deferred to phase 2",
      };
    },
  },
];

export interface ClassifierResult {
  path: string;
  proposed_voice: ClassifierVoice;
  confidence: Confidence;
  signals: RuleHit[];
  excerpt: string;
  byte_length: number;
}

/**
 * Classify a single note. Applies every rule; if any hits, picks the
 * highest-confidence + most-specific result.
 *
 * Voice resolution:
 *   - If multiple rules agree on voice, take the highest confidence.
 *   - If rules disagree, default to "unknown" for human review.
 *   - If no rule matches, default to "unknown".
 */
export function classifyNote(input: ClassifyInput): ClassifierResult {
  const sig = readSignals(input);
  const hits: RuleHit[] = [];
  for (const rule of RULES) {
    const hit = rule.apply(input, sig);
    if (hit) hits.push(hit);
  }

  // Aggregate into a single decision.
  let voice: ClassifierVoice = "unknown";
  let confidence: Confidence = "low";
  if (hits.length > 0) {
    // Group by voice; take the highest-confidence vote per voice.
    const byVoice = new Map<ClassifierVoice, Confidence>();
    for (const h of hits) {
      const existing = byVoice.get(h.voice);
      if (!existing || rankConfidence(h.confidence) > rankConfidence(existing)) {
        byVoice.set(h.voice, h.confidence);
      }
    }
    if (byVoice.size === 1) {
      const [[v, c]] = [...byVoice];
      voice = v;
      confidence = c;
    } else {
      // Disagreement — leave for human review.
      voice = "unknown";
      confidence = "low";
    }
  }

  return {
    path: input.notePath,
    proposed_voice: voice,
    confidence,
    signals: hits,
    excerpt: sig.body.slice(0, 200).replace(/\s+/g, " ").trim(),
    byte_length: sig.byteLength,
  };
}

function rankConfidence(c: Confidence): number {
  return c === "high" ? 3 : c === "medium" ? 2 : 1;
}

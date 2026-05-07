// Conditions sweep — each condition shapes the context Claude sees when
// asked to act on a test note. A vs D is the kill-switch (control vs full
// mechanism); B/C/E are diagnostic ablations to attribute the lift.
//
// The runner's job is to:
//   1. Take a (TestNote, PromptClass, Condition) tuple
//   2. Build the system + user message Claude will receive
//   3. Execute against Claude
//   4. Pass the response to the judge
//
// Conditions only differ in HOW the note's content is presented to Claude.
// The note itself (body, frontmatter, written_at, voice, basis) is the
// same across conditions — what changes is what signal Claude sees about
// the note's provenance.

import type { BlameSegment } from "../../src/blame.js";
import { PERISHABLE_READ_DIRECTIVE } from "../../src/blame.js";
import type { PreparedNote } from "./setup-vault.js";

export type ConditionId = "A" | "B" | "C" | "D" | "E";

export interface ConditionSpec {
  id: ConditionId;
  label: string;
  /** Description for the eval report. */
  description: string;
  /** Build the get-tool-style response shape Claude will see. */
  shapeResponse: (note: PreparedNote, blame: BlameSegment[]) => Record<string, unknown>;
  /** System-prompt addition (e.g., the read-site directive). Empty string for none. */
  systemAddendum: string;
}

const baseResponse = (note: PreparedNote): Record<string, unknown> => ({
  path: note.test.path,
  frontmatter: parseFrontmatter(note.test.frontmatter),
  content: note.test.body,
  source_hash: note.source_hash,
  content_hash: note.source_hash,
});

function parseFrontmatter(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of raw.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2];
  }
  return out;
}

const hasPerishable = (blame: BlameSegment[]): boolean =>
  blame.some((s) => s.voice === "perishable");

export const CONDITIONS: ConditionSpec[] = [
  {
    id: "A",
    label: "control: no provenance",
    description:
      "Pre-rollout shape: just frontmatter + content + content_hash. No provenance signal anywhere. Baseline for measuring lift.",
    shapeResponse: (note) => baseResponse(note),
    systemAddendum: "",
  },
  {
    id: "B",
    label: "frontmatter only",
    description:
      "Earlier v2 design: provenance encoded as a YAML block in the frontmatter. Tests whether buried-in-prose signal is enough to change behavior.",
    shapeResponse: (note) => {
      const provInFrontmatter = {
        ...parseFrontmatter(note.test.frontmatter),
        provenance: {
          voice: note.test.voice,
          by: note.test.by,
          written_at: note.test.written_at,
          ...(note.test.basis && { basis: note.test.basis }),
          ...(note.test.reason && { reason: note.test.reason }),
        },
      };
      return {
        path: note.test.path,
        frontmatter: provInFrontmatter,
        content: note.test.body,
        source_hash: note.source_hash,
        content_hash: note.source_hash,
      };
    },
    systemAddendum: "",
  },
  {
    id: "C",
    label: "envelope only (no directive)",
    description:
      "Provenance lifted to the response envelope (provenance_blame, has_perishable_segments) but no tool-description directive instructing Claude how to use it.",
    shapeResponse: (note, blame) => {
      const r = baseResponse(note);
      r.provenance_blame = blame;
      if (hasPerishable(blame)) r.has_perishable_segments = true;
      return r;
    },
    systemAddendum: "",
  },
  {
    id: "D",
    label: "envelope + directive (the full mechanism)",
    description:
      "v3 design: provenance in envelope + per-call usage_directive when perishable + tool-description directive in system prompt. The hypothesis-A condition.",
    shapeResponse: (note, blame) => {
      const r = baseResponse(note);
      r.provenance_blame = blame;
      if (hasPerishable(blame)) {
        r.has_perishable_segments = true;
        r.usage_directive = PERISHABLE_READ_DIRECTIVE;
      }
      return r;
    },
    systemAddendum: PERISHABLE_READ_DIRECTIVE,
  },
  {
    id: "E",
    label: "asymmetric labeling (only perishable surfaces)",
    description:
      "Same as D, but durable segments are not labeled at all in the response — only perishable triggers extra fields. Tests whether dropping the noise on durable improves false-positive rate.",
    shapeResponse: (note, blame) => {
      const r = baseResponse(note);
      if (hasPerishable(blame)) {
        r.provenance_blame = blame.filter((s) => s.voice === "perishable");
        r.has_perishable_segments = true;
        r.usage_directive = PERISHABLE_READ_DIRECTIVE;
      }
      return r;
    },
    systemAddendum: PERISHABLE_READ_DIRECTIVE,
  },
];

// Frozen test set for the search-quality eval.
//
// Two fixture domains:
//
// 1. CANDIDATE_FIXTURES — synthetic BM25 / vector / title candidate lists per
//    query, with a per-candidate (voice, written_at) tuple. The ranking-unit
//    layer feeds these straight into rrfFuse + the new reweight code and
//    checks ordering. No QMD, no vault, no embeddings.
//
// 2. VAULT_NOTES — a small set of synthetic notes that get materialized into
//    a tmp git vault (with real Provenance-* trailers via composeCommitMessage)
//    so the end-to-end layer can measure latency + envelope completeness on a
//    real read path with blame lookup.
//
// Frozen 2026-05-09 alongside the GOAL.md Search Quality component.
// Bump SCHEMA_VERSION when changing structure so historical runs compare.

import type { Voice } from "../../src/provenance.js";

export const SCHEMA_VERSION = 1;

// ── Layer 1: Candidate fixtures (PPR / RPR-p / RI-d) ──────────────────

/** One candidate result as it would come out of BM25 / vector / title. */
export interface FixtureCandidate {
  title: string;
  vault_path: string;
  /** Score from the producing backend. Used by rrfFuse via rank order. */
  score: number;
  /** Note-level voice (modal across blame segments in real life). */
  voice: Voice;
  /** Note-level written_at (most recent in real life). */
  written_at: string;
  /** Snippet kept short — irrelevant to scoring, here for envelope checks. */
  snippet: string;
}

/** A query plus the per-backend candidate lists and the expected outcome. */
export interface CandidateFixture {
  /** Stable id for cross-run diffing. */
  id: string;
  /** Which property this fixture exercises. */
  kind: "ppr" | "rpr-perishable" | "ri-durable";
  query: string;
  /** Candidates per backend. Order = score order out of that backend. */
  bm25: FixtureCandidate[];
  vector: FixtureCandidate[];
  title: FixtureCandidate[];
  /**
   * Expected top-1 vault_path after fusion + reweight.
   * For PPR: the durable note. For RPR-p: the more-recent perishable.
   * For RI-d: the more-relevant durable (regardless of age).
   */
  expected_top: string;
  /**
   * Loser path — the note we expect NOT to take rank 1 even though it
   * appears as a candidate. Asserts the reweighting is doing real work.
   */
  loser: string;
  notes?: string;
}

/**
 * Helper for fixture authoring. Builds a candidate inline.
 * Default snippet keeps the JSON small.
 */
function c(
  title: string,
  vault_path: string,
  score: number,
  voice: Voice,
  written_at: string,
  snippet = "",
): FixtureCandidate {
  return { title, vault_path, score, voice, written_at, snippet: snippet || `(${title})` };
}

// ── PPR: durable should outrank perishable when both legitimately match ──
//
// 12 fixtures. Each has a durable canonical note + a perishable AI synthesis
// on the same topic, both appearing as candidates with comparable backend
// scores. Without provenance reweight, fusion would be roughly tied or
// slightly favor whichever has higher raw score. With reweight, durable wins.

const PPR_FIXTURES: CandidateFixture[] = [
  {
    id: "ppr-001-parametric-design",
    kind: "ppr",
    query: "parametric design philosophy",
    bm25: [
      c("Parametric Design", "Resources/Concepts/parametric-design.md", 0.82, "durable", "2024-03-12T00:00:00Z"),
      c("Parametric Design (Claude summary)", "Inbox/2026-04-claude-parametric-design.md", 0.79, "perishable", "2026-04-22T15:10:00Z"),
    ],
    vector: [
      c("Parametric Design (Claude summary)", "Inbox/2026-04-claude-parametric-design.md", 0.71, "perishable", "2026-04-22T15:10:00Z"),
      c("Parametric Design", "Resources/Concepts/parametric-design.md", 0.69, "durable", "2024-03-12T00:00:00Z"),
    ],
    title: [
      c("Parametric Design", "Resources/Concepts/parametric-design.md", 20, "durable", "2024-03-12T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/parametric-design.md",
    loser: "Inbox/2026-04-claude-parametric-design.md",
    notes: "John has held this thesis since UCLA; the AI summary is a moment-in-time restatement.",
  },
  {
    id: "ppr-002-taste-graph",
    kind: "ppr",
    query: "taste graph thesis",
    bm25: [
      c("Taste Graphs (synth)", "Inbox/2026-03-taste-graphs-synth.md", 0.84, "perishable", "2026-03-08T11:00:00Z"),
      c("Taste Graphs", "Resources/Concepts/taste-graphs.md", 0.80, "durable", "2023-11-04T00:00:00Z"),
    ],
    vector: [
      c("Taste Graphs", "Resources/Concepts/taste-graphs.md", 0.74, "durable", "2023-11-04T00:00:00Z"),
      c("Taste Graphs (synth)", "Inbox/2026-03-taste-graphs-synth.md", 0.73, "perishable", "2026-03-08T11:00:00Z"),
    ],
    title: [
      c("Taste Graphs", "Resources/Concepts/taste-graphs.md", 20, "durable", "2023-11-04T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/taste-graphs.md",
    loser: "Inbox/2026-03-taste-graphs-synth.md",
  },
  {
    id: "ppr-003-attachment-theory",
    kind: "ppr",
    query: "attachment theory bids for connection",
    bm25: [
      c("Attachment Theory", "Resources/Concepts/attachment-theory.md", 0.78, "durable", "2024-09-01T00:00:00Z"),
      c("Attachment Theory (notes)", "Inbox/2026-02-attachment-claude.md", 0.76, "perishable", "2026-02-18T20:30:00Z"),
    ],
    vector: [
      c("Attachment Theory (notes)", "Inbox/2026-02-attachment-claude.md", 0.69, "perishable", "2026-02-18T20:30:00Z"),
      c("Attachment Theory", "Resources/Concepts/attachment-theory.md", 0.66, "durable", "2024-09-01T00:00:00Z"),
    ],
    title: [
      c("Attachment Theory", "Resources/Concepts/attachment-theory.md", 20, "durable", "2024-09-01T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/attachment-theory.md",
    loser: "Inbox/2026-02-attachment-claude.md",
  },
  {
    id: "ppr-004-agent-memory",
    kind: "ppr",
    query: "agent memory and context windows",
    bm25: [
      c("AI Agent Memory & Context (synth)", "Inbox/2026-04-agent-memory-synth.md", 0.86, "perishable", "2026-04-30T14:00:00Z"),
      c("AI Agent Memory & Context", "Resources/Concepts/ai-agent-memory-and-context.md", 0.81, "durable", "2025-12-01T00:00:00Z"),
    ],
    vector: [
      c("AI Agent Memory & Context", "Resources/Concepts/ai-agent-memory-and-context.md", 0.77, "durable", "2025-12-01T00:00:00Z"),
      c("AI Agent Memory & Context (synth)", "Inbox/2026-04-agent-memory-synth.md", 0.76, "perishable", "2026-04-30T14:00:00Z"),
    ],
    title: [
      c("AI Agent Memory & Context", "Resources/Concepts/ai-agent-memory-and-context.md", 20, "durable", "2025-12-01T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/ai-agent-memory-and-context.md",
    loser: "Inbox/2026-04-agent-memory-synth.md",
  },
  {
    id: "ppr-005-conviction-leave",
    kind: "ppr",
    query: "conviction then leave decision pattern",
    bm25: [
      c("Conviction Then Leave Pattern (Claude)", "Resources/Concepts/conviction-then-leave-pattern.md", 0.88, "perishable", "2026-04-30T22:15:00Z"),
      c("Career Decisions Framework", "Resources/Concepts/career-decisions-framework.md", 0.74, "durable", "2024-07-22T00:00:00Z"),
    ],
    vector: [
      c("Career Decisions Framework", "Resources/Concepts/career-decisions-framework.md", 0.68, "durable", "2024-07-22T00:00:00Z"),
      c("Conviction Then Leave Pattern (Claude)", "Resources/Concepts/conviction-then-leave-pattern.md", 0.65, "perishable", "2026-04-30T22:15:00Z"),
    ],
    title: [],
    expected_top: "Resources/Concepts/career-decisions-framework.md",
    loser: "Resources/Concepts/conviction-then-leave-pattern.md",
    notes: "The contamination case from Phase A — perishable masquerading as durable in Resources/Concepts.",
  },
  {
    id: "ppr-006-recruiter-signals",
    kind: "ppr",
    query: "interpreting recruiter silence",
    bm25: [
      c("Reading Recruiter Signals (claude)", "Resources/Concepts/reading-recruiter-signals.md", 0.90, "perishable", "2026-04-29T18:00:00Z"),
      c("Hiring & Recruiting Notes", "Resources/Concepts/hiring-and-recruiting.md", 0.71, "durable", "2024-02-18T00:00:00Z"),
    ],
    vector: [
      c("Hiring & Recruiting Notes", "Resources/Concepts/hiring-and-recruiting.md", 0.66, "durable", "2024-02-18T00:00:00Z"),
      c("Reading Recruiter Signals (claude)", "Resources/Concepts/reading-recruiter-signals.md", 0.62, "perishable", "2026-04-29T18:00:00Z"),
    ],
    title: [],
    expected_top: "Resources/Concepts/hiring-and-recruiting.md",
    loser: "Resources/Concepts/reading-recruiter-signals.md",
  },
  {
    id: "ppr-007-design-systems",
    kind: "ppr",
    query: "brand systems and design tokens",
    bm25: [
      c("Brand Systems", "Resources/Concepts/brand-systems.md", 0.80, "durable", "2023-06-15T00:00:00Z"),
      c("Brand Systems (Claude restatement)", "Inbox/2026-01-brand-systems-claude.md", 0.78, "perishable", "2026-01-12T09:00:00Z"),
    ],
    vector: [
      c("Brand Systems (Claude restatement)", "Inbox/2026-01-brand-systems-claude.md", 0.70, "perishable", "2026-01-12T09:00:00Z"),
      c("Brand Systems", "Resources/Concepts/brand-systems.md", 0.68, "durable", "2023-06-15T00:00:00Z"),
    ],
    title: [
      c("Brand Systems", "Resources/Concepts/brand-systems.md", 20, "durable", "2023-06-15T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/brand-systems.md",
    loser: "Inbox/2026-01-brand-systems-claude.md",
  },
  {
    id: "ppr-008-bootstrapped-growth",
    kind: "ppr",
    query: "bootstrapped growth strategy",
    bm25: [
      c("Bootstrapped Growth", "Resources/Concepts/bootstrapped-growth.md", 0.79, "durable", "2024-04-10T00:00:00Z"),
      c("Bootstrapped Growth (synth)", "Inbox/2026-03-bootstrapped-claude.md", 0.77, "perishable", "2026-03-21T12:00:00Z"),
    ],
    vector: [
      c("Bootstrapped Growth (synth)", "Inbox/2026-03-bootstrapped-claude.md", 0.72, "perishable", "2026-03-21T12:00:00Z"),
      c("Bootstrapped Growth", "Resources/Concepts/bootstrapped-growth.md", 0.70, "durable", "2024-04-10T00:00:00Z"),
    ],
    title: [
      c("Bootstrapped Growth", "Resources/Concepts/bootstrapped-growth.md", 20, "durable", "2024-04-10T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/bootstrapped-growth.md",
    loser: "Inbox/2026-03-bootstrapped-claude.md",
  },
  {
    id: "ppr-009-mcp-protocol",
    kind: "ppr",
    query: "MCP model context protocol overview",
    bm25: [
      c("MCP (Model Context Protocol)", "Resources/Concepts/mcp.md", 0.83, "durable", "2025-08-11T00:00:00Z"),
      c("MCP Notes (Claude)", "Inbox/2026-04-mcp-claude-notes.md", 0.81, "perishable", "2026-04-15T16:00:00Z"),
    ],
    vector: [
      c("MCP Notes (Claude)", "Inbox/2026-04-mcp-claude-notes.md", 0.74, "perishable", "2026-04-15T16:00:00Z"),
      c("MCP (Model Context Protocol)", "Resources/Concepts/mcp.md", 0.71, "durable", "2025-08-11T00:00:00Z"),
    ],
    title: [
      c("MCP (Model Context Protocol)", "Resources/Concepts/mcp.md", 20, "durable", "2025-08-11T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/mcp.md",
    loser: "Inbox/2026-04-mcp-claude-notes.md",
  },
  {
    id: "ppr-010-anxiety-management",
    kind: "ppr",
    query: "managing anxiety and fear",
    bm25: [
      c("Anxiety & Fear Management", "Resources/Concepts/anxiety-fear-management.md", 0.81, "durable", "2024-11-30T00:00:00Z"),
      c("Anxiety Notes (Claude session)", "Inbox/2026-02-anxiety-claude.md", 0.79, "perishable", "2026-02-04T19:00:00Z"),
    ],
    vector: [
      c("Anxiety Notes (Claude session)", "Inbox/2026-02-anxiety-claude.md", 0.71, "perishable", "2026-02-04T19:00:00Z"),
      c("Anxiety & Fear Management", "Resources/Concepts/anxiety-fear-management.md", 0.70, "durable", "2024-11-30T00:00:00Z"),
    ],
    title: [
      c("Anxiety & Fear Management", "Resources/Concepts/anxiety-fear-management.md", 20, "durable", "2024-11-30T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/anxiety-fear-management.md",
    loser: "Inbox/2026-02-anxiety-claude.md",
  },
  {
    id: "ppr-011-fire-math",
    kind: "ppr",
    query: "FIRE 4 percent rule retirement math",
    bm25: [
      c("4% Rule & 25x Multiple", "Resources/Concepts/4-percent-rule.md", 0.85, "durable", "2024-01-22T00:00:00Z"),
      c("FIRE Math Quick Notes (Claude)", "Inbox/2026-04-fire-claude.md", 0.78, "perishable", "2026-04-09T08:30:00Z"),
    ],
    vector: [
      c("FIRE Math Quick Notes (Claude)", "Inbox/2026-04-fire-claude.md", 0.69, "perishable", "2026-04-09T08:30:00Z"),
      c("4% Rule & 25x Multiple", "Resources/Concepts/4-percent-rule.md", 0.67, "durable", "2024-01-22T00:00:00Z"),
    ],
    title: [
      c("4% Rule & 25x Multiple", "Resources/Concepts/4-percent-rule.md", 20, "durable", "2024-01-22T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/4-percent-rule.md",
    loser: "Inbox/2026-04-fire-claude.md",
  },
  {
    id: "ppr-012-coding-agents",
    kind: "ppr",
    query: "AI coding agents and tools landscape",
    bm25: [
      c("AI Coding Agents", "Resources/Concepts/ai-coding-agents.md", 0.84, "durable", "2025-09-15T00:00:00Z"),
      c("Coding Agents Survey (Claude)", "Inbox/2026-04-coding-agents-survey.md", 0.83, "perishable", "2026-04-25T13:00:00Z"),
    ],
    vector: [
      c("Coding Agents Survey (Claude)", "Inbox/2026-04-coding-agents-survey.md", 0.76, "perishable", "2026-04-25T13:00:00Z"),
      c("AI Coding Agents", "Resources/Concepts/ai-coding-agents.md", 0.73, "durable", "2025-09-15T00:00:00Z"),
    ],
    title: [
      c("AI Coding Agents", "Resources/Concepts/ai-coding-agents.md", 20, "durable", "2025-09-15T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/ai-coding-agents.md",
    loser: "Inbox/2026-04-coding-agents-survey.md",
  },
];

// ── RPR-perishable: among perishable matches, recent should outrank stale ──
//
// 8 fixtures. Both candidates are perishable; only difference is written_at.
// Without age decay, ordering is determined by raw score. With age decay,
// the recent perishable wins even when raw score slightly favors the stale.

const RPR_PERISHABLE_FIXTURES: CandidateFixture[] = [
  {
    id: "rpr-p-001-claude-models",
    kind: "rpr-perishable",
    query: "current state of Claude model family",
    bm25: [
      c("Claude Models (old summary)", "Inbox/2025-08-claude-models-summary.md", 0.84, "perishable", "2025-08-01T00:00:00Z"),
      c("Claude Models (recent)", "Inbox/2026-05-claude-models-summary.md", 0.82, "perishable", "2026-05-02T00:00:00Z"),
    ],
    vector: [
      c("Claude Models (recent)", "Inbox/2026-05-claude-models-summary.md", 0.76, "perishable", "2026-05-02T00:00:00Z"),
      c("Claude Models (old summary)", "Inbox/2025-08-claude-models-summary.md", 0.74, "perishable", "2025-08-01T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-claude-models-summary.md",
    loser: "Inbox/2025-08-claude-models-summary.md",
    notes: "Stale perishable about Claude models is actively wrong. Recent perishable should win.",
  },
  {
    id: "rpr-p-002-recruiter-state",
    kind: "rpr-perishable",
    query: "where am I in recruiter conversations",
    bm25: [
      c("Recruiter Status (Feb)", "Inbox/2026-02-recruiter-status.md", 0.88, "perishable", "2026-02-15T00:00:00Z"),
      c("Recruiter Status (May)", "Inbox/2026-05-recruiter-status.md", 0.85, "perishable", "2026-05-05T00:00:00Z"),
    ],
    vector: [
      c("Recruiter Status (May)", "Inbox/2026-05-recruiter-status.md", 0.79, "perishable", "2026-05-05T00:00:00Z"),
      c("Recruiter Status (Feb)", "Inbox/2026-02-recruiter-status.md", 0.77, "perishable", "2026-02-15T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-recruiter-status.md",
    loser: "Inbox/2026-02-recruiter-status.md",
  },
  {
    id: "rpr-p-003-grove-roadmap",
    kind: "rpr-perishable",
    query: "Grove roadmap status",
    bm25: [
      c("Grove Roadmap (Mar)", "Inbox/2026-03-grove-roadmap.md", 0.82, "perishable", "2026-03-10T00:00:00Z"),
      c("Grove Roadmap (May)", "Inbox/2026-05-grove-roadmap.md", 0.81, "perishable", "2026-05-07T00:00:00Z"),
    ],
    vector: [
      c("Grove Roadmap (May)", "Inbox/2026-05-grove-roadmap.md", 0.74, "perishable", "2026-05-07T00:00:00Z"),
      c("Grove Roadmap (Mar)", "Inbox/2026-03-grove-roadmap.md", 0.72, "perishable", "2026-03-10T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-grove-roadmap.md",
    loser: "Inbox/2026-03-grove-roadmap.md",
  },
  {
    id: "rpr-p-004-vault-stats",
    kind: "rpr-perishable",
    query: "current vault size and counts",
    bm25: [
      c("Vault Stats (Jan)", "Inbox/2026-01-vault-stats.md", 0.86, "perishable", "2026-01-04T00:00:00Z"),
      c("Vault Stats (Apr)", "Inbox/2026-04-vault-stats.md", 0.85, "perishable", "2026-04-30T00:00:00Z"),
    ],
    vector: [
      c("Vault Stats (Apr)", "Inbox/2026-04-vault-stats.md", 0.77, "perishable", "2026-04-30T00:00:00Z"),
      c("Vault Stats (Jan)", "Inbox/2026-01-vault-stats.md", 0.75, "perishable", "2026-01-04T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-04-vault-stats.md",
    loser: "Inbox/2026-01-vault-stats.md",
  },
  {
    id: "rpr-p-005-canva-priorities",
    kind: "rpr-perishable",
    query: "Canva team priorities right now",
    bm25: [
      c("Canva Priorities (Feb)", "Inbox/2026-02-canva-priorities.md", 0.83, "perishable", "2026-02-12T00:00:00Z"),
      c("Canva Priorities (May)", "Inbox/2026-05-canva-priorities.md", 0.82, "perishable", "2026-05-01T00:00:00Z"),
    ],
    vector: [
      c("Canva Priorities (May)", "Inbox/2026-05-canva-priorities.md", 0.74, "perishable", "2026-05-01T00:00:00Z"),
      c("Canva Priorities (Feb)", "Inbox/2026-02-canva-priorities.md", 0.72, "perishable", "2026-02-12T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-canva-priorities.md",
    loser: "Inbox/2026-02-canva-priorities.md",
  },
  {
    id: "rpr-p-006-llm-providers",
    kind: "rpr-perishable",
    query: "comparison of LLM providers",
    bm25: [
      c("LLM Providers (Q3 2025)", "Inbox/2025-09-llm-providers.md", 0.88, "perishable", "2025-09-15T00:00:00Z"),
      c("LLM Providers (Q2 2026)", "Inbox/2026-04-llm-providers.md", 0.86, "perishable", "2026-04-12T00:00:00Z"),
    ],
    vector: [
      c("LLM Providers (Q2 2026)", "Inbox/2026-04-llm-providers.md", 0.78, "perishable", "2026-04-12T00:00:00Z"),
      c("LLM Providers (Q3 2025)", "Inbox/2025-09-llm-providers.md", 0.76, "perishable", "2025-09-15T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-04-llm-providers.md",
    loser: "Inbox/2025-09-llm-providers.md",
  },
  {
    id: "rpr-p-007-job-loops",
    kind: "rpr-perishable",
    query: "interview loop debriefs",
    bm25: [
      c("Loop Debrief (Mar)", "Inbox/2026-03-loop-debrief.md", 0.84, "perishable", "2026-03-22T00:00:00Z"),
      c("Loop Debrief (May)", "Inbox/2026-05-loop-debrief.md", 0.82, "perishable", "2026-05-04T00:00:00Z"),
    ],
    vector: [
      c("Loop Debrief (May)", "Inbox/2026-05-loop-debrief.md", 0.76, "perishable", "2026-05-04T00:00:00Z"),
      c("Loop Debrief (Mar)", "Inbox/2026-03-loop-debrief.md", 0.74, "perishable", "2026-03-22T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-loop-debrief.md",
    loser: "Inbox/2026-03-loop-debrief.md",
  },
  {
    id: "rpr-p-008-canva-orgchart",
    kind: "rpr-perishable",
    query: "Canva engineering org chart",
    bm25: [
      c("Canva Org (Q4 2025)", "Inbox/2025-11-canva-org.md", 0.85, "perishable", "2025-11-08T00:00:00Z"),
      c("Canva Org (Q2 2026)", "Inbox/2026-04-canva-org.md", 0.83, "perishable", "2026-04-19T00:00:00Z"),
    ],
    vector: [
      c("Canva Org (Q2 2026)", "Inbox/2026-04-canva-org.md", 0.75, "perishable", "2026-04-19T00:00:00Z"),
      c("Canva Org (Q4 2025)", "Inbox/2025-11-canva-org.md", 0.73, "perishable", "2025-11-08T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-04-canva-org.md",
    loser: "Inbox/2025-11-canva-org.md",
  },
];

// ── RI-durable: among durable matches, age should NOT determine order ──
//
// 8 fixtures. Both candidates are durable; one is meaningfully more relevant
// to the query than the other (higher backend scores). Some have a big age
// gap. The reweighting code MUST NOT decay the older durable enough to swap
// the relevance order. Critical: this is the "John's 2023 thesis is still
// John's thesis" case.

const RI_DURABLE_FIXTURES: CandidateFixture[] = [
  {
    id: "ri-d-001-parametric-vs-design-automation",
    kind: "ri-durable",
    query: "parametric design philosophy core thesis",
    bm25: [
      c("Parametric Design", "Resources/Concepts/parametric-design.md", 0.88, "durable", "2023-04-12T00:00:00Z"),
      c("Design Automation", "Resources/Concepts/design-automation.md", 0.62, "durable", "2026-04-01T00:00:00Z"),
    ],
    vector: [
      c("Parametric Design", "Resources/Concepts/parametric-design.md", 0.79, "durable", "2023-04-12T00:00:00Z"),
      c("Design Automation", "Resources/Concepts/design-automation.md", 0.61, "durable", "2026-04-01T00:00:00Z"),
    ],
    title: [
      c("Parametric Design", "Resources/Concepts/parametric-design.md", 20, "durable", "2023-04-12T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/parametric-design.md",
    loser: "Resources/Concepts/design-automation.md",
    notes: "Old durable with strong relevance must not lose to newer durable that's only adjacent.",
  },
  {
    id: "ri-d-002-taste-graphs-vs-recsys",
    kind: "ri-durable",
    query: "taste graphs personal preference learning",
    bm25: [
      c("Taste Graphs", "Resources/Concepts/taste-graphs.md", 0.86, "durable", "2023-11-04T00:00:00Z"),
      c("Recommender Systems", "Resources/Concepts/recsys.md", 0.66, "durable", "2026-02-10T00:00:00Z"),
    ],
    vector: [
      c("Taste Graphs", "Resources/Concepts/taste-graphs.md", 0.78, "durable", "2023-11-04T00:00:00Z"),
      c("Recommender Systems", "Resources/Concepts/recsys.md", 0.64, "durable", "2026-02-10T00:00:00Z"),
    ],
    title: [
      c("Taste Graphs", "Resources/Concepts/taste-graphs.md", 20, "durable", "2023-11-04T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/taste-graphs.md",
    loser: "Resources/Concepts/recsys.md",
  },
  {
    id: "ri-d-003-brand-vs-design-tokens",
    kind: "ri-durable",
    query: "brand systems philosophy",
    bm25: [
      c("Brand Systems", "Resources/Concepts/brand-systems.md", 0.84, "durable", "2023-06-15T00:00:00Z"),
      c("Design Tokens", "Resources/Concepts/design-tokens.md", 0.65, "durable", "2026-03-22T00:00:00Z"),
    ],
    vector: [
      c("Brand Systems", "Resources/Concepts/brand-systems.md", 0.76, "durable", "2023-06-15T00:00:00Z"),
      c("Design Tokens", "Resources/Concepts/design-tokens.md", 0.63, "durable", "2026-03-22T00:00:00Z"),
    ],
    title: [
      c("Brand Systems", "Resources/Concepts/brand-systems.md", 20, "durable", "2023-06-15T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/brand-systems.md",
    loser: "Resources/Concepts/design-tokens.md",
  },
  {
    id: "ri-d-004-attachment-vs-emotional-reg",
    kind: "ri-durable",
    query: "attachment theory bids and connection",
    bm25: [
      c("Attachment Theory", "Resources/Concepts/attachment-theory.md", 0.85, "durable", "2024-09-01T00:00:00Z"),
      c("Emotional Regulation", "Resources/Concepts/emotional-regulation.md", 0.66, "durable", "2026-04-04T00:00:00Z"),
    ],
    vector: [
      c("Attachment Theory", "Resources/Concepts/attachment-theory.md", 0.77, "durable", "2024-09-01T00:00:00Z"),
      c("Emotional Regulation", "Resources/Concepts/emotional-regulation.md", 0.64, "durable", "2026-04-04T00:00:00Z"),
    ],
    title: [
      c("Attachment Theory", "Resources/Concepts/attachment-theory.md", 20, "durable", "2024-09-01T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/attachment-theory.md",
    loser: "Resources/Concepts/emotional-regulation.md",
  },
  {
    id: "ri-d-005-fire-vs-financial-planning",
    kind: "ri-durable",
    query: "FIRE 4 percent rule retirement math",
    bm25: [
      c("4% Rule & 25x Multiple", "Resources/Concepts/4-percent-rule.md", 0.87, "durable", "2024-01-22T00:00:00Z"),
      c("Financial Planning", "Resources/Concepts/financial-planning.md", 0.65, "durable", "2026-03-30T00:00:00Z"),
    ],
    vector: [
      c("4% Rule & 25x Multiple", "Resources/Concepts/4-percent-rule.md", 0.78, "durable", "2024-01-22T00:00:00Z"),
      c("Financial Planning", "Resources/Concepts/financial-planning.md", 0.63, "durable", "2026-03-30T00:00:00Z"),
    ],
    title: [
      c("4% Rule & 25x Multiple", "Resources/Concepts/4-percent-rule.md", 20, "durable", "2024-01-22T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/4-percent-rule.md",
    loser: "Resources/Concepts/financial-planning.md",
  },
  {
    id: "ri-d-006-mcp-vs-tool-use",
    kind: "ri-durable",
    query: "MCP model context protocol",
    bm25: [
      c("MCP (Model Context Protocol)", "Resources/Concepts/mcp.md", 0.86, "durable", "2025-08-11T00:00:00Z"),
      c("Tool Use Patterns", "Resources/Concepts/tool-use.md", 0.67, "durable", "2026-04-20T00:00:00Z"),
    ],
    vector: [
      c("MCP (Model Context Protocol)", "Resources/Concepts/mcp.md", 0.78, "durable", "2025-08-11T00:00:00Z"),
      c("Tool Use Patterns", "Resources/Concepts/tool-use.md", 0.65, "durable", "2026-04-20T00:00:00Z"),
    ],
    title: [
      c("MCP (Model Context Protocol)", "Resources/Concepts/mcp.md", 20, "durable", "2025-08-11T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/mcp.md",
    loser: "Resources/Concepts/tool-use.md",
  },
  {
    id: "ri-d-007-bootstrap-vs-growth",
    kind: "ri-durable",
    query: "bootstrapped growth strategy",
    bm25: [
      c("Bootstrapped Growth", "Resources/Concepts/bootstrapped-growth.md", 0.84, "durable", "2024-04-10T00:00:00Z"),
      c("Growth Strategy", "Resources/Concepts/growth-strategy.md", 0.66, "durable", "2026-03-15T00:00:00Z"),
    ],
    vector: [
      c("Bootstrapped Growth", "Resources/Concepts/bootstrapped-growth.md", 0.76, "durable", "2024-04-10T00:00:00Z"),
      c("Growth Strategy", "Resources/Concepts/growth-strategy.md", 0.64, "durable", "2026-03-15T00:00:00Z"),
    ],
    title: [
      c("Bootstrapped Growth", "Resources/Concepts/bootstrapped-growth.md", 20, "durable", "2024-04-10T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/bootstrapped-growth.md",
    loser: "Resources/Concepts/growth-strategy.md",
  },
  {
    id: "ri-d-008-anxiety-vs-meditation",
    kind: "ri-durable",
    query: "managing anxiety daily techniques",
    bm25: [
      c("Anxiety & Fear Management", "Resources/Concepts/anxiety-fear-management.md", 0.85, "durable", "2024-11-30T00:00:00Z"),
      c("Meditation & Mindfulness", "Resources/Concepts/meditation-mindfulness.md", 0.66, "durable", "2026-02-28T00:00:00Z"),
    ],
    vector: [
      c("Anxiety & Fear Management", "Resources/Concepts/anxiety-fear-management.md", 0.77, "durable", "2024-11-30T00:00:00Z"),
      c("Meditation & Mindfulness", "Resources/Concepts/meditation-mindfulness.md", 0.64, "durable", "2026-02-28T00:00:00Z"),
    ],
    title: [
      c("Anxiety & Fear Management", "Resources/Concepts/anxiety-fear-management.md", 20, "durable", "2024-11-30T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/anxiety-fear-management.md",
    loser: "Resources/Concepts/meditation-mindfulness.md",
  },
];

export const CANDIDATE_FIXTURES: CandidateFixture[] = [
  ...PPR_FIXTURES,
  ...RPR_PERISHABLE_FIXTURES,
  ...RI_DURABLE_FIXTURES,
];

// ── Layer 3: Vault notes (E2E latency + envelope) ──────────────────────
//
// 6 notes — small enough that materialization + blame computation finish in
// ~5s, large enough that hybridSearch returns ≥3 results with a mix of
// voices. Materialized into a tmp git vault by setup-vault.ts.

export interface VaultTestNote {
  path: string;
  frontmatter: string;
  body: string;
  voice: Voice;
  written_at: string;
  by: string;
  basis?: string[];
  reason?: string;
}

export const VAULT_NOTES: VaultTestNote[] = [
  {
    path: "Resources/Concepts/parametric-design.md",
    frontmatter: "type: concept\ntags: [design, parametric, ucla, thesis]",
    body: "# Parametric Design\n\nA design philosophy where artifacts are described as systems of constraints and parameters rather than fixed forms. The output is the resolution of the system at given parameter values; the artifact is the system itself.",
    voice: "durable",
    written_at: "2024-03-12T00:00:00Z",
    by: "human",
  },
  {
    path: "Inbox/2026-04-claude-parametric-design.md",
    frontmatter: "type: synthesis\ntags: [design, parametric, claude-summary]",
    body: "# Parametric Design (Claude summary)\n\nClaude's summary of the parametric design conversation on 2026-04-22. May or may not match John's actual thesis.",
    voice: "perishable",
    written_at: "2026-04-22T15:10:00Z",
    by: "claude-opus-4-6",
    reason: "moment-in-time conversation summary; not John's primary statement",
    basis: ["Journal/2026/2026-04-22.md"],
  },
  {
    path: "Resources/Concepts/taste-graphs.md",
    frontmatter: "type: concept\ntags: [recsys, taste, pinterest]",
    body: "# Taste Graphs\n\nNetworks of personal preferences that resist single-axis ranking. Pinterest 2016 was the original prompt; the thesis remains: taste cannot be reduced to a scalar without losing the thing that made it taste.",
    voice: "durable",
    written_at: "2023-11-04T00:00:00Z",
    by: "human",
  },
  {
    path: "Inbox/2026-05-claude-models-summary.md",
    frontmatter: "type: synthesis\ntags: [ai, claude, models]",
    body: "# Claude Models (May 2026 snapshot)\n\nOpus 4.7 (1M ctx), Sonnet 4.6, Haiku 4.5. As-of 2026-05-02. Will be wrong by Q3.",
    voice: "perishable",
    written_at: "2026-05-02T00:00:00Z",
    by: "claude-opus-4-7",
    reason: "snapshot of model lineup; expires fast",
  },
  {
    path: "Inbox/2025-08-claude-models-summary.md",
    frontmatter: "type: synthesis\ntags: [ai, claude, models, stale]",
    body: "# Claude Models (Aug 2025 snapshot)\n\nOpus 4.1, Sonnet 4.0, Haiku 3.5. Already wrong as of writing this comment.",
    voice: "perishable",
    written_at: "2025-08-01T00:00:00Z",
    by: "claude-opus-4-5",
    reason: "outdated model snapshot; kept for the eval, not for use",
  },
  {
    path: "Resources/Concepts/brand-systems.md",
    frontmatter: "type: concept\ntags: [design, brand, systems]",
    body: "# Brand Systems\n\nA brand is the rule, not the artifact. Design systems make the rule executable; brand systems make the rule meaningful.",
    voice: "durable",
    written_at: "2023-06-15T00:00:00Z",
    by: "human",
  },
];

/** Queries used by the E2E layer against the materialized vault. */
export const E2E_QUERIES: string[] = [
  "parametric design philosophy",
  "taste graphs",
  "current Claude model lineup",
  "brand systems and rules",
];

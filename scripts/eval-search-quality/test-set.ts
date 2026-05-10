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
  kind: "ppr" | "rpr-perishable" | "ri-durable" | "fir";
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

// ── Adversarial fixtures (V3 §F) ─────────────────────────────────────
//
// Five shapes × ~5 each. Authored to exercise the §A piecewise voice/age
// curve on cases where a single signal (voice OR age OR intent) must do
// the work without the others helping. Reference time is 2026-05-09T12:00Z.
//
// Naming: "adv-<shape-prefix>-NNN-<slug>".
//   op-nd  = old-perishable / new-durable cross
//   sa     = same-age cross (voice signal isolation)
//   sv-on  = same-voice old-vs-new (age signal isolation)
//   ic     = intent-conflicting (FIR override)

// Shape 1: 200-day-old perishable competes with 5-day-old durable on
// canonical concept queries. Decay-only (no voice factor) would actually
// rank durable above perishable too — because durable doesn't decay.
// What this set really tests: the voice-factor path doesn't NEED a
// `durable_factor > 1.0` for these cases to pass. Voice signal alone (with
// age decay applied to perishable per §A) is sufficient.
export const ADV_OLD_PERISHABLE_NEW_DURABLE: CandidateFixture[] = [
  {
    id: "adv-op-nd-001-parametric",
    kind: "ppr",
    query: "parametric design philosophy",
    bm25: [
      c("Parametric Design (old synth)", "Inbox/2025-10-parametric-claude.md", 0.83, "perishable", "2025-10-21T11:00:00Z"),
      c("Parametric Design", "Resources/Concepts/parametric-design.md", 0.79, "durable", "2026-05-04T00:00:00Z"),
    ],
    vector: [
      c("Parametric Design (old synth)", "Inbox/2025-10-parametric-claude.md", 0.74, "perishable", "2025-10-21T11:00:00Z"),
      c("Parametric Design", "Resources/Concepts/parametric-design.md", 0.71, "durable", "2026-05-04T00:00:00Z"),
    ],
    title: [
      c("Parametric Design", "Resources/Concepts/parametric-design.md", 20, "durable", "2026-05-04T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/parametric-design.md",
    loser: "Inbox/2025-10-parametric-claude.md",
    notes: "200d perishable vs 5d durable. Voice must beat the slight raw-score advantage of the perishable.",
  },
  {
    id: "adv-op-nd-002-taste-graphs",
    kind: "ppr",
    query: "taste graphs preference networks",
    bm25: [
      c("Taste Graphs (synth)", "Inbox/2025-10-taste-graphs-claude.md", 0.84, "perishable", "2025-10-21T16:00:00Z"),
      c("Taste Graphs", "Resources/Concepts/taste-graphs.md", 0.80, "durable", "2026-05-04T00:00:00Z"),
    ],
    vector: [
      c("Taste Graphs (synth)", "Inbox/2025-10-taste-graphs-claude.md", 0.73, "perishable", "2025-10-21T16:00:00Z"),
      c("Taste Graphs", "Resources/Concepts/taste-graphs.md", 0.70, "durable", "2026-05-04T00:00:00Z"),
    ],
    title: [
      c("Taste Graphs", "Resources/Concepts/taste-graphs.md", 20, "durable", "2026-05-04T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/taste-graphs.md",
    loser: "Inbox/2025-10-taste-graphs-claude.md",
    notes: "Old perishable Pinterest-era synth vs freshly-edited durable concept note.",
  },
  {
    id: "adv-op-nd-003-attachment",
    kind: "ppr",
    query: "attachment theory bids for connection",
    bm25: [
      c("Attachment Theory (synth)", "Inbox/2025-10-attachment-claude.md", 0.82, "perishable", "2025-10-21T09:00:00Z"),
      c("Attachment Theory", "Resources/Concepts/attachment-theory.md", 0.78, "durable", "2026-05-04T00:00:00Z"),
    ],
    vector: [
      c("Attachment Theory (synth)", "Inbox/2025-10-attachment-claude.md", 0.72, "perishable", "2025-10-21T09:00:00Z"),
      c("Attachment Theory", "Resources/Concepts/attachment-theory.md", 0.69, "durable", "2026-05-04T00:00:00Z"),
    ],
    title: [
      c("Attachment Theory", "Resources/Concepts/attachment-theory.md", 20, "durable", "2026-05-04T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/attachment-theory.md",
    loser: "Inbox/2025-10-attachment-claude.md",
  },
  {
    id: "adv-op-nd-004-agent-memory",
    kind: "ppr",
    query: "agent memory and context windows",
    bm25: [
      c("AI Agent Memory (synth)", "Inbox/2025-10-agent-memory-claude.md", 0.85, "perishable", "2025-10-21T13:30:00Z"),
      c("AI Agent Memory & Context", "Resources/Concepts/ai-agent-memory-and-context.md", 0.81, "durable", "2026-05-04T00:00:00Z"),
    ],
    vector: [
      c("AI Agent Memory (synth)", "Inbox/2025-10-agent-memory-claude.md", 0.75, "perishable", "2025-10-21T13:30:00Z"),
      c("AI Agent Memory & Context", "Resources/Concepts/ai-agent-memory-and-context.md", 0.72, "durable", "2026-05-04T00:00:00Z"),
    ],
    title: [
      c("AI Agent Memory & Context", "Resources/Concepts/ai-agent-memory-and-context.md", 20, "durable", "2026-05-04T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/ai-agent-memory-and-context.md",
    loser: "Inbox/2025-10-agent-memory-claude.md",
  },
  {
    id: "adv-op-nd-005-bootstrapped",
    kind: "ppr",
    query: "bootstrapped growth strategy",
    bm25: [
      c("Bootstrapped Growth (synth)", "Inbox/2025-10-bootstrapped-claude.md", 0.81, "perishable", "2025-10-21T20:00:00Z"),
      c("Bootstrapped Growth", "Resources/Concepts/bootstrapped-growth.md", 0.77, "durable", "2026-05-04T00:00:00Z"),
    ],
    vector: [
      c("Bootstrapped Growth (synth)", "Inbox/2025-10-bootstrapped-claude.md", 0.71, "perishable", "2025-10-21T20:00:00Z"),
      c("Bootstrapped Growth", "Resources/Concepts/bootstrapped-growth.md", 0.68, "durable", "2026-05-04T00:00:00Z"),
    ],
    title: [
      c("Bootstrapped Growth", "Resources/Concepts/bootstrapped-growth.md", 20, "durable", "2026-05-04T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/bootstrapped-growth.md",
    loser: "Inbox/2025-10-bootstrapped-claude.md",
  },
];

// Shape 2: same-age cross. Two notes within 24h on the same topic — one
// John's journal entry (durable), one Inbox AI synthesis (perishable).
// Identical or near-identical written_at. Pure voice signal isolation:
// age curve cancels out, raw scores are designed to slightly favor the
// perishable, so voice must do all the work.
export const ADV_SAME_AGE_CROSS: CandidateFixture[] = [
  {
    id: "adv-sa-001-bootstrapped",
    kind: "ppr",
    query: "bootstrapped growth playbook",
    bm25: [
      c("Bootstrapped Growth (Claude synth, 2026-05-08)", "Inbox/2026-05-08-bootstrapped-claude.md", 0.85, "perishable", "2026-05-08T14:00:00Z"),
      c("Journal 2026-05-08", "Journal/2026/2026-05-08.md", 0.81, "durable", "2026-05-08T22:00:00Z"),
    ],
    vector: [
      c("Bootstrapped Growth (Claude synth, 2026-05-08)", "Inbox/2026-05-08-bootstrapped-claude.md", 0.74, "perishable", "2026-05-08T14:00:00Z"),
      c("Journal 2026-05-08", "Journal/2026/2026-05-08.md", 0.71, "durable", "2026-05-08T22:00:00Z"),
    ],
    title: [],
    expected_top: "Journal/2026/2026-05-08.md",
    loser: "Inbox/2026-05-08-bootstrapped-claude.md",
    notes: "Same-day journal vs Claude synth on bootstrapped growth. Voice alone must flip the order.",
  },
  {
    id: "adv-sa-002-attachment",
    kind: "ppr",
    query: "attachment theory in conversation",
    bm25: [
      c("Attachment Theory (Claude session, 2026-05-07)", "Inbox/2026-05-07-attachment-claude.md", 0.86, "perishable", "2026-05-07T10:00:00Z"),
      c("Journal 2026-05-07", "Journal/2026/2026-05-07.md", 0.82, "durable", "2026-05-07T20:00:00Z"),
    ],
    vector: [
      c("Attachment Theory (Claude session, 2026-05-07)", "Inbox/2026-05-07-attachment-claude.md", 0.75, "perishable", "2026-05-07T10:00:00Z"),
      c("Journal 2026-05-07", "Journal/2026/2026-05-07.md", 0.72, "durable", "2026-05-07T20:00:00Z"),
    ],
    title: [],
    expected_top: "Journal/2026/2026-05-07.md",
    loser: "Inbox/2026-05-07-attachment-claude.md",
  },
  {
    id: "adv-sa-003-mcp",
    kind: "ppr",
    query: "MCP server architecture trade-offs",
    bm25: [
      c("MCP Notes (Claude, 2026-05-06)", "Inbox/2026-05-06-mcp-claude.md", 0.84, "perishable", "2026-05-06T09:00:00Z"),
      c("Journal 2026-05-06", "Journal/2026/2026-05-06.md", 0.80, "durable", "2026-05-06T18:00:00Z"),
    ],
    vector: [
      c("MCP Notes (Claude, 2026-05-06)", "Inbox/2026-05-06-mcp-claude.md", 0.73, "perishable", "2026-05-06T09:00:00Z"),
      c("Journal 2026-05-06", "Journal/2026/2026-05-06.md", 0.70, "durable", "2026-05-06T18:00:00Z"),
    ],
    title: [],
    expected_top: "Journal/2026/2026-05-06.md",
    loser: "Inbox/2026-05-06-mcp-claude.md",
  },
  {
    id: "adv-sa-004-recruiter",
    kind: "ppr",
    query: "recruiter conversation patterns",
    bm25: [
      c("Recruiter Patterns (Claude, 2026-05-05)", "Inbox/2026-05-05-recruiter-claude.md", 0.85, "perishable", "2026-05-05T11:00:00Z"),
      c("Journal 2026-05-05", "Journal/2026/2026-05-05.md", 0.81, "durable", "2026-05-05T21:30:00Z"),
    ],
    vector: [
      c("Recruiter Patterns (Claude, 2026-05-05)", "Inbox/2026-05-05-recruiter-claude.md", 0.74, "perishable", "2026-05-05T11:00:00Z"),
      c("Journal 2026-05-05", "Journal/2026/2026-05-05.md", 0.71, "durable", "2026-05-05T21:30:00Z"),
    ],
    title: [],
    expected_top: "Journal/2026/2026-05-05.md",
    loser: "Inbox/2026-05-05-recruiter-claude.md",
  },
  {
    id: "adv-sa-005-fire",
    kind: "ppr",
    query: "FIRE math and 4 percent rule",
    bm25: [
      c("FIRE Math (Claude, 2026-05-04)", "Inbox/2026-05-04-fire-claude.md", 0.83, "perishable", "2026-05-04T08:00:00Z"),
      c("Journal 2026-05-04", "Journal/2026/2026-05-04.md", 0.79, "durable", "2026-05-04T19:00:00Z"),
    ],
    vector: [
      c("FIRE Math (Claude, 2026-05-04)", "Inbox/2026-05-04-fire-claude.md", 0.72, "perishable", "2026-05-04T08:00:00Z"),
      c("Journal 2026-05-04", "Journal/2026/2026-05-04.md", 0.69, "durable", "2026-05-04T19:00:00Z"),
    ],
    title: [],
    expected_top: "Journal/2026/2026-05-04.md",
    loser: "Inbox/2026-05-04-fire-claude.md",
  },
];

// Shape 3: same-voice old-vs-new. Two perishable notes — 7d and 180d old.
// Pure age signal isolation. Voice factor cancels (both perishable). Raw
// scores designed to slightly favor the older note, so the §A age curve
// must do the work.
export const ADV_SAME_VOICE_OLD_NEW: CandidateFixture[] = [
  {
    id: "adv-sv-on-001-claude-models",
    kind: "rpr-perishable",
    query: "Claude model lineup snapshot",
    bm25: [
      c("Claude Models (180d old)", "Inbox/2025-11-claude-models.md", 0.86, "perishable", "2025-11-10T00:00:00Z"),
      c("Claude Models (7d old)", "Inbox/2026-05-02-claude-models.md", 0.83, "perishable", "2026-05-02T00:00:00Z"),
    ],
    vector: [
      c("Claude Models (180d old)", "Inbox/2025-11-claude-models.md", 0.76, "perishable", "2025-11-10T00:00:00Z"),
      c("Claude Models (7d old)", "Inbox/2026-05-02-claude-models.md", 0.73, "perishable", "2026-05-02T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-02-claude-models.md",
    loser: "Inbox/2025-11-claude-models.md",
    notes: "180d vs 7d, both perishable. Age curve must overcome ~3pt raw-score gap favoring stale.",
  },
  {
    id: "adv-sv-on-002-vault-stats",
    kind: "rpr-perishable",
    query: "vault size counts and stats",
    bm25: [
      c("Vault Stats (180d old)", "Inbox/2025-11-vault-stats.md", 0.85, "perishable", "2025-11-10T00:00:00Z"),
      c("Vault Stats (7d old)", "Inbox/2026-05-02-vault-stats.md", 0.82, "perishable", "2026-05-02T00:00:00Z"),
    ],
    vector: [
      c("Vault Stats (180d old)", "Inbox/2025-11-vault-stats.md", 0.75, "perishable", "2025-11-10T00:00:00Z"),
      c("Vault Stats (7d old)", "Inbox/2026-05-02-vault-stats.md", 0.72, "perishable", "2026-05-02T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-02-vault-stats.md",
    loser: "Inbox/2025-11-vault-stats.md",
  },
  {
    id: "adv-sv-on-003-canva-org",
    kind: "rpr-perishable",
    query: "Canva engineering org chart",
    bm25: [
      c("Canva Org (180d old)", "Inbox/2025-11-canva-org-snapshot.md", 0.87, "perishable", "2025-11-10T00:00:00Z"),
      c("Canva Org (7d old)", "Inbox/2026-05-02-canva-org-snapshot.md", 0.84, "perishable", "2026-05-02T00:00:00Z"),
    ],
    vector: [
      c("Canva Org (180d old)", "Inbox/2025-11-canva-org-snapshot.md", 0.77, "perishable", "2025-11-10T00:00:00Z"),
      c("Canva Org (7d old)", "Inbox/2026-05-02-canva-org-snapshot.md", 0.74, "perishable", "2026-05-02T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-02-canva-org-snapshot.md",
    loser: "Inbox/2025-11-canva-org-snapshot.md",
  },
  {
    id: "adv-sv-on-004-llm-providers",
    kind: "rpr-perishable",
    query: "LLM provider comparison",
    bm25: [
      c("LLM Providers (180d old)", "Inbox/2025-11-llm-providers.md", 0.86, "perishable", "2025-11-10T00:00:00Z"),
      c("LLM Providers (7d old)", "Inbox/2026-05-02-llm-providers.md", 0.83, "perishable", "2026-05-02T00:00:00Z"),
    ],
    vector: [
      c("LLM Providers (180d old)", "Inbox/2025-11-llm-providers.md", 0.76, "perishable", "2025-11-10T00:00:00Z"),
      c("LLM Providers (7d old)", "Inbox/2026-05-02-llm-providers.md", 0.73, "perishable", "2026-05-02T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-02-llm-providers.md",
    loser: "Inbox/2025-11-llm-providers.md",
  },
  {
    id: "adv-sv-on-005-recruiter-status",
    kind: "rpr-perishable",
    query: "recruiter pipeline status",
    bm25: [
      c("Recruiter Status (180d old)", "Inbox/2025-11-recruiter-status.md", 0.85, "perishable", "2025-11-10T00:00:00Z"),
      c("Recruiter Status (7d old)", "Inbox/2026-05-02-recruiter-status.md", 0.82, "perishable", "2026-05-02T00:00:00Z"),
    ],
    vector: [
      c("Recruiter Status (180d old)", "Inbox/2025-11-recruiter-status.md", 0.75, "perishable", "2025-11-10T00:00:00Z"),
      c("Recruiter Status (7d old)", "Inbox/2026-05-02-recruiter-status.md", 0.72, "perishable", "2026-05-02T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-02-recruiter-status.md",
    loser: "Inbox/2025-11-recruiter-status.md",
  },
];

// Shape 4: intent-conflicting. Query has freshness intent (date markers,
// "today/this week/current/latest") + a recent (≤7d) perishable + a
// durable concept on an adjacent topic. The §G regex must auto-detect
// freshness intent and disable decay for the perishable so it ranks top.
export const ADV_INTENT_CONFLICTING: CandidateFixture[] = [
  {
    id: "adv-ic-001-model-lineup",
    kind: "fir",
    query: "what's the Claude model lineup today",
    bm25: [
      c("Anthropic Models", "Resources/Concepts/anthropic-models.md", 0.84, "durable", "2024-09-01T00:00:00Z"),
      c("Claude Models (2026-05-04 snapshot)", "Inbox/2026-05-04-claude-models.md", 0.80, "perishable", "2026-05-04T00:00:00Z"),
    ],
    vector: [
      c("Anthropic Models", "Resources/Concepts/anthropic-models.md", 0.76, "durable", "2024-09-01T00:00:00Z"),
      c("Claude Models (2026-05-04 snapshot)", "Inbox/2026-05-04-claude-models.md", 0.73, "perishable", "2026-05-04T00:00:00Z"),
    ],
    title: [
      c("Anthropic Models", "Resources/Concepts/anthropic-models.md", 20, "durable", "2024-09-01T00:00:00Z"),
    ],
    expected_top: "Inbox/2026-05-04-claude-models.md",
    loser: "Resources/Concepts/anthropic-models.md",
    notes: "Freshness intent ('today') must override voice penalty. Recent perishable wins.",
  },
  {
    id: "adv-ic-002-pricing-current",
    kind: "fir",
    query: "Claude API current pricing",
    bm25: [
      c("Anthropic Pricing", "Resources/Concepts/anthropic-pricing.md", 0.83, "durable", "2024-11-01T00:00:00Z"),
      c("Claude API Pricing (2026-05-03)", "Inbox/2026-05-03-claude-pricing.md", 0.79, "perishable", "2026-05-03T00:00:00Z"),
    ],
    vector: [
      c("Anthropic Pricing", "Resources/Concepts/anthropic-pricing.md", 0.75, "durable", "2024-11-01T00:00:00Z"),
      c("Claude API Pricing (2026-05-03)", "Inbox/2026-05-03-claude-pricing.md", 0.72, "perishable", "2026-05-03T00:00:00Z"),
    ],
    title: [
      c("Anthropic Pricing", "Resources/Concepts/anthropic-pricing.md", 20, "durable", "2024-11-01T00:00:00Z"),
    ],
    expected_top: "Inbox/2026-05-03-claude-pricing.md",
    loser: "Resources/Concepts/anthropic-pricing.md",
  },
  {
    id: "adv-ic-003-canva-priorities-week",
    kind: "fir",
    query: "Canva priorities this week",
    bm25: [
      c("Canva Strategy", "Resources/Concepts/canva-strategy.md", 0.82, "durable", "2025-01-15T00:00:00Z"),
      c("Canva Priorities (2026-05-05)", "Inbox/2026-05-05-canva-priorities.md", 0.78, "perishable", "2026-05-05T00:00:00Z"),
    ],
    vector: [
      c("Canva Strategy", "Resources/Concepts/canva-strategy.md", 0.74, "durable", "2025-01-15T00:00:00Z"),
      c("Canva Priorities (2026-05-05)", "Inbox/2026-05-05-canva-priorities.md", 0.71, "perishable", "2026-05-05T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-05-canva-priorities.md",
    loser: "Resources/Concepts/canva-strategy.md",
  },
  {
    id: "adv-ic-004-recent-agent-bench",
    kind: "fir",
    query: "recent agent benchmark results",
    bm25: [
      c("AI Agent Memory & Context", "Resources/Concepts/ai-agent-memory-and-context.md", 0.83, "durable", "2025-12-01T00:00:00Z"),
      c("Agent Benchmarks (2026-05-06)", "Inbox/2026-05-06-agent-benchmarks.md", 0.79, "perishable", "2026-05-06T00:00:00Z"),
    ],
    vector: [
      c("AI Agent Memory & Context", "Resources/Concepts/ai-agent-memory-and-context.md", 0.75, "durable", "2025-12-01T00:00:00Z"),
      c("Agent Benchmarks (2026-05-06)", "Inbox/2026-05-06-agent-benchmarks.md", 0.72, "perishable", "2026-05-06T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-06-agent-benchmarks.md",
    loser: "Resources/Concepts/ai-agent-memory-and-context.md",
  },
  {
    id: "adv-ic-005-recruiter-yesterday",
    kind: "fir",
    query: "yesterday's recruiter call notes",
    bm25: [
      c("Hiring & Recruiting Notes", "Resources/Concepts/hiring-and-recruiting.md", 0.82, "durable", "2024-02-18T00:00:00Z"),
      c("Recruiter Call Notes (2026-05-08)", "Inbox/2026-05-08-recruiter-calls.md", 0.78, "perishable", "2026-05-08T16:00:00Z"),
    ],
    vector: [
      c("Hiring & Recruiting Notes", "Resources/Concepts/hiring-and-recruiting.md", 0.74, "durable", "2024-02-18T00:00:00Z"),
      c("Recruiter Call Notes (2026-05-08)", "Inbox/2026-05-08-recruiter-calls.md", 0.71, "perishable", "2026-05-08T16:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-08-recruiter-calls.md",
    loser: "Resources/Concepts/hiring-and-recruiting.md",
  },
];

// ── Freshness-intent fixtures (V3 §G regex) ──────────────────────────
//
// 12 fixtures exercising the freshness-intent auto-detect regex and its
// negative gate (durable-intent terms force voice_preference=mixed even
// when freshness terms also fire). Each fixture's `kind` is "fir" so the
// runner can measure FIR sensitivity (does it pick recent perishable
// when freshness intent is present?) and specificity (does it NOT pick
// recent perishable when the negative gate suppresses the freshness
// signal?).
//
// Mix:
//   3 with explicit date/month markers (ISO date or "month YYYY")
//   3 with "today/now/right now/this week|month|quarter" forms
//   3 with "latest/recent/recently/lately" forms
//   3 mixed-intent — including one negative-gate case where `latest`
//     co-occurs with a durable-intent term ("understanding"); the gate
//     must fire and expected_top is the DURABLE concept note.
export const FRESHNESS_INTENT_FIXTURES: CandidateFixture[] = [
  // — Explicit date/month markers —
  {
    id: "fir-001-2026-05-model-lineup",
    kind: "fir",
    query: "2026-05 Claude model lineup",
    bm25: [
      c("Anthropic Models", "Resources/Concepts/anthropic-models.md", 0.83, "durable", "2024-09-01T00:00:00Z"),
      c("Claude Models May 2026", "Inbox/2026-05-02-claude-models.md", 0.80, "perishable", "2026-05-02T00:00:00Z"),
    ],
    vector: [
      c("Anthropic Models", "Resources/Concepts/anthropic-models.md", 0.74, "durable", "2024-09-01T00:00:00Z"),
      c("Claude Models May 2026", "Inbox/2026-05-02-claude-models.md", 0.71, "perishable", "2026-05-02T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-02-claude-models.md",
    loser: "Resources/Concepts/anthropic-models.md",
    notes: "Explicit ISO date marker '2026-05' triggers freshness intent.",
  },
  {
    id: "fir-002-claude-releases-this-week",
    kind: "fir",
    query: "Claude releases this week",
    bm25: [
      c("Anthropic Models", "Resources/Concepts/anthropic-models.md", 0.82, "durable", "2024-09-01T00:00:00Z"),
      c("Claude Releases (2026-05-07)", "Inbox/2026-05-07-claude-releases.md", 0.79, "perishable", "2026-05-07T00:00:00Z"),
    ],
    vector: [
      c("Anthropic Models", "Resources/Concepts/anthropic-models.md", 0.74, "durable", "2024-09-01T00:00:00Z"),
      c("Claude Releases (2026-05-07)", "Inbox/2026-05-07-claude-releases.md", 0.71, "perishable", "2026-05-07T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-07-claude-releases.md",
    loser: "Resources/Concepts/anthropic-models.md",
    notes: "'this week' is in FRESHNESS_TERMS.",
  },
  {
    id: "fir-003-may-2026-grove-roadmap",
    kind: "fir",
    query: "May 2026 Grove roadmap",
    bm25: [
      c("Grove Roadmap", "Resources/Concepts/grove-roadmap.md", 0.81, "durable", "2025-08-15T00:00:00Z"),
      c("Grove Roadmap (May 2026)", "Inbox/2026-05-07-grove-roadmap.md", 0.78, "perishable", "2026-05-07T00:00:00Z"),
    ],
    vector: [
      c("Grove Roadmap", "Resources/Concepts/grove-roadmap.md", 0.73, "durable", "2025-08-15T00:00:00Z"),
      c("Grove Roadmap (May 2026)", "Inbox/2026-05-07-grove-roadmap.md", 0.70, "perishable", "2026-05-07T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-07-grove-roadmap.md",
    loser: "Resources/Concepts/grove-roadmap.md",
    notes: "'May 2026' month-year marker triggers freshness intent.",
  },
  // — "today/now" forms —
  {
    id: "fir-004-current-claude-lineup",
    kind: "fir",
    query: "what's today's Claude lineup",
    bm25: [
      c("Anthropic Models", "Resources/Concepts/anthropic-models.md", 0.82, "durable", "2024-09-01T00:00:00Z"),
      c("Claude Lineup Today (2026-05-08)", "Inbox/2026-05-08-claude-lineup.md", 0.79, "perishable", "2026-05-08T00:00:00Z"),
    ],
    vector: [
      c("Anthropic Models", "Resources/Concepts/anthropic-models.md", 0.74, "durable", "2024-09-01T00:00:00Z"),
      c("Claude Lineup Today (2026-05-08)", "Inbox/2026-05-08-claude-lineup.md", 0.71, "perishable", "2026-05-08T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-08-claude-lineup.md",
    loser: "Resources/Concepts/anthropic-models.md",
    notes: "'today' is in FRESHNESS_TERMS. Note: 'current' was dropped in §G hardening, so this query uses 'today' as the trigger.",
  },
  {
    id: "fir-005-todays-recruiter-calls",
    kind: "fir",
    query: "today's recruiter calls",
    bm25: [
      c("Hiring & Recruiting Notes", "Resources/Concepts/hiring-and-recruiting.md", 0.81, "durable", "2024-02-18T00:00:00Z"),
      c("Recruiter Calls (2026-05-09)", "Inbox/2026-05-09-recruiter-calls.md", 0.78, "perishable", "2026-05-09T08:00:00Z"),
    ],
    vector: [
      c("Hiring & Recruiting Notes", "Resources/Concepts/hiring-and-recruiting.md", 0.73, "durable", "2024-02-18T00:00:00Z"),
      c("Recruiter Calls (2026-05-09)", "Inbox/2026-05-09-recruiter-calls.md", 0.70, "perishable", "2026-05-09T08:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-09-recruiter-calls.md",
    loser: "Resources/Concepts/hiring-and-recruiting.md",
    notes: "'today' triggers freshness; same-day perishable wins.",
  },
  {
    id: "fir-006-right-now-canva-priorities",
    kind: "fir",
    query: "Canva priorities right now",
    bm25: [
      c("Canva Strategy", "Resources/Concepts/canva-strategy.md", 0.82, "durable", "2025-01-15T00:00:00Z"),
      c("Canva Priorities (2026-05-08)", "Inbox/2026-05-08-canva-priorities.md", 0.79, "perishable", "2026-05-08T00:00:00Z"),
    ],
    vector: [
      c("Canva Strategy", "Resources/Concepts/canva-strategy.md", 0.74, "durable", "2025-01-15T00:00:00Z"),
      c("Canva Priorities (2026-05-08)", "Inbox/2026-05-08-canva-priorities.md", 0.71, "perishable", "2026-05-08T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-08-canva-priorities.md",
    loser: "Resources/Concepts/canva-strategy.md",
    notes: "'right now' is in FRESHNESS_TERMS.",
  },
  // — "latest/recent" forms —
  {
    id: "fir-007-latest-thinking-on-gemini",
    kind: "fir",
    query: "latest on Gemini model family",
    bm25: [
      c("Google Models", "Resources/Concepts/google-models.md", 0.83, "durable", "2024-12-10T00:00:00Z"),
      c("Gemini Update (2026-05-06)", "Inbox/2026-05-06-gemini-update.md", 0.80, "perishable", "2026-05-06T00:00:00Z"),
    ],
    vector: [
      c("Google Models", "Resources/Concepts/google-models.md", 0.75, "durable", "2024-12-10T00:00:00Z"),
      c("Gemini Update (2026-05-06)", "Inbox/2026-05-06-gemini-update.md", 0.72, "perishable", "2026-05-06T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-06-gemini-update.md",
    loser: "Resources/Concepts/google-models.md",
    notes: "'latest' triggers freshness; no durable-intent term to gate.",
  },
  {
    id: "fir-008-recent-agent-benchmarks",
    kind: "fir",
    query: "recent agent benchmarks",
    bm25: [
      c("AI Coding Agents", "Resources/Concepts/ai-coding-agents.md", 0.82, "durable", "2025-09-15T00:00:00Z"),
      c("Agent Benchmarks (2026-05-04)", "Inbox/2026-05-04-agent-benchmarks.md", 0.79, "perishable", "2026-05-04T00:00:00Z"),
    ],
    vector: [
      c("AI Coding Agents", "Resources/Concepts/ai-coding-agents.md", 0.74, "durable", "2025-09-15T00:00:00Z"),
      c("Agent Benchmarks (2026-05-04)", "Inbox/2026-05-04-agent-benchmarks.md", 0.71, "perishable", "2026-05-04T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-04-agent-benchmarks.md",
    loser: "Resources/Concepts/ai-coding-agents.md",
    notes: "'recent' triggers freshness; no durable-intent term to gate.",
  },
  {
    id: "fir-009-lately-coding-agents",
    kind: "fir",
    query: "AI coding agents lately",
    bm25: [
      c("AI Coding Agents", "Resources/Concepts/ai-coding-agents.md", 0.83, "durable", "2025-09-15T00:00:00Z"),
      c("Coding Agents Survey (2026-05-05)", "Inbox/2026-05-05-coding-agents.md", 0.80, "perishable", "2026-05-05T00:00:00Z"),
    ],
    vector: [
      c("AI Coding Agents", "Resources/Concepts/ai-coding-agents.md", 0.75, "durable", "2025-09-15T00:00:00Z"),
      c("Coding Agents Survey (2026-05-05)", "Inbox/2026-05-05-coding-agents.md", 0.72, "perishable", "2026-05-05T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-05-coding-agents.md",
    loser: "Resources/Concepts/ai-coding-agents.md",
    notes: "'lately' triggers freshness; no durable-intent term to gate.",
  },
  // — Mixed intent —
  {
    id: "fir-010-this-quarter-llm-providers",
    kind: "fir",
    query: "this quarter's LLM provider landscape",
    bm25: [
      c("LLM Providers", "Resources/Concepts/llm-providers.md", 0.82, "durable", "2025-03-01T00:00:00Z"),
      c("LLM Providers Q2 2026", "Inbox/2026-04-12-llm-providers.md", 0.79, "perishable", "2026-04-12T00:00:00Z"),
    ],
    vector: [
      c("LLM Providers", "Resources/Concepts/llm-providers.md", 0.74, "durable", "2025-03-01T00:00:00Z"),
      c("LLM Providers Q2 2026", "Inbox/2026-04-12-llm-providers.md", 0.71, "perishable", "2026-04-12T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-04-12-llm-providers.md",
    loser: "Resources/Concepts/llm-providers.md",
    notes: "'this quarter' triggers freshness. 'landscape' is a topic word, not a durable-intent term.",
  },
  {
    id: "fir-011-recently-published-mcp",
    kind: "fir",
    query: "recently published MCP servers",
    bm25: [
      c("MCP (Model Context Protocol)", "Resources/Concepts/mcp.md", 0.83, "durable", "2025-08-11T00:00:00Z"),
      c("MCP Server Roundup (2026-05-03)", "Inbox/2026-05-03-mcp-roundup.md", 0.80, "perishable", "2026-05-03T00:00:00Z"),
    ],
    vector: [
      c("MCP (Model Context Protocol)", "Resources/Concepts/mcp.md", 0.75, "durable", "2025-08-11T00:00:00Z"),
      c("MCP Server Roundup (2026-05-03)", "Inbox/2026-05-03-mcp-roundup.md", 0.72, "perishable", "2026-05-03T00:00:00Z"),
    ],
    title: [],
    expected_top: "Inbox/2026-05-03-mcp-roundup.md",
    loser: "Resources/Concepts/mcp.md",
    notes: "'recently' triggers freshness; 'servers' is plain noun, no negative-gate match.",
  },
  // The negative-gate fixture: `latest` + `understanding` (durable-intent term).
  // §G regex: DURABLE_INTENT_TERMS fires first → voice_preference=mixed →
  // age decay stays active for the perishable, voice factor stays active too,
  // and the durable concept note ranks top. This case keeps `kind: "fir"`
  // because the FIR eval needs to measure regex SPECIFICITY, not just
  // sensitivity — false positives on durable-intent queries are the main
  // failure mode the gate exists to prevent.
  {
    id: "fir-012-latest-understanding-attachment",
    kind: "fir",
    query: "latest understanding of attachment theory",
    bm25: [
      c("Attachment Theory", "Resources/Concepts/attachment-theory.md", 0.84, "durable", "2024-09-01T00:00:00Z"),
      c("Attachment Notes (2026-05-04)", "Inbox/2026-05-04-attachment-claude.md", 0.81, "perishable", "2026-05-04T00:00:00Z"),
    ],
    vector: [
      c("Attachment Theory", "Resources/Concepts/attachment-theory.md", 0.76, "durable", "2024-09-01T00:00:00Z"),
      c("Attachment Notes (2026-05-04)", "Inbox/2026-05-04-attachment-claude.md", 0.73, "perishable", "2026-05-04T00:00:00Z"),
    ],
    title: [
      c("Attachment Theory", "Resources/Concepts/attachment-theory.md", 20, "durable", "2024-09-01T00:00:00Z"),
    ],
    expected_top: "Resources/Concepts/attachment-theory.md",
    loser: "Inbox/2026-05-04-attachment-claude.md",
    notes: "Negative-gate: 'latest' fires freshness, but 'understanding' is in DURABLE_INTENT_TERMS, forcing voice_preference=mixed. Durable concept must win. Tests FIR specificity (fewer false-positives), not sensitivity. Kind stays 'fir' for that reason.",
  },
];

export const CANDIDATE_FIXTURES: CandidateFixture[] = [
  ...PPR_FIXTURES,
  ...RPR_PERISHABLE_FIXTURES,
  ...RI_DURABLE_FIXTURES,
];

// V3 aggregate exports — the canonical CANDIDATE_FIXTURES set above stays
// frozen as the canonical baseline (28 fixtures). Adversarial and FIR
// subsets are reported separately by run.ts via the `kind` field.
export const ADVERSARIAL_FIXTURES: CandidateFixture[] = [
  ...ADV_OLD_PERISHABLE_NEW_DURABLE,
  ...ADV_SAME_AGE_CROSS,
  ...ADV_SAME_VOICE_OLD_NEW,
  ...ADV_INTENT_CONFLICTING,
];

export const ALL_CANDIDATE_FIXTURES: CandidateFixture[] = [
  ...CANDIDATE_FIXTURES,
  ...ADVERSARIAL_FIXTURES,
  ...FRESHNESS_INTENT_FIXTURES,
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

// ── V3 §F vault straddle (multi-segment voice resolution) ────────────
//
// One note with explicit line-range markers in the body so future-Claude
// can author straddle queries against deterministic line numbers. Per
// §D's worst-case-voice rule, a query whose match span overlaps any
// perishable segment must surface voice="perishable" + the directive,
// even when the rest of the matched span is durable.
//
// The note's voice/written_at fields here represent the LATEST stamp
// (the perishable insertion) so a single-segment fallback would still
// pick perishable. The point of the fixture is to test the multi-segment
// resolver, not the single-segment fallback.
export const VAULT_STRADDLE: VaultTestNote[] = [
  {
    path: "Resources/Concepts/parametric-design-straddle.md",
    frontmatter: "type: concept\ntags: [design, parametric, straddle-fixture]",
    body: [
      "<!--",
      "  STRADDLE FIXTURE — line ranges:",
      "    Lines 1-10  : durable  (John writing, original 2024 content)",
      "    Lines 11-15 : perishable (Claude-appended summary, inserted 2026-05-04)",
      "    Lines 16-30 : durable  (more John content, original 2024)",
      "  Author straddle queries against line ranges that cross 10/11 or 15/16.",
      "  Per §D worst-case-voice: any span overlapping lines 11-15 surfaces",
      "  voice=perishable in the envelope + usage_directive present.",
      "-->",
      "",
      "# Parametric Design (straddle)",
      "",
      "A design philosophy where artifacts are described as systems of",
      "constraints and parameters rather than fixed forms. The output is",
      "the resolution of the system at given parameter values; the artifact",
      "is the system itself.",
      "",
      "## Claude summary (2026-05-04)",
      "",
      "Claude's restatement: parametric design treats designs as functions",
      "of inputs. Output varies as the inputs vary. May or may not match",
      "John's actual thesis — verify before extending.",
      "",
      "## Application to brand systems",
      "",
      "Brand systems are the parametric variant of identity. The brand is",
      "the rule, not the artifact. Every visible expression of the brand",
      "should be derivable from the rule applied to a context — color",
      "palette + typographic scale + spatial system + voice + motion. When",
      "the rule changes, every artifact derived from it updates in lockstep.",
      "Pre-rule brands are collections of one-offs; post-rule brands are",
      "instances of a system. The work shifts from drawing the artifact to",
      "specifying the rule, which is harder and more leveraged. Designers",
      "who can specify rules outscale designers who draw artifacts.",
    ].join("\n"),
    voice: "perishable",
    written_at: "2026-05-04T00:00:00Z",
    by: "claude-opus-4-7",
    reason: "perishable insertion is most-recent stamp; note carries durable bookends per §F straddle shape",
    basis: ["Resources/Concepts/parametric-design.md"],
  },
];

// ── V3 §D mixed-voice realistic patterns ─────────────────────────────
//
// Three notes that are PARTIALLY durable + PARTIALLY perishable in
// realistic vault patterns (vs the synthetic VAULT_STRADDLE which is
// pure-fixture). These exercise §D's worst-case-voice multi-segment
// rule under shapes the user actually generates day-to-day.
//
// Same line-range comment convention as VAULT_STRADDLE so future-Claude
// can author targeted queries.
export const MIXED_VOICE_VAULT_NOTES: VaultTestNote[] = [
  // 1) People note — durable POV section + perishable last-meeting summary.
  {
    path: "Resources/People/example-collaborator.md",
    frontmatter: "type: person\ntags: [collaborator, mixed-voice-fixture]",
    body: [
      "<!--",
      "  MIXED-VOICE FIXTURE (People note) — line ranges:",
      "    Lines 1-12  : durable  (John's POV on the person, written 2024-08)",
      "    Lines 13-22 : perishable (Claude-extracted last-meeting summary, 2026-05-05)",
      "    Lines 23-30 : durable  (relationship history continued)",
      "-->",
      "",
      "# Example Collaborator",
      "",
      "An ex-Pinterest designer who shaped how I think about taste graphs",
      "in product surfaces. We disagree productively about whether taste is",
      "scalar-reducible — she thinks it eventually is, with enough features;",
      "I think it can't be without losing what made it taste in the first",
      "place. The disagreement is the relationship's load-bearing wall:",
      "neither of us has converted the other in eight years and probably",
      "won't. That stability is the point.",
      "",
      "## Last meeting (2026-05-05, Claude-summarized)",
      "",
      "Met for coffee at Sightglass. Topics discussed: her new role at a",
      "Series B startup doing personalization, my Grove project, the state",
      "of taste-graph research after the 2025 RecSys papers, and whether",
      "Pinterest's 2016 thesis still holds. She's bullish, I'm cautious.",
      "Action items: send her the [[Taste Graphs]] note; she'll send me",
      "the RecSys 2025 paper she keeps citing. Verify before extending —",
      "this is a Claude extraction, not John's verbatim recollection.",
      "",
      "## Relationship history",
      "",
      "We met at Pinterest in 2016 when I was thinking about boards as",
      "graph nodes and she was thinking about pin-pin similarity. The",
      "framing collision shaped both of us. She left for Stitch Fix in",
      "2018, then to a stealth startup, then to her current role. We've",
      "stayed in regular touch through the moves. Pattern: every 2-3",
      "months, coffee, one productive disagreement.",
    ].join("\n"),
    voice: "perishable",
    written_at: "2026-05-05T00:00:00Z",
    by: "claude-opus-4-7",
    reason: "last-meeting summary is the most-recent stamp; durable POV bookends",
    basis: ["Journal/2026/2026-05-05.md"],
  },
  // 2) Concept note — durable definition + perishable Claude-added clarification.
  {
    path: "Resources/Concepts/agent-memory-mixed.md",
    frontmatter: "type: concept\ntags: [agents, memory, mixed-voice-fixture]",
    body: [
      "<!--",
      "  MIXED-VOICE FIXTURE (Concept note) — line ranges:",
      "    Lines 1-10  : durable  (John's definition, written 2025-12)",
      "    Lines 11-18 : perishable (Claude-added clarification, 2026-05-06)",
      "    Lines 19-30 : durable  (John's examples and POV continued)",
      "-->",
      "",
      "# Agent Memory (mixed)",
      "",
      "An agent's memory is the union of three stores: the prompt itself",
      "(volatile, scoped to one call), the durable artifact the agent",
      "writes to (vault, database, file), and the cache the platform keeps",
      "between calls (compaction state, prompt-cache hits). All three are",
      "memory; none is the memory.",
      "",
      "## Clarification (Claude, 2026-05-06)",
      "",
      "Claude added: the three-store taxonomy maps to (1) ephemeral",
      "context, (2) externalized state, (3) implementation-detail cache.",
      "Most agent failures come from confusing the three — treating cache",
      "as durable, or expecting context to persist across sessions.",
      "Verify framing before extending; this is a clarification, not",
      "John's primary statement.",
      "",
      "## Examples and POV",
      "",
      "Examples: Grove writes to (2). Claude Code's prompt cache lives in",
      "(3). The conversation transcript is (1). The mistake people make",
      "when designing agent memory is treating (3) as if it were (2).",
      "(3) is opaque, eviction-driven, and not under the agent's control.",
      "Memory you can rely on is memory you wrote down. Everything else",
      "is hope. The vault wins because it's (2) by construction.",
    ].join("\n"),
    voice: "perishable",
    written_at: "2026-05-06T00:00:00Z",
    by: "claude-opus-4-7",
    reason: "Claude clarification is the most-recent stamp; durable definition+POV bookends",
    basis: ["Resources/Concepts/ai-agent-memory-and-context.md"],
  },
  // 3) Journal entry — durable reflection + perishable AI-extracted entity list.
  {
    path: "Journal/2026/2026-05-07-mixed.md",
    frontmatter: "type: journal\ntags: [journal, mixed-voice-fixture]",
    body: [
      "<!--",
      "  MIXED-VOICE FIXTURE (Journal entry) — line ranges:",
      "    Lines 1-12  : durable  (John's reflection, written 2026-05-07)",
      "    Lines 13-20 : perishable (Claude-extracted entity list, 2026-05-08)",
      "    Lines 21-30 : durable  (rest of John's entry)",
      "-->",
      "",
      "# 2026-05-07",
      "",
      "Long day on Grove. The piecewise voice/age curve is finally",
      "behaving — fresh perishable now ranks where it should, and durables",
      "stop getting punished for being old. The clarifying insight today",
      "was that the v2 spec was multiplying three things that should have",
      "been one: voice factor, lifetime ramp, and decay. Once §A collapsed",
      "them into the single piecewise function with floor as asymptote,",
      "the math stopped being a layered hack and started being a curve.",
      "Felt the Phase B work shift from grinding to drawing.",
      "",
      "## Entities mentioned (Claude-extracted, 2026-05-08)",
      "",
      "- [[Grove]] — primary subject",
      "- [[V3_PLAN]] — referenced by §A",
      "- [[Voice Factor]] — concept invoked",
      "- [[Piecewise Decay]] — concept invoked",
      "- [[Phase B]] — project phase",
      "Verify entity list before extending; auto-extracted, may include",
      "spurious matches or miss salient entities.",
      "",
      "## Continued reflection",
      "",
      "Tomorrow: write the adversarial fixtures. The point isn't more",
      "fixtures, it's harder fixtures — the kind where one signal has to",
      "do all the work because the others cancel. If the sweep starts",
      "differentiating configs after the §F additions land, we'll know",
      "the v2 100%-everywhere result was fixture-easiness, not config",
      "convergence. If the sweep still ties out, the math is wrong and",
      "the panels were right to push back. Either way, we learn something",
      "real.",
    ].join("\n"),
    voice: "perishable",
    written_at: "2026-05-08T00:00:00Z",
    by: "claude-opus-4-7",
    reason: "AI-extracted entity list is the most-recent stamp; durable reflection bookends",
    basis: ["Journal/2026/2026-05-07.md"],
  },
];

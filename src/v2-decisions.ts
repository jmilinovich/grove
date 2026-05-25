/**
 * Inbox v2 decision types (S-INBOX-1).
 *
 * The shapes in this module describe a "decision Grove made about the
 * graph" — the unit of work for the new inbox surface. See
 * docs/inbox-v2-spec.md for the full design and docs/inbox-v2-plan.md
 * for the work-item DAG. S-INBOX-2 through S-INBOX-10 build on these
 * types; this file only defines them.
 *
 * Two layers:
 *
 *   1. Wire/domain shape (`Decision`, `ReviewOption`, payload union) —
 *      what skills produce, what the inbox API returns, what
 *      .grove/decisions.jsonl serializes.
 *
 *   2. Row shape (`DecisionRow`, `SuppressionRow` in src/db-types.ts) —
 *      what better-sqlite3 returns from per-vault state.db. JSON
 *      columns stay as strings at the SQL boundary; parsing into the
 *      domain shape happens in the API layer (same convention as
 *      task_results.provenance_json).
 *
 * Payload is a discriminated union keyed by `type` so each suggestion
 * class can store the fields its compensation path needs:
 *   - disambiguation → candidates + surface form
 *   - link           → source/target paths + surface form
 *   - enrichment     → prior + new content (prior_content is required;
 *                      compensation restores it on rollback)
 */

export type SuggestionType = "disambiguation" | "link" | "enrichment";

export type DecisionStatus = "provisional" | "confirmed" | "compensated";

/**
 * A single option offered to the user for resolving a decision.
 * `source` distinguishes schema-derived options (the common case) from
 * LLM-proposed options (rare, for novel ambiguity) per spec D-10.
 */
export interface ReviewOption {
  id: string;
  label: string;
  description?: string;
  source: "schema" | "llm";
}

export interface DisambiguationPayload {
  source_path: string;
  surface_form: string;
  candidates: Array<{ note_path: string; signals?: string[] }>;
}

export interface LinkPayload {
  source_path: string;
  surface_form: string;
  target_path: string;
  candidates: Array<{ note_path: string }>;
}

export interface EnrichmentPayload {
  target_path: string;
  /** Pre-decision note body — restored on compensation. */
  prior_content: string;
  new_content: string;
}

export type DecisionPayload =
  | ({ readonly type?: "disambiguation" } & DisambiguationPayload)
  | ({ readonly type?: "link" } & LinkPayload)
  | ({ readonly type?: "enrichment" } & EnrichmentPayload);

/**
 * Domain shape of a decision. Mirrors the JSONL line in
 * .grove/decisions.jsonl and the projection in state.db's `decisions`
 * table (see DecisionRow in src/db-types.ts).
 */
export interface Decision {
  id: string;
  type: SuggestionType;
  skillRunId: string;
  taskId: string | null;
  createdAt: string;
  status: DecisionStatus;
  payload: DecisionPayload;
  options: ReviewOption[];
  chosenOptionId: string;
  affectedPaths: string[];
  compensatedBy: string | null;
}

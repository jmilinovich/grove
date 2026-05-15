/**
 * Hardcoded skill metadata for the v2 dashboard.
 *
 * Per PLAN.md Phase 21 D-2: skills are NOT user-authored. A registry
 * table without third-party authors would be premature abstraction
 * (marketplace = v3). `skill_configs` (per-vault state.db) holds the
 * per-vault user state — enabled/cadence/last_run_at/next_run_at —
 * keyed by `skill_slug`. This registry holds the metadata side.
 *
 * Scope: 3 skills land in Phase 21 — only the skills with executors
 * already speced for Phase 22/23. The 4 metadata-only entries from the
 * mock (`relationship-surface`, `dormant-thread-surface`,
 * `weekly-journal-patterns`, `perishable-audit`) are deferred to v3
 * alongside their executors per Scope Cop's "browse tab full of 'coming
 * soon' is worse than no tab" cut.
 *
 * Field shape matches `grove-www/src/lib/grove-api.v2.types.ts` Skill
 * interface exactly. The `installState` field is derived per-vault at
 * read time from `skill_configs.enabled` (P21-5).
 */

import type { Cadence } from "../db-types.js";

export type SkillDomain =
  | "knowledge"
  | "journal"
  | "relationships"
  | "health"
  | "finances"
  | "system";

export type TaskArtifactType =
  | "surface"
  | "note-change"
  | "note-create"
  | "note-link"
  | "concept-merge";

/**
 * Static metadata for a builtin skill. Per-vault state (installed?
 * cadence? last run?) lives in `skill_configs` and is merged in at
 * read time.
 */
export interface SkillMetadata {
  id: string;
  slug: string;
  name: string;
  domain: SkillDomain;
  author: "builtin";
  description: string;
  sampleTasks: string[];
  cadenceOptions: Cadence[];
  defaultCadence: Cadence | null;
  defaultArtifactType: TaskArtifactType;
  /** Pre-populated by `bootstrapFirstRun` (P23-2) when the vault is provisioned. */
  starterPendingTasks?: string[];
}

export const SKILL_REGISTRY: readonly SkillMetadata[] = [
  {
    id: "skill-daily-vault-review",
    slug: "daily-vault-review",
    name: "Daily Vault Review",
    domain: "system",
    author: "builtin",
    description:
      "Surfaces today's noteworthy patterns, dormant threads, and perishable claims approaching staleness. Surface-only — never writes.",
    sampleTasks: [
      "today's patterns from your journal",
      "concepts that haven't been touched in 30 days",
      "perishable claims older than 14 days",
    ],
    cadenceOptions: ["daily", "on-demand"],
    defaultCadence: "daily",
    defaultArtifactType: "surface",
    starterPendingTasks: [
      "Surface today's patterns from your journal",
      "Flag perishable claims older than 14 days",
      "Highlight concepts not touched in 30 days",
    ],
  },
  {
    id: "skill-concept-graph-cleanup",
    slug: "concept-graph-cleanup",
    name: "Concept Graph Cleanup",
    domain: "knowledge",
    author: "builtin",
    description:
      "Detects probable duplicates, orphans, and dead concepts. Surfaces them for ritual review.",
    sampleTasks: [
      "concepts that look like duplicates",
      "concepts with zero inbound wikilinks",
      "concepts not touched in 90 days",
    ],
    cadenceOptions: ["weekly", "on-demand"],
    defaultCadence: "weekly",
    defaultArtifactType: "concept-merge",
  },
  {
    id: "skill-dup-people-detection",
    slug: "dup-people-detection",
    name: "Duplicate People Detection",
    domain: "relationships",
    author: "builtin",
    description:
      "Finds near-duplicate person notes (same recruiter under two spellings, same exec under handle + full name) and surfaces them for merge.",
    sampleTasks: [
      "person notes with near-identical names",
      "people sharing 5+ wikilinks and source references",
      "merge candidates flagged by content similarity",
    ],
    cadenceOptions: ["weekly", "on-demand"],
    defaultCadence: "weekly",
    defaultArtifactType: "concept-merge",
  },
];

/** Lookup by slug; returns undefined if the slug isn't a registered builtin. */
export function getSkillBySlug(slug: string): SkillMetadata | undefined {
  return SKILL_REGISTRY.find((s) => s.slug === slug);
}

/**
 * Dynamically load the executor module for a skill slug. Centralizes
 * the slug → module wiring in the registry so the worker (v2-task-run)
 * doesn't bake any one skill's path into its dispatch logic.
 *
 * Returns the imported module namespace (callers introspect for a `run`
 * export) or null when the slug has no executor wired yet — e.g., the
 * `concept-graph-cleanup` entry is still waiting on P23-3 for its
 * executor.
 *
 * Lazy `await import` avoids loading the Anthropic SDK and per-skill
 * dependencies at module-eval time (the registry is hot — it's read on
 * every backlog request).
 */
export async function loadSkillModule(slug: string): Promise<unknown | null> {
  switch (slug) {
    case "daily-vault-review":
      return await import("./daily-vault-review.js");
    case "dup-people-detection":
      return await import("./dup-people-detection.js");
    // P23-3 wires concept-graph-cleanup.
    default:
      return null;
  }
}

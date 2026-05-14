/**
 * P22-5 — `daily-vault-review` skill executor.
 *
 * Reads up to 5 unresolved `graph_health_flags` rows + up to 5 high-
 * confidence `discovery_results` (cosine ≥ 0.9) from the shared control
 * db, asks Claude Haiku to draft 3–5 short review tasks framing them,
 * and inserts those tasks into the vault's per-vault state.db as new
 * `state='review'` rows so the user can disposition them via the v2
 * dashboard.
 *
 * Two exports:
 *   - `runDailyVaultReview(vault, options): Promise<TaskResult>` — the
 *     high-level skill API. Returns the SUMMARY artifact for the
 *     originating tick task; child tasks are inserted as a side effect.
 *   - `run(vault, task): Promise<ExecutorResult>` — the SkillExecutor
 *     adapter that fits the worker contract in `v2-task-run.ts`. Reads
 *     mode/tokenCeiling from env (`GROVE_DAILY_REVIEW_MODE`,
 *     `GROVE_DAILY_REVIEW_TOKEN_CEILING`) so cadenced runs don't need
 *     options threaded through the worker.
 *
 * Cost ceiling (Scope Cop SHRINK #1, Phase 22 revision note #5): the
 * executor HARD-FAILS on ceiling exceeded — no sampling, no partial
 * runs. When `estimateRunCost(...)` exceeds `tokenCeiling`, the summary
 * artifact is `type='surface'` with a `surfaceText` explaining the vault
 * is too large for this tick and no LLM call was made.
 *
 * `mode='surface-only'` never produces note-change artifacts on child
 * tasks; the LLM-proposed `artifactType` is downgraded to `'surface'`
 * if it would otherwise carry a write. `mode='writes-allowed'` lets the
 * model propose `note-change`/`note-link`/`concept-merge` artifacts and
 * the user dispositions them via `/review`.
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import { getVaultDb } from "../db-per-vault.js";
import type { VaultContext } from "../vault-router.js";
import type { TaskRow } from "../db-types.js";
import type { ExecutorResult } from "../v2-task-run.js";
import type {
  GroveProvenance,
  TaskArtifactType,
  TaskResult,
} from "../v2-tasks.js";
import {
  estimateRunCost,
  exceededCeiling,
  recordRunCost,
} from "./cost-ceiling.js";

// ── Tunable constants ─────────────────────────────────────────────────

const MODEL = "claude-haiku-4-5-20251001";
const MAX_FLAGS_PER_RUN = 5;
const MAX_DISCOVERY_PER_RUN = 5;
const MIN_DISCOVERY_SIMILARITY = 0.9;
const MIN_OUTPUT_TASKS = 3;
const MAX_OUTPUT_TASKS = 5;
const MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_TOKEN_CEILING = 12_000;
const SKILL_SLUG = "daily-vault-review";

// ── Types ─────────────────────────────────────────────────────────────

export type DailyVaultReviewMode = "surface-only" | "writes-allowed";

export interface DailyVaultReviewOptions {
  mode: DailyVaultReviewMode;
  /** Per-run token cap. Exceeded → surface artifact, no LLM call. */
  tokenCeiling?: number;
}

interface FlagInput {
  id: string;
  flag_type: string;
  source_path: string | null;
  target_path: string | null;
  details: string;
}

interface DiscoveryInput {
  id: string;
  source_path: string;
  target_path: string;
  similarity: number;
  relationship: string | null;
}

/** Shape the model emits via the `propose_review_tasks` tool call. */
interface ProposedTask {
  title: string;
  body: string;
  artifactType: TaskArtifactType;
  notePath?: string;
  sourceFlagId?: string;
  noteChangeContent?: string;
}

// ── Anthropic client (testable) ───────────────────────────────────────

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

/** Inject a mock client for tests. Pass `null` to reset to a fresh real client. */
export function setClientForTesting(c: Anthropic | null): void {
  client = c;
}

// ── Input readers ─────────────────────────────────────────────────────

function readFlags(vaultId: string): FlagInput[] {
  return getDb()
    .prepare(
      `SELECT id, flag_type, source_path, target_path, details
         FROM graph_health_flags
        WHERE vault_id = ?
          AND resolved_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(vaultId, MAX_FLAGS_PER_RUN) as FlagInput[];
}

function readDiscovery(vaultId: string): DiscoveryInput[] {
  return getDb()
    .prepare(
      `SELECT id, source_path, target_path, similarity, relationship
         FROM discovery_results
        WHERE vault_id = ?
          AND dismissed_at IS NULL
          AND similarity >= ?
        ORDER BY similarity DESC, created_at DESC
        LIMIT ?`,
    )
    .all(
      vaultId,
      MIN_DISCOVERY_SIMILARITY,
      MAX_DISCOVERY_PER_RUN,
    ) as DiscoveryInput[];
}

// ── Prompt construction (cache-friendly static prefix) ────────────────

const STATIC_PROMPT_PREFIX = `You are the Grove daily-vault-review skill.

Your job: read the inputs below and propose between ${MIN_OUTPUT_TASKS} and ${MAX_OUTPUT_TASKS} short review tasks the vault owner can disposition in seconds (confirm / refine / dismiss / mark-stale).

Each task's body should name the specific notes and the specific question — concrete and short.

Rules:
- Prefer flags over discovery results when both inputs are present.
- If two inputs concern the same pair of notes, merge them into a single task.
- For surface-only runs, every artifactType MUST be "surface" — never propose a write.
- For writes-allowed runs, you may propose "note-change", "note-link", or "concept-merge" when the change is obvious (e.g., a duplicate-candidate flag with two clearly-mergeable concept notes).
- Always copy through the originating flag id via sourceFlagId when the task derives from a flag.

Respond by calling the \`propose_review_tasks\` tool with between ${MIN_OUTPUT_TASKS} and ${MAX_OUTPUT_TASKS} tasks.`;

function buildInputBlock(
  mode: DailyVaultReviewMode,
  flags: FlagInput[],
  discovery: DiscoveryInput[],
): string {
  const lines: string[] = [];
  lines.push(`Mode: ${mode}`);
  lines.push("");

  if (flags.length > 0) {
    lines.push("# Graph health flags (unresolved)");
    for (const f of flags) {
      lines.push(
        `- id=${f.id} type=${f.flag_type} source=${f.source_path ?? "-"} target=${f.target_path ?? "-"} details=${f.details}`,
      );
    }
    lines.push("");
  }

  if (discovery.length > 0) {
    lines.push("# Discovery results (cosine ≥ 0.9)");
    for (const d of discovery) {
      lines.push(
        `- id=${d.id} source=${d.source_path} target=${d.target_path} similarity=${d.similarity.toFixed(3)} relationship=${d.relationship ?? "-"}`,
      );
    }
    lines.push("");
  }

  if (flags.length === 0 && discovery.length === 0) {
    lines.push("# No flags or high-confidence discovery results today.");
    lines.push(
      "Propose 3 generic review tasks reminding the owner to write a journal entry, check Inbox/, and revisit a long-orphan concept.",
    );
  }

  return lines.join("\n");
}

const PROPOSE_TOOL: Anthropic.Tool = {
  name: "propose_review_tasks",
  description:
    "Propose 3–5 short review tasks for the vault owner to disposition.",
  input_schema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: MIN_OUTPUT_TASKS,
        maxItems: MAX_OUTPUT_TASKS,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            artifactType: {
              type: "string",
              enum: [
                "surface",
                "note-change",
                "note-link",
                "concept-merge",
              ],
            },
            notePath: {
              type: "string",
              description:
                "Vault-relative path of the note this task concerns, if any.",
            },
            sourceFlagId: {
              type: "string",
              description:
                "id of the graph_health_flags row this task derives from, if any.",
            },
            noteChangeContent: {
              type: "string",
              description:
                "Proposed full note body, populated only when artifactType is 'note-change' AND mode is 'writes-allowed'.",
            },
          },
          required: ["title", "body", "artifactType"],
        },
      },
    },
    required: ["tasks"],
  },
};

function buildRequest(
  mode: DailyVaultReviewMode,
  flags: FlagInput[],
  discovery: DiscoveryInput[],
): Anthropic.MessageCreateParamsNonStreaming {
  const dynamicBlock = buildInputBlock(mode, flags, discovery);
  return {
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    tools: [{ ...PROPOSE_TOOL, cache_control: { type: "ephemeral" } }],
    tool_choice: { type: "tool", name: PROPOSE_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: STATIC_PROMPT_PREFIX,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: dynamicBlock },
        ],
      },
    ],
  };
}

// ── Response parsing + mode enforcement ───────────────────────────────

function parseProposedTasks(response: Anthropic.Message): ProposedTask[] {
  const toolUse = response.content.find(
    (block): block is Extract<typeof block, { type: "tool_use" }> =>
      block.type === "tool_use" && block.name === PROPOSE_TOOL.name,
  );
  if (!toolUse) return [];
  const input = (toolUse.input ?? {}) as { tasks?: unknown };
  if (!Array.isArray(input.tasks)) return [];

  const out: ProposedTask[] = [];
  for (const raw of input.tasks) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.title !== "string" || typeof r.body !== "string") continue;
    if (typeof r.artifactType !== "string") continue;
    const artifactType = r.artifactType as TaskArtifactType;
    const task: ProposedTask = {
      title: r.title,
      body: r.body,
      artifactType,
    };
    if (typeof r.notePath === "string") task.notePath = r.notePath;
    if (typeof r.sourceFlagId === "string") task.sourceFlagId = r.sourceFlagId;
    if (typeof r.noteChangeContent === "string") {
      task.noteChangeContent = r.noteChangeContent;
    }
    out.push(task);
  }
  return out;
}

/** Downgrade any write-typed proposal to surface when mode forbids writes. */
function enforceMode(
  tasks: ProposedTask[],
  mode: DailyVaultReviewMode,
): ProposedTask[] {
  if (mode === "writes-allowed") return tasks;
  return tasks.map((t) =>
    t.artifactType === "surface"
      ? t
      : { ...t, artifactType: "surface" as const, noteChangeContent: undefined },
  );
}

// ── Child task insertion ──────────────────────────────────────────────

function insertChildTasks(
  vault: VaultContext,
  tasks: ProposedTask[],
  provenance: GroveProvenance,
): string[] {
  const db = getVaultDb(vault.vaultId);
  const insertTask = db.prepare(
    `INSERT INTO tasks (id, skill_slug, state, title, body, source_note_path, source_flag_id)
     VALUES (?, ?, 'review', ?, ?, ?, ?)`,
  );
  const insertResult = db.prepare(
    `INSERT INTO task_results (task_id, artifact_json, note_change_json, provenance_json)
     VALUES (?, ?, ?, ?)`,
  );

  const ids: string[] = [];
  const tx = db.transaction(() => {
    for (const t of tasks) {
      const id = `task_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      insertTask.run(
        id,
        SKILL_SLUG,
        t.title,
        t.body,
        t.notePath ?? null,
        t.sourceFlagId ?? null,
      );

      const artifact: TaskResult["artifact"] = { type: t.artifactType };
      if (t.notePath) artifact.notePath = t.notePath;
      if (t.artifactType === "surface") artifact.surfaceText = t.body;

      const noteChange =
        t.artifactType === "note-change" && t.noteChangeContent
          ? JSON.stringify({ content: t.noteChangeContent })
          : null;

      insertResult.run(
        id,
        JSON.stringify(artifact),
        noteChange,
        JSON.stringify(provenance),
      );
      ids.push(id);
    }
  });
  tx();
  return ids;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Run the daily-vault-review skill once. Returns the SUMMARY artifact
 * for the originating tick task; child review tasks are inserted into
 * the per-vault state.db as a side effect (one row per proposed task,
 * plus a matching task_results row).
 *
 * Hard-fails on cost ceiling exceeded — returns a surface artifact, no
 * LLM call. The caller (worker) records the summary; the user sees the
 * "vault too large for this tick" copy in the dashboard.
 */
export async function runDailyVaultReview(
  vault: VaultContext,
  options: DailyVaultReviewOptions,
): Promise<TaskResult> {
  const { mode } = options;
  const tokenCeiling = options.tokenCeiling ?? DEFAULT_TOKEN_CEILING;

  const flags = readFlags(vault.vaultId);
  const discovery = readDiscovery(vault.vaultId);

  const estimate = estimateRunCost({
    flagsCount: flags.length,
    discoveryCount: discovery.length,
    outputTasks: MAX_OUTPUT_TASKS,
  });

  if (exceededCeiling(estimate, tokenCeiling)) {
    // Hard fail. Surface artifact, no LLM call. Scope Cop SHRINK #1:
    // never split-and-sample — either the run fits or the user sees a
    // clear "too large for this tick" message and the tick rolls
    // forward without a half-result.
    return {
      artifact: {
        type: "surface",
        surfaceText:
          `Daily vault review skipped this tick — estimated cost ` +
          `(${estimate} tokens) exceeds the ceiling (${tokenCeiling}). ` +
          `${flags.length} unresolved flags + ${discovery.length} high-` +
          `confidence discovery rows would have been processed. ` +
          `No LLM call was made. The next scheduled run will retry; ` +
          `narrow the inputs (resolve flags, dismiss noise in discovery) ` +
          `to fit under the ceiling.`,
      },
      provenance: {
        voice: "perishable",
        by: "system",
        writtenAt: new Date().toISOString(),
        reason: "cost_ceiling_exceeded",
      },
    };
  }

  let response: Anthropic.Message;
  try {
    response = await getClient().messages.create(buildRequest(mode, flags, discovery));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      artifact: {
        type: "surface",
        surfaceText: `Daily vault review failed: ${message}`,
      },
      provenance: {
        voice: "perishable",
        by: "system",
        writtenAt: new Date().toISOString(),
        reason: "llm_error",
      },
    };
  }

  const usage = (response.usage ?? {}) as {
    input_tokens?: number;
    output_tokens?: number;
  };
  recordRunCost(
    SKILL_SLUG,
    (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
  );

  const proposed = enforceMode(parseProposedTasks(response), mode);
  if (proposed.length === 0) {
    return {
      artifact: {
        type: "surface",
        surfaceText:
          "Daily vault review produced no actionable tasks this tick.",
      },
      provenance: {
        voice: "perishable",
        by: MODEL,
        writtenAt: new Date().toISOString(),
        reason: "empty_proposal",
      },
    };
  }

  const childProvenance: GroveProvenance = {
    voice: "perishable",
    by: MODEL,
    writtenAt: new Date().toISOString(),
    reason: "daily-vault-review proposal",
  };
  const childIds = insertChildTasks(vault, proposed, childProvenance);

  const summarySurface =
    `Generated ${childIds.length} review task` +
    `${childIds.length === 1 ? "" : "s"} from ` +
    `${flags.length} unresolved flag${flags.length === 1 ? "" : "s"} ` +
    `+ ${discovery.length} discovery result` +
    `${discovery.length === 1 ? "" : "s"} (mode=${mode}). ` +
    `Disposition them from the dashboard's review pane.`;

  return {
    artifact: { type: "surface", surfaceText: summarySurface },
    provenance: {
      voice: "perishable",
      by: MODEL,
      writtenAt: new Date().toISOString(),
      reason: "daily-vault-review summary",
    },
  };
}

// ── SkillExecutor adapter (worker contract) ───────────────────────────

function readModeFromEnv(): DailyVaultReviewMode {
  const raw = process.env.GROVE_DAILY_REVIEW_MODE;
  return raw === "writes-allowed" ? "writes-allowed" : "surface-only";
}

function readCeilingFromEnv(): number {
  const raw = process.env.GROVE_DAILY_REVIEW_TOKEN_CEILING;
  if (!raw) return DEFAULT_TOKEN_CEILING;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOKEN_CEILING;
}

/**
 * Worker-side entry point. The v2-task-run worker loop loads this
 * symbol via `loadSkillModule('daily-vault-review')` and calls it with
 * the originating tick task. Returns an `ExecutorResult` so the worker
 * writes the summary to `task_results` and transitions the originating
 * task to `review` for the user to acknowledge.
 */
export async function run(
  vault: VaultContext,
  _task: TaskRow,
): Promise<ExecutorResult> {
  const result = await runDailyVaultReview(vault, {
    mode: readModeFromEnv(),
    tokenCeiling: readCeilingFromEnv(),
  });
  return {
    artifact: result.artifact,
    provenance: result.provenance,
    finalState: "review",
  };
}

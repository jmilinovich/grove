/**
 * S-INBOX-10 — refine-handler stub skill.
 *
 * This skill exists ONLY so the scheduler can dispatch refine tasks
 * spawned by `/review {kind:"refine"}` (or legacy
 * `{action:"refine"}`) without crashing. Today it just marks the task
 * done with a surface artifact that quotes the operator's refinement
 * instruction. The actual refinement-execution logic (regenerate the
 * suggestion with the instruction folded in) is a future work item —
 * when that ships, replace this stub.
 *
 * Hard rule: the executor MUST NOT throw on any task body. Tasks
 * spawned by the V2 dispatcher pass `{original_decision_id, refinement}`
 * as a JSON-encoded body, but the executor tolerates anything (legacy
 * tasks, malformed bodies, null bodies) so a bad body never poisons
 * the scheduler.
 */

import type { TaskRow } from "../db-types.js";
import type { ExecutorResult } from "../v2-task-run.js";
import type { GroveProvenance } from "../v2-tasks.js";
import type { VaultContext } from "../vault-router.js";

interface RefineBody {
  original_decision_id?: string | null;
  refinement?: string;
}

/**
 * Best-effort parse of the refine task body. Returns an empty struct on
 * any failure — the executor must not throw on a malformed body.
 */
function parseRefineBody(body: string | null): RefineBody {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const out: RefineBody = {};
      if (typeof obj.original_decision_id === "string") {
        out.original_decision_id = obj.original_decision_id;
      } else if (obj.original_decision_id === null) {
        out.original_decision_id = null;
      }
      if (typeof obj.refinement === "string") {
        out.refinement = obj.refinement;
      }
      return out;
    }
  } catch {
    // Body wasn't JSON — fall through to empty struct. Surface the raw
    // body in the artifact so an operator can still see what was sent.
  }
  return {};
}

/**
 * Worker-side entry point (`SkillExecutor` contract). The scheduler
 * loads this via `loadSkillModule('refine-handler')` and invokes it
 * with the originating task row.
 *
 * Returns a `surface` artifact summarizing the refinement so it shows
 * up in the cleared-tasks lane with the operator's instruction visible.
 */
export async function run(
  _vault: VaultContext,
  task: TaskRow,
): Promise<ExecutorResult> {
  const parsed = parseRefineBody(task.body);
  const refinement = parsed.refinement ?? "(no refinement text)";
  const originRef = parsed.original_decision_id
    ? ` (original decision: ${parsed.original_decision_id})`
    : "";
  const surfaceText =
    `Refinement logged (not yet executed)${originRef}: ${refinement}`;

  const provenance: GroveProvenance = {
    voice: "perishable",
    by: "grove-skill/refine-handler",
    writtenAt: new Date().toISOString(),
    reason: "refine-handler stub — real execution lands in a future PR",
  };

  return {
    artifact: { type: "surface", surfaceText },
    provenance,
    finalState: "done",
  };
}

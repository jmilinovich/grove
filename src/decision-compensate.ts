/**
 * S-INBOX-5 — forward-only compensation executor for Inbox v2.
 *
 * `compensateDecision(vaultPath, vaultId, decisionId, newChoice?)` is the
 * one entry point in this module. Given a provisional decision id and an
 * optional new ReviewOption, it:
 *
 *   1. Loads the original Decision from the per-vault `decisions`
 *      projection and validates `status === 'provisional'` (a decision
 *      already in `confirmed` or `compensated` is a no-op error — we
 *      refuse to compensate twice or unwind a confirmation).
 *
 *   2. Computes the inverse mutation per `decision.type`:
 *
 *        - link            → strip the wikilink the original added from
 *                            `source_path`. If `newChoice` resolves to a
 *                            different candidate, ALSO add a wikilink to
 *                            that candidate (refine-by-pick).
 *
 *        - disambiguation  → same shape as link — the original added a
 *                            link to whichever candidate the chosen
 *                            option pointed at; the inverse strips it
 *                            and optionally relinks to the new choice's
 *                            candidate.
 *
 *        - enrichment      → restore `payload.prior_content` to
 *                            `payload.target_path`. `newChoice` is a
 *                            no-op for enrichment (we don't model
 *                            "rewrite-with-instruction" inline —
 *                            refinement spawns a fresh task per spec
 *                            S-INBOX-10 / D-6, not a payload swap).
 *
 *   3. Records a NEW Decision (forward-only) describing the resulting
 *      state, marks the original as `compensated` (state.db UPDATE +
 *      a snapshot JSONL line so projection-replay reaches the same
 *      final state), and emits a single git commit carrying:
 *
 *        Provenance-* trailers           (perishable, by claude)
 *        Compensates-Decision-Id: <orig> (links the commit to its parent decision)
 *        Decision-Id: <new>              (the compensation's own decision id)
 *
 * Hard rules (from docs/inbox-v2-spec.md § "Rollback is forward"):
 *
 *   - Never calls `git revert`.
 *   - Never resets, force-pushes, or otherwise rewrites history.
 *   - Cascade is strictly "just X" (spec D-5): downstream work that
 *     built on the original decision stays as-is. Operators who want
 *     transitive corrections compensate those decisions explicitly.
 *
 * The compensation Decision itself is `status='confirmed'` on emission
 * (it's the action the operator just chose, not a fresh suggestion).
 * It's never itself compensated by this module — re-rolling-back would
 * need a separate user action against the new id.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { getVaultDb } from "./db-per-vault.js";
import type { DecisionRow } from "./db-types.js";
import { appendDecisionEvent } from "./decisions-log.js";
import { commitSkillRun, recordDecision } from "./decision-writer.js";
import {
  composeCommitMessage,
  provenanceToTrailers,
  type Trailers,
} from "./provenance.js";
import type {
  Decision,
  DecisionPayload,
  DisambiguationPayload,
  EnrichmentPayload,
  LinkPayload,
  ReviewOption,
} from "./v2-decisions.js";
import { readNoteFile, writeNoteFile } from "./vault-ops.js";

const DECISIONS_LOG_REL = ".grove/decisions.jsonl";

/** Result of a successful compensation. */
export interface CompensationResult {
  compensatingDecisionId: string;
  commitSha: string;
  affectedPaths: string[];
}

/**
 * Compute and apply the inverse mutation for `decisionId`, optionally
 * re-applying with a different chosen option. Emits one new git commit.
 *
 * Throws when:
 *   - the decision id is not present in the projection
 *   - the original decision is not in `provisional` status
 *   - the payload is missing required fields (e.g. enrichment without
 *     `prior_content`) — this is a schema bug surfaced loudly rather
 *     than papered over by guessing a restore value
 */
export async function compensateDecision(
  vaultPath: string,
  vaultId: string,
  decisionId: string,
  newChoice?: ReviewOption,
): Promise<CompensationResult> {
  const original = loadDecision(vaultId, decisionId);
  if (original.status !== "provisional") {
    throw new Error(
      `compensateDecision: decision ${decisionId} is in status '${original.status}', ` +
        `only 'provisional' decisions can be compensated`,
    );
  }

  // Per-type inverse mutation. Each branch returns the set of vault-
  // relative paths that were modified — those go into the commit `paths`
  // arg alongside `.grove/decisions.jsonl` (which `recordDecision`
  // appends to under the hood).
  let affectedPaths: string[];
  let compensationPayload: DecisionPayload;
  switch (original.type) {
    case "link": {
      const result = compensateLink(
        vaultPath,
        original.payload as LinkPayload,
        newChoice,
      );
      affectedPaths = result.affectedPaths;
      compensationPayload = result.payload;
      break;
    }
    case "disambiguation": {
      const result = compensateDisambiguation(
        vaultPath,
        original.payload as DisambiguationPayload,
        original.chosenOptionId,
        newChoice,
      );
      affectedPaths = result.affectedPaths;
      compensationPayload = result.payload;
      break;
    }
    case "enrichment": {
      const result = compensateEnrichment(
        vaultPath,
        original.payload as EnrichmentPayload,
      );
      affectedPaths = result.affectedPaths;
      compensationPayload = result.payload;
      break;
    }
    default: {
      // Exhaustiveness guard — if a new SuggestionType is added we want
      // the build to surface it here, not silently no-op.
      const _exhaustive: never = original.type;
      throw new Error(
        `compensateDecision: unhandled decision type ${JSON.stringify(_exhaustive)}`,
      );
    }
  }

  // Build the compensation Decision. The chosenOptionId reflects what
  // the user actually picked: the new option id if provided, else a
  // synthetic "rollback" sentinel so the chosen_option_id column stays
  // NOT-NULL-compatible. The options list mirrors the original so the
  // event-log entry is self-describing on replay.
  const now = new Date().toISOString();
  const compensationId = newCompensationId(now);
  const chosenOptionId = newChoice?.id ?? "rollback";
  const compensation: Decision = {
    id: compensationId,
    type: original.type,
    skillRunId: `SR-compensate-${original.id}`,
    taskId: null,
    createdAt: now,
    status: "confirmed",
    payload: compensationPayload,
    options: original.options,
    chosenOptionId,
    affectedPaths,
    compensatedBy: null,
  };

  // Order matters: insert the new Decision row + append JSONL line
  // FIRST (so a failed update of the original doesn't leave a half-
  // recorded compensation), then mark the original compensated.
  recordDecision(vaultPath, vaultId, compensation);
  markOriginalCompensated(vaultPath, vaultId, original, compensationId);

  // Build the commit message: provenance trailers + Compensates-Decision-Id.
  // commitSkillRun layers on Decision-Id: <compensationId> for us.
  const trailers: Trailers = {
    ...provenanceToTrailers({
      voice: "perishable",
      by: "claude-opus-4-7",
      written_at: now,
      reason: `compensate ${original.id}${newChoice ? ` → ${chosenOptionId}` : " (rollback)"}`,
    }),
    "Compensates-Decision-Id": [original.id],
  };
  const subject = `grove: compensate ${original.type} decision ${original.id}`;
  const message = composeCommitMessage(subject, trailers);

  // Paths: every vault file we touched, plus the JSONL log (required by
  // commitSkillRun when decisionIds is non-empty).
  const commitPaths = Array.from(new Set([DECISIONS_LOG_REL, ...affectedPaths]));
  const commitSha = await commitSkillRun(vaultPath, commitPaths, message, [
    compensationId,
  ]);

  return {
    compensatingDecisionId: compensationId,
    commitSha,
    affectedPaths,
  };
}

// ── Per-type compensators ────────────────────────────────────────────

interface CompensationOutcome {
  affectedPaths: string[];
  payload: DecisionPayload;
}

/**
 * Inverse of a `link` decision. The original added `[[<target>]]` to
 * `source_path`; we strip that link, optionally relinking to a new
 * candidate when `newChoice` resolves to one. The compensation payload
 * mirrors LinkPayload so future readers see the resulting target.
 */
function compensateLink(
  vaultPath: string,
  payload: LinkPayload,
  newChoice: ReviewOption | undefined,
): CompensationOutcome {
  const sourceAbs = join(vaultPath, payload.source_path);
  const before = readNoteFile(sourceAbs);
  const stripped = removeWikilink(before, payload.target_path);

  const newTargetPath = newChoice
    ? resolveOptionTargetPath(newChoice, payload.candidates)
    : null;

  const after = newTargetPath
    ? addWikilink(stripped, newTargetPath)
    : stripped;

  writeNoteFile(sourceAbs, after);

  const compensationPayload: LinkPayload = {
    source_path: payload.source_path,
    surface_form: payload.surface_form,
    target_path: newTargetPath ?? "",
    candidates: payload.candidates,
  };

  return {
    affectedPaths: [payload.source_path],
    payload: compensationPayload,
  };
}

/**
 * Inverse of a `disambiguation` decision. The original picked one
 * candidate (via `chosenOptionId`) and linked the source to it; we
 * strip that link. If `newChoice` points at a different candidate we
 * also add a link to the new pick — that's the "refine by picking
 * another option" path that S-INBOX-10 dispatches into.
 */
function compensateDisambiguation(
  vaultPath: string,
  payload: DisambiguationPayload,
  originalChosenOptionId: string,
  newChoice: ReviewOption | undefined,
): CompensationOutcome {
  // The original target is whatever candidate the original chosenOptionId
  // pointed at. Same opt-N → candidates[N-1] convention used by the link
  // skill (S-INBOX-7) and the disambiguation skill (S-INBOX-6).
  const originalTargetPath = resolveOptionIdToCandidatePath(
    originalChosenOptionId,
    payload.candidates,
  );
  const sourceAbs = join(vaultPath, payload.source_path);
  const before = readNoteFile(sourceAbs);
  const stripped = originalTargetPath
    ? removeWikilink(before, originalTargetPath)
    : before;

  const newTargetPath = newChoice
    ? resolveOptionTargetPath(
        newChoice,
        payload.candidates.map((c) => ({ note_path: c.note_path })),
      )
    : null;
  const after = newTargetPath
    ? addWikilink(stripped, newTargetPath)
    : stripped;

  writeNoteFile(sourceAbs, after);

  // For the compensation payload we keep the disambiguation shape — the
  // surface form and candidate list are still meaningful context for a
  // future re-look. If a new target was chosen, record it as the first
  // candidate so the payload's "what we did" reading stays accurate.
  const compensationCandidates = newTargetPath
    ? [
        { note_path: newTargetPath, signals: ["compensation-chosen"] },
        ...payload.candidates.filter((c) => c.note_path !== newTargetPath),
      ]
    : payload.candidates;
  const compensationPayload: DisambiguationPayload = {
    source_path: payload.source_path,
    surface_form: payload.surface_form,
    candidates: compensationCandidates,
  };

  return {
    affectedPaths: [payload.source_path],
    payload: compensationPayload,
  };
}

/**
 * Inverse of an `enrichment` decision. The original replaced the note
 * body at `target_path` with `payload.new_content`; we restore
 * `payload.prior_content`. `newChoice` is ignored — the spec routes
 * "rewrite with my instruction" through a new spawned task, not an
 * inline payload swap (see docs/inbox-v2-spec.md § "Refine = free
 * instruction" and S-INBOX-10).
 */
function compensateEnrichment(
  vaultPath: string,
  payload: EnrichmentPayload,
): CompensationOutcome {
  if (typeof payload.prior_content !== "string") {
    // S-INBOX-1 schema marks prior_content required precisely so this
    // can never happen at runtime. If it does, we'd be silently
    // discarding pre-decision content — refuse loudly so the bug is
    // findable.
    throw new Error(
      `compensateDecision (enrichment): payload is missing prior_content; ` +
        `cannot restore ${payload.target_path}`,
    );
  }
  const targetAbs = join(vaultPath, payload.target_path);
  writeNoteFile(targetAbs, payload.prior_content);

  const compensationPayload: EnrichmentPayload = {
    target_path: payload.target_path,
    // After compensation the file holds prior_content again, and the
    // "new" content from the original is what's been undone. Recording
    // both keeps the JSONL self-describing for replay.
    prior_content: payload.new_content,
    new_content: payload.prior_content,
  };

  return {
    affectedPaths: [payload.target_path],
    payload: compensationPayload,
  };
}

// ── Decision lookup + status update ─────────────────────────────────

function loadDecision(vaultId: string, decisionId: string): Decision {
  const db = getVaultDb(vaultId);
  const row = db
    .prepare("SELECT * FROM decisions WHERE id = ?")
    .get(decisionId) as DecisionRow | undefined;
  if (!row) {
    throw new Error(
      `compensateDecision: no decision found with id ${JSON.stringify(decisionId)}`,
    );
  }
  return rowToDecision(row);
}

function rowToDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    type: row.type as Decision["type"],
    skillRunId: row.skill_run_id,
    taskId: row.task_id,
    createdAt: row.created_at,
    status: row.status as Decision["status"],
    payload: JSON.parse(row.payload_json) as DecisionPayload,
    options: JSON.parse(row.options_json) as ReviewOption[],
    chosenOptionId: row.chosen_option_id,
    affectedPaths: JSON.parse(row.affected_paths_json) as string[],
    compensatedBy: row.compensated_by,
  };
}

/**
 * Flip the original decision to compensated state — both in state.db
 * AND in the JSONL log (as a fresh snapshot line). Without the JSONL
 * snapshot, a later projection rebuild from the log would read the
 * original event and reinstate `status='provisional'`, losing the
 * compensation record.
 */
function markOriginalCompensated(
  vaultPath: string,
  vaultId: string,
  original: Decision,
  compensationId: string,
): void {
  const db = getVaultDb(vaultId);
  db.prepare(
    `UPDATE decisions SET status = ?, compensated_by = ? WHERE id = ?`,
  ).run("compensated", compensationId, original.id);

  // Append-only event-log snapshot of the now-compensated original.
  // Replay (S-INBOX-4) uses INSERT OR REPLACE so the later snapshot wins.
  const snapshot: Decision = {
    ...original,
    status: "compensated",
    compensatedBy: compensationId,
  };
  appendDecisionEvent(vaultPath, snapshot);
}

// ── ID generation ───────────────────────────────────────────────────

/**
 * Generate a new compensation decision id. Format: `D-YYYY-MM-DD-<short>`
 * — matches the spec's example ids and is lexicographically sortable by
 * date, with a uuid suffix for collision resistance across same-day
 * compensations.
 */
function newCompensationId(nowIso: string): string {
  const datePart = nowIso.slice(0, 10);
  const short = randomUUID().replace(/-/g, "").slice(0, 8);
  return `D-${datePart}-${short}`;
}

// ── Option → candidate path resolution ───────────────────────────────

/**
 * Resolve a `ReviewOption.id` to one of the candidate paths in a
 * payload. Convention (locked across S-INBOX-6/7 skills): option ids
 * are shaped `opt-<N>` where N is 1-based and indexes into
 * `payload.candidates`. Options beyond `candidates.length` represent
 * "no link / keep ambiguous" — those return null.
 *
 * The function is permissive: a malformed id (non-numeric, out of
 * range) returns null rather than throwing, because compensation
 * should still be possible when the operator picks a "do nothing"
 * style option.
 */
function resolveOptionIdToCandidatePath(
  optionId: string,
  candidates: ReadonlyArray<{ note_path: string }>,
): string | null {
  const match = /^opt-(\d+)$/.exec(optionId);
  if (!match) return null;
  const idx = Number.parseInt(match[1]!, 10) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) return null;
  return candidates[idx]!.note_path;
}

/**
 * Resolve the target path for a `newChoice` option, used when refining
 * a link/disambiguation by switching to a different candidate. Returns
 * null when the option doesn't map to a candidate (e.g. "no link").
 */
function resolveOptionTargetPath(
  option: ReviewOption,
  candidates: ReadonlyArray<{ note_path: string }>,
): string | null {
  return resolveOptionIdToCandidatePath(option.id, candidates);
}

// ── Wikilink editing primitives ─────────────────────────────────────
//
// Lightweight, idempotent edits over note content. We deliberately do
// not reuse `updateWikilinks` from vault-ops.ts — that walks the entire
// vault and rewrites in place, which is more than compensation needs
// and would couple this module to the global rewrite path.

/**
 * Remove every wikilink in `content` whose target resolves to
 * `targetPath` (either as full vault-relative path with .md stripped,
 * or as basename). Whitespace immediately surrounding the removed link
 * is collapsed minimally so the resulting prose doesn't leave a
 * dangling double space, but paragraph structure is preserved.
 *
 * Match shapes (case-sensitive on the target):
 *   [[<targetNoExt>]]            [[<targetNoExt>|display]]
 *   [[<basename>]]               [[<basename>|display]]
 *
 * Idempotent: removing a link that isn't there is a no-op.
 */
export function removeWikilink(content: string, targetPath: string): string {
  if (!targetPath) return content;
  const noExt = targetPath.replace(/\.md$/, "");
  const basename = noExt.split("/").pop() ?? noExt;
  const targets = new Set<string>([noExt, basename]);

  const wikilinkRe = /\[\[([^\]|\n]+)(?:\|[^\]\n]+)?\]\]/g;
  // First pass: replace the link with a single space placeholder so we
  // can then collapse runs of whitespace cleanly without ripping out
  // intentional newlines.
  const out = content.replace(wikilinkRe, (match, raw: string) => {
    const trimmed = raw.trim();
    if (targets.has(trimmed)) {
      return ""; // strip the link entirely
    }
    return match;
  });

  // Tidy: collapse "  " left behind on the same line, but preserve
  // newlines so list/paragraph structure stays intact.
  return out.replace(/[^\S\n]{2,}/g, " ").replace(/[^\S\n]+(\n)/g, "$1");
}

/**
 * Append a wikilink to `content` referencing `targetPath`. Used when
 * compensation includes a `newChoice` that points at a different
 * candidate (refine-by-pick). The link is added on a new line at the
 * end of the file so it's deterministic for tests and easy to spot in
 * a diff; downstream link-tidying skills can re-flow it.
 *
 * Idempotent: if the file already has a link to `targetPath`, no
 * change is made.
 */
export function addWikilink(content: string, targetPath: string): string {
  const noExt = targetPath.replace(/\.md$/, "");
  const basename = noExt.split("/").pop() ?? noExt;
  // Idempotency check: does a wikilink to this target already exist?
  const wikilinkRe = /\[\[([^\]|\n]+)(?:\|[^\]\n]+)?\]\]/g;
  for (const m of content.matchAll(wikilinkRe)) {
    const trimmed = m[1]!.trim();
    if (trimmed === noExt || trimmed === basename) return content;
  }
  const trailingNewline = content.endsWith("\n") ? "" : "\n";
  return `${content}${trailingNewline}[[${basename}]]\n`;
}

/**
 * P21-4 — v2 task-detail endpoint + shared throughput compute.
 *
 * Reads-side of the v2 dashboard contract from grove-www's
 * `src/lib/grove-api.v2.types.ts`. Two exports:
 *
 *   - `handleV2TaskDetail(req, res, vault, taskId)` — `GET /v/<slug>/v1/tasks/<id>`.
 *     Joins per-vault `tasks` + `task_results` (state.db) with `note_blame`
 *     (control.db, via ATTACH) when the result's artifact is a note-change.
 *
 *   - `computeThroughput(vaultId)` — shared helper consumed by P21-3's
 *     BacklogPayload (the standalone `/v1/throughput` endpoint was CUT per
 *     Scope Cop; throughput now lives inside the backlog payload only).
 *
 * Storage model:
 *   - `tasks`, `task_results` live in per-vault `state.db` (P21-1/P21-2).
 *   - `task_results.provenance_json` is a single JSON column carrying the
 *     full `GroveProvenance` object — parsed back to the typed shape on read.
 *   - `note_blame` lives in the shared control db (`grove.db`). The detail
 *     handler ATTACHes the control db onto the vault connection so the
 *     join is a single round-trip query without juggling two pools.
 *
 * Field names track grove-www's camelCase type contract — SELECT column
 * aliases do the snake_case → camelCase rename so the row shape passes
 * through to JSON without a hand-converted mapper.
 */

import type Database from "better-sqlite3";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "./db.js";
import { getVaultDb } from "./db-per-vault.js";
import type { VaultContext } from "./vault-router.js";

// ── Response types (extensions to grove-www's grove-api.v2.types.ts) ──

type Voice = "durable" | "perishable" | "legacy-unknown";

interface GroveProvenance {
  voice: Voice;
  by?: string;
  writtenAt?: string;
  source?: string;
  basis?: string[];
  reason?: string;
}

type TaskArtifactType =
  | "surface"
  | "note-change"
  | "note-create"
  | "note-link"
  | "concept-merge";

interface TaskArtifact {
  type: TaskArtifactType;
  notePath?: string;
  surfaceText?: string;
}

interface ProvenanceBlameEntry {
  lineStart: number;
  lineEnd: number;
  provenance: GroveProvenance;
}

interface TaskResultPayload {
  artifact: TaskArtifact;
  provenance: GroveProvenance;
  /**
   * Per-segment blame for the affected note. Only populated when
   * `artifact.type === 'note-change'` and a `note_blame` row exists for
   * the artifact's `notePath`. PLAN.md P21-4 acceptance criterion:
   * `result.provenance_blame` — exposed as camelCase `provenanceBlame`
   * to match the rest of the v2 API surface.
   */
  provenanceBlame?: ProvenanceBlameEntry[];
}

interface TaskDetailPayload {
  id: string;
  skillId: string;
  title: string;
  description: string;
  state: string;
  scheduledFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
  estimatedMinutes: number;
  actualMinutes: number | null;
  result: TaskResultPayload | null;
  sourceNotes?: string[];
}

// ── Internal row shapes (snake-case → camelCase done by SELECT aliases) ──

interface TaskSelectRow {
  id: string;
  skillId: string;
  title: string;
  description: string | null;
  state: string;
  scheduledFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  source_note_path: string | null;
}

interface TaskResultSelectRow {
  artifact_json: string;
  note_change_json: string | null;
  provenance_json: string | null;
}

interface NoteBlameRow {
  blame_json: string;
}

interface BlameSegmentRow {
  line_start: number;
  line_end: number;
  voice: Voice;
  by: string;
  written_at: string;
  basis?: string[];
  source?: string;
  reason?: string;
}

// ── ATTACH helpers ─────────────────────────────────────────────────────

/**
 * Idempotently ATTACH the control db (`grove.db`) onto the vault's
 * state.db connection under the alias `control`. The pool reuses the
 * same connection across requests so subsequent calls are a no-op —
 * the `database_list` pragma reports whether the alias is already in
 * place.
 *
 * The control db path is read from the live `getDb()` handle's `name`
 * property so tests that swap `GROVE_DB_PATH` via env vars pick up the
 * test-scoped path automatically.
 */
export function ensureControlAttached(vaultDb: Database.Database): void {
  const attached = vaultDb.pragma("database_list") as Array<{ name: string }>;
  if (attached.some((row) => row.name === "control")) return;
  const controlPath = getDb().name;
  // Path comes from a trusted env var, not request input — no injection
  // surface. Better-sqlite3 doesn't bind parameters into ATTACH.
  vaultDb.exec(`ATTACH DATABASE '${controlPath.replace(/'/g, "''")}' AS control`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ── handleV2TaskDetail ─────────────────────────────────────────────────

/**
 * `GET /v/<slug>/v1/tasks/<id>` — task detail.
 *
 * Steps:
 *   1. SELECT the task row from the vault's state.db (404 if missing).
 *   2. SELECT the matching task_results row (may be null — a pending
 *      task that hasn't run yet has no result).
 *   3. If the result's artifact is a `note-change` with a notePath,
 *      open a brief transaction on the vault db, ATTACH the control db,
 *      and join `control.note_blame` for the affected note path. The
 *      blame_json column is decoded into per-segment entries and
 *      returned as `result.provenanceBlame`.
 *
 * Auth has already been enforced at the proxy.ts `vaultV1Match` block —
 * by the time we land here `vault.vaultId` is the URL slug's vault and
 * the bearer token authorizes the caller to read it.
 */
export function handleV2TaskDetail(
  _req: IncomingMessage,
  res: ServerResponse,
  vault: VaultContext,
  taskId: string,
): void {
  const vaultDb = getVaultDb(vault.vaultId);

  const taskRow = vaultDb
    .prepare(
      `SELECT id,
              skill_slug          AS skillId,
              title,
              body                AS description,
              state,
              scheduled_for       AS scheduledFor,
              started_at          AS startedAt,
              completed_at        AS completedAt,
              estimated_minutes   AS estimatedMinutes,
              actual_minutes      AS actualMinutes,
              source_note_path
         FROM tasks
        WHERE id = ?
        LIMIT 1`,
    )
    .get(taskId) as TaskSelectRow | undefined;

  if (!taskRow) {
    sendJson(res, 404, { error: "task_not_found" });
    return;
  }

  const resultRow = vaultDb
    .prepare(
      `SELECT artifact_json, note_change_json, provenance_json
         FROM task_results
        WHERE task_id = ?
        LIMIT 1`,
    )
    .get(taskId) as TaskResultSelectRow | undefined;

  let result: TaskResultPayload | null = null;

  if (resultRow) {
    let artifact: TaskArtifact;
    try {
      artifact = JSON.parse(resultRow.artifact_json) as TaskArtifact;
    } catch {
      // Corrupt artifact_json shouldn't happen — writes go through a
      // typed code path — but if it does, surface the task without a
      // result rather than 500'ing the detail page.
      artifact = { type: "surface" };
    }

    const provenance: GroveProvenance = resultRow.provenance_json
      ? safeParseProvenance(resultRow.provenance_json)
      : { voice: "legacy-unknown" };

    result = { artifact, provenance };

    if (artifact.type === "note-change" && typeof artifact.notePath === "string") {
      const blame = readBlameForNote(vaultDb, artifact.notePath);
      if (blame.length > 0) result.provenanceBlame = blame;
    }
  }

  const payload: TaskDetailPayload = {
    id: taskRow.id,
    skillId: taskRow.skillId,
    title: taskRow.title,
    description: taskRow.description ?? "",
    state: taskRow.state,
    scheduledFor: taskRow.scheduledFor,
    startedAt: taskRow.startedAt,
    completedAt: taskRow.completedAt,
    estimatedMinutes: taskRow.estimatedMinutes ?? 0,
    actualMinutes: taskRow.actualMinutes,
    result,
  };
  if (taskRow.source_note_path) {
    payload.sourceNotes = [taskRow.source_note_path];
  }

  sendJson(res, 200, payload);
}

function safeParseProvenance(json: string): GroveProvenance {
  try {
    const parsed = JSON.parse(json) as Partial<GroveProvenance>;
    if (parsed && typeof parsed === "object" && typeof parsed.voice === "string") {
      return parsed as GroveProvenance;
    }
  } catch {
    // fall through
  }
  return { voice: "legacy-unknown" };
}

/**
 * Pull per-segment blame rows for `notePath` from `control.note_blame`
 * via ATTACH, projecting `BlameSegment[]` JSON into the v2-shaped
 * `ProvenanceBlameEntry[]`. Returns `[]` on cache miss or corrupt JSON
 * — the strip just won't render rather than failing the detail page.
 *
 * ATTACH happens once per pooled connection (see `ensureControlAttached`);
 * the SELECT then reads the latest cached blame row for the path.
 */
function readBlameForNote(
  vaultDb: Database.Database,
  notePath: string,
): ProvenanceBlameEntry[] {
  ensureControlAttached(vaultDb);

  const blameRow = vaultDb
    .prepare(
      `SELECT blame_json
         FROM control.note_blame
        WHERE path = ?
        ORDER BY computed_at DESC
        LIMIT 1`,
    )
    .get(notePath) as NoteBlameRow | undefined;

  if (!blameRow) return [];

  let segments: BlameSegmentRow[];
  try {
    segments = JSON.parse(blameRow.blame_json) as BlameSegmentRow[];
  } catch {
    return [];
  }
  if (!Array.isArray(segments)) return [];

  return segments.map((seg) => {
    const provenance: GroveProvenance = { voice: seg.voice };
    if (seg.by) provenance.by = seg.by;
    if (seg.written_at) provenance.writtenAt = seg.written_at;
    if (seg.source) provenance.source = seg.source;
    if (seg.basis) provenance.basis = seg.basis;
    if (seg.reason) provenance.reason = seg.reason;
    return {
      lineStart: seg.line_start,
      lineEnd: seg.line_end,
      provenance,
    };
  });
}


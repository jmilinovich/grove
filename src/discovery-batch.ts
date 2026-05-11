/**
 * P7-COST-5 — Anthropic Message Batches integration.
 *
 * Cron-driven `commit` extractions don't block any user, so we route
 * them through Anthropic's batch API (50% off list price, ≤24h SLA).
 * The realtime `messages.create` path stays as-is for `write`,
 * `image_enrich`, `embed_retry`, and `ingest` triggers — those carry
 * a user behind them and can't tolerate the batch latency.
 *
 * Two-phase loop, called from the discovery worker tick:
 *   Phase A (submit): claim N batch-eligible rows, build their
 *     `messages.create` payloads, POST them as one batch, flip rows
 *     to `'batched'`, insert a tracking row in `discovery_batches`.
 *   Phase B (poll):   for every open batch, GET its status; once it
 *     ends, stream the JSONL results, resolve each row's
 *     `custom_id` back to a `discovery_queue.id`, parse the
 *     `tool_use.input` with the realtime path's post-processor, and
 *     route through `wireLinks` + `markDiscoveryDone` (or
 *     `markDiscoveryError` on per-row failure). Finalize the batch.
 *
 * Backstop: rows that have been `'batched'` for more than
 * `GROVE_DISCOVERY_BATCH_MAX_AGE_HOURS` (default 26) are reclaimed
 * back to `pending` with `trigger='write'` so the urgent path picks
 * them up — guards against silent stalls and the 29d `batch_id`
 * expiry.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

import {
  claimBatchEligible,
  countTodayProcessed,
  finalizeBatch,
  getBatchedRows,
  insertDiscoveryBatch,
  listOpenBatches,
  markDiscoveryDone,
  markDiscoveryError,
  markRowsBatched,
  recoverStaleBatched as dbRecoverStaleBatched,
  type DiscoveryQueueEntry,
} from "./db.js";
import {
  buildMessageRequest,
  parseExtractionResponse,
  _vocabInternals,
} from "./discovery-extract.js";
import { wireLinks } from "./discovery-link.js";
import { loadVaultConfig } from "./vault-config.js";

// ── Tuning knobs ──────────────────────────────────────────────────────

const ANTHROPIC_BATCH_BASE = "https://api.anthropic.com/v1/messages/batches";
const ANTHROPIC_VERSION = "2023-06-01";

function readMaxRows(): number {
  const raw = process.env.GROVE_DISCOVERY_BATCH_MAX_ROWS;
  if (!raw) return 100;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

function readMaxAgeHours(): number {
  const raw = process.env.GROVE_DISCOVERY_BATCH_MAX_AGE_HOURS;
  if (!raw) return 26;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 26;
}

/**
 * Daily-cap budget for Phase A. Mirrors the realtime path's
 * `checkDailyCap` in `discovery.ts` — batched rows count toward
 * the same cap because they cost the same Anthropic tokens
 * (the discount is on the request fee, not on the spend itself
 * once you factor in token usage, but the rule is "any extraction
 * counts" so the cap is honoured uniformly).
 */
function dailyCapRemaining(vaultId: string): number {
  const raw = process.env.GROVE_DISCOVERY_DAILY_CAP;
  const cap = raw === undefined ? 100 : Number.parseInt(raw, 10);
  if (!Number.isFinite(cap) || cap <= 0) return Number.POSITIVE_INFINITY;
  const today = countTodayProcessed(vaultId);
  return Math.max(0, cap - today);
}

// ── Internal HTTP helpers (raw fetch — no SDK call needed) ────────────

interface FetchFn {
  (url: string, init?: RequestInit): Promise<Response>;
}

/**
 * Indirection so tests can inject a fetch fixture without hooking into
 * the global. The default uses the built-in `fetch` (Node ≥ 22).
 */
export const _httpInternals: { fetch: FetchFn } = {
  fetch: (url, init) => fetch(url, init),
};

function headers(): Record<string, string> {
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  return {
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_VERSION,
    "Content-Type": "application/json",
  };
}

// ── Phase A — submit ──────────────────────────────────────────────────

/**
 * Submit a batch of rows to Anthropic's `/v1/messages/batches` endpoint.
 *
 * Returns the new `batch_id` and the number of rows actually submitted
 * (which can be less than `rows.length` if any row's payload failed to
 * build — those rows are marked errored and excluded from the batch).
 *
 * Caller is responsible for having already claimed the rows via
 * `claimBatchEligible`. The rows are flipped to `'batched'` and a
 * `discovery_batches` row is inserted inside this function so partial
 * states can't strand them.
 */
export async function submitBatch(
  vaultPath: string,
  vaultId: string,
  rows: DiscoveryQueueEntry[],
): Promise<{ batch_id: string; row_count: number } | null> {
  if (rows.length === 0) return null;

  // Build vocab + config once for the whole batch. The same
  // (vault, drain) snapshot used by the realtime path — the batch
  // shares the same drift semantics: vocab churn between calls
  // invalidates the prefix cache, but within one submit we send a
  // single consistent vocab to every row's payload.
  const cfg = loadVaultConfig(vaultPath);
  const vocab = _vocabInternals.buildVocabulary(vaultPath, cfg);

  const requests: Array<{
    custom_id: string;
    params: Anthropic.MessageCreateParamsNonStreaming;
  }> = [];
  const includedRowIds: number[] = [];

  for (const row of rows) {
    try {
      const fullPath = join(vaultPath, row.path);
      const content = readFileSync(fullPath, "utf-8");
      const params = buildMessageRequest(content, vocab, cfg);
      requests.push({ custom_id: `row-${row.id}`, params });
      includedRowIds.push(row.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[discovery-batch] skipping row ${row.id} (${row.path}): ${message}`,
      );
      markDiscoveryError(row.id, `batch-build failed: ${message}`);
    }
  }

  if (requests.length === 0) return null;

  const res = await _httpInternals.fetch(ANTHROPIC_BATCH_BASE, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ requests }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `anthropic batch submit failed: ${res.status} ${res.statusText} ${body.slice(0, 500)}`,
    );
  }

  const payload = (await res.json()) as { id?: string };
  const batchId = payload.id;
  if (!batchId) {
    throw new Error(
      `anthropic batch submit returned no id: ${JSON.stringify(payload).slice(0, 500)}`,
    );
  }

  markRowsBatched(includedRowIds, batchId);
  insertDiscoveryBatch(batchId, vaultId, includedRowIds.length);

  console.log(
    `[discovery-batch] submitted batch ${batchId} for vault=${vaultId} ` +
      `with ${includedRowIds.length} rows`,
  );

  return { batch_id: batchId, row_count: includedRowIds.length };
}

/**
 * Phase A entrypoint — called from the discovery worker tick. Claims
 * batch-eligible rows up to the configured cap (daily cap and
 * `GROVE_DISCOVERY_BATCH_MAX_ROWS` both apply) and submits one batch
 * if any rows are available.
 *
 * Returns the number of rows submitted (or 0 if the cap is hit / no
 * eligible rows exist). Designed to be a fast no-op when there's
 * nothing to do — the worker calls this every tick.
 */
export async function submitBatchTick(
  vaultPath: string,
  vaultId: string,
): Promise<number> {
  const remaining = dailyCapRemaining(vaultId);
  if (remaining <= 0) return 0;

  const limit = Math.min(readMaxRows(), remaining);
  const rows = claimBatchEligible(vaultId, limit);
  if (rows.length === 0) return 0;

  if (!process.env.ANTHROPIC_API_KEY) {
    // Don't strand rows because the env var is missing — back off and
    // let the next tick try again once it's configured.
    console.warn(
      `[discovery-batch] ANTHROPIC_API_KEY not set; skipping batch submit ` +
        `(${rows.length} eligible rows will retry next tick)`,
    );
    return 0;
  }

  try {
    const result = await submitBatch(vaultPath, vaultId, rows);
    return result?.row_count ?? 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[discovery-batch] phase A failed: ${message}`);
    return 0;
  }
}

// ── Phase B — poll ────────────────────────────────────────────────────

interface BatchStatusResponse {
  id: string;
  processing_status: "in_progress" | "ended" | "canceling";
  results_url?: string | null;
  ended_at?: string | null;
}

interface BatchResultRow {
  custom_id: string;
  result: {
    type: "succeeded" | "errored" | "canceled" | "expired";
    message?: Anthropic.Message;
    error?: { type?: string; message?: string };
  };
}

/**
 * Poll every open batch for `vaultId`. On `processing_status='ended'`,
 * fetch the JSONL results, decode each `custom_id` back to its
 * `discovery_queue.id`, parse the response, and wire its links. On any
 * other status (`in_progress`, `canceling`), leave the batch alone so
 * the next tick re-polls.
 *
 * Per-row failures inside an otherwise successful batch are routed
 * through `markDiscoveryError` — they don't fail siblings.
 */
export async function pollBatches(
  vaultPath: string,
  vaultId: string,
): Promise<void> {
  const open = listOpenBatches(vaultId);
  if (open.length === 0) return;

  for (const batch of open) {
    try {
      await pollOne(vaultPath, batch.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[discovery-batch] poll failed for batch ${batch.id}: ${message}`,
      );
    }
  }
}

async function pollOne(vaultPath: string, batchId: string): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    // Same back-off shape as Phase A — don't blow up open batches when
    // the env var disappears.
    return;
  }

  const statusRes = await _httpInternals.fetch(
    `${ANTHROPIC_BATCH_BASE}/${encodeURIComponent(batchId)}`,
    { method: "GET", headers: headers() },
  );
  if (!statusRes.ok) {
    const body = await statusRes.text().catch(() => "");
    throw new Error(
      `anthropic batch status failed: ${statusRes.status} ${statusRes.statusText} ${body.slice(0, 500)}`,
    );
  }

  const status = (await statusRes.json()) as BatchStatusResponse;
  if (status.processing_status !== "ended") {
    return; // still in_progress — try again next tick
  }
  if (!status.results_url) {
    throw new Error(`batch ${batchId} ended without results_url`);
  }

  const resultsRes = await _httpInternals.fetch(status.results_url, {
    method: "GET",
    headers: headers(),
  });
  if (!resultsRes.ok) {
    const body = await resultsRes.text().catch(() => "");
    throw new Error(
      `anthropic batch results failed: ${resultsRes.status} ${resultsRes.statusText} ${body.slice(0, 500)}`,
    );
  }
  const jsonl = await resultsRes.text();

  // Resolve our local snapshot of the batched rows once, so the
  // results-loop can map custom_id -> row without N db queries.
  const rows = getBatchedRows(batchId);
  const rowsById = new Map(rows.map((r) => [r.id, r]));

  // Rebuild vocab/config once per batch finalization. The vocab may
  // have drifted since submit (other extractions, user writes, etc.) —
  // we still want resolution against current state because the link
  // wiring is happening *now*.
  const cfg = loadVaultConfig(vaultPath);
  const vocab = _vocabInternals.buildVocabulary(vaultPath, cfg);

  let succeeded = 0;
  let errored = 0;

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let parsed: BatchResultRow;
    try {
      parsed = JSON.parse(line) as BatchResultRow;
    } catch (err) {
      console.error(
        `[discovery-batch] could not parse result line: ${(err as Error).message}`,
      );
      continue;
    }

    const rowId = decodeCustomId(parsed.custom_id);
    if (rowId === null) {
      console.error(
        `[discovery-batch] unrecognized custom_id: ${parsed.custom_id}`,
      );
      continue;
    }
    const row = rowsById.get(rowId);
    if (!row) {
      // Likely already resolved (e.g. stale-batched recovery flipped
      // it back to write). Skip silently — duplicate completion is
      // not a problem here.
      continue;
    }

    if (parsed.result.type !== "succeeded" || !parsed.result.message) {
      const reason =
        parsed.result.error?.message ??
        `batch result type=${parsed.result.type}`;
      markDiscoveryError(row.id, reason);
      errored++;
      continue;
    }

    try {
      const extraction = parseExtractionResponse(
        parsed.result.message,
        vocab,
        cfg,
      );
      await wireLinks(vaultPath, row.path, extraction);
      markDiscoveryDone(row.id);
      succeeded++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markDiscoveryError(row.id, message);
      errored++;
    }
  }

  finalizeBatch(batchId, "ended");
  console.log(
    `[discovery-batch] batch ${batchId} resolved: ${succeeded} succeeded, ${errored} errored`,
  );
}

function decodeCustomId(customId: string): number | null {
  const m = customId.match(/^row-(\d+)$/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// ── Backstop — reclaim stale batched rows ─────────────────────────────

/**
 * Flip rows that have been `'batched'` longer than the configured
 * max age back to `'pending'` with `trigger='write'` so the urgent
 * path picks them up. Called from the worker tick — cheap when the
 * queue is healthy (zero changed rows).
 */
export function recoverStaleBatched(vaultId: string): number {
  const hours = readMaxAgeHours();
  const recovered = dbRecoverStaleBatched(vaultId, hours);
  if (recovered > 0) {
    console.warn(
      `[discovery-batch] reclaimed ${recovered} stale batched rows ` +
        `(older than ${hours}h) for vault_id=${vaultId} as urgent`,
    );
  }
  return recovered;
}

/**
 * Per-vault usage counters (P8-A6).
 *
 * In-memory counters per `(vault_id, date)` — bumped on every authenticated
 * request in the proxy. Flushed to the `vault_usage_daily` SQLite table via
 * upsert every 60s. Keeping the write path in-memory avoids a SQLite hit on
 * every request; the observability substrate needs rough accuracy, not
 * millisecond precision.
 *
 * This module is the substrate for rate-limiting + billing policy layers
 * that come later (explicitly out of Phase 8 scope — see PLAN.md).
 */

import { getDb } from "./db.js";

export type CounterKind = "requests" | "writes" | "embed_tokens" | "search_queries" | "bytes_stored";

interface CellCounts {
  requests: number;
  writes: number;
  embed_tokens: number;
  search_queries: number;
  bytes_stored: number;
}

function freshCell(): CellCounts {
  return { requests: 0, writes: 0, embed_tokens: 0, search_queries: 0, bytes_stored: 0 };
}

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

// Key: `${vaultId}\0${date}`. Value: accumulated counts since last flush.
const buckets: Map<string, CellCounts> = new Map();

function bucketKey(vaultId: string, date: string): string {
  return `${vaultId}\0${date}`;
}

function bumpKind(vaultId: string, kind: CounterKind, delta: number): void {
  if (!vaultId) return;
  if (delta <= 0 && kind !== "bytes_stored") return;
  const date = today();
  const key = bucketKey(vaultId, date);
  const cell = buckets.get(key) ?? freshCell();
  cell[kind] += delta;
  buckets.set(key, cell);
}

/** Record one inbound request for a vault. */
export function bumpRequest(vaultId: string): void {
  bumpKind(vaultId, "requests", 1);
}

/** Record one vault write (commit to git). */
export function bumpWrite(vaultId: string): void {
  bumpKind(vaultId, "writes", 1);
}

/** Record embedding tokens consumed on Voyage for this vault. */
export function bumpEmbedTokens(vaultId: string, tokens: number): void {
  bumpKind(vaultId, "embed_tokens", tokens);
}

/** Record one search query. */
export function bumpSearch(vaultId: string): void {
  bumpKind(vaultId, "search_queries", 1);
}

/** Snapshot the current in-memory counters. Useful for tests + /metrics. */
export function snapshot(): Record<string, CellCounts> {
  const out: Record<string, CellCounts> = {};
  for (const [k, v] of buckets) out[k] = { ...v };
  return out;
}

/** Clear the in-memory buckets (for tests). */
export function resetCounters(): void {
  buckets.clear();
}

/**
 * Flush the in-memory buckets to `vault_usage_daily` via upsert, then clear
 * them. Called on a 60s timer or on graceful shutdown. Upsert accumulates
 * across flushes so partial data is never lost.
 */
export function flushCounters(): void {
  if (buckets.size === 0) return;
  const db = getDb();

  const upsert = db.prepare(
    `INSERT INTO vault_usage_daily (vault_id, date, requests, writes, embed_tokens, search_queries, bytes_stored)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(vault_id, date) DO UPDATE SET
       requests       = requests       + excluded.requests,
       writes         = writes         + excluded.writes,
       embed_tokens   = embed_tokens   + excluded.embed_tokens,
       search_queries = search_queries + excluded.search_queries,
       bytes_stored   = bytes_stored   + excluded.bytes_stored`,
  );

  const entries = [...buckets.entries()];
  buckets.clear();

  const tx = db.transaction(() => {
    for (const [k, v] of entries) {
      const [vaultId, date] = k.split("\0");
      upsert.run(
        vaultId,
        date,
        v.requests,
        v.writes,
        v.embed_tokens,
        v.search_queries,
        v.bytes_stored,
      );
    }
  });
  tx();
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the 60s flush timer. Idempotent. */
export function startFlushTimer(intervalMs = 60_000): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    try {
      flushCounters();
    } catch (err) {
      console.error(`[vault-usage] flush failed: ${(err as Error).message}`);
    }
  }, intervalMs);
  timer.unref();
}

/** Stop the flush timer (for tests + graceful shutdown). */
export function stopFlushTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Discovery loop — dequeues changed notes and dispatches to extractors.
 *
 * Runs as a polling loop (default 2s interval). Each tick:
 * 1. Claims the next pending entry from discovery_queue
 * 2. Reads the note and extracts entities via Claude API
 * 3. Wires wikilinks into the source note and creates new concept notes
 * 4. Marks the entry done or errored
 *
 * Errors on individual notes are caught and logged — they never block the queue.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import {
  countTodayProcessed,
  dequeueDiscovery,
  dequeueDiscoveryUrgent,
  markDiscoveryDone,
  markDiscoveryError,
  recoverOrphanedDiscoveryProcessing,
  type DiscoveryQueueEntry,
} from "./db.js";
import { extractFromNote } from "./discovery-extract.js";
import { wireLinks } from "./discovery-link.js";
import { embedFile } from "./embed-single.js";
import {
  pollBatches,
  recoverStaleBatched,
  submitBatchTick,
} from "./discovery-batch.js";

const DEFAULT_POLL_MS = 2_000;
/** Max attempts before an embed_retry entry is abandoned as errored. */
const MAX_EMBED_RETRY_ATTEMPTS = 5;

export type Processor = (entry: DiscoveryQueueEntry) => Promise<void>;

function getVaultPath(): string {
  return process.env.GROVE_VAULT ?? join(homedir(), "life");
}

/** Default processor — extracts entities and wires wikilinks. */
const defaultProcessor: Processor = async (entry) => {
  const vaultPath = getVaultPath();

  // Embed-retry entries skip entity extraction; they just re-run the embed
  // step for a note whose fire-and-forget embed failed earlier.
  if (entry.trigger === "embed_retry") {
    if (entry.attempts > MAX_EMBED_RETRY_ATTEMPTS) {
      throw new Error(
        `embed retry abandoned after ${entry.attempts} attempts for ${entry.path}`,
      );
    }
    console.log(`[discovery] embed retry (attempt ${entry.attempts}) for ${entry.path}`);
    await embedFile(vaultPath, entry.path);
    console.log(`[discovery] embed retry succeeded for ${entry.path}`);
    return;
  }

  console.log(`[discovery] processing ${entry.path}`);

  const extraction = await extractFromNote(vaultPath, entry.path);
  console.log(
    `[discovery] extracted ${extraction.entities.length} entities, ` +
    `${extraction.suggested_links.length} links, ` +
    `${extraction.new_notes.length} new notes from ${entry.path}`,
  );

  // Wire wikilinks and create new concept notes
  const result = await wireLinks(vaultPath, entry.path, extraction);
  console.log(
    `[discovery] wired ${result.links_wired} links, ` +
    `created ${result.notes_created.length} notes for ${entry.path}`,
  );
};

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start the discovery polling loop.
 *
 * @param processor  Function called for each dequeued entry (default: extract→link)
 * @param pollMs     Polling interval in ms (default: 2000)
 */
export function startDiscoveryLoop(
  processor: Processor = defaultProcessor,
  pollMs: number = DEFAULT_POLL_MS,
): void {
  if (running) return;
  running = true;
  const recovered = recoverOrphanedDiscoveryProcessing();
  if (recovered > 0) {
    console.log(`[discovery] recovered ${recovered} orphaned 'processing' row(s) from prior worker exit`);
  }
  console.log(`[discovery] loop started (poll every ${pollMs}ms)`);
  scheduleTick(processor, pollMs);
}

/** Stop the discovery loop. */
export function stopDiscoveryLoop(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  console.log("[discovery] loop stopped");
}

// Timestamp of the last "cap reached" log so we don't spam every 2s once
// the cap fires.
let lastCapLogAt = 0;

/**
 * Hard daily extraction cap. Returns true when the cap is reached and the
 * caller should treat the tick as a no-op. Reads `GROVE_DISCOVERY_DAILY_CAP`
 * on every call so env changes take effect without a restart. Defaults to
 * 100; set to 0 (or any non-positive number) to disable.
 */
function checkDailyCap(): boolean {
  const raw = process.env.GROVE_DISCOVERY_DAILY_CAP;
  const cap = raw === undefined ? 100 : Number.parseInt(raw, 10);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  const today = countTodayProcessed();
  if (today < cap) return false;
  const now = Date.now();
  if (now - lastCapLogAt > 60_000) {
    console.warn(
      `[discovery] daily cap of ${cap} reached (today=${today}); deferring until UTC midnight`,
    );
    lastCapLogAt = now;
  }
  return true;
}

/** Exposed for testing — process a single queue tick synchronously. */
export async function tick(
  processor: Processor = defaultProcessor,
): Promise<boolean> {
  if (checkDailyCap()) return false;
  // Urgent drain skips `trigger='commit'` rows so they route through the
  // batch path. Every other trigger (`write`, `embed_retry`, `ingest`)
  // passes the urgent filter.
  const entry = dequeueDiscoveryUrgent();
  if (!entry) return false;

  try {
    await processor(entry);
    markDiscoveryDone(entry.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[discovery] error processing ${entry.path}: ${message}`);
    markDiscoveryError(entry.id, message);
  }

  return true;
}

/**
 * P7-COST-5: per-tick orchestration of the batch + urgent paths.
 *
 * Order is deliberate:
 *   1. Phase B — resolve completed batches so their links land before
 *      urgent work might shadow them.
 *   2. Stale-batched recovery — flip any rows past the 24h SLA back to
 *      `pending` with `trigger='write'`, so they're picked up by the
 *      urgent drain in the same tick.
 *   3. Urgent drain — process all `pending` non-`commit` rows. Same as
 *      pre-P7-COST-5 except `commit` rows are deferred to Phase A.
 *   4. Phase A — claim batch-eligible rows and POST them as one batch.
 *
 * Errors at any phase are caught and logged so a transient Anthropic
 * 5xx (or a missing API key) doesn't take the worker down.
 */
export async function runDiscoveryCycle(
  processor: Processor = defaultProcessor,
): Promise<void> {
  const vaultPath = getVaultPath();

  try {
    await pollBatches(vaultPath);
  } catch (err) {
    console.error("[discovery] phase B (poll) failed:", err);
  }

  try {
    recoverStaleBatched();
  } catch (err) {
    console.error("[discovery] stale-batched recovery failed:", err);
  }

  while (true) {
    const processed = await tick(processor);
    if (!processed) break;
  }

  try {
    await submitBatchTick(vaultPath);
  } catch (err) {
    console.error("[discovery] phase A (submit) failed:", err);
  }
}

function scheduleTick(processor: Processor, pollMs: number): void {
  if (!running) return;
  timer = setTimeout(async () => {
    try {
      await runDiscoveryCycle(processor);
    } catch (err) {
      console.error("[discovery] unexpected loop error:", err);
    }
    scheduleTick(processor, pollMs);
  }, pollMs);
}

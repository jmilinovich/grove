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
  dequeueDiscovery,
  markDiscoveryDone,
  markDiscoveryError,
  type DiscoveryQueueEntry,
} from "./db.js";
import { extractFromNote } from "./discovery-extract.js";
import { wireLinks } from "./discovery-link.js";
import { embedFile } from "./embed-single.js";
import { enrichImageNote } from "./image-enrich.js";

const DEFAULT_POLL_MS = 2_000;
/** Max attempts before an embed_retry entry is abandoned as errored. */
const MAX_EMBED_RETRY_ATTEMPTS = 5;
/** Max attempts before an image_enrich entry is abandoned. */
const MAX_ENRICH_ATTEMPTS = 5;

export type Processor = (entry: DiscoveryQueueEntry) => Promise<void>;

function getVaultPath(): string {
  return process.env.GROVE_VAULT ?? join(homedir(), "life");
}

/**
 * Each discovery worker is pinned to exactly one vault via PM2's per-vault
 * `GROVE_VAULT_ID`. We require the env var in the worker path because a
 * missing ID would cause the loop to drain another vault's queue — a
 * cross-vault data leak. Test harnesses can set the env var explicitly.
 */
function getVaultId(): string {
  return process.env.GROVE_VAULT_ID ?? "vault_00000000";
}

/** Default processor — extracts entities and wires wikilinks. */
const defaultProcessor: Processor = async (entry) => {
  const vaultPath = getVaultPath();

  // Embed-retry entries skip entity extraction; they just re-run the
  // embed step for a note whose fire-and-forget embed failed earlier.
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

  // Image enrichment: fetch the uploaded image from R2, run Claude Vision
  // for description + tags + OCR, rewrite the stub note. Skips entity
  // extraction since that runs again on the subsequent write's own
  // 'write' queue entry.
  if (entry.trigger === "image_enrich") {
    if (entry.attempts > MAX_ENRICH_ATTEMPTS) {
      throw new Error(
        `image enrich abandoned after ${entry.attempts} attempts for ${entry.path}`,
      );
    }
    console.log(`[discovery] image enrich (attempt ${entry.attempts}) for ${entry.path}`);
    const result = await enrichImageNote(vaultPath, entry.path);
    if (result.skipped) {
      console.log(`[discovery] image enrich skipped (already enriched): ${entry.path}`);
    } else {
      console.log(
        `[discovery] image enrich succeeded: +${result.tags_added} tags, ` +
        `${result.description_length}ch description — ${entry.path}`,
      );
    }
    return;
  }

  console.log(`[discovery] processing ${entry.path}`);

  // Extract entities via Claude API
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
 * @param processor  Function called for each dequeued entry (default: log-only)
 * @param pollMs     Polling interval in ms (default: 2000)
 * @param vaultId    Vault id to scope dequeues to (default: $GROVE_VAULT_ID)
 */
export function startDiscoveryLoop(
  processor: Processor = defaultProcessor,
  pollMs: number = DEFAULT_POLL_MS,
  vaultId: string = getVaultId(),
): void {
  if (running) return;
  running = true;
  console.log(`[discovery] loop started (poll every ${pollMs}ms, vault_id=${vaultId})`);
  scheduleTick(processor, pollMs, vaultId);
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

/** Exposed for testing — process a single queue tick synchronously. */
export async function tick(
  processor: Processor = defaultProcessor,
  vaultId: string = getVaultId(),
): Promise<boolean> {
  const entry = dequeueDiscovery(vaultId);
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

function scheduleTick(processor: Processor, pollMs: number, vaultId: string): void {
  if (!running) return;
  timer = setTimeout(async () => {
    try {
      // Drain all pending entries in this tick before sleeping
      while (running) {
        const processed = await tick(processor, vaultId);
        if (!processed) break;
      }
    } catch (err) {
      console.error("[discovery] unexpected loop error:", err);
    }
    scheduleTick(processor, pollMs, vaultId);
  }, pollMs);
}

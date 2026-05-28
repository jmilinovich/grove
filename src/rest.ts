/**
 * Note write / move / delete handlers — the cathedral's git-backed surface.
 *
 * All disk + git work goes through a single per-vault `WriteQueue` so writes
 * serialize correctly (CLAUDE.md rule #3). Every successful write produces a
 * git commit and an updated `write_provenance` row.
 */

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, unlinkSync } from "node:fs";
import { join, relative, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { bm25Search } from "./hybrid-search.js";
import {
  gitLog,
  listNotes,
  gitCommit,
  gitCommitPaths,
  gitMv,
  gitRevParseHead,
  gitResetHard,
  qmdReindex,
  gitPush,
  readNoteFile,
  writeNoteFile,
  invalidateFrontmatterCache,
  updateWikilinks,
} from "./vault-ops.js";
import { validatePath, validateNote, parseNote, serializeNote, contentHash } from "./notes-validate.js";
import {
  composeCommitMessage,
  provenanceToTrailers,
  validateCallerProvenance,
  type Provenance,
} from "./provenance.js";
import { provenanceRequired } from "./blame.js";
import { loadVaultConfig } from "./vault-config.js";
import { searchMetrics, metrics } from "./metrics.js";
import { WriteQueue } from "./write-queue.js";
import { embedFile } from "./embed-single.js";
import {
  enqueueDiscovery,
  recordWrite,
  getSourceHash,
  getProvenance,
  setProvenanceRow,
  deleteProvenance,
  renameProvenance,
  discoveryQueueDepth,
  getLastProcessedAt,
} from "./db.js";
import { noteUrl } from "./url.js";

/**
 * Per-request vault context. Single-user, single-vault Grove keeps this as a
 * thin record for "the vault path" so handler signatures stay stable.
 */
export interface VaultContext {
  vaultPath: string;
}

/**
 * Build a `VaultContext` from `$GROVE_VAULT`. Used by tests and any caller
 * that doesn't thread `ctx` explicitly.
 */
export function defaultVaultContext(): VaultContext {
  return { vaultPath: process.env.GROVE_VAULT ?? join(homedir(), "life") };
}

// ── Write queue ──────────────────────────────────────────────────────

const writeQueueByPath = new Map<string, WriteQueue>();

function getWriteQueue(ctx: VaultContext): WriteQueue {
  let q = writeQueueByPath.get(ctx.vaultPath);
  if (!q) {
    q = new WriteQueue();
    const pushPath = ctx.vaultPath;
    q.schedulePush(() => gitPush(pushPath));
    writeQueueByPath.set(ctx.vaultPath, q);
  }
  return q;
}

/** Flush pending writes — call on graceful shutdown. */
export async function flushWriteQueue(): Promise<void> {
  await Promise.all(Array.from(writeQueueByPath.values()).map((q) => q.flush()));
}

// ── Path traversal guard (mirror of server.ts) ──────────────────────

function sanitizePath(vaultRoot: string, filePath: string): string | null {
  const root = resolve(vaultRoot);
  const normalized = resolve(root, filePath);
  if (!normalized.startsWith(root + "/") && normalized !== root) return null;
  if (filePath.includes("..")) return null;
  try {
    const stat = statSync(normalized, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) return null;
  } catch {
    // File doesn't exist — fine for reads
  }
  return normalized;
}

// ── Wikilink extraction ─────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

function extractWikilinks(text: string): string[] {
  const targets = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(WIKILINK_RE.source, "g");
  while ((m = re.exec(text)) !== null) targets.add(m[1].trim());
  return [...targets];
}

// ── Optimistic-concurrency check shared by write / move / delete ────

function assertIfHashMatches(relPath: string, absPath: string, ifHash: string): void {
  const recordedSource = getSourceHash(relPath);
  if (recordedSource !== null) {
    if (recordedSource !== ifHash) {
      throw Object.assign(new Error("Conflict: note was modified"), {
        code: "CONFLICT",
        currentHash: recordedSource,
      });
    }
    return;
  }
  if (!existsSync(absPath)) return;
  const currentHash = contentHash(readNoteFile(absPath));
  if (currentHash !== ifHash) {
    throw Object.assign(new Error("Conflict: note was modified"), {
      code: "CONFLICT",
      currentHash,
    });
  }
}

// ── Status / perf ──────────────────────────────────────────────────

/**
 * Cheap-to-compute observability snapshot. Aggregates write-queue stats and
 * the discovery backlog depth so MCP `vault_status mode=perf` has a stable
 * envelope without any heavy I/O.
 */
export async function handleStatusPerf(): Promise<Record<string, unknown>> {
  const toolMetrics = metrics.getMetrics();
  let depthSum = 0;
  let oldestAge = 0;
  for (const q of writeQueueByPath.values()) {
    depthSum += q.depth();
    const age = q.oldestQueuedAgeMs();
    if (age > oldestAge) oldestAge = age;
  }
  return {
    uptime_seconds: toolMetrics.uptime_seconds,
    total_requests: toolMetrics.total_requests,
    total_errors: toolMetrics.total_errors,
    error_rate: toolMetrics.error_rate,
    tools: toolMetrics.by_tool,
    search: searchMetrics.getSearchStats(),
    write_queue: {
      depth: depthSum,
      oldest_queued_age_ms: oldestAge,
    },
    discovery: {
      queue_depth: discoveryQueueDepth(),
      last_processed_at: getLastProcessedAt(),
    },
    window_ms: 60_000 * 60,
  };
}

// ── Write ──────────────────────────────────────────────────────────

export interface WriteNoteResult {
  path: string;
  action: string;
  source_hash: string;
  content_hash: string;
  commit: string;
  url: string;
}

async function executeWriteInMutex(params: {
  ctx: VaultContext;
  absPath: string;
  relPath: string;
  frontmatter: Record<string, unknown>;
  content: string;
  isNew: boolean;
  keyName?: string;
  provenance?: Provenance;
}): Promise<WriteNoteResult> {
  const { ctx, absPath, relPath, frontmatter, content, isNew, keyName, provenance } = params;

  const serialized = serializeNote(frontmatter, content);
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeNoteFile(absPath, serialized);
  invalidateFrontmatterCache(absPath);

  const action = isNew ? "create" : "update";
  const who = keyName ? `grove (${keyName})` : "grove (api)";
  const subject = `${who}: ${action} ${relPath}`;
  const commitMsg = provenance
    ? composeCommitMessage(subject, provenanceToTrailers(provenance))
    : subject;
  const sha = await gitCommit(ctx.vaultPath, relPath, commitMsg);

  const sourceHash = contentHash(serialized);
  recordWrite(relPath, sourceHash, sha, keyName ?? "api");

  qmdReindex(ctx.vaultPath).catch(() => {});

  return {
    path: relPath,
    action,
    source_hash: sourceHash,
    content_hash: sourceHash,
    commit: sha,
    url: noteUrl(relPath),
  };
}

export async function handleWriteNote(
  ctx: VaultContext,
  notePath: string,
  frontmatter: Record<string, unknown>,
  content: string,
  options: {
    ifHash?: string;
    keyName?: string;
    provenance?: Provenance;
  } = {},
): Promise<WriteNoteResult> {
  let absPath: string;
  try {
    absPath = validatePath(ctx.vaultPath, notePath);
  } catch (err: any) {
    throw Object.assign(new Error(`Path error: ${err.message}`), { code: "VALIDATION", errors: [err.message] });
  }
  const relPath = relative(ctx.vaultPath, absPath);

  const { errors } = validateNote(relPath, frontmatter, content, loadVaultConfig(ctx.vaultPath));
  if (errors.length > 0) {
    throw Object.assign(new Error(`Validation errors:\n${errors.map((e) => `- ${e}`).join("\n")}`), { code: "VALIDATION", errors });
  }

  if (provenanceRequired() && !options.provenance) {
    throw Object.assign(
      new Error(
        "Provenance is required for write_note (GROVE_REQUIRE_PROVENANCE=true). " +
          "Pass a provenance arg with at least: voice (durable | perishable), by, written_at.",
      ),
      { code: "VALIDATION", errors: ["missing required provenance"] },
    );
  }

  if (options.provenance) {
    try {
      validateCallerProvenance(options.provenance);
    } catch (err: any) {
      throw Object.assign(new Error(`Provenance: ${err.message}`), {
        code: "VALIDATION",
        errors: [err.message],
      });
    }
  }

  if (options.ifHash) assertIfHashMatches(relPath, absPath, options.ifHash);

  const result = await getWriteQueue(ctx).enqueue(() => executeWriteInMutex({
    ctx,
    absPath,
    relPath,
    frontmatter,
    content,
    isNew: !options.ifHash,
    keyName: options.keyName,
    provenance: options.provenance,
  }));

  try {
    enqueueDiscovery(result.path, "write");
  } catch (err) {
    console.error(`[grove] discovery enqueue failed for ${result.path}:`, (err as Error).message);
  }

  // Fire-and-forget re-embed of the changed file.
  embedFile(ctx.vaultPath, result.path).catch((err) => {
    console.error(`[grove] embed-single failed for ${result.path}:`, err.message);
    try {
      enqueueDiscovery(result.path, "embed_retry");
    } catch {
      /* already logged */
    }
  });

  return result;
}

// ── Batch write ────────────────────────────────────────────────────

export interface BatchOperation {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
  if_hash?: string;
  if_hash_from_op?: number;
  provenance?: Provenance;
}

export interface WriteBatchResult {
  results: WriteNoteResult[];
}

export async function handleWriteBatch(
  ctx: VaultContext,
  operations: BatchOperation[],
  options: { atomic?: boolean; keyName?: string } = {},
): Promise<WriteBatchResult> {
  if (operations.length === 0) {
    throw Object.assign(new Error("operations array is empty"), { code: "VALIDATION" });
  }
  const atomic = options.atomic ?? false;

  const validated: Array<{
    absPath: string;
    relPath: string;
    frontmatter: Record<string, unknown>;
    content: string;
    if_hash?: string;
    if_hash_from_op?: number;
    provenance?: Provenance;
  }> = [];
  const config = loadVaultConfig(ctx.vaultPath);

  for (const [i, op] of operations.entries()) {
    if (!op || typeof op.path !== "string") {
      throw Object.assign(new Error(`op ${i}: path is required`), { code: "VALIDATION", errors: [`op ${i}: path is required`] });
    }
    let absPath: string;
    try {
      absPath = validatePath(ctx.vaultPath, op.path);
    } catch (err: any) {
      throw Object.assign(new Error(`op ${i}: path error: ${err.message}`), { code: "VALIDATION", errors: [err.message] });
    }
    const relPath = relative(ctx.vaultPath, absPath);
    const { errors } = validateNote(relPath, op.frontmatter ?? {}, op.content ?? "", config);
    if (errors.length > 0) {
      throw Object.assign(
        new Error(`op ${i}: validation errors:\n${errors.map((e) => `- ${e}`).join("\n")}`),
        { code: "VALIDATION", errors: errors.map((e) => `op ${i}: ${e}`) },
      );
    }
    if (op.if_hash_from_op !== undefined) {
      if (!Number.isInteger(op.if_hash_from_op) || op.if_hash_from_op < 0 || op.if_hash_from_op >= i) {
        throw Object.assign(
          new Error(`op ${i}: if_hash_from_op must be an integer < current op index`),
          { code: "VALIDATION", errors: [`op ${i}: if_hash_from_op out of range`] },
        );
      }
    }
    if (op.provenance) {
      try {
        validateCallerProvenance(op.provenance);
      } catch (err: any) {
        throw Object.assign(new Error(`op ${i}: provenance: ${err.message}`), {
          code: "VALIDATION",
          errors: [`op ${i}: ${err.message}`],
        });
      }
    } else if (provenanceRequired()) {
      throw Object.assign(
        new Error(
          `op ${i}: provenance required (GROVE_REQUIRE_PROVENANCE=true). ` +
            "Pass a provenance with at least: voice (durable | perishable), by, written_at.",
        ),
        { code: "VALIDATION", errors: [`op ${i}: missing required provenance`] },
      );
    }
    validated.push({
      absPath,
      relPath,
      frontmatter: op.frontmatter,
      content: op.content,
      if_hash: op.if_hash,
      if_hash_from_op: op.if_hash_from_op,
      provenance: op.provenance,
    });
  }

  const results = await getWriteQueue(ctx).enqueue(async () => {
    const preSha: string | null = atomic ? await gitRevParseHead(ctx.vaultPath) : null;
    const preProvenance: Map<string, ReturnType<typeof getProvenance>> | null = atomic
      ? new Map(validated.map((v) => [v.relPath, getProvenance(v.relPath)]))
      : null;

    const collected: WriteNoteResult[] = [];
    try {
      for (const [i, op] of validated.entries()) {
        let ifHash = op.if_hash;
        if (op.if_hash_from_op !== undefined) {
          ifHash = collected[op.if_hash_from_op]!.source_hash;
        }
        if (ifHash) assertIfHashMatches(op.relPath, op.absPath, ifHash);

        const r = await executeWriteInMutex({
          ctx,
          absPath: op.absPath,
          relPath: op.relPath,
          frontmatter: op.frontmatter,
          content: op.content,
          isNew: !ifHash,
          keyName: options.keyName,
          provenance: op.provenance,
        });
        collected.push(r);
      }
      return collected;
    } catch (err) {
      if (atomic && preSha && preProvenance) {
        try {
          await gitResetHard(ctx.vaultPath, preSha);
        } catch (resetErr) {
          console.error(`[grove] batch rollback git reset failed: ${(resetErr as Error).message}`);
        }
        for (const [path, prior] of preProvenance) {
          if (prior === null) deleteProvenance(path);
          else setProvenanceRow(prior);
          invalidateFrontmatterCache(join(ctx.vaultPath, path));
        }
      }
      throw err;
    }
  });

  for (const r of results) {
    try {
      enqueueDiscovery(r.path, "write");
    } catch (enqueueErr) {
      console.error(`[grove] discovery enqueue failed for ${r.path}:`, (enqueueErr as Error).message);
    }
    embedFile(ctx.vaultPath, r.path).catch((err) => {
      console.error(`[grove] embed-single failed for ${r.path}:`, (err as Error).message);
      try {
        enqueueDiscovery(r.path, "embed_retry");
      } catch {
        /* swallow */
      }
    });
  }

  return { results };
}

// ── Delete ─────────────────────────────────────────────────────────

export interface DeleteNoteResult {
  action: "archived" | "deleted";
  original_path: string;
  archive_path?: string;
  commit: string;
}

export async function handleDeleteNote(
  ctx: VaultContext,
  notePath: string,
  options: { hard?: boolean; ifHash?: string; keyName?: string } = {},
): Promise<DeleteNoteResult> {
  let srcAbs: string;
  try {
    srcAbs = validatePath(ctx.vaultPath, notePath);
  } catch (err: any) {
    throw Object.assign(new Error(`Path error: ${err.message}`), { code: "VALIDATION", errors: [err.message] });
  }
  const srcRel = relative(ctx.vaultPath, srcAbs);

  if (!existsSync(srcAbs)) {
    throw Object.assign(new Error(`Note not found: ${notePath}`), { code: "NOT_FOUND" });
  }

  if (options.ifHash) assertIfHashMatches(srcRel, srcAbs, options.ifHash);

  const who = options.keyName ? `grove (${options.keyName})` : "grove (api)";

  if (options.hard) {
    return await getWriteQueue(ctx).enqueue(async () => {
      unlinkSync(srcAbs);
      invalidateFrontmatterCache(srcAbs);
      const sha = await gitCommit(ctx.vaultPath, srcRel, `${who}: hard_delete ${srcRel}`);
      deleteProvenance(srcRel);
      return { action: "deleted", original_path: srcRel, commit: sha };
    });
  }

  // Soft delete: move into the configured archive path with archived_from/archived_at frontmatter.
  const config = loadVaultConfig(ctx.vaultPath);
  const archiveBase = config.structure.archive_path ?? "Archives/";
  const archiveRel = join(archiveBase, srcRel);
  const archiveAbs = join(ctx.vaultPath, archiveRel);

  return await getWriteQueue(ctx).enqueue(async () => {
    const raw = readNoteFile(srcAbs);
    const { frontmatter, content } = parseNote(raw);
    const updatedFm = {
      ...frontmatter,
      archived_from: srcRel,
      archived_at: new Date().toISOString(),
    };
    const serialized = serializeNote(updatedFm, content);
    mkdirSync(dirname(archiveAbs), { recursive: true });
    writeNoteFile(archiveAbs, serialized);
    invalidateFrontmatterCache(archiveAbs);
    unlinkSync(srcAbs);
    invalidateFrontmatterCache(srcAbs);
    const sha = await gitCommitPaths(
      ctx.vaultPath,
      [srcRel, archiveRel],
      `${who}: archive ${srcRel} -> ${archiveRel}`,
    );
    // Source path's provenance moves with the file
    renameProvenance(srcRel, archiveRel);
    return {
      action: "archived",
      original_path: srcRel,
      archive_path: archiveRel,
      commit: sha,
    };
  });
}

// ── Move ───────────────────────────────────────────────────────────

export interface MoveNoteResult {
  action: "moved";
  from: string;
  to: string;
  commit: string;
  /** Count of files whose wikilinks were rewritten. */
  links_updated: number;
  /** Paths of files whose wikilinks were rewritten. */
  links_updated_paths: string[];
  source_hash: string;
  content_hash: string;
  url: string;
}

export async function handleMoveNote(
  ctx: VaultContext,
  fromPath: string,
  toPath: string,
  options: { ifHash?: string; keyName?: string } = {},
): Promise<MoveNoteResult> {
  let srcAbs: string;
  let dstAbs: string;
  try {
    srcAbs = validatePath(ctx.vaultPath, fromPath);
    dstAbs = validatePath(ctx.vaultPath, toPath);
  } catch (err: any) {
    throw Object.assign(new Error(`Path error: ${err.message}`), { code: "VALIDATION", errors: [err.message] });
  }
  const srcRel = relative(ctx.vaultPath, srcAbs);
  const dstRel = relative(ctx.vaultPath, dstAbs);

  if (srcRel === dstRel) {
    throw Object.assign(new Error("from and to are the same path"), { code: "VALIDATION" });
  }
  if (!existsSync(srcAbs)) {
    throw Object.assign(new Error(`Note not found: ${fromPath}`), { code: "NOT_FOUND" });
  }
  if (existsSync(dstAbs)) {
    throw Object.assign(new Error(`Destination already exists: ${toPath}`), { code: "CONFLICT" });
  }

  if (options.ifHash) assertIfHashMatches(srcRel, srcAbs, options.ifHash);

  const who = options.keyName ? `grove (${options.keyName})` : "grove (api)";

  return await getWriteQueue(ctx).enqueue(async () => {
    mkdirSync(dirname(dstAbs), { recursive: true });
    await gitMv(ctx.vaultPath, srcRel, dstRel);
    invalidateFrontmatterCache(srcAbs);
    invalidateFrontmatterCache(dstAbs);

    // Rewrite incoming wikilinks (both basename and full-path forms). Pulls
    // aliases off the destination's frontmatter so `[[alias|display]]` style
    // links rewrite to the new basename too.
    const dstRaw = readNoteFile(dstAbs);
    const { frontmatter } = parseNote(dstRaw);
    const aliases = Array.isArray(frontmatter.aliases)
      ? (frontmatter.aliases as unknown[]).filter((a): a is string => typeof a === "string")
      : [];
    const updatedPaths = updateWikilinks(ctx.vaultPath, srcRel, dstRel, aliases);

    // After `git mv` the source no longer exists on disk — only the
    // destination + any link-rewritten paths need to be `git add`ed. The
    // rename itself is already staged by `git mv`.
    const paths = [dstRel, ...updatedPaths];
    const sha = await gitCommitPaths(
      ctx.vaultPath,
      paths,
      `${who}: move ${srcRel} -> ${dstRel}`,
    );

    renameProvenance(srcRel, dstRel);
    const sourceHash = contentHash(dstRaw);
    recordWrite(dstRel, sourceHash, sha, options.keyName ?? "api");

    qmdReindex(ctx.vaultPath).catch(() => {});

    return {
      action: "moved",
      from: srcRel,
      to: dstRel,
      commit: sha,
      links_updated: updatedPaths.length,
      links_updated_paths: updatedPaths,
      source_hash: sourceHash,
      content_hash: sourceHash,
      url: noteUrl(dstRel),
    };
  });
}

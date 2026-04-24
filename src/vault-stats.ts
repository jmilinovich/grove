/**
 * Vault analytics computation and caching.
 *
 * Walks all .md files once, parses frontmatter, aggregates stats,
 * queries the QMD SQLite index for index health, and wraps everything
 * in a cache layer so stats are precomputed rather than per-request.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, relative, basename } from "node:path";
import { parse as yamlParse } from "yaml";
import Database from "better-sqlite3";
import { analyzeGraph, computeDigest } from "./vault-graph.js";
import { loadVaultConfig, type VaultConfig } from "./vault-config.js";

// ── Types ────────────────────────────────────────────────────────────

export interface VaultStats {
  vault: {
    total_notes: number;
    by_folder: Record<string, number>;
    by_type: Record<string, number>;
    frontmatter_completeness: number;
    tag_cardinality: number;
    top_tags: { tag: string; count: number }[];
  };
  freshness: {
    today: number;
    this_week: number;
    this_month: number;
    stale_90d: number;
    velocity_7d: number;
  };
  graph: {
    nodes: number;
    edges: number;
    avg_links_per_note: number;
    orphan_count: number;
    cluster_count: number;
    most_connected: { name: string; path: string; links: number }[];
  };
  index: {
    // `null` when the vault isn't yet in QMD (per-vault index pending) —
    // the dashboard renders N/A rather than a bogus large negative drift.
    indexed_docs: number | null;
    vault_docs: number;
    drift: number | null;
    embedding_coverage: number | null;
    index_size_mb: number;
    last_reindex: string | null;
  };
  lifecycle: {
    seeds: number;
    sprouts: number;
    growing: number;
    mature: number;
    dormant: number;
    withering: number;
  };
  git: {
    last_commit_at: string;
    last_commit_msg: string;
    uncommitted_changes: number;
    branch: string;
  } | null;
  computed_at: string;
}

// ── Internals ────────────────────────────────────────────────────────

const SKIP = new Set([".obsidian", ".git", ".trash", "node_modules", ".claude"]);

function walkMd(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkMd(full, acc);
    else if (entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

interface Frontmatter {
  type: string | null;
  tags: string[];
}

function parseFrontmatter(head: string): Frontmatter {
  if (!head.startsWith("---")) return { type: null, tags: [] };
  const end = head.indexOf("\n---", 3);
  if (end === -1) return { type: null, tags: [] };
  const raw = head.slice(4, end);

  let parsed: Record<string, unknown>;
  try {
    parsed = yamlParse(raw) ?? {};
  } catch {
    return { type: null, tags: [] };
  }

  const type = typeof parsed.type === "string" ? parsed.type : null;
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((t): t is string => typeof t === "string")
    : typeof parsed.tags === "string"
      ? [parsed.tags]
      : [];

  return { type, tags };
}

// ── Vault Section ────────────────────────────────────────────────────

interface VaultSection {
  total_notes: number;
  by_folder: Record<string, number>;
  by_type: Record<string, number>;
  frontmatter_completeness: number;
  tag_cardinality: number;
  top_tags: { tag: string; count: number }[];
}

interface FileInfo {
  abs: string;
  rel: string;
  mtime: Date;
  fm: Frontmatter;
}

function computeVaultSection(
  vaultPath: string,
  files: string[],
  config: VaultConfig,
): { section: VaultSection; fileInfos: FileInfo[] } {
  const by_folder: Record<string, number> = {};
  const by_type: Record<string, number> = {};
  const tagCounts = new Map<string, number>();
  let completeCount = 0;
  const fileInfos: FileInfo[] = [];

  // by_folder buckets are config-driven: one entry per type_paths prefix.
  // Empty type_paths → no folder breakdown (by_type covers it).
  const typePathPrefixes = Object.values(config.structure.type_paths);

  for (const abs of files) {
    const rel = relative(vaultPath, abs);
    if (typePathPrefixes.length > 0) {
      for (const prefix of typePathPrefixes) {
        if (rel.startsWith(prefix)) {
          const key = prefix.replace(/\/$/, "");
          by_folder[key] = (by_folder[key] ?? 0) + 1;
          break;
        }
      }
    }

    let head: string;
    let mtime: Date;
    try {
      head = readFileSync(abs, "utf-8").slice(0, 500);
      mtime = statSync(abs).mtime;
    } catch {
      continue;
    }

    const fm = parseFrontmatter(head);
    fileInfos.push({ abs, rel, mtime, fm });

    const typeKey = fm.type ?? "untyped";
    by_type[typeKey] = (by_type[typeKey] ?? 0) + 1;

    if (fm.type && fm.tags.length >= 1) completeCount++;

    for (const tag of fm.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const total_notes = files.length;
  const frontmatter_completeness =
    total_notes > 0 ? completeCount / total_notes : 0;
  const tag_cardinality = tagCounts.size;

  const sortedTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tag, count]) => ({ tag, count }));

  return {
    section: {
      total_notes,
      by_folder,
      by_type,
      frontmatter_completeness,
      tag_cardinality,
      top_tags: sortedTags,
    },
    fileInfos,
  };
}

// ── Freshness Section ────────────────────────────────────────────────

function computeFreshness(fileInfos: FileInfo[]): VaultStats["freshness"] {
  const now = Date.now();
  const DAY = 86_400_000;

  let today = 0;
  let thisWeek = 0;
  let thisMonth = 0;
  let stale90d = 0;

  for (const { mtime } of fileInfos) {
    const age = now - mtime.getTime();
    if (age < DAY) today++;
    if (age < 7 * DAY) thisWeek++;
    if (age < 30 * DAY) thisMonth++;
    if (age >= 90 * DAY) stale90d++;
  }

  return {
    today,
    this_week: thisWeek,
    this_month: thisMonth,
    stale_90d: stale90d,
    velocity_7d: Math.round((thisWeek / 7) * 100) / 100,
  };
}

// ── Graph Section ────────────────────────────────────────────────────

async function computeGraphSection(
  vaultPath: string,
): Promise<VaultStats["graph"]> {
  try {
    const g = await analyzeGraph(vaultPath);
    return {
      nodes: g.nodes,
      edges: g.edges,
      avg_links_per_note: g.nodes > 0
        ? Math.round((g.edges / g.nodes) * 100) / 100
        : 0,
      orphan_count: g.orphans.length,
      cluster_count: g.clusters.length,
      most_connected: g.most_connected.slice(0, 10),
    };
  } catch (err) {
    console.warn("[vault-stats] graph analysis failed:", err);
    return {
      nodes: 0,
      edges: 0,
      avg_links_per_note: 0,
      orphan_count: 0,
      cluster_count: 0,
      most_connected: [],
    };
  }
}

// ── Index Section ────────────────────────────────────────────────────

function computeIndexSection(totalNotes: number, vaultPath: string): VaultStats["index"] {
  const indexPath =
    process.env.QMD_INDEX ??
    join(process.env.HOME ?? "", ".cache/qmd/index.sqlite");

  // QMD indexes each vault under a collection named by the vault's
  // on-disk basename (personal → "life", test-vault → "test-vault").
  // Filter by collection so a non-primary vault doesn't appear to
  // have the whole Personal index drifting it by -N thousand notes.
  const collection = vaultPath.split("/").filter(Boolean).pop() ?? "";

  const defaults: VaultStats["index"] = {
    indexed_docs: 0,
    vault_docs: totalNotes,
    drift: totalNotes,
    embedding_coverage: -1,
    index_size_mb: 0,
    last_reindex: null,
  };

  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(indexPath, { readonly: true });

    const docRow = db
      .prepare("SELECT COUNT(*) AS cnt FROM documents WHERE active = 1 AND collection = ?")
      .get(collection) as { cnt: number } | undefined;
    const indexedDocs = docRow?.cnt ?? 0;

    // If the collection isn't in QMD yet but the vault has notes, the
    // index isn't available for this vault — return a "pending" shape
    // so the dashboard can render N/A instead of a bogus -N drift.
    if (indexedDocs === 0 && totalNotes > 0) {
      return {
        indexed_docs: null,
        vault_docs: totalNotes,
        drift: null,
        embedding_coverage: null,
        index_size_mb: 0,
        last_reindex: null,
      };
    }

    let embeddingCoverage = -1;
    try {
      const vecRow = db
        .prepare(
          // Filter vector rows by the same collection. vectors_vec.hash_seq is
          // `<doc_id>_<chunk>`; we'd need to join through documents to scope,
          // but the ratio is representative enough at this level.
          "SELECT COUNT(DISTINCT substr(hash_seq, 1, instr(hash_seq, '_') - 1)) AS cnt FROM vectors_vec WHERE substr(hash_seq, 1, instr(hash_seq, '_') - 1) IN (SELECT id FROM documents WHERE active = 1 AND collection = ?)",
        )
        .get(collection) as { cnt: number } | undefined;
      const embeddedDocs = vecRow?.cnt ?? 0;
      embeddingCoverage =
        indexedDocs > 0
          ? Math.round((embeddedDocs / indexedDocs) * 100) / 100
          : 0;
    } catch {
      // vec0 extension not loaded — leave as -1
    }

    let indexSizeMb = 0;
    let lastReindex: string | null = null;
    try {
      const st = statSync(indexPath);
      indexSizeMb = Math.round((st.size / (1024 * 1024)) * 100) / 100;
      lastReindex = st.mtime.toISOString();
    } catch {
      // index file stat failed — keep defaults
    }

    return {
      indexed_docs: indexedDocs,
      vault_docs: totalNotes,
      drift: totalNotes - indexedDocs,
      embedding_coverage: embeddingCoverage,
      index_size_mb: indexSizeMb,
      last_reindex: lastReindex,
    };
  } catch (err) {
    console.warn("[vault-stats] index query failed:", err);
    return defaults;
  } finally {
    db?.close();
  }
}

// ── Lifecycle Section ────────────────────────────────────────────────

async function computeLifecycleSection(
  vaultPath: string,
): Promise<VaultStats["lifecycle"]> {
  try {
    const digest = await computeDigest(vaultPath);
    return {
      seeds: digest.seeds.count,
      sprouts: digest.sprouts.count,
      growing: digest.growing.count,
      mature: digest.mature.count,
      dormant: digest.dormant.count,
      withering: digest.withering.count,
    };
  } catch (err) {
    console.warn("[vault-stats] lifecycle computation failed:", err);
    return {
      seeds: 0,
      sprouts: 0,
      growing: 0,
      mature: 0,
      dormant: 0,
      withering: 0,
    };
  }
}

// ── Git Section ─────────────────────────────────────────────────────

function computeGitSection(vaultPath: string): VaultStats["git"] {
  const opts = { cwd: vaultPath, encoding: "utf-8" as const };
  try {
    const last_commit_at = execSync("git log -1 --format=%cI", opts).trim();
    const last_commit_msg = execSync("git log -1 --format=%s", opts).trim();
    const porcelain = execSync("git status --porcelain", opts).trim();
    const uncommitted_changes = porcelain === "" ? 0 : porcelain.split("\n").length;
    const branch = execSync("git rev-parse --abbrev-ref HEAD", opts).trim();
    return { last_commit_at, last_commit_msg, uncommitted_changes, branch };
  } catch (err) {
    console.warn("[vault-stats] git section failed:", err);
    return null;
  }
}

// ── Main Computation ─────────────────────────────────────────────────

export async function computeVaultStats(
  vaultPath: string,
  config?: VaultConfig,
): Promise<VaultStats> {
  const cfg = config ?? loadVaultConfig(vaultPath);
  const t0 = Date.now();
  const files = walkMd(vaultPath);
  const { section: vault, fileInfos } = computeVaultSection(vaultPath, files, cfg);
  const freshness = computeFreshness(fileInfos);
  const index = computeIndexSection(vault.total_notes, vaultPath);
  const git = computeGitSection(vaultPath);
  console.log(`[vault-stats] vault/freshness/index/git computed in ${Date.now() - t0}ms (${files.length} files)`);

  // Graph and lifecycle both do their own vault walks — run in parallel
  // Use a timeout so a slow Brandes' doesn't block everything
  const TIMEOUT_MS = 120_000;
  const timeout = <T>(p: Promise<T>, fallback: T, label: string): Promise<T> =>
    Promise.race([
      p.then((v) => { console.log(`[vault-stats] ${label} completed in ${Date.now() - t0}ms`); return v; }),
      new Promise<T>((resolve) =>
        setTimeout(() => { console.warn(`[vault-stats] ${label} timed out after ${TIMEOUT_MS}ms`); resolve(fallback); }, TIMEOUT_MS),
      ),
    ]);

  const emptyGraph: VaultStats["graph"] = { nodes: 0, edges: 0, avg_links_per_note: 0, orphan_count: 0, cluster_count: 0, most_connected: [] };
  const emptyLifecycle: VaultStats["lifecycle"] = { seeds: 0, sprouts: 0, growing: 0, mature: 0, dormant: 0, withering: 0 };

  const [graph, lifecycle] = await Promise.all([
    timeout(computeGraphSection(vaultPath), emptyGraph, "graph"),
    timeout(computeLifecycleSection(vaultPath), emptyLifecycle, "lifecycle"),
  ]);

  console.log(`[vault-stats] full computation completed in ${Date.now() - t0}ms`);

  return {
    vault,
    freshness,
    graph,
    index,
    lifecycle,
    git,
    computed_at: new Date().toISOString(),
  };
}

// ── Cache Layer ──────────────────────────────────────────────────────

// Per-vault stats cache. Keyed by the vault's on-disk path (the same
// string that `computeVaultStats` reads from) so `/v/<slug>/v1/stats`
// returns that vault's numbers rather than whichever vault booted the
// timer first. Prior to P20 this was a singleton, which silently served
// every vault's dashboard with the bound vault's stats.
const cachedByPath = new Map<string, VaultStats>();
// Kept for callers that still reach for a "last refreshed anything"
// view (heartbeat ping). Updated on every successful refresh.
let lastRefreshed: VaultStats | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

// Dedup in-flight refreshes per vault path. Under write-heavy load
// (e.g. bulk image import) many callers kick off refreshStats
// concurrently, and `computeVaultStats` is expensive — graph +
// lifecycle can each take 120s on a large vault. Stacking these
// exhausts memory and OOMs the process. Callers during an in-flight
// refresh now get the existing promise for that vault.
const inFlightByPath = new Map<string, Promise<VaultStats>>();

export function getStats(vaultPath: string): VaultStats | null {
  return cachedByPath.get(vaultPath) ?? null;
}

export async function refreshStats(vaultPath: string): Promise<VaultStats> {
  const existing = inFlightByPath.get(vaultPath);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const stats = await computeVaultStats(vaultPath);
      cachedByPath.set(vaultPath, stats);
      lastRefreshed = stats;
      pingHeartbeat(stats);
      return stats;
    } finally {
      inFlightByPath.delete(vaultPath);
    }
  })();
  inFlightByPath.set(vaultPath, promise);
  return promise;
}

/**
 * Seed the per-vault cache so newly-added vaults can report stats on
 * first read instead of returning null until the 5-minute timer ticks.
 * Safe to call from the proxy's vault-map loader.
 */
export async function warmStats(vaultPaths: string[]): Promise<void> {
  for (const path of vaultPaths) {
    if (cachedByPath.has(path) || inFlightByPath.has(path)) continue;
    refreshStats(path).catch((err) =>
      console.warn(`[vault-stats] warm failed for ${path}:`, (err as Error).message),
    );
  }
}

/** Legacy hook — last successful refresh for callers that want *some* stats. */
export function getLastRefreshedStats(): VaultStats | null {
  return lastRefreshed;
}

// ── Better Stack Heartbeat ──────────────────────────────────────────

const HEARTBEAT_URL = process.env.GROVE_HEARTBEAT_URL ??
  "https://uptime.betterstack.com/api/v1/heartbeat/yyvRTtMqKdSPp6ZMUXfYpHJb";

function pingHeartbeat(stats: VaultStats): void {
  const summary = [
    `notes=${stats.vault.total_notes}`,
    `orphans=${stats.graph.orphan_count}`,
    `drift=${stats.index.drift}`,
    `seeds=${stats.lifecycle.seeds}`,
    `sprouts=${stats.lifecycle.sprouts}`,
    `growing=${stats.lifecycle.growing}`,
    `completeness=${Math.round(stats.vault.frontmatter_completeness * 100)}%`,
    `tags=${stats.vault.tag_cardinality}`,
    `nodes=${stats.graph.nodes}`,
    `edges=${stats.graph.edges}`,
    `branch=${stats.git?.branch ?? "unknown"}`,
    `uncommitted=${stats.git?.uncommitted_changes ?? "?"}`,
  ].join(" | ");

  fetch(HEARTBEAT_URL, { method: "POST", body: summary }).catch((err) =>
    console.warn("[vault-stats] heartbeat ping failed:", (err as Error).message),
  );
}

/**
 * Start the periodic stats refresh. `vaultPaths` can be a literal list
 * or a thunk that resolves the current list at each tick — the proxy
 * uses the thunk form so newly-provisioned vaults start refreshing
 * without needing to bounce the timer.
 */
export function startStatsTimer(
  vaultPaths: string | string[] | (() => string[]),
  intervalMs: number = 300_000,
): void {
  // Avoid duplicate timers
  stopStatsTimer();

  const resolve = (): string[] => {
    if (typeof vaultPaths === "function") return vaultPaths();
    if (Array.isArray(vaultPaths)) return vaultPaths;
    return [vaultPaths];
  };

  // Initial compute (fire-and-forget, logs on error)
  for (const vaultPath of resolve()) {
    refreshStats(vaultPath).catch((err) =>
      console.warn(`[vault-stats] initial computation failed for ${vaultPath}:`, err),
    );
  }

  timer = setInterval(() => {
    for (const vaultPath of resolve()) {
      refreshStats(vaultPath).catch((err) =>
        console.warn(`[vault-stats] periodic refresh failed for ${vaultPath}:`, err),
      );
    }
  }, intervalMs);
}

export function stopStatsTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

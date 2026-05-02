/**
 * Graph health metrics, scoring, persistence, and automated monitoring.
 *
 * Walks the vault to compute a snapshot of structural health (orphans,
 * broken links, embedding coverage, clustering, growth), calculates a
 * composite 0–100 score, and stores each run as a time-series row in
 * `graph_health`. A cron loop runs the check on a configurable interval
 * and emits structured alerts when thresholds are exceeded. Also exposes
 * read-side query helpers used by the admin REST layer.
 */

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { parse as yamlParse } from "yaml";
import Database from "better-sqlite3";
import {
  getDb,
  insertHealthFlag,
  type HealthFlagType,
} from "./db.js";
import { log } from "./logger.js";
import { parseNote, serializeNote, inferTags } from "./notes-validate.js";
import { loadVaultConfig, type VaultConfig } from "./vault-config.js";

// ── Types ────────────────────────────────────────────────────────────

export interface GraphHealthMetrics {
  total_notes: number;
  total_links: number;
  link_density: number;
  orphan_count: number;
  orphan_rate: number;
  broken_link_count: number;
  embedding_coverage: number;
  stale_embedding_count: number;
  missing_frontmatter: number;
  duplicate_candidates: number;
  growth_velocity_7d: number;
  growth_velocity_30d: number;
  avg_links_per_note: number;
  cluster_count: number;
  largest_cluster_pct: number;
}

export interface HealthSnapshot {
  id: string;
  measured_at: string;
  metrics: GraphHealthMetrics;
  score: number;
}

export type HealthAlertType =
  | "score_drop"
  | "orphan_rate"
  | "broken_links"
  | "embedding_coverage";

export interface HealthAlert {
  type: HealthAlertType;
  message: string;
  value: number;
  threshold: number;
}

export interface AlertThresholds {
  score_drop_24h: number;
  orphan_rate: number;
  broken_links: number;
  embedding_coverage: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  score_drop_24h: 10,
  orphan_rate: 0.15,
  broken_links: 20,
  embedding_coverage: 0.8,
};

// ── Internals ────────────────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const SKIP = new Set([".obsidian", ".git", ".trash", "node_modules", ".claude"]);
const DAY_MS = 86_400_000;

function walkMd(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkMd(full, acc);
    else if (entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

function extractWikilinks(text: string): string[] {
  const links: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(WIKILINK_RE.source, "g");
  while ((m = re.exec(text)) !== null) links.push(m[1].trim());
  return links;
}

function stem(link: string): string {
  const parts = link.split("/");
  return parts[parts.length - 1];
}

/**
 * Normalize a wikilink target for resolution:
 * - strip `#section` and `^block` anchors
 * - strip optional `.md` suffix
 * - take the last path segment (stem)
 * - lowercase for case-insensitive matching
 */
function normalizeLinkTarget(raw: string): string {
  let target = raw.trim();
  // Strip header anchor `#...` and block anchor `^...`
  const hash = target.indexOf("#");
  if (hash !== -1) target = target.slice(0, hash);
  const caret = target.indexOf("^");
  if (caret !== -1) target = target.slice(0, caret);
  target = target.trim();
  // Strip .md suffix if present
  if (target.toLowerCase().endsWith(".md")) target = target.slice(0, -3);
  // Take last path segment (Obsidian wikilinks use either name or relative path)
  target = stem(target);
  return target.toLowerCase();
}

interface Frontmatter2 {
  type: string | null;
  tags: string[];
  aliases: string[];
  present: boolean;
}

function parseFrontmatterWithAliases(head: string): Frontmatter2 {
  if (!head.startsWith("---")) return { type: null, tags: [], aliases: [], present: false };
  const end = head.indexOf("\n---", 3);
  if (end === -1) return { type: null, tags: [], aliases: [], present: false };
  let parsed: Record<string, unknown>;
  try {
    parsed = yamlParse(head.slice(4, end)) ?? {};
  } catch {
    return { type: null, tags: [], aliases: [], present: false };
  }
  const type = typeof parsed.type === "string" ? parsed.type : null;
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((t): t is string => typeof t === "string")
    : typeof parsed.tags === "string"
      ? [parsed.tags]
      : [];
  const aliases = Array.isArray(parsed.aliases)
    ? parsed.aliases.filter((a): a is string => typeof a === "string")
    : typeof parsed.aliases === "string"
      ? [parsed.aliases]
      : [];
  return { type, tags, aliases, present: true };
}

interface Frontmatter {
  type: string | null;
  tags: string[];
  present: boolean;
}

function parseFrontmatter(head: string): Frontmatter {
  if (!head.startsWith("---")) return { type: null, tags: [], present: false };
  const end = head.indexOf("\n---", 3);
  if (end === -1) return { type: null, tags: [], present: false };
  let parsed: Record<string, unknown>;
  try {
    parsed = yamlParse(head.slice(4, end)) ?? {};
  } catch {
    return { type: null, tags: [], present: false };
  }
  const type = typeof parsed.type === "string" ? parsed.type : null;
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((t): t is string => typeof t === "string")
    : typeof parsed.tags === "string"
      ? [parsed.tags]
      : [];
  return { type, tags, present: true };
}

// ── Graph computation ────────────────────────────────────────────────

interface GraphView {
  realNames: Set<string>;
  outgoing: Map<string, Set<string>>;
  incoming: Map<string, Set<string>>;
  edgeCount: number;
  brokenLinkCount: number;
  orphanCount: number;
  clusterCount: number;
  largestClusterSize: number;
}

function buildGraph(
  files: string[],
  fileTexts: Map<string, string>,
): GraphView {
  // Canonical name per file = basename without .md (original case preserved).
  const realNames = new Set<string>();
  // Alias resolution map: lowercased lookup → canonical name.
  // Includes both filenames and frontmatter aliases.
  const aliasMap = new Map<string, string>();
  for (const abs of files) {
    const name = basename(abs, ".md");
    realNames.add(name);
    aliasMap.set(name.toLowerCase(), name);
    const text = fileTexts.get(abs);
    if (text !== undefined) {
      const fm = parseFrontmatterWithAliases(text.slice(0, 2000));
      for (const alias of fm.aliases) {
        const key = alias.trim().toLowerCase();
        // First-come-first-served on alias collisions (rare; fine for stats)
        if (key && !aliasMap.has(key)) aliasMap.set(key, name);
      }
    }
  }

  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const name of realNames) {
    outgoing.set(name, new Set());
    incoming.set(name, new Set());
  }

  let edgeCount = 0;
  let brokenLinkCount = 0;

  for (const abs of files) {
    const srcName = basename(abs, ".md");
    const text = fileTexts.get(abs);
    if (text === undefined) continue;
    const srcOut = outgoing.get(srcName)!;

    for (const raw of extractWikilinks(text)) {
      const key = normalizeLinkTarget(raw);
      if (!key) continue;
      const target = aliasMap.get(key);
      if (target === undefined) {
        brokenLinkCount++;
        continue;
      }
      if (target === srcName) continue;
      if (srcOut.has(target)) continue;

      srcOut.add(target);
      edgeCount++;
      if (!incoming.has(target)) incoming.set(target, new Set());
      incoming.get(target)!.add(srcName);
    }
  }

  // Orphans: zero inbound + zero outbound among real notes
  let orphanCount = 0;
  for (const name of realNames) {
    const out = outgoing.get(name)!.size;
    const inc = incoming.get(name)?.size ?? 0;
    if (out === 0 && inc === 0) orphanCount++;
  }

  // Connected components (undirected BFS over real nodes only)
  const visited = new Set<string>();
  const componentSizes: number[] = [];
  for (const start of realNames) {
    if (visited.has(start)) continue;
    let size = 0;
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      size++;
      const neighbors = new Set<string>();
      for (const n of outgoing.get(cur) ?? []) {
        if (realNames.has(n)) neighbors.add(n);
      }
      for (const n of incoming.get(cur) ?? []) {
        if (realNames.has(n)) neighbors.add(n);
      }
      for (const nb of neighbors) {
        if (!visited.has(nb)) {
          visited.add(nb);
          queue.push(nb);
        }
      }
    }
    componentSizes.push(size);
  }

  const clusterCount = componentSizes.length;
  const largestClusterSize = componentSizes.reduce(
    (max, s) => (s > max ? s : max),
    0,
  );

  return {
    realNames,
    outgoing,
    incoming,
    edgeCount,
    brokenLinkCount,
    orphanCount,
    clusterCount,
    largestClusterSize,
  };
}

// ── Index health (QMD index, optional) ───────────────────────────────

interface IndexHealth {
  embedding_coverage: number; // -1 if unavailable
  stale_embedding_count: number;
}

function getIndexPath(): string {
  return (
    process.env.QMD_INDEX ??
    join(process.env.HOME ?? homedir(), ".cache/qmd/index.sqlite")
  );
}

function computeIndexHealth(
  totalNotes: number,
  files: string[],
  collection: string,
  indexDb?: Database.Database,
): IndexHealth {
  const defaults: IndexHealth = {
    embedding_coverage: -1,
    stale_embedding_count: 0,
  };

  let db: Database.Database | null = null;
  let owned = false;
  try {
    if (indexDb) {
      db = indexDb;
    } else {
      const path = getIndexPath();
      if (!existsSync(path)) return defaults;
      db = new Database(path, { readonly: true });
      owned = true;
    }

    // Scope to this vault's collection so multi-vault deployments don't
    // compute embedding_coverage as (global embedded count) /
    // (this-vault note count) — which can exceed 1.0 and leaks the
    // existence of other vaults via the metric.
    const docRow = db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM documents WHERE active = 1 AND collection = ?",
      )
      .get(collection) as { cnt: number } | undefined;
    const indexedDocs = docRow?.cnt ?? 0;

    // Count embedded documents via the regular `content_vectors` table
    // (hash-keyed; each row is a chunk). Join against active documents so
    // we only count vectors that still correspond to live notes.
    // The `vectors_vec` virtual table (sqlite-vec vec0 module) is NOT
    // queryable from a plain Node sqlite connection — use content_vectors
    // which is the canonical source of truth for which docs are embedded.
    let embeddedDocs = 0;
    try {
      const vecRow = db
        .prepare(
          `SELECT COUNT(DISTINCT d.id) AS cnt
             FROM documents d
             JOIN content_vectors cv ON cv.hash = d.hash
            WHERE d.active = 1 AND d.collection = ?`,
        )
        .get(collection) as { cnt: number } | undefined;
      embeddedDocs = vecRow?.cnt ?? 0;
    } catch {
      // content_vectors missing (unlikely) — leave at 0
    }

    const coverage =
      totalNotes > 0
        ? Math.max(0, Math.min(1, embeddedDocs / totalNotes))
        : 0;

    // Stale: vault files modified after the index was last written.
    // Uses index file mtime as a proxy for "last reindex" — any file
    // whose mtime is later has been edited since it was embedded.
    let staleCount = 0;
    try {
      const path = getIndexPath();
      const indexMtime = statSync(path).mtimeMs;
      for (const abs of files) {
        try {
          if (statSync(abs).mtimeMs > indexMtime) staleCount++;
        } catch {
          /* file gone between walk and stat */
        }
      }
    } catch {
      /* can't stat index — leave stale at 0 */
    }

    return {
      embedding_coverage: Math.round(coverage * 100) / 100,
      stale_embedding_count: staleCount,
    };
  } catch {
    return defaults;
  } finally {
    if (db && owned) db.close();
  }
}

// ── Growth velocity (from git log) ───────────────────────────────────

function execSyncGit(vaultPath: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: vaultPath,
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function computeGrowthVelocity(
  vaultPath: string,
  now: Date,
): { v7: number; v30: number } {
  const raw = execSyncGit(vaultPath, [
    "log",
    "--format=COMMIT %aI",
    "--name-only",
    "--diff-filter=A",
  ]);
  if (!raw) return { v7: 0, v30: 0 };

  const firstSeen = new Map<string, Date>();
  let currentDate: Date | null = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("COMMIT ")) {
      currentDate = new Date(trimmed.slice(7));
      continue;
    }
    if (!currentDate) continue;
    if (!trimmed.endsWith(".md")) continue;
    const existing = firstSeen.get(trimmed);
    if (!existing || currentDate < existing) firstSeen.set(trimmed, currentDate);
  }

  const cutoff7 = now.getTime() - 7 * DAY_MS;
  const cutoff30 = now.getTime() - 30 * DAY_MS;
  let v7 = 0;
  let v30 = 0;
  for (const d of firstSeen.values()) {
    const t = d.getTime();
    if (t >= cutoff7) v7++;
    if (t >= cutoff30) v30++;
  }
  return { v7, v30 };
}

// ── Duplicate candidates (optional) ──────────────────────────────────

/** Same env-default pattern as src/db.ts so legacy single-vault callers
 * (and tests that rely on the same default for inserts) keep working. */
function defaultVaultId(): string {
  return process.env.GROVE_VAULT_ID ?? "vault_00000000";
}

function countDuplicateCandidates(vaultId: string = defaultVaultId()): number {
  // Near-duplicate pairs surface in discovery_results once discovery
  // (Phase 7) embeds notes and compares neighbors. Auto-healing (P13-3)
  // will flag them explicitly; here we just count undismissed high-sim
  // pairs that already exist in the table.
  //
  // discovery_results is a process-global SQLite table; without
  // `vault_id = ?` here, vault A's stats report vault B's duplicate
  // count — same class of cross-vault leak as the unscoped search query
  // we caught on 2026-04-29.
  try {
    const row = getDb()
      .prepare(
        "SELECT COUNT(*) AS cnt FROM discovery_results WHERE vault_id = ? AND similarity > 0.85 AND dismissed_at IS NULL",
      )
      .get(vaultId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

// ── Metric computation ───────────────────────────────────────────────

export interface ComputeOptions {
  indexDb?: Database.Database;
  now?: Date;
  /**
   * vault_id used to scope process-global tables (discovery_results,
   * health flags) to this vault. Required for correct stats in
   * multi-vault deployments; falls back to the empty string only for
   * legacy single-vault callers, which produces zero matches and is
   * preferable to leaking other vaults' counts.
   */
  vaultId?: string;
}

export async function computeHealthMetrics(
  vaultPath: string,
  opts: ComputeOptions = {},
): Promise<GraphHealthMetrics> {
  const now = opts.now ?? new Date();
  const files = walkMd(vaultPath);

  // QMD's documents table tags every row with `collection` (= the last
  // path segment of the vault root). Use it to scope index reads here.
  const collection = vaultPath.split("/").filter(Boolean).pop() ?? "";
  const vaultId = opts.vaultId ?? defaultVaultId();

  const fileTexts = new Map<string, string>();
  let missingFrontmatter = 0;

  for (const abs of files) {
    let text: string;
    try {
      text = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    fileTexts.set(abs, text);
    const fm = parseFrontmatter(text.slice(0, 500));
    if (!fm.present || !fm.type || fm.tags.length === 0) missingFrontmatter++;
  }

  const totalNotes = files.length;
  const graph = buildGraph(files, fileTexts);
  const index = computeIndexHealth(totalNotes, files, collection, opts.indexDb);
  const growth = computeGrowthVelocity(vaultPath, now);
  const duplicateCandidates = countDuplicateCandidates(vaultId);

  const linkDensity =
    totalNotes > 0 ? graph.edgeCount / totalNotes : 0;
  const orphanRate =
    totalNotes > 0 ? graph.orphanCount / totalNotes : 0;
  const avgLinksPerNote =
    totalNotes > 0 ? graph.edgeCount / totalNotes : 0;
  const largestClusterPct =
    totalNotes > 0 ? graph.largestClusterSize / totalNotes : 0;

  return {
    total_notes: totalNotes,
    total_links: graph.edgeCount,
    link_density: Math.round(linkDensity * 100) / 100,
    orphan_count: graph.orphanCount,
    orphan_rate: Math.round(orphanRate * 10000) / 10000,
    broken_link_count: graph.brokenLinkCount,
    embedding_coverage: index.embedding_coverage,
    stale_embedding_count: index.stale_embedding_count,
    missing_frontmatter: missingFrontmatter,
    duplicate_candidates: duplicateCandidates,
    growth_velocity_7d: growth.v7,
    growth_velocity_30d: growth.v30,
    avg_links_per_note: Math.round(avgLinksPerNote * 100) / 100,
    cluster_count: graph.clusterCount,
    largest_cluster_pct: Math.round(largestClusterPct * 10000) / 10000,
  };
}

// ── Composite score ──────────────────────────────────────────────────

export function calculateHealthScore(m: GraphHealthMetrics): number {
  let score = 0;

  if (m.orphan_rate < 0.05) score += 20;
  else if (m.orphan_rate < 0.1) score += 10;

  if (m.broken_link_count === 0) score += 20;
  else if (m.broken_link_count < 5) score += 10;

  // Embedding coverage is optional — -1 means "not measurable" and
  // should not be penalised. Treat unknown as healthy to avoid
  // fluctuating scores when QMD isn't reachable.
  if (m.embedding_coverage < 0 || m.embedding_coverage > 0.95) score += 20;
  else if (m.embedding_coverage > 0.8) score += 10;

  if (m.link_density > 2.0) score += 20;
  else if (m.link_density > 1.0) score += 10;

  if (m.growth_velocity_7d > 0 || m.growth_velocity_30d > 0) score += 10;

  if (m.missing_frontmatter === 0) score += 10;
  else if (m.missing_frontmatter < 10) score += 5;

  return Math.max(0, Math.min(100, score));
}

// ── Persistence ──────────────────────────────────────────────────────

function parseSnapshotRow(row: {
  id: string;
  measured_at: string;
  metrics: string;
  score: number;
}): HealthSnapshot {
  return {
    id: row.id,
    measured_at: row.measured_at,
    metrics: JSON.parse(row.metrics) as GraphHealthMetrics,
    score: row.score,
  };
}

export function storeHealthSnapshot(
  metrics: GraphHealthMetrics,
  score: number,
  measuredAt?: string,
): HealthSnapshot {
  const db = getDb();
  const id = "health_" + randomBytes(8).toString("hex");
  const ts = measuredAt ?? new Date().toISOString();
  db.prepare(
    "INSERT INTO graph_health (id, measured_at, metrics, score) VALUES (?, ?, ?, ?)",
  ).run(id, ts, JSON.stringify(metrics), score);
  return { id, measured_at: ts, metrics, score };
}

export function getLatestHealthSnapshot(vaultId?: string): HealthSnapshot | null {
  const db = getDb();
  const row = (vaultId
    ? db
        .prepare(
          "SELECT id, measured_at, metrics, score FROM graph_health WHERE vault_id = ? ORDER BY measured_at DESC LIMIT 1",
        )
        .get(vaultId)
    : db
        .prepare(
          "SELECT id, measured_at, metrics, score FROM graph_health ORDER BY measured_at DESC LIMIT 1",
        )
        .get()) as
    | { id: string; measured_at: string; metrics: string; score: number }
    | undefined;
  return row ? parseSnapshotRow(row) : null;
}

/**
 * Return health snapshots from the last `days` days, oldest first.
 * Default window is 30 days; clamped to [1, 365]. Oldest-first ordering
 * suits dashboard trend lines (time flows left to right).
 */
export function getHealthHistory(days = 30, vaultId?: string): HealthSnapshot[] {
  const db = getDb();
  const window = Math.min(365, Math.max(1, Math.floor(days)));
  const rows = (vaultId
    ? db
        .prepare(
          `SELECT id, measured_at, metrics, score
             FROM graph_health
            WHERE vault_id = ? AND measured_at >= datetime('now', ?)
            ORDER BY measured_at ASC`,
        )
        .all(vaultId, `-${window} days`)
    : db
        .prepare(
          `SELECT id, measured_at, metrics, score
             FROM graph_health
            WHERE measured_at >= datetime('now', ?)
            ORDER BY measured_at ASC`,
        )
        .all(`-${window} days`)) as {
    id: string;
    measured_at: string;
    metrics: string;
    score: number;
  }[];
  return rows.map(parseSnapshotRow);
}

/**
 * Find the most recent snapshot strictly older than `measuredAt` and
 * within the given window (default 24h). Used to detect score drops.
 */
export function getPriorSnapshotWithin(
  measuredAt: string,
  windowMs: number = DAY_MS,
): HealthSnapshot | null {
  const db = getDb();
  const cutoff = new Date(new Date(measuredAt).getTime() - windowMs).toISOString();
  const row = db
    .prepare(
      `SELECT id, measured_at, metrics, score FROM graph_health
       WHERE measured_at < ? AND measured_at >= ?
       ORDER BY measured_at DESC LIMIT 1`,
    )
    .get(measuredAt, cutoff) as
    | { id: string; measured_at: string; metrics: string; score: number }
    | undefined;
  return row ? parseSnapshotRow(row) : null;
}

// ── Alert detection ──────────────────────────────────────────────────

export function detectAlerts(
  metrics: GraphHealthMetrics,
  score: number,
  previous: HealthSnapshot | null,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): HealthAlert[] {
  const alerts: HealthAlert[] = [];

  if (previous && previous.score - score > thresholds.score_drop_24h) {
    alerts.push({
      type: "score_drop",
      message: `Health score dropped from ${previous.score} to ${score} in the last 24h`,
      value: previous.score - score,
      threshold: thresholds.score_drop_24h,
    });
  }

  if (metrics.orphan_rate > thresholds.orphan_rate) {
    alerts.push({
      type: "orphan_rate",
      message: `Orphan rate is ${(metrics.orphan_rate * 100).toFixed(1)}% (threshold ${(thresholds.orphan_rate * 100).toFixed(0)}%)`,
      value: metrics.orphan_rate,
      threshold: thresholds.orphan_rate,
    });
  }

  if (metrics.broken_link_count > thresholds.broken_links) {
    alerts.push({
      type: "broken_links",
      message: `${metrics.broken_link_count} broken wikilinks (threshold ${thresholds.broken_links})`,
      value: metrics.broken_link_count,
      threshold: thresholds.broken_links,
    });
  }

  if (
    metrics.embedding_coverage >= 0 &&
    metrics.embedding_coverage < thresholds.embedding_coverage
  ) {
    alerts.push({
      type: "embedding_coverage",
      message: `Embedding coverage is ${(metrics.embedding_coverage * 100).toFixed(0)}% (threshold ${(thresholds.embedding_coverage * 100).toFixed(0)}%)`,
      value: metrics.embedding_coverage,
      threshold: thresholds.embedding_coverage,
    });
  }

  return alerts;
}

// ── Orchestration ────────────────────────────────────────────────────

export interface RunHealthCheckOptions {
  thresholds?: AlertThresholds;
  indexDb?: Database.Database;
  now?: Date;
  onAlert?: (alert: HealthAlert) => void;
  rid?: string;
  vaultId?: string;
}

export interface HealthCheckResult {
  snapshot: HealthSnapshot;
  alerts: HealthAlert[];
}

export async function runHealthCheck(
  vaultPath: string,
  opts: RunHealthCheckOptions = {},
): Promise<HealthCheckResult> {
  const rid = opts.rid ?? "health-" + randomBytes(4).toString("hex");
  const metrics = await computeHealthMetrics(vaultPath, {
    indexDb: opts.indexDb,
    now: opts.now,
    vaultId: opts.vaultId,
  });
  const score = calculateHealthScore(metrics);
  const snapshot = storeHealthSnapshot(
    metrics,
    score,
    opts.now?.toISOString(),
  );

  const prior = getPriorSnapshotWithin(snapshot.measured_at);
  const alerts = detectAlerts(
    metrics,
    score,
    prior,
    opts.thresholds ?? DEFAULT_ALERT_THRESHOLDS,
  );

  log("info", "graph-health.check", rid, {
    score,
    total_notes: metrics.total_notes,
    orphan_count: metrics.orphan_count,
    broken_link_count: metrics.broken_link_count,
    alert_count: alerts.length,
  });

  for (const alert of alerts) {
    log("warn", "graph-health.alert", rid, {
      alert_type: alert.type,
      alert_message: alert.message,
      value: alert.value,
      threshold: alert.threshold,
    });
    opts.onAlert?.(alert);
  }

  return { snapshot, alerts };
}

// ── Cron loop ────────────────────────────────────────────────────────

let cronTimer: ReturnType<typeof setTimeout> | null = null;
let cronRunning = false;

export const DEFAULT_HEALTH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface HealthCronOptions {
  intervalMs?: number;
  thresholds?: AlertThresholds;
  runImmediately?: boolean;
  onAlert?: (alert: HealthAlert) => void;
  vaultId?: string;
}

export function startHealthCronLoop(
  vaultPath: string,
  opts: HealthCronOptions = {},
): void {
  if (cronRunning) return;
  cronRunning = true;
  const interval = opts.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;

  const tick = async (): Promise<void> => {
    if (!cronRunning) return;
    try {
      await runHealthCheck(vaultPath, {
        thresholds: opts.thresholds,
        onAlert: opts.onAlert,
        vaultId: opts.vaultId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[graph-health] cron tick failed:", msg);
    }
    if (cronRunning) cronTimer = setTimeout(tick, interval);
  };

  console.log(`[graph-health] cron started (interval ${interval}ms)`);
  if (opts.runImmediately ?? false) {
    tick();
  } else {
    cronTimer = setTimeout(tick, interval);
  }
}

export function stopHealthCronLoop(): void {
  cronRunning = false;
  if (cronTimer) {
    clearTimeout(cronTimer);
    cronTimer = null;
  }
}

// ── Auto-healing ─────────────────────────────────────────────────────
//
// After computing metrics, fix non-risky issues automatically:
//   1. Broken wikilinks → rewrite when the old title matches an alias on
//      exactly one note (exact rename recovery).
//   2. Stale embeddings → re-queue notes modified after the index was built.
//   3. Missing tags → backfill via inferTags() when a note has none.
//   4. Missing type → infer from type_paths prefix in vault config.
//
// Risky issues are flagged instead (graph_health_flags):
//   5. Near-duplicates (similarity > 0.85, from discovery_results)
//   6. Long orphans (no links, file untouched for > 90 days)
//   7. Cluster islands (< 3 notes, disconnected from main component)

export interface AutoHealDetails {
  broken_link_fixes: Array<{ file: string; from: string; to: string }>;
  tag_additions: Array<{ file: string; tags: string[] }>;
  type_additions: Array<{ file: string; type: string }>;
  stale_embeddings: string[];
  flags: Array<{
    type: HealthFlagType;
    source_path: string | null;
    target_path: string | null;
  }>;
}

export interface AutoHealStats {
  broken_links_fixed: number;
  stale_embeddings_queued: number;
  tags_added: number;
  types_inferred: number;
  duplicate_candidates_flagged: number;
  long_orphans_flagged: number;
  cluster_islands_flagged: number;
  commit?: string;
  details: AutoHealDetails;
}

export interface AutoHealOptions {
  embedFn?: (vaultPath: string, filePath: string) => Promise<void>;
  queueWrite?: <T>(fn: () => Promise<T>) => Promise<T>;
  commit?: boolean;
  now?: Date;
  longOrphanDays?: number;
  duplicateSimilarityThreshold?: number;
  clusterIslandMaxSize?: number;
  rid?: string;
  config?: VaultConfig;
  /**
   * vault_id used to scope process-global tables (discovery_results) to
   * this vault. Without it, the duplicate-flag pass would surface
   * (source_path, target_path) pairs from other vaults — generating
   * noise flags on this vault about notes that don't exist here.
   */
  vaultId?: string;
}

function readVaultFile(abs: string): string | null {
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

interface NoteView {
  abs: string;
  rel: string;
  basename: string;
  frontmatter: Record<string, unknown>;
  content: string;
  rawHash: string;
  type: string | null;
  tags: string[];
  aliases: string[];
  links: string[];
  mtimeMs: number;
}

function parseNoteView(
  abs: string,
  vaultPath: string,
  raw: string,
  mtimeMs: number,
): NoteView {
  const { frontmatter, content } = parseNote(raw);
  const type =
    typeof frontmatter.type === "string" ? frontmatter.type : null;
  const tags = Array.isArray(frontmatter.tags)
    ? (frontmatter.tags as unknown[]).filter(
        (t): t is string => typeof t === "string",
      )
    : typeof frontmatter.tags === "string"
      ? [frontmatter.tags as string]
      : [];
  const aliases = Array.isArray(frontmatter.aliases)
    ? (frontmatter.aliases as unknown[]).filter(
        (a): a is string => typeof a === "string",
      )
    : [];
  return {
    abs,
    rel: relative(vaultPath, abs),
    basename: basename(abs, ".md"),
    frontmatter,
    content,
    rawHash: raw,
    type,
    tags,
    aliases,
    links: extractWikilinks(raw),
    mtimeMs,
  };
}

function inferTypeFromPath(
  relPath: string,
  config: VaultConfig,
): string | null {
  // Exact type_paths match. Longer prefixes win so Resources/Concepts/
  // beats Resources/ if both were registered.
  let best: { type: string; length: number } | null = null;
  for (const [type, prefix] of Object.entries(config.structure.type_paths)) {
    if (!prefix) continue;
    if (relPath.startsWith(prefix)) {
      if (!best || prefix.length > best.length) {
        best = { type, length: prefix.length };
      }
    }
  }
  return best?.type ?? null;
}

/**
 * Build a lookup of alias → single owning note for broken-link repair.
 * Aliases that belong to more than one note are excluded (ambiguous — we
 * refuse to guess). Basenames are also added so `[[Old Name]]` matches the
 * new note when the alias was recorded as the original title before rename.
 */
function buildAliasIndex(notes: NoteView[]): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const note of notes) {
    const candidates = new Set<string>([note.basename, ...note.aliases]);
    for (const raw of candidates) {
      const key = raw.trim().toLowerCase();
      if (!key) continue;
      let set = owners.get(key);
      if (!set) {
        set = new Set();
        owners.set(key, set);
      }
      set.add(note.basename);
    }
  }

  const index = new Map<string, string>();
  for (const [key, set] of owners) {
    if (set.size === 1) index.set(key, [...set][0]);
  }
  return index;
}

function rewriteWikilinks(
  raw: string,
  aliasIndex: Map<string, string>,
  realBases: Set<string>,
): { updated: string; fixes: Array<{ from: string; to: string }> } {
  const fixes: Array<{ from: string; to: string }> = [];
  const re = new RegExp(WIKILINK_RE.source, "g");
  const updated = raw.replace(re, (match, rawTarget: string) => {
    const trimmed = rawTarget.trim();
    const base = stem(trimmed);
    if (realBases.has(base)) return match;
    const key = base.toLowerCase();
    const replacement = aliasIndex.get(key);
    if (!replacement) return match;
    fixes.push({ from: trimmed, to: replacement });
    // Preserve any pipe display text the caller had
    const pipeIdx = match.indexOf("|");
    if (pipeIdx !== -1) {
      return `[[${replacement}${match.slice(pipeIdx, -2)}]]`;
    }
    return `[[${replacement}]]`;
  });
  return { updated, fixes };
}

function gitCommitSync(
  vaultPath: string,
  paths: string[],
  message: string,
): string | null {
  try {
    if (paths.length === 0) return null;
    execFileSync("git", ["add", "-A", "--", ...paths], {
      cwd: vaultPath,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30_000,
    });
    execFileSync("git", ["commit", "-m", message], {
      cwd: vaultPath,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30_000,
    });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: vaultPath,
      encoding: "utf-8",
      timeout: 10_000,
    });
    return sha.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[graph-health] auto-heal commit skipped: ${msg}`);
    return null;
  }
}

export async function autoHeal(
  vaultPath: string,
  opts: AutoHealOptions = {},
): Promise<AutoHealStats> {
  const rid = opts.rid ?? "autoheal-" + randomBytes(4).toString("hex");
  const now = opts.now ?? new Date();
  const longOrphanMs =
    (opts.longOrphanDays ?? 90) * DAY_MS;
  const dupThreshold = opts.duplicateSimilarityThreshold ?? 0.85;
  const clusterMax = opts.clusterIslandMaxSize ?? 3;
  const config = opts.config ?? loadVaultConfig(vaultPath);
  const queueWrite =
    opts.queueWrite ?? (async <T>(fn: () => Promise<T>) => fn());

  const details: AutoHealDetails = {
    broken_link_fixes: [],
    tag_additions: [],
    type_additions: [],
    stale_embeddings: [],
    flags: [],
  };

  const files = walkMd(vaultPath);
  const notes: NoteView[] = [];
  for (const abs of files) {
    const raw = readVaultFile(abs);
    if (raw === null) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(abs).mtimeMs;
    } catch {
      /* file vanished */
    }
    notes.push(parseNoteView(abs, vaultPath, raw, mtimeMs));
  }

  const aliasIndex = buildAliasIndex(notes);
  const realBases = new Set(notes.map((n) => n.basename));
  const modifiedPaths = new Set<string>();

  // ── 1. Broken wikilinks → rewrite via alias/basename match ──────────
  for (const note of notes) {
    const { updated, fixes } = rewriteWikilinks(
      note.rawHash,
      aliasIndex,
      realBases,
    );
    // Don't rewrite links that already point to the current note's basename
    const relevantFixes = fixes.filter((f) => f.to !== note.basename);
    if (relevantFixes.length === 0) continue;

    await queueWrite(async () => {
      writeFileSync(note.abs, updated, "utf-8");
    });
    modifiedPaths.add(note.rel);
    for (const fix of relevantFixes) {
      details.broken_link_fixes.push({
        file: note.rel,
        from: fix.from,
        to: fix.to,
      });
    }
  }

  // ── 2. Stale embeddings → re-queue (fire-and-forget) ────────────────
  const indexPath = getIndexPath();
  let indexMtime = 0;
  try {
    indexMtime = statSync(indexPath).mtimeMs;
  } catch {
    /* index unavailable */
  }
  if (indexMtime > 0 && opts.embedFn) {
    for (const note of notes) {
      if (note.mtimeMs > indexMtime) {
        details.stale_embeddings.push(note.rel);
        opts.embedFn(vaultPath, note.rel).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          log("warn", "graph-health.embed_failed", rid, {
            path: note.rel,
            error: msg,
          });
        });
      }
    }
  } else if (indexMtime > 0) {
    for (const note of notes) {
      if (note.mtimeMs > indexMtime) details.stale_embeddings.push(note.rel);
    }
  }

  // ── 3. Missing tags → inferTags backfill ────────────────────────────
  // ── 4. Missing type → infer from type_paths ────────────────────────
  // (Combined walk: one frontmatter rewrite per note covers both.)
  for (const note of notes) {
    const freshRaw = readVaultFile(note.abs);
    if (freshRaw === null) continue;
    const { frontmatter: fm, content } = parseNote(freshRaw);

    const hadType = typeof fm.type === "string" && fm.type.length > 0;
    let inferredType: string | null = null;
    if (!hadType) {
      inferredType = inferTypeFromPath(note.rel, config);
      if (inferredType) fm.type = inferredType;
    }

    const existingTags = Array.isArray(fm.tags)
      ? (fm.tags as unknown[]).filter(
          (t): t is string => typeof t === "string",
        )
      : typeof fm.tags === "string"
        ? [fm.tags as string]
        : [];

    let addedTags: string[] = [];
    if (existingTags.length === 0) {
      const inferred = inferTags(note.rel, fm, config);
      if (inferred.length > 0) {
        fm.tags = inferred;
        addedTags = inferred;
      }
    }

    const changedType = !hadType && inferredType !== null;
    const changedTags = addedTags.length > 0;
    if (!changedType && !changedTags) continue;

    const updated = serializeNote(fm, content);
    if (updated === freshRaw) continue;

    await queueWrite(async () => {
      writeFileSync(note.abs, updated, "utf-8");
    });
    modifiedPaths.add(note.rel);
    if (changedType && inferredType)
      details.type_additions.push({ file: note.rel, type: inferredType });
    if (changedTags)
      details.tag_additions.push({ file: note.rel, tags: addedTags });
  }

  // ── Commit all auto-fix changes as a single batch ───────────────────
  let commitSha: string | null = null;
  const commitEnabled = opts.commit ?? true;
  if (commitEnabled && modifiedPaths.size > 0) {
    const summary: string[] = [];
    if (details.broken_link_fixes.length > 0)
      summary.push(`fixed ${details.broken_link_fixes.length} broken links`);
    if (details.tag_additions.length > 0)
      summary.push(`backfilled tags on ${details.tag_additions.length} notes`);
    if (details.type_additions.length > 0)
      summary.push(`inferred type on ${details.type_additions.length} notes`);
    const msg = `grove (auto-heal): ${summary.join(", ")}`;
    commitSha = gitCommitSync(vaultPath, [...modifiedPaths], msg);
  }

  // ── 5. Near-duplicate flags (from discovery_results) ────────────────
  // Scope by vault_id; discovery_results is process-global and an
  // unscoped read here would let vault A's auto-heal fabricate flags
  // about vault B's (source_path, target_path) pairs.
  const vaultId = opts.vaultId ?? defaultVaultId();
  let duplicatesFlagged = 0;
  try {
    const rows = getDb()
      .prepare(
        `SELECT id, source_path, target_path, similarity
         FROM discovery_results
         WHERE vault_id = ? AND similarity > ? AND dismissed_at IS NULL`,
      )
      .all(vaultId, dupThreshold) as Array<{
      id: string;
      source_path: string;
      target_path: string;
      similarity: number;
    }>;
    for (const row of rows) {
      // Normalise so (A,B) and (B,A) share a flag
      const [a, b] = [row.source_path, row.target_path].sort();
      const id = "flag_" + randomBytes(8).toString("hex");
      const inserted = insertHealthFlag(
        id,
        "duplicate_candidate",
        a,
        b,
        { similarity: row.similarity, discovery_id: row.id },
      );
      if (inserted) {
        duplicatesFlagged++;
        details.flags.push({
          type: "duplicate_candidate",
          source_path: a,
          target_path: b,
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("warn", "graph-health.duplicate_flag_failed", rid, { error: msg });
  }

  // ── 6. Long orphan flags ────────────────────────────────────────────
  // Rebuild a light graph view over notes we already have parsed.
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const note of notes) {
    outgoing.set(note.basename, new Set());
    incoming.set(note.basename, new Set());
  }
  for (const note of notes) {
    const srcOut = outgoing.get(note.basename)!;
    for (const raw of note.links) {
      const target = stem(raw);
      if (target === note.basename) continue;
      if (!realBases.has(target)) continue;
      if (srcOut.has(target)) continue;
      srcOut.add(target);
      if (!incoming.has(target)) incoming.set(target, new Set());
      incoming.get(target)!.add(note.basename);
    }
  }

  let longOrphansFlagged = 0;
  const cutoff = now.getTime() - longOrphanMs;
  for (const note of notes) {
    const outSize = outgoing.get(note.basename)?.size ?? 0;
    const incSize = incoming.get(note.basename)?.size ?? 0;
    if (outSize > 0 || incSize > 0) continue;
    if (!note.mtimeMs || note.mtimeMs > cutoff) continue;
    const id = "flag_" + randomBytes(8).toString("hex");
    const inserted = insertHealthFlag(
      id,
      "long_orphan",
      note.rel,
      null,
      {
        basename: note.basename,
        last_modified_at: new Date(note.mtimeMs).toISOString(),
        age_days: Math.floor((now.getTime() - note.mtimeMs) / DAY_MS),
      },
    );
    if (inserted) {
      longOrphansFlagged++;
      details.flags.push({
        type: "long_orphan",
        source_path: note.rel,
        target_path: null,
      });
    }
  }

  // ── 7. Cluster island flags ─────────────────────────────────────────
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const note of notes) {
    if (visited.has(note.basename)) continue;
    const members: string[] = [];
    const queue = [note.basename];
    visited.add(note.basename);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      members.push(cur);
      const neighbors = new Set<string>();
      for (const n of outgoing.get(cur) ?? []) neighbors.add(n);
      for (const n of incoming.get(cur) ?? []) neighbors.add(n);
      for (const nb of neighbors) {
        if (!visited.has(nb) && realBases.has(nb)) {
          visited.add(nb);
          queue.push(nb);
        }
      }
    }
    components.push(members);
  }

  let clusterIslandsFlagged = 0;
  // Skip the largest component — that's the "mainland."
  let largestIndex = -1;
  let largestSize = 0;
  for (let i = 0; i < components.length; i++) {
    if (components[i].length > largestSize) {
      largestSize = components[i].length;
      largestIndex = i;
    }
  }
  const baseToNote = new Map(notes.map((n) => [n.basename, n]));
  for (let i = 0; i < components.length; i++) {
    if (i === largestIndex) continue;
    const members = components[i];
    if (members.length >= clusterMax) continue;
    if (members.length < 2) continue; // singletons surface via long_orphan
    const memberPaths = members
      .map((b) => baseToNote.get(b)?.rel)
      .filter((p): p is string => typeof p === "string")
      .sort();
    const id = "flag_" + randomBytes(8).toString("hex");
    const inserted = insertHealthFlag(
      id,
      "cluster_island",
      memberPaths[0] ?? null,
      null,
      { size: members.length, members: memberPaths },
    );
    if (inserted) {
      clusterIslandsFlagged++;
      details.flags.push({
        type: "cluster_island",
        source_path: memberPaths[0] ?? null,
        target_path: null,
      });
    }
  }

  const stats: AutoHealStats = {
    broken_links_fixed: details.broken_link_fixes.length,
    stale_embeddings_queued: details.stale_embeddings.length,
    tags_added: details.tag_additions.length,
    types_inferred: details.type_additions.length,
    duplicate_candidates_flagged: duplicatesFlagged,
    long_orphans_flagged: longOrphansFlagged,
    cluster_islands_flagged: clusterIslandsFlagged,
    details,
  };
  if (commitSha) stats.commit = commitSha;

  log("info", "graph-health.auto_heal", rid, {
    broken_links_fixed: stats.broken_links_fixed,
    stale_embeddings_queued: stats.stale_embeddings_queued,
    tags_added: stats.tags_added,
    types_inferred: stats.types_inferred,
    duplicate_candidates_flagged: stats.duplicate_candidates_flagged,
    long_orphans_flagged: stats.long_orphans_flagged,
    cluster_islands_flagged: stats.cluster_islands_flagged,
    commit: commitSha ?? undefined,
  });

  return stats;
}

// ── Admin health API helpers (P13-4) ─────────────────────────────────

export interface HealthFlag {
  id: string;
  flag_type: string;
  source_path: string | null;
  target_path: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
  resolved_at: string | null;
}

interface FlagRow {
  id: string;
  flag_type: string;
  source_path: string | null;
  target_path: string | null;
  details: string | null;
  created_at: string;
  resolved_at: string | null;
}

function hydrateFlag(row: FlagRow): HealthFlag {
  return {
    id: row.id,
    flag_type: row.flag_type,
    source_path: row.source_path,
    target_path: row.target_path,
    details: row.details ? (JSON.parse(row.details) as Record<string, unknown>) : null,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  };
}

/** Alias for the admin API — returns the most recent health snapshot. */
export function getCurrentHealth(vaultId?: string): HealthSnapshot | null {
  return getLatestHealthSnapshot(vaultId);
}

/** Return unresolved health flags, most recent first. */
export function getUnresolvedFlags(vaultId?: string): HealthFlag[] {
  const db = getDb();
  const rows = (vaultId
    ? db
        .prepare(
          `SELECT id, flag_type, source_path, target_path, details, created_at, resolved_at
             FROM graph_health_flags
            WHERE resolved_at IS NULL AND vault_id = ?
            ORDER BY created_at DESC`,
        )
        .all(vaultId)
    : db
        .prepare(
          `SELECT id, flag_type, source_path, target_path, details, created_at, resolved_at
             FROM graph_health_flags
            WHERE resolved_at IS NULL
            ORDER BY created_at DESC`,
        )
        .all()) as FlagRow[];
  return rows.map(hydrateFlag);
}

/**
 * Mark a flag as resolved. Returns true if a row was updated, false if the
 * flag did not exist or was already resolved.
 */
export function resolveFlag(id: string): boolean {
  const db = getDb();
  const result = db
    .prepare(
      "UPDATE graph_health_flags SET resolved_at = datetime('now') WHERE id = ? AND resolved_at IS NULL",
    )
    .run(id);
  return result.changes > 0;
}

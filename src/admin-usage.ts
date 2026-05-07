/**
 * Admin usage dashboard — pulls per-user/per-vault activity from sqlite
 * (users + vaults + api_keys), the proxy's own pm2 log file (the
 * historical request stream), and the persistent stats cache (vault
 * content snapshot). Renders a single server-rendered HTML page so an
 * operator can answer "who's actually using Grove and how much" without
 * SSH-ing the box.
 *
 * Backed by a 60s in-memory cache because the log parse is ~200-500ms
 * on a 10MB file. If the log grows past ~100MB we should switch to a
 * sqlite usage_events table updated synchronously by the structured
 * logger, but at current volume disk-tail is plenty.
 */

import { readFileSync, existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { getDb } from "./db.js";
import { getStats } from "./vault-stats.js";
import type { VaultStats } from "./vault-stats.js";

// ── Tool taxonomy ────────────────────────────────────────────────────
//
// Separating "real work" from MCP handshake is the difference between
// "Sumon is active" and "Sumon's Claude session opened" — the second
// happens on every chat-window open even if he never touches the vault.

const HANDSHAKE_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "ping",
  "GET",
]);

const READ_METHODS = new Set([
  "get",
  "multi_get",
  "query",
  "list_notes",
  "vault_status",
]);

const WRITE_METHODS = new Set([
  "write_note",
]);

const READ_MSGS = new Set([
  "rest.get_note",
  "rest.list",
  "rest.search",
  "rest.stats",
  "rest.status",
  "audit.read",
]);

const WRITE_MSGS = new Set([
  "rest.put_note",
  "rest.delete_note",
  "rest.move_note",
  "rest.image_upload",
  "audit.write",
]);

function classify(msg: string, tool: string): "read" | "write" | "handshake" | "other" {
  if (msg === "mcp.request") {
    if (HANDSHAKE_METHODS.has(tool)) return "handshake";
    if (READ_METHODS.has(tool)) return "read";
    if (WRITE_METHODS.has(tool)) return "write";
    return "other";
  }
  if (READ_MSGS.has(msg)) return "read";
  if (WRITE_MSGS.has(msg)) return "write";
  return "other";
}

// ── Types ─────────────────────────────────────────────────────────────

export interface UsageInputs {
  users: { id: string; email: string; role: string }[];
  vaults: { id: string; slug: string; owner_id: string; git_repo_path: string }[];
  keys: { name: string; vault_id: string; user_id: string; created_at: string; last_used_at: string | null }[];
  events: UsageEvent[];
  contentByVaultSlug: Map<string, VaultStats>;
  logRange: { earliest: string | null; latest: string | null };
}

export interface UsageEvent {
  ts: string;          // ISO
  key_name: string;
  msg: string;
  tool: string;        // tool or mcp_method or msg
}

export interface VaultUsage {
  slug: string;
  vault_id: string;
  content: VaultStats | null;
  requests: { "24h": number; "7d": number; "30d": number };
  real_reads_7d: number;
  real_writes_7d: number;
  handshake_7d: number;
  last_seen: string | null;
  top_tools_7d: { tool: string; count: number }[];
  daily_30d: { day: string; count: number }[];
  keys: { name: string; created_at: string; last_used_at: string | null }[];
}

export interface UserUsage {
  email: string;
  label: string;
  is_owner: boolean;
  vaults: VaultUsage[];
  total_7d: number;
}

export interface UsageSummary {
  computed_at: string;
  log_range: { earliest: string | null; latest: string | null };
  users: UserUsage[];
  unattributed_recent_keys: { name: string; recent_count: number }[];
}

// ── Inputs ────────────────────────────────────────────────────────────

const DEFAULT_LOG_PATH =
  process.env.GROVE_PROXY_LOG ?? "/root/.pm2/logs/grove-proxy-out.log";

interface LoadInputsOptions {
  logPath?: string;
  db?: Database.Database;
}

export function loadUsageInputs(opts: LoadInputsOptions = {}): UsageInputs {
  const logPath = opts.logPath ?? DEFAULT_LOG_PATH;
  const db = opts.db ?? getDb();

  const users = db
    .prepare("SELECT id, email, role FROM users WHERE email IS NOT NULL")
    .all() as { id: string; email: string; role: string }[];

  const vaults = db
    .prepare("SELECT id, slug, owner_id, git_repo_path FROM vaults")
    .all() as { id: string; slug: string; owner_id: string; git_repo_path: string }[];

  const keys = db
    .prepare(
      "SELECT name, vault_id, user_id, created_at, last_used_at FROM api_keys"
    )
    .all() as {
      name: string;
      vault_id: string;
      user_id: string;
      created_at: string;
      last_used_at: string | null;
    }[];

  const { events, logRange } = parseLogEvents(logPath);

  const contentByVaultSlug = new Map<string, VaultStats>();
  for (const v of vaults) {
    const stats = getStats(v.git_repo_path);
    if (stats) contentByVaultSlug.set(v.slug, stats);
  }

  return { users, vaults, keys, events, contentByVaultSlug, logRange };
}

export function parseLogEvents(logPath: string): {
  events: UsageEvent[];
  logRange: { earliest: string | null; latest: string | null };
} {
  if (!existsSync(logPath)) {
    return { events: [], logRange: { earliest: null, latest: null } };
  }

  const events: UsageEvent[] = [];
  let earliest: string | null = null;
  let latest: string | null = null;

  // For files this size (~10MB) reading the whole thing in is fine. If
  // the log grows past ~100MB switch to a streaming reader.
  const raw = readFileSync(logPath, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.startsWith("{")) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const msg = typeof d.msg === "string" ? d.msg : "";
    if (!msg) continue;
    const kn = typeof d.key_name === "string" ? d.key_name : "";
    if (!kn) continue;
    const ts = typeof d.ts === "string" ? d.ts : "";
    if (!ts) continue;
    const tool =
      (typeof d.tool === "string" && d.tool) ||
      (typeof d.mcp_method === "string" && d.mcp_method) ||
      msg;
    events.push({ ts, key_name: kn, msg, tool });
    if (!earliest || ts < earliest) earliest = ts;
    if (!latest || ts > latest) latest = ts;
  }

  return { events, logRange: { earliest, latest } };
}

// ── Aggregation ───────────────────────────────────────────────────────

const USER_LABELS: Record<string, string> = {
  // email-prefix → short label
  jrmilinovich: "john",
  modernmedici88: "sumon",
  "ryan.p.parker": "ryan",
};

function userLabel(email: string): string {
  const local = email.split("@")[0].toLowerCase();
  for (const [prefix, label] of Object.entries(USER_LABELS)) {
    if (local.startsWith(prefix)) return label;
  }
  return local;
}

export function aggregateUsage(inputs: UsageInputs, now: Date = new Date()): UsageSummary {
  const cutoffs = {
    "24h": new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    "7d": new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    "30d": new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  };

  const keyToUserVault = new Map<string, { user_id: string; vault_id: string }>();
  for (const k of inputs.keys) {
    keyToUserVault.set(k.name, { user_id: k.user_id, vault_id: k.vault_id });
  }

  const userById = new Map(inputs.users.map((u) => [u.id, u]));
  const vaultById = new Map(inputs.vaults.map((v) => [v.id, v]));

  // Build a (user, vault) → metrics structure
  type Bucket = {
    by_window: Record<"24h" | "7d" | "30d", number>;
    real_reads_7d: number;
    real_writes_7d: number;
    handshake_7d: number;
    last_seen: string | null;
    tool_counts_7d: Map<string, number>;
    daily_30d: Map<string, number>;
  };
  const empty = (): Bucket => ({
    by_window: { "24h": 0, "7d": 0, "30d": 0 },
    real_reads_7d: 0,
    real_writes_7d: 0,
    handshake_7d: 0,
    last_seen: null,
    tool_counts_7d: new Map(),
    daily_30d: new Map(),
  });

  const buckets = new Map<string, Bucket>(); // key: `${user_id}|${vault_id}`
  const unattributed = new Map<string, number>();
  const RECENT_CUTOFF_FOR_UNATTRIBUTED = cutoffs["30d"];

  for (const e of inputs.events) {
    const ref = keyToUserVault.get(e.key_name);
    if (!ref) {
      if (e.ts >= RECENT_CUTOFF_FOR_UNATTRIBUTED) {
        unattributed.set(e.key_name, (unattributed.get(e.key_name) ?? 0) + 1);
      }
      continue;
    }
    const k = `${ref.user_id}|${ref.vault_id}`;
    let b = buckets.get(k);
    if (!b) {
      b = empty();
      buckets.set(k, b);
    }
    if (e.ts >= cutoffs["30d"]) b.by_window["30d"] += 1;
    if (e.ts >= cutoffs["7d"]) {
      b.by_window["7d"] += 1;
      const klass = classify(e.msg, e.tool);
      if (klass === "read") b.real_reads_7d += 1;
      else if (klass === "write") b.real_writes_7d += 1;
      else if (klass === "handshake") b.handshake_7d += 1;
      b.tool_counts_7d.set(e.tool, (b.tool_counts_7d.get(e.tool) ?? 0) + 1);
    }
    if (e.ts >= cutoffs["24h"]) b.by_window["24h"] += 1;
    if (e.ts >= cutoffs["30d"]) {
      const day = e.ts.slice(0, 10);
      b.daily_30d.set(day, (b.daily_30d.get(day) ?? 0) + 1);
    }
    if (!b.last_seen || e.ts > b.last_seen) b.last_seen = e.ts;
  }

  // Build keys-by-vault index
  const keysByVault = new Map<string, typeof inputs.keys>();
  for (const k of inputs.keys) {
    const list = keysByVault.get(k.vault_id) ?? [];
    list.push(k);
    keysByVault.set(k.vault_id, list);
  }

  const users: UserUsage[] = [];
  for (const u of inputs.users) {
    const userVaults = inputs.vaults.filter((v) => v.owner_id === u.id);
    if (userVaults.length === 0) continue;

    const vaultUsages: VaultUsage[] = [];
    let total_7d = 0;
    for (const v of userVaults) {
      const b = buckets.get(`${u.id}|${v.id}`) ?? empty();
      const top_tools_7d = [...b.tool_counts_7d.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([tool, count]) => ({ tool, count }));

      const daily_30d = thirtyDayCurve(b.daily_30d, now);

      vaultUsages.push({
        slug: v.slug,
        vault_id: v.id,
        content: inputs.contentByVaultSlug.get(v.slug) ?? null,
        requests: { ...b.by_window },
        real_reads_7d: b.real_reads_7d,
        real_writes_7d: b.real_writes_7d,
        handshake_7d: b.handshake_7d,
        last_seen: b.last_seen,
        top_tools_7d,
        daily_30d,
        keys: keysByVault.get(v.id) ?? [],
      });
      total_7d += b.by_window["7d"];
    }

    users.push({
      email: u.email,
      label: userLabel(u.email),
      is_owner: u.role === "owner",
      vaults: vaultUsages,
      total_7d,
    });
  }

  users.sort((a, b) => b.total_7d - a.total_7d);

  const unattributed_recent_keys = [...unattributed.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, recent_count]) => ({ name, recent_count }));

  return {
    computed_at: now.toISOString(),
    log_range: inputs.logRange,
    users,
    unattributed_recent_keys,
  };
}

function thirtyDayCurve(
  daily: Map<string, number>,
  now: Date,
): { day: string; count: number }[] {
  const out: { day: string; count: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const day = d.toISOString().slice(0, 10);
    out.push({ day, count: daily.get(day) ?? 0 });
  }
  return out;
}

// ── Cache wrapper ─────────────────────────────────────────────────────

let cache: { value: UsageSummary; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

export function getUsageSummary(opts: LoadInputsOptions = {}): UsageSummary {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  const inputs = loadUsageInputs(opts);
  const value = aggregateUsage(inputs);
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

export function clearUsageCache(): void {
  cache = null;
}

// ── HTML rendering ────────────────────────────────────────────────────

const SPARK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function sparkline(values: number[]): string {
  const max = Math.max(1, ...values);
  return values
    .map((v) => SPARK_BLOCKS[Math.min(7, Math.floor((v / max) * 7))])
    .join("");
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return iso.replace("T", " ").slice(0, 19) + " UTC";
}

export function renderUsageHtml(summary: UsageSummary): string {
  const rows: string[] = [];

  for (const user of summary.users) {
    for (const v of user.vaults) {
      const spark = sparkline(v.daily_30d.map((d) => d.count));
      const tools = v.top_tools_7d
        .map((t) => `${escape(t.tool)} ${t.count}`)
        .join(" · ");
      const c = v.content;
      const contentLine = c
        ? `${c.vault.total_notes} notes · ${c.graph.edges} edges · ${c.graph.orphan_count} orphans · ${c.freshness.this_week} edited 7d · velocity ${c.freshness.velocity_7d}/d`
        : "(no stats cached yet)";
      rows.push(`
<tr>
  <td><strong>${escape(user.label)}</strong><br><span class="dim">${escape(user.email)}</span></td>
  <td>${escape(v.slug)}</td>
  <td class="num">${v.requests["24h"]}</td>
  <td class="num">${v.requests["7d"]}</td>
  <td class="num">${v.requests["30d"]}</td>
  <td class="num">${v.real_reads_7d}<span class="dim">r</span> / ${v.real_writes_7d}<span class="dim">w</span> <span class="dim">(${v.handshake_7d}h)</span></td>
  <td>${escape(fmtTime(v.last_seen))}</td>
  <td class="spark">${spark}</td>
</tr>
<tr class="detail">
  <td></td>
  <td colspan="7">
    <span class="dim">content:</span> ${escape(contentLine)}<br>
    <span class="dim">top tools 7d:</span> ${tools || "—"}<br>
    <span class="dim">keys:</span> ${escape(v.keys.map((k) => k.name).join(", ") || "—")}
  </td>
</tr>`);
    }
  }

  const unattribLine = summary.unattributed_recent_keys.length === 0
    ? ""
    : `<p class="dim">Unattributed keys with recent activity (likely revoked): ${
        summary.unattributed_recent_keys
          .map((u) => `${escape(u.name)} (${u.recent_count})`)
          .join(", ")
      }</p>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Grove · Usage</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; max-width: 1100px; margin: 32px auto; padding: 0 16px; color: #1a1423; background: #faf7f2; font-size: 13px; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  .dim { color: #1a142399; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #1a142318; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #1a142399; font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.spark { font-size: 18px; letter-spacing: 1px; line-height: 1; color: #6b4fd6; }
  tr.detail td { padding-top: 0; padding-bottom: 14px; border-bottom: 2px solid #1a142318; font-size: 11px; line-height: 1.6; }
</style>
</head>
<body>
<h1>Grove · Usage</h1>
<p class="dim">computed ${escape(fmtTime(summary.computed_at))} · log window ${escape(fmtTime(summary.log_range.earliest))} → ${escape(fmtTime(summary.log_range.latest))}</p>
${unattribLine}
<table>
  <thead>
    <tr>
      <th>User</th><th>Vault</th><th>24h</th><th>7d</th><th>30d</th>
      <th>reads / writes (handshake) 7d</th><th>Last seen</th><th>30d daily</th>
    </tr>
  </thead>
  <tbody>${rows.join("")}</tbody>
</table>
</body>
</html>`;
}

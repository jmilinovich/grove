#!/usr/bin/env tsx
/**
 * Grove CLI — talk to the Grove knowledge API from the terminal.
 *
 * Usage:
 *   grove search "taste graph"
 *   grove read "Taste Graph"
 *   grove list "Resources/People/*"
 *   grove history --since "3 days ago"
 *   grove status
 *   grove diagnostics
 *   grove write "Inbox/idea.md" --type concept
 *
 * Flags:
 *   --json   Force JSON output (auto-enabled when stdout is not a TTY)
 */

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { readArchiveSources, planSync, normalizeDir } from "./sync-sources.js";
import { loadTrails, createTrail, disableTrail, deleteTrail } from "./trails.js";
import { parseNote, serializeNote, inferTags, contentHash } from "./notes-validate.js";
import { enqueueDiscovery, createSchema } from "./db.js";
import { syncBookmarks } from "./discovery-bookmarks.js";
import { installSignalHandlers } from "./cli/lib/signals.js";
import { guardAgainstTokenInArgv } from "./cli/lib/argv.js";
import { GroveCliError, exitCodeFor as newExitCodeFor } from "./cli/lib/errors.js";
import {
  selectFormat,
  render as renderOutput,
  parseFields,
  isNullDelimited,
  type Format,
} from "./cli/lib/format.js";
import { resolveIdempotencyKey } from "./cli/lib/idempotency.js";
import { confirmTyped } from "./cli/lib/confirm.js";
import { promptPassphrase } from "./cli/lib/passphrase.js";
import { warnDeprecated } from "./cli/lib/deprecation.js";
import {
  validatePatchArgs,
  obsidianUrl,
  openInObsidian,
  doLogout,
  runDoctor,
  completionBash,
  completionZsh,
  completionFish,
} from "./cli/phase3.js";
import { runEdit, type EditDeps } from "./cli/edit.js";
import {
  CONFIG_RELATIVE_PATH,
  detectAndWriteConfig,
  loadVaultConfig,
} from "./vault-config.js";

// ── Vault path (local git operations) ────────────────────────────
const VAULT_PATH = process.env.GROVE_VAULT ?? join(homedir(), "life");

// ── Config ───────────────────────────────────────────────────────

// Re-export the new config types/loader; keep local Config interface for back-compat.
import { loadConfig as loadConfigImpl, type Config as NewConfig } from "./cli/lib/config.js";

type Config = NewConfig;

function loadConfig(): Config {
  // Prefer the new GroveCliError-based loader; main() already handles both error classes.
  return loadConfigImpl();
}

// ── CliError ────────────────────────────────────────────────────

export class CliError extends Error {
  constructor(public code: string, message: string, public exitCode: number = 1) {
    super(message);
  }
}

// Exit codes:
//   0 = success
//   1 = not_found, bad_request, usage errors
//   2 = auth_error, config_missing
//   3 = server_error, connection_refused

// ── HTTP helpers ─────────────────────────────────────────────────

function httpDo(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const isHttps = url.protocol === "https:";
  const doRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = doRequest(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          ...(body != null ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } : {}),
          "Accept": "application/json",
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED") {
        reject(new CliError("connection_refused", `Cannot connect to ${url.origin} — is the server running?`, 3));
      } else {
        reject(new CliError("server_error", err.message, 3));
      }
    });
    if (body != null) req.write(body);
    req.end();
  });
}

function handleHttpStatus(res: { status: number; body: string }): never | void {
  if (res.status === 401) throw new CliError("auth_error", "Authentication failed. Check your token in ~/.grove/cli.json", 2);
  if (res.status === 403) throw new CliError("auth_error", "Permission denied.", 2);
  if (res.status === 404) {
    const msg = tryParseJson(res.body)?.error ?? "Not found";
    throw new CliError("not_found", msg, 1);
  }
  if (res.status === 429) throw new CliError("rate_limited", "Rate limited. Try again shortly.", 1);
  if (res.status === 503) {
    const parsed = tryParseJson(res.body);
    if (parsed?.error === "vault_locked") {
      throw new CliError("vault_locked", parsed.message ?? "Vault is encrypted and locked. Unlock with: grove vault unlock", 3);
    }
    throw new CliError("server_error", `Service unavailable (503)`, 3);
  }
  if (res.status >= 500) throw new CliError("server_error", `Server error (${res.status})`, 3);
}

function tryParseJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

// ── REST API client ─────────────────────────────────────────────

async function restGet(config: Config, path: string): Promise<any> {
  const url = new URL(path, config.server);
  const res = await httpDo("GET", url, { Authorization: `Bearer ${config.token}` });
  handleHttpStatus(res);
  const data = tryParseJson(res.body);
  if (data == null) throw new CliError("server_error", `Unexpected response (${res.status}): ${res.body.slice(0, 200)}`, 3);
  return data;
}

async function restPut(config: Config, path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<{ status: number; data: any }> {
  const url = new URL(path, config.server);
  const res = await httpDo("PUT", url, { Authorization: `Bearer ${config.token}`, ...extraHeaders }, JSON.stringify(body));
  const data = tryParseJson(res.body);
  return { status: res.status, data: data ?? { raw: res.body.slice(0, 200) } };
}

async function restPost(config: Config, path: string, body: unknown): Promise<{ status: number; data: any }> {
  const url = new URL(path, config.server);
  const res = await httpDo("POST", url, { Authorization: `Bearer ${config.token}` }, JSON.stringify(body));
  const data = tryParseJson(res.body);
  return { status: res.status, data: data ?? { raw: res.body.slice(0, 200) } };
}

async function restPatch(config: Config, path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<{ status: number; data: any }> {
  const url = new URL(path, config.server);
  const res = await httpDo("PATCH", url, { Authorization: `Bearer ${config.token}`, ...extraHeaders }, JSON.stringify(body));
  const data = tryParseJson(res.body);
  return { status: res.status, data: data ?? { raw: res.body.slice(0, 200) } };
}

async function restDelete(config: Config, path: string, extraHeaders?: Record<string, string>): Promise<{ status: number; data: any }> {
  const url = new URL(path, config.server);
  const res = await httpDo("DELETE", url, { Authorization: `Bearer ${config.token}`, ...extraHeaders });
  const data = tryParseJson(res.body);
  return { status: res.status, data: data ?? { raw: res.body.slice(0, 200) } };
}

// ── MCP JSON-RPC (fallback for endpoints without REST routes) ───

let sessionId: string | undefined;
let rpcId = 0;

async function mcpRequest(config: Config, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const url = new URL("/mcp", config.server);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
  const res = await httpDo("POST", url, headers, body);
  handleHttpStatus(res);

  const sid = res.headers["mcp-session-id"];
  if (sid) sessionId = Array.isArray(sid) ? sid[0] : sid;

  const data = tryParseJson(res.body);
  if (data == null) throw new CliError("server_error", `Unexpected response (${res.status}): ${res.body.slice(0, 200)}`, 3);
  return data;
}

async function mcpInitialize(config: Config): Promise<void> {
  await mcpRequest(config, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "grove-cli", version: "1.0.0" },
  });
}

async function mcpCall(config: Config, tool: string, args: Record<string, unknown>): Promise<string> {
  if (!sessionId) await mcpInitialize(config);
  const res = await mcpRequest(config, "tools/call", { name: tool, arguments: args });
  if (res.error) throw new CliError("server_error", res.error.message ?? JSON.stringify(res.error), 3);
  const content = res.result?.content?.[0]?.text;
  if (content == null) throw new CliError("server_error", "No content in response", 3);
  return content;
}

// ── Argument parsing ─────────────────────────────────────────────

// Flags that never take a value — used so `grove --json search foo` doesn't
// consume `search` as the value of `--json`.
const BOOLEAN_FLAGS = new Set([
  "json",
  "help",
  "paths",
  "aliases",
  "yes",
  "dry-run",
  "v",
  "h",
  // Phase 1 additions
  "jsonl",
  "table",
  "0",
  "print0",
  "stdout",
  "apply",
  "plan",
  "redact",
  // Phase 11: lifecycle
  "hard",
]);

export function parseArgs(argv: string[]): { command: string; positional: string; positionals: string[]; flags: Record<string, string | boolean> } {
  let command = "help";
  let commandSet = false;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  const looksLikeFlag = (s: string | undefined): boolean =>
    !!s && (/^--[a-zA-Z]/.test(s) || /^-[a-zA-Z]$/.test(s));

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const key = body;
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !looksLikeFlag(next)) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !looksLikeFlag(next)) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (!commandSet) {
      command = arg;
      commandSet = true;
    } else {
      positionals.push(arg);
    }
  }

  // Auto-detect non-TTY → JSON mode
  if (!process.stdout.isTTY) flags.json = true;

  return { command, positional: positionals[0] ?? "", positionals, flags };
}

// ── Human-readable formatters ───────────────────────────────────

function formatSearch(data: { results: any[]; count: number }): string {
  if (data.results.length === 0) return "No results.";
  const lines: string[] = [];
  for (const r of data.results) {
    lines.push(`${r.path}`);
    if (r.snippet) lines.push(`  ${r.snippet.slice(0, 120)}`);
    lines.push("");
  }
  lines.push(`${data.count} result${data.count === 1 ? "" : "s"}`);
  return lines.join("\n");
}

function formatRead(data: { path: string; frontmatter: Record<string, unknown>; content: string; content_hash: string; resolved_from?: string }): string {
  const lines: string[] = [];
  if (data.resolved_from) lines.push(`(resolved from "${data.resolved_from}")`);
  lines.push(`path: ${data.path}`);
  if (data.content_hash) lines.push(`hash: ${data.content_hash}`);
  lines.push("---");
  if (data.frontmatter && Object.keys(data.frontmatter).length > 0) {
    lines.push("---");
    for (const [k, v] of Object.entries(data.frontmatter)) {
      lines.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
    }
    lines.push("---");
  }
  if (data.content) lines.push(data.content);
  return lines.join("\n");
}

function formatList(data: { count: number; entries: any[] }): string {
  const entries = data.entries;
  if (entries.length === 0) return "No notes found.";

  const lines = [`${data.count} notes\n`];
  const pathW = Math.min(60, Math.max(...entries.map((n: any) => (n.path as string).length)));
  for (const n of entries) {
    const path = (n.path as string).padEnd(pathW);
    const type = (n.type ?? "-").padEnd(10);
    const mod = n.modified_at ? new Date(n.modified_at).toISOString().slice(0, 10) : "-";
    let line = `  ${path}  ${type}  ${mod}`;
    if (n.aliases?.length) line += `  (${n.aliases.join(", ")})`;
    lines.push(line);
  }
  return lines.join("\n");
}

function formatHistory(data: { entries: any[] }): string {
  const entries = data.entries;
  if (entries.length === 0) return "No recent changes.";

  const lines: string[] = [];
  for (const e of entries) {
    const date = e.date ? new Date(e.date).toISOString().slice(0, 16).replace("T", " ") : "-";
    const msg = e.message ?? "";
    const files = (e.files ?? []).slice(0, 3).join(", ");
    lines.push(`  ${date}  ${msg}`);
    if (files) lines.push(`             ${files}`);
  }
  return lines.join("\n");
}

function formatStatus(data: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === "_fmt") continue;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        lines.push(...renderField(k2, v2, "  "));
      }
    } else {
      lines.push(...renderField(k, v, ""));
    }
  }
  return lines.join("\n");
}

function renderField(key: string, value: unknown, indent: string): string[] {
  if (value === null || value === undefined) return [`${indent}${key}: ${value ?? ""}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}${key}: (none)`];
    const inner = indent + "  ";
    const items = value.map((item) => {
      if (item === null || typeof item !== "object") return `${inner}- ${item}`;
      return `${inner}- ${summarizeObject(item as Record<string, unknown>)}`;
    });
    return [`${indent}${key}:`, ...items];
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [`${indent}${key}: (empty)`];
    const inner = indent + "  ";
    return [`${indent}${key}:`, ...entries.map(([k2, v2]) => `${inner}${k2}: ${v2}`)];
  }
  return [`${indent}${key}: ${value}`];
}

function summarizeObject(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj);
  if (entries.length === 2) {
    const [[, a], [, b]] = entries;
    return `${a} (${b})`;
  }
  if ("name" in obj || "tag" in obj || "path" in obj) {
    const label = obj.name ?? obj.tag ?? obj.path;
    const rest = entries.filter(([k]) => k !== "name" && k !== "tag" && k !== "path");
    if (rest.length === 0) return String(label);
    return `${label} — ${rest.map(([k, v]) => `${k}: ${v}`).join(", ")}`;
  }
  return entries.map(([k, v]) => `${k}: ${v}`).join(", ");
}

function formatDiagnostics(data: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`Total notes: ${data.total_notes}\n`);

  for (const category of ["orphans", "broken_links", "missing_frontmatter", "stale_inbox"] as const) {
    const section = data[category] as any;
    if (!section) continue;
    const label = category.replace(/_/g, " ");
    lines.push(`${label}: ${section.count}`);
    const items = section.notes ?? section.links ?? [];
    for (const item of items.slice(0, 5)) {
      lines.push(`  - ${item}`);
    }
    if (items.length > 5) lines.push(`  ... and ${items.length - 5} more`);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Commands (return structured data) ───────────────────────────

interface CmdResult {
  ok: true;
  [key: string]: unknown;
  _fmt?: (data: any) => string;
}

async function cmdSearch(config: Config, query: string, flags: Record<string, string | boolean>): Promise<CmdResult> {
  if (!query) throw new CliError("bad_request", "Usage: grove search <query> [-n limit]", 1);
  const limit = Number(flags.n) || 10;
  const data = await restGet(config, `/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  const results = data.results ?? [];
  return { ok: true, results, count: results.length, _fmt: formatSearch };
}

async function cmdRead(config: Config, file: string): Promise<CmdResult> {
  if (!file) throw new CliError("bad_request", "Usage: grove read <path-or-title>", 1);
  const data = await restGet(config, `/v1/notes/${encodeURIComponent(file)}`);
  return { ok: true, ...data, _fmt: formatRead };
}

async function cmdList(config: Config, pattern: string, flags: Record<string, string | boolean>): Promise<CmdResult> {
  if (!pattern) throw new CliError("bad_request", "Usage: grove list <glob-pattern> [--aliases]", 1);
  const data = await restGet(config, `/v1/list?prefix=${encodeURIComponent(pattern)}`);
  const entries = data.entries ?? [];
  return { ok: true, entries, count: entries.length, _fmt: formatList };
}

async function cmdWrite(config: Config, path: string, flags: Record<string, string | boolean>): Promise<CmdResult> {
  if (!path) throw new CliError("bad_request", "Usage: grove write <path> --type <type> [--content text | stdin] [--if-hash hash]", 1);
  const type = (flags.type as string) ?? "concept";
  const tags = flags.tags
    ? (flags.tags as string).split(",").map((t) => t.trim())
    : [type];

  let content: string;
  if (typeof flags.content === "string") {
    content = flags.content.trim();
  } else if (process.stdin.isTTY) {
    throw new CliError("bad_request", "Provide content via --content flag or pipe to stdin", 1);
  } else {
    // Read content from stdin.
    // Cast-on-entry because @types/node >=25 types the stdin data
    // callback as `string | Buffer` (depending on encoding state),
    // but we never call setEncoding so runtime is always Buffer.
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: string | Buffer) => {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    });
    await new Promise<void>((resolve) => process.stdin.on("end", resolve));
    content = Buffer.concat(chunks).toString().trim();
  }

  if (!content) throw new CliError("bad_request", "No content provided.", 1);

  const extraHeaders: Record<string, string> = {};
  if (typeof flags["if-hash"] === "string") {
    extraHeaders["If-Match"] = `"${flags["if-hash"]}"`;
  }

  const { status, data } = await restPut(
    config,
    `/v1/notes/${encodeURIComponent(path)}`,
    { frontmatter: { type, tags }, content },
    extraHeaders,
  );

  if (status === 409) throw new CliError("conflict", data?.error ?? "Content changed since last read (hash mismatch)", 1);
  if (status === 400) throw new CliError("bad_request", data?.error ?? "Bad request", 1);
  if (status === 401) throw new CliError("auth_error", "Authentication failed. Check your token.", 2);
  if (status === 403) throw new CliError("auth_error", "Permission denied.", 2);
  if (status >= 500) throw new CliError("server_error", `Server error (${status})`, 3);

  return { ok: true, ...data, _fmt: formatStatus };
}

export function validateDeleteFlags(flags: Record<string, string | boolean>, path: string): void {
  if (flags.hard && !flags.yes) {
    throw new CliError(
      "bad_request",
      `Hard delete requires --yes. Would permanently remove: ${path}\nRun again with --yes to confirm — this is irreversible.`,
      1,
    );
  }
}

async function cmdDelete(config: Config, path: string, flags: Record<string, string | boolean>): Promise<CmdResult> {
  if (!path) throw new CliError("bad_request", "Usage: grove delete <path> [--hard --yes] [--if-hash hash]", 1);
  validateDeleteFlags(flags, path);
  const hard = !!flags.hard;

  const extraHeaders: Record<string, string> = {};
  if (typeof flags["if-hash"] === "string") {
    extraHeaders["If-Match"] = `"${flags["if-hash"]}"`;
  }

  const qs = hard ? "?hard=true" : "";
  const { status, data } = await restDelete(
    config,
    `/v1/notes/${encodeURIComponent(path)}${qs}`,
    extraHeaders,
  );

  if (status === 404) throw new CliError("not_found", data?.error ?? `Not found: ${path}`, 1);
  if (status === 409) throw new CliError("conflict", data?.error ?? "Content changed since last read (hash mismatch)", 1);
  if (status === 400) throw new CliError("bad_request", data?.error ?? "Bad request", 1);
  if (status === 401) throw new CliError("auth_error", "Authentication failed. Check your token.", 2);
  if (status === 403) throw new CliError("auth_error", "Permission denied.", 2);
  if (status >= 500) throw new CliError("server_error", `Server error (${status})`, 3);

  return {
    ok: true,
    ...data,
    _fmt: () => {
      const action = data?.action ?? (hard ? "deleted" : "archived");
      if (action === "archived" && data?.archive_path) return `archived ${path} → ${data.archive_path}`;
      if (action === "deleted") return `deleted ${path}`;
      return `${action} ${path}`;
    },
  };
}

async function cmdMove(config: Config, from: string, to: string, flags: Record<string, string | boolean>): Promise<CmdResult> {
  if (!from || !to) throw new CliError("bad_request", "Usage: grove move <from> <to> [--if-hash hash]", 1);

  const extraHeaders: Record<string, string> = {};
  if (typeof flags["if-hash"] === "string") {
    extraHeaders["If-Match"] = `"${flags["if-hash"]}"`;
  }

  const { status, data } = await restPatch(
    config,
    `/v1/notes/${encodeURIComponent(from)}`,
    { move_to: to },
    extraHeaders,
  );

  if (status === 404) throw new CliError("not_found", data?.error ?? `Not found: ${from}`, 1);
  if (status === 409) throw new CliError("conflict", data?.error ?? `Destination already exists: ${to}`, 1);
  if (status === 400) throw new CliError("bad_request", data?.error ?? "Bad request", 1);
  if (status === 401) throw new CliError("auth_error", "Authentication failed. Check your token.", 2);
  if (status === 403) throw new CliError("auth_error", "Permission denied.", 2);
  if (status >= 500) throw new CliError("server_error", `Server error (${status})`, 3);

  return {
    ok: true,
    ...data,
    _fmt: () => {
      const links = Number(data?.links_updated ?? 0);
      return `moved ${from} → ${to} (${links} link${links === 1 ? "" : "s"} updated)`;
    },
  };
}

async function cmdHistory(config: Config, flags: Record<string, string | boolean>): Promise<CmdResult> {
  const since = (flags.since as string) ?? "1 week ago";
  // History still uses MCP (no REST endpoint yet)
  const raw = await mcpCall(config, "vault_status", { mode: "history", since });
  const data = tryParseJson(raw) ?? { entries: [] };
  return { ok: true, ...data, _fmt: formatHistory };
}

async function cmdStatus(config: Config): Promise<CmdResult> {
  const data = await restGet(config, "/v1/stats");
  return { ok: true, ...data, _fmt: formatStatus };
}

async function cmdDiagnostics(config: Config): Promise<CmdResult> {
  // Diagnostics still uses MCP (no REST endpoint yet)
  const raw = await mcpCall(config, "vault_status", { mode: "diagnostics" });
  const data = tryParseJson(raw) ?? {};
  return { ok: true, ...data, _fmt: formatDiagnostics };
}

async function cmdGraph(config: Config): Promise<CmdResult> {
  const data = await restGet(config, "/v1/stats?sections=graph");
  const graph = data.graph ?? {};
  return {
    ok: true,
    ...graph,
    _fmt: () => {
      const lines: string[] = [];
      if (graph.total_nodes != null) lines.push(`Nodes: ${graph.total_nodes}`);
      if (graph.total_edges != null) lines.push(`Edges: ${graph.total_edges}`);
      if (graph.clusters) {
        lines.push(`\nClusters: ${graph.clusters.length}`);
        for (const c of graph.clusters.slice(0, 10)) {
          lines.push(`  ${c.label ?? c.id ?? "?"}: ${c.size ?? c.count ?? "?"} notes`);
        }
      }
      if (graph.top_hubs) {
        lines.push(`\nTop hubs:`);
        for (const h of graph.top_hubs.slice(0, 10)) {
          lines.push(`  ${h.path ?? h.title ?? h}: ${h.degree ?? h.connections ?? ""}`);
        }
      }
      return lines.join("\n") || JSON.stringify(graph, null, 2);
    },
  };
}

async function cmdDigest(config: Config): Promise<CmdResult> {
  const data = await restGet(config, "/v1/stats?sections=lifecycle");
  const lifecycle = data.lifecycle ?? {};
  return {
    ok: true,
    ...lifecycle,
    _fmt: () => {
      const lines: string[] = [];
      if (lifecycle.stages) {
        for (const [stage, info] of Object.entries(lifecycle.stages as Record<string, any>)) {
          lines.push(`${stage}: ${info.count ?? info}`);
        }
      } else {
        // Flat lifecycle object
        for (const [k, v] of Object.entries(lifecycle)) {
          if (k === "velocity_7d") continue;
          lines.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
        }
      }
      if (lifecycle.velocity_7d != null) lines.push(`\nVelocity (7d): ${lifecycle.velocity_7d}`);
      return lines.join("\n") || JSON.stringify(lifecycle, null, 2);
    },
  };
}

async function cmdHealth(config: Config): Promise<CmdResult> {
  const url = new URL("/health", config.server);
  const res = await httpDo("GET", url, { Authorization: `Bearer ${config.token}` });
  if (res.status >= 500) throw new CliError("server_error", `Server error (${res.status})`, 3);
  const data = tryParseJson(res.body) ?? {};
  const checks = data.checks ?? {};
  return {
    ok: true,
    status: data.ok ? "healthy" : "degraded",
    components: checks,
    _fmt: () => {
      const lines: string[] = [];
      lines.push(`Status: ${data.ok ? "healthy" : "DEGRADED"}`);
      if (Object.keys(checks).length > 0) {
        lines.push("");
        for (const [name, ok] of Object.entries(checks)) {
          lines.push(`  ${ok ? "✓" : "✗"} ${name}`);
        }
      }
      return lines.join("\n");
    },
  };
}

async function cmdMetrics(config: Config): Promise<CmdResult> {
  const url = new URL("/metrics", config.server);
  const res = await httpDo("GET", url, { Authorization: `Bearer ${config.token}` });
  handleHttpStatus(res);
  const data = tryParseJson(res.body) ?? {};
  return {
    ok: true,
    ...data,
    _fmt: () => {
      const lines: string[] = [];
      if (data.started_at) lines.push(`Up since: ${data.started_at}`);
      if (data.uptime_seconds != null) lines.push(`Uptime:   ${Math.floor(data.uptime_seconds / 3600)}h ${Math.floor((data.uptime_seconds % 3600) / 60)}m`);
      lines.push(`Requests: ${data.total_requests ?? 0}`);
      lines.push(`Errors:   ${data.total_errors ?? 0} (${((data.error_rate ?? 0) * 100).toFixed(1)}%)`);

      const byTool = data.by_tool as Record<string, any> | undefined;
      if (byTool && Object.keys(byTool).length > 0) {
        lines.push("\nBy endpoint:");
        for (const [name, stats] of Object.entries(byTool)) {
          lines.push(`  ${name}: ${stats.count} req, p50=${stats.latency_p50}ms, p95=${stats.latency_p95}ms`);
        }
      }

      const search = data.search as Record<string, any> | undefined;
      if (search && search.queries_1h > 0) {
        lines.push(`\nSearch (1h): ${search.queries_1h} queries, avg ${search.avg_latency_ms}ms, ${((search.zero_result_rate ?? 0) * 100).toFixed(0)}% zero-result`);
      }
      return lines.join("\n");
    },
  };
}

async function cmdWhoami(config: Config): Promise<CmdResult> {
  const data = await restGet(config, "/v1/whoami");
  return {
    ok: true,
    ...data,
    _fmt: () => {
      const lines: string[] = [];
      lines.push(`Key:    ${data.key_name ?? data.key_id}`);
      lines.push(`Scopes: ${(data.scopes ?? []).join(", ") || "(none)"}`);
      lines.push(`Vault:  ${data.vault_id ?? "-"}`);
      if (data.trail) lines.push(`Trail:  ${data.trail.name} (${data.trail.id})`);
      return lines.join("\n");
    },
  };
}

async function cmdInit(flags: Record<string, string | boolean>): Promise<CmdResult> {
  const server = (flags.server as string) ?? "https://api.grove.md";
  const token = flags.token as string;
  if (!token) throw new CliError("bad_request", "Usage: grove init --server <url> --token <token>", 1);

  // Validate by calling /health
  const url = new URL("/health", server);
  let res: { status: number; body: string };
  try {
    res = await httpDo("GET", url, { Authorization: `Bearer ${token}` });
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError("connection_refused", `Cannot connect to ${server}`, 3);
  }
  if (res.status >= 400) throw new CliError("auth_error", `Server returned ${res.status}. Check your token.`, 2);

  // Write config with mode 0600 (enforced by writeConfig helper).
  const { writeConfig } = await import("./cli/lib/config.js");
  const configPathResult = writeConfig({ server, token });

  return {
    ok: true,
    server,
    config_path: configPathResult,
    _fmt: () => `Connected to ${server}\nConfig written to ${configPathResult} (mode 0600)`,
  };
}

async function cmdSync(config: Config, dir: string, flags: Record<string, string | boolean>): Promise<CmdResult> {
  if (!dir) throw new CliError("bad_request", "Usage: grove sync <archive-sources-dir> [--dry-run]", 1);
  const dryRun = !!flags["dry-run"];

  // Read local archive
  const local = readArchiveSources(dir);

  // List existing sources via REST
  const listData = await restGet(config, `/v1/list?prefix=${encodeURIComponent("Sources")}`);
  const existingPaths = new Set<string>((listData.entries ?? []).map((n: any) => n.path));

  // Plan
  const plan = planSync(local, existingPaths);

  if (plan.toCreate.length === 0) {
    return { ok: true, action: "sync", created: 0, skipped: plan.skipped.length, message: "Nothing to sync." };
  }

  if (dryRun) {
    return { ok: true, action: "sync_dry_run", would_create: plan.toCreate.map((n: any) => n.path), skipped: plan.skipped.length };
  }

  // Execute writes via MCP (no PUT endpoint yet)
  let ok = 0;
  let fail = 0;
  const results: { path: string; status: string }[] = [];
  for (const note of plan.toCreate) {
    try {
      const raw = await mcpCall(config, "write_note", {
        path: note.path,
        frontmatter: JSON.stringify(note.frontmatter),
        content: note.content,
      });
      const result = tryParseJson(raw) ?? {};
      results.push({ path: result.path ?? note.path, status: result.action ?? "created" });
      ok++;
    } catch (err: any) {
      results.push({ path: note.path, status: `error: ${err.message ?? err}` });
      fail++;
    }
  }

  return {
    ok: true,
    action: "sync",
    created: ok,
    failed: fail,
    skipped: plan.skipped.length,
    results,
    _fmt: () => {
      const lines: string[] = [];
      lines.push(`Reading archive: ${dir}`);
      lines.push(`Found ${local.length} source notes locally`);
      lines.push(`Found ${existingPaths.size} source notes on Grove`);
      lines.push(`\nSync plan:`);
      lines.push(`  Create: ${plan.toCreate.length}`);
      lines.push(`  Skip:   ${plan.skipped.length}`);
      lines.push("");
      for (const r of results) {
        const icon = r.status.startsWith("error") ? "✗" : "✓";
        lines.push(`  ${icon} ${r.status} ${r.path}`);
      }
      lines.push(`\nDone: ${ok} created, ${fail} failed, ${plan.skipped.length} skipped`);
      return lines.join("\n");
    },
  };
}

// ── Ingest (bulk import .md files) ─────────────────────────

/**
 * Build the type→folder map used to route ingested notes.
 *
 * Reads from the vault's configured `type_paths`. If the vault config is
 * unreadable (stale symlink, missing vault), falls back to PARA defaults so
 * ingest can still run against a remote server.
 */
function loadIngestTypePaths(): Record<string, string> {
  try {
    return { ...loadVaultConfig(VAULT_PATH).structure.type_paths };
  } catch {
    return {
      concept: "Resources/Concepts/",
      person:  "Resources/People/",
      recipe:  "Resources/Recipes/",
      project: "Resources/Projects/",
      company: "Resources/Companies/",
      place:   "Resources/Places/",
      journal: "Journal/",
      source:  "Sources/",
    };
  }
}

async function cmdIngest(config: Config, dir: string, flags: Record<string, string | boolean>): Promise<CmdResult> {
  if (!dir) throw new CliError("bad_request", "Usage: grove ingest <dir> [--dry-run]", 1);
  const dryRun = !!flags["dry-run"];

  // Verify dir exists and has .md files
  let dirEntries: { isFile(): boolean; name: string }[];
  try {
    dirEntries = readdirSync(dir, { withFileTypes: true }) as unknown as { isFile(): boolean; name: string }[];
  } catch {
    throw new CliError("bad_request", `Cannot read directory: ${dir}`, 1);
  }
  const mdFiles = dirEntries.filter((e) => e.isFile() && (e.name.endsWith(".md") || e.name.endsWith(".txt")));
  if (mdFiles.length === 0) throw new CliError("bad_request", `No .md or .txt files found in ${dir}`, 1);

  // Parse each file and determine target path
  interface IngestCandidate {
    filename: string;
    targetPath: string;
    frontmatter: Record<string, unknown>;
    content: string;
    title: string;
  }
  const candidates: IngestCandidate[] = [];
  const prefixesNeeded = new Set<string>();
  const typePaths = loadIngestTypePaths();
  let defaultPrefix = "Inbox/";
  try {
    defaultPrefix = loadVaultConfig(VAULT_PATH).structure.entities.default;
  } catch {
    // Fall back to Inbox/ already set above
  }

  for (const entry of mdFiles) {
    const raw = readFileSync(join(dir, entry.name), "utf-8");
    const { frontmatter, content } = parseNote(raw);
    const type = typeof frontmatter.type === "string" ? frontmatter.type : undefined;
    const prefix = type && typePaths[type] ? typePaths[type] : defaultPrefix;
    const mdName = entry.name.replace(/\.txt$/, ".md");
    const targetPath = prefix + mdName;
    const title = mdName.replace(/\.md$/, "").toLowerCase();

    prefixesNeeded.add(prefix.replace(/\/$/, ""));
    candidates.push({ filename: entry.name, targetPath, frontmatter, content, title });
  }

  // Fetch existing notes for dedup (by path and title)
  const existingPaths = new Set<string>();
  const existingTitles = new Set<string>();

  for (const prefix of prefixesNeeded) {
    try {
      const data = await restGet(config, `/v1/list?prefix=${encodeURIComponent(prefix)}`);
      for (const n of (data.entries ?? []) as Array<{ path: string }>) {
        existingPaths.add(n.path);
        const stem = n.path.split("/").pop()?.replace(/\.md$/, "").toLowerCase() ?? "";
        existingTitles.add(stem);
      }
    } catch {
      // Prefix may not exist yet — not an error
    }
  }

  // Split into import vs skip
  const toImport: IngestCandidate[] = [];
  const skipped: string[] = [];

  for (const c of candidates) {
    if (existingPaths.has(c.targetPath) || existingTitles.has(c.title)) {
      skipped.push(c.filename);
    } else {
      toImport.push(c);
    }
  }

  // Snapshot before writing
  if (!dryRun) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tagName = `grove-snapshot-pre-ingest-${timestamp}`;
    execSync(`git tag ${tagName}`, { cwd: VAULT_PATH });
    process.stderr.write(`Snapshot created: ${tagName}\n`);
  }

  if (dryRun) {
    return {
      ok: true,
      action: "ingest_dry_run",
      would_import: toImport.map((n) => n.targetPath),
      skipped: skipped.length,
      total: mdFiles.length,
      _fmt: () => {
        const lines: string[] = [];
        for (const n of toImport) lines.push(`  would import: ${n.targetPath}`);
        for (const s of skipped) lines.push(`  would skip:   ${s} (duplicate)`);
        lines.push(`\n${toImport.length} would import, ${skipped.length} would skip (${mdFiles.length} total)`);
        return lines.join("\n");
      },
    };
  }

  // Write notes via MCP
  let imported = 0;
  let failed = 0;
  const results: { path: string; status: string }[] = [];

  for (const note of toImport) {
    try {
      const fm = { ...note.frontmatter };
      if (!fm.type) fm.type = "concept";
      if (!Array.isArray(fm.tags) || fm.tags.length === 0) {
        fm.tags = inferTags(note.targetPath, fm);
        if ((fm.tags as string[]).length === 0) fm.tags = [fm.type as string];
      }

      const raw = await mcpCall(config, "write_note", {
        path: note.targetPath,
        frontmatter: JSON.stringify(fm),
        content: note.content,
      });
      const result = tryParseJson(raw) ?? {};
      results.push({ path: result.path ?? note.targetPath, status: result.action ?? "created" });
      imported++;
      process.stderr.write(`\rImported ${imported}/${toImport.length} notes (${skipped.length} skipped as duplicates)`);
    } catch (err: any) {
      results.push({ path: note.targetPath, status: `error: ${err.message ?? err}` });
      failed++;
    }
  }
  if (toImport.length > 0) process.stderr.write("\n");

  // P7-8: Enqueue all successfully imported notes for discovery processing
  let enqueued = 0;
  for (const r of results) {
    if (!r.status.startsWith("error")) {
      try {
        enqueueDiscovery(r.path, "ingest");
        enqueued++;
      } catch {
        // DB may not be initialized in all environments — best-effort
      }
    }
  }
  if (enqueued > 0) {
    process.stderr.write(`Enqueued ${enqueued} notes for discovery processing\n`);
  }

  return {
    ok: true,
    action: "ingest",
    imported,
    failed,
    skipped: skipped.length,
    enqueued,
    total: mdFiles.length,
    results,
    _fmt: () => {
      const lines: string[] = [];
      lines.push(`Reading: ${dir}`);
      lines.push(`Found ${mdFiles.length} .md files`);
      lines.push("");
      for (const r of results) {
        const icon = r.status.startsWith("error") ? "✗" : "✓";
        lines.push(`  ${icon} ${r.path}`);
      }
      lines.push(`\nImported ${imported}/${mdFiles.length} notes (${skipped.length} skipped as duplicates)`);
      if (enqueued > 0) lines.push(`${enqueued} enqueued for discovery`);
      if (failed > 0) lines.push(`${failed} failed`);
      return lines.join("\n");
    },
  };
}

// ── Bookmark sync ───────────────────────────────────────────

function cmdBookmarkSync(flags: Record<string, string | boolean>): CmdResult {
  const count = typeof flags.count === "string" ? parseInt(flags.count, 10) || 20 : 20;

  // Ensure DB schema exists for enqueue
  try { createSchema(); } catch { /* may already exist */ }

  const result = syncBookmarks(count);

  return {
    ok: true,
    action: "bookmark_sync",
    ...result,
    _fmt: () => {
      const lines: string[] = [];
      lines.push(`Fetched ${result.fetched} bookmarks from X`);
      lines.push(`Created ${result.created} new Source notes (${result.skipped} already synced)`);
      if (result.enqueued > 0) lines.push(`Enqueued ${result.enqueued} for discovery processing`);
      for (const p of result.notes) lines.push(`  + ${p}`);
      for (const e of result.errors) lines.push(`  ! ${e}`);
      return lines.join("\n");
    },
  };
}

// ── Key management (remote, via /keys API) ──────────────────

function keysPost(config: Config, body: unknown): Promise<{ status: number; body: string }> {
  const url = new URL("/keys", config.server);
  return httpDo("POST", url, { Authorization: `Bearer ${config.token}` }, JSON.stringify(body));
}

async function cmdKeysList(config: Config): Promise<CmdResult> {
  const res = await keysPost(config, { action: "list" });
  handleHttpStatus(res);
  const data = tryParseJson(res.body) ?? {};
  const keys = data.keys ?? [];
  return {
    ok: true,
    keys,
    _fmt: () => {
      if (keys.length === 0) return "No keys.";
      const lines: string[] = [];
      lines.push("\nID            Name                Scopes          Vault   Created      Last used");
      lines.push("─".repeat(90));
      for (const k of keys) {
        const created = k.created_at?.slice(0, 10) ?? "-";
        const lastUsed = k.last_used_at?.slice(0, 10) ?? "never";
        lines.push(
          `${(k.id ?? "").padEnd(14)}${(k.name ?? "").padEnd(20)}${(k.scopes?.join(",") ?? "").padEnd(16)}${(k.vault_id ?? "").padEnd(8)}${created.padEnd(13)}${lastUsed}`,
        );
      }
      lines.push("");
      return lines.join("\n");
    },
  };
}

async function cmdKeysCreate(config: Config, name: string): Promise<CmdResult> {
  if (!name) throw new CliError("bad_request", "Usage: grove keys create <name>", 1);
  const res = await keysPost(config, { action: "create", name });
  handleHttpStatus(res);
  const data = tryParseJson(res.body) ?? {};
  return {
    ok: true,
    ...data,
    _fmt: () => `\nKey created: ${data.id}\nName:        ${data.name}\n\nToken (shown once, save it now):\n\n  ${data.token}\n`,
  };
}

async function cmdKeysRevoke(config: Config, id: string): Promise<CmdResult> {
  if (!id) throw new CliError("bad_request", "Usage: grove keys revoke <key-id>", 1);
  const res = await keysPost(config, { action: "revoke", id });
  handleHttpStatus(res);
  const data = tryParseJson(res.body) ?? {};
  if (!data.revoked) throw new CliError("not_found", `Failed to revoke: ${JSON.stringify(data)}`, 1);
  return { ok: true, revoked: data.revoked, _fmt: () => `Revoked key: ${data.revoked}` };
}

// ── Key rotate (client-side atomic swap) ──────────────────────────
//
// Server has no single "rotate" endpoint — we implement it as create-new
// then revoke-old. An optional --grace <seconds> keeps the old key active
// briefly so clients can update their config without a hard cutover. In
// --grace mode we sleep between the two calls. Default grace is 0 (immediate).

async function cmdKeyRotate(
  config: Config,
  id: string,
  flags: Record<string, string | boolean>,
): Promise<CmdResult> {
  if (!id) throw new CliError("bad_request", "Usage: grove key rotate <old-key-id> [--name <new-name>] [--grace <seconds>]", 1);

  // Step 1: discover the old key's name (so we can preserve it by default).
  const listRes = await keysPost(config, { action: "list" });
  handleHttpStatus(listRes);
  const listData = tryParseJson(listRes.body) ?? {};
  const oldKey = (listData.keys ?? []).find((k: any) => k.id === id);
  if (!oldKey) throw new CliError("not_found", `No such key: ${id}`, 1);

  const newName = (flags.name as string) ?? `${oldKey.name}-rotated`;
  const graceSec = flags.grace ? Number(flags.grace) : 0;
  if (!Number.isFinite(graceSec) || graceSec < 0) {
    throw new CliError("bad_request", "--grace must be a non-negative integer (seconds)", 1);
  }

  // Step 2: create new key with the chosen name.
  const createRes = await keysPost(config, { action: "create", name: newName });
  handleHttpStatus(createRes);
  const createData = tryParseJson(createRes.body) ?? {};
  if (!createData.id || !createData.token) {
    throw new CliError("server_error", `Create returned unexpected shape: ${JSON.stringify(createData)}`, 3);
  }
  const newId = createData.id;
  const newToken = createData.token;

  // Step 3: optional grace — old key keeps working while user updates configs.
  if (graceSec > 0) {
    process.stderr.write(`new key ${newId} issued; old key ${id} will be revoked in ${graceSec}s...\n`);
    await new Promise((r) => setTimeout(r, graceSec * 1000));
  }

  // Step 4: revoke the old key. If this step fails the user has an orphan new
  // key — we still return the new token so they don't lose it.
  let oldRevoked = false;
  let revokeError: string | undefined;
  try {
    const revRes = await keysPost(config, { action: "revoke", id });
    handleHttpStatus(revRes);
    const revData = tryParseJson(revRes.body) ?? {};
    oldRevoked = !!revData.revoked;
  } catch (e) {
    revokeError = e instanceof Error ? e.message : String(e);
  }

  return {
    ok: true,
    rotated: true,
    new_id: newId,
    new_name: newName,
    token: newToken,
    old_id: id,
    old_revoked: oldRevoked,
    ...(revokeError ? { revoke_error: revokeError } : {}),
    grace_seconds: graceSec,
    _fmt: () => {
      const lines: string[] = [];
      lines.push(`\nRotated key ${id}`);
      lines.push(`New key:    ${newId} (${newName})`);
      lines.push(`Old key:    ${oldRevoked ? "revoked" : `NOT revoked — ${revokeError ?? "unknown error"}`}`);
      lines.push("");
      lines.push(`New token (shown once, save it now):`);
      lines.push(`\n  ${newToken}\n`);
      if (!oldRevoked) {
        lines.push(`WARNING: old key still active. Run manually: grove key revoke ${id}`);
      }
      return lines.join("\n");
    },
  };
}

// ── User management (admin) ───────────────────────────────────────

async function cmdUsersList(config: Config): Promise<CmdResult> {
  const data = await restGet(config, "/v1/admin/users");
  const users = data.users ?? [];
  return {
    ok: true,
    users,
    count: users.length,
    _fmt: () => {
      if (users.length === 0) return "No users.";
      const lines: string[] = [];
      lines.push("\nID              Email                           Role      Created      Last login");
      lines.push("─".repeat(95));
      for (const u of users) {
        const created = u.created_at?.slice(0, 10) ?? "-";
        const last = u.last_login_at?.slice(0, 10) ?? "never";
        lines.push(
          `${(u.id ?? "").padEnd(16)}${(u.email ?? "").padEnd(32)}${(u.role ?? "").padEnd(10)}${created.padEnd(13)}${last}`,
        );
      }
      lines.push("");
      return lines.join("\n");
    },
  };
}

async function cmdUserDelete(config: Config, id: string): Promise<CmdResult> {
  if (!id) throw new CliError("bad_request", "Usage: grove user delete <user-id>", 1);
  const url = new URL(`/v1/admin/users/${encodeURIComponent(id)}`, config.server);
  const res = await httpDo("DELETE", url, { Authorization: `Bearer ${config.token}` });
  handleHttpStatus(res);
  const data = tryParseJson(res.body) ?? {};
  if (!data.deleted) throw new CliError("not_found", `Failed to delete user: ${JSON.stringify(data)}`, 1);
  return { ok: true, deleted: data.deleted, _fmt: () => `Deleted user: ${data.deleted}` };
}

// ── Trail update (partial) ──────────────────────────────────────

async function cmdTrailUpdate(
  config: Config,
  id: string,
  flags: Record<string, string | boolean>,
): Promise<CmdResult> {
  if (!id) {
    throw new CliError(
      "bad_request",
      "Usage: grove trail update <id> [--name N] [--description D] [--allow-tags t1,t2] [--deny-tags t1,t2] [--allow-types t1,t2] [--allow-paths p1,p2] [--enabled true|false]",
      1,
    );
  }
  const splitFlag = (f: string | boolean | undefined) =>
    typeof f === "string" ? f.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  const body: Record<string, unknown> = { action: "update", id };
  if (typeof flags.name === "string") body.name = flags.name;
  if (typeof flags.description === "string") body.description = flags.description;
  if (flags.enabled === true || flags.enabled === "true") body.enabled = true;
  if (flags.enabled === false || flags.enabled === "false") body.enabled = false;
  const tagsA = splitFlag(flags["allow-tags"]);
  if (tagsA) body.allow_tags = tagsA;
  const tagsD = splitFlag(flags["deny-tags"]);
  if (tagsD) body.deny_tags = tagsD;
  const typesA = splitFlag(flags["allow-types"]);
  if (typesA) body.allow_types = typesA;
  const typesD = splitFlag(flags["deny-types"]);
  if (typesD) body.deny_types = typesD;
  const pathsA = splitFlag(flags["allow-paths"]);
  if (pathsA) body.allow_paths = pathsA;
  const pathsD = splitFlag(flags["deny-paths"]);
  if (pathsD) body.deny_paths = pathsD;

  // Require at least one mutating field beyond action+id.
  if (Object.keys(body).length <= 2) {
    throw new CliError("bad_request", "grove trail update requires at least one field to change (e.g., --name, --enabled, --allow-tags).", 1);
  }

  const res = await trailsPost(config, body);
  handleHttpStatus(res);
  const data = tryParseJson(res.body) ?? {};
  if (!data.updated) throw new CliError("not_found", `Failed to update trail: ${JSON.stringify(data)}`, 1);
  return { ok: true, updated: data.updated, changes: Object.keys(body).filter((k) => k !== "action" && k !== "id"), _fmt: () => `Updated trail: ${data.updated}` };
}

// ── Trail management (remote, via /v1/admin/trails API) ──────────────

function trailsPost(config: Config, body: unknown): Promise<{ status: number; body: string }> {
  const url = new URL("/v1/admin/trails", config.server);
  return httpDo("POST", url, { Authorization: `Bearer ${config.token}` }, JSON.stringify(body));
}

async function cmdTrailsList(config: Config): Promise<CmdResult> {
  const res = await trailsPost(config, { action: "list" });
  handleHttpStatus(res);
  const data = tryParseJson(res.body) ?? {};
  const trails = data.trails ?? [];
  return {
    ok: true,
    trails,
    _fmt: () => {
      if (trails.length === 0) return "No trails. Create one with: grove trails create <name> --allow-tags tag1,tag2";
      const lines: string[] = [];
      lines.push("\nID              Name                Status    Tags                    Paths");
      lines.push("─".repeat(90));
      for (const t of trails) {
        const status = t.enabled ? "active" : "disabled";
        const tags = (t.allow_tags ?? []).length > 0 ? t.allow_tags.join(",") : "(all)";
        const paths = (t.allow_paths ?? []).length > 0 ? t.allow_paths.join(",") : "(all)";
        lines.push(`${(t.id ?? "").padEnd(16)}${(t.name ?? "").padEnd(20)}${status.padEnd(10)}${tags.padEnd(24)}${paths}`);
      }
      lines.push("");
      return lines.join("\n");
    },
  };
}

async function cmdTrailCreate(config: Config, name: string, flags: Record<string, string | boolean>): Promise<CmdResult> {
  if (!name) throw new CliError("bad_request", "Usage: grove trails create <name> [--allow-tags t1,t2] [--deny-tags t1,t2] [--allow-types t1,t2] [--allow-paths p1,p2]", 1);
  const splitFlag = (f: string | boolean | undefined) => typeof f === "string" ? f.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const res = await trailsPost(config, {
    action: "create",
    name,
    description: (flags.description as string) ?? "",
    allow_tags: splitFlag(flags["allow-tags"]),
    deny_tags: splitFlag(flags["deny-tags"]),
    allow_types: splitFlag(flags["allow-types"]),
    deny_types: splitFlag(flags["deny-types"]),
    allow_paths: splitFlag(flags["allow-paths"]),
    deny_paths: splitFlag(flags["deny-paths"]),
  });
  handleHttpStatus(res);
  const data = tryParseJson(res.body) ?? {};
  const trail = data.trail ?? {};
  const token = data.token ?? "";
  return {
    ok: true,
    id: trail.id,
    name: trail.name,
    key_id: trail.key_id,
    token,
    _fmt: () => `\nTrail created: ${trail.id}\nName:          ${trail.name}\nKey:           ${trail.key_id}\n\nToken (shown once, give to consumer):\n\n  ${token}\n`,
  };
}

async function cmdTrailDisable(config: Config, id: string): Promise<CmdResult> {
  if (!id) throw new CliError("bad_request", "Usage: grove trails disable <trail-id>", 1);
  const res = await trailsPost(config, { action: "update", id, enabled: false });
  handleHttpStatus(res);
  const data = tryParseJson(res.body) ?? {};
  if (!data.updated) throw new CliError("not_found", `Trail not found: ${id}`, 1);
  return { ok: true, disabled: id, _fmt: () => `Disabled trail: ${id}` };
}

async function cmdTrailDelete(config: Config, id: string, flags: Record<string, string | boolean>): Promise<CmdResult> {
  if (!id) throw new CliError("bad_request", "Usage: grove trails delete <trail-id> --yes", 1);
  if (!flags.yes) throw new CliError("bad_request", "Destructive operation. Pass --yes to confirm.\nUsage: grove trails delete <trail-id> --yes", 1);
  const res = await trailsPost(config, { action: "delete", id });
  handleHttpStatus(res);
  const data = tryParseJson(res.body) ?? {};
  if (!data.deleted) throw new CliError("not_found", `Trail not found: ${id}`, 1);
  return { ok: true, deleted: id, _fmt: () => `Deleted trail: ${id}` };
}

// ── Share (remote, via /v1/admin/share API) ────────────────────

async function cmdShare(config: Config, notePath: string, flags: Record<string, string | boolean>): Promise<CmdResult> {
  if (!notePath) throw new CliError("bad_request", "Usage: grove share <note-path> [--ttl 24h|7d] [--max-views 100]", 1);

  // Parse TTL — supports "24h", "1d", "7d" etc. Default 7d.
  let ttlDays = 7;
  const ttlRaw = flags.ttl as string | undefined;
  if (ttlRaw) {
    const m = ttlRaw.match(/^(\d+)(h|d)$/i);
    if (!m) throw new CliError("bad_request", "Invalid --ttl format. Use e.g. 24h or 7d", 1);
    const [, num, unit] = m;
    ttlDays = unit.toLowerCase() === "h" ? Number(num) / 24 : Number(num);
  }

  const maxViews = flags["max-views"] ? Number(flags["max-views"]) : undefined;

  const url = new URL("/v1/admin/share", config.server);
  const body: Record<string, unknown> = { note_path: notePath, ttl_days: ttlDays };
  if (maxViews) body.max_views = maxViews;

  const res = await httpDo("POST", url, { Authorization: `Bearer ${config.token}` }, JSON.stringify(body));
  handleHttpStatus(res);
  const data = JSON.parse(res.body);
  return { ok: true, lines: [`${data.url}\n\nExpires: ${data.expires_at}  Views: 0/${maxViews ?? 100}`], data };
}

// ── Invite (remote, via /v1/admin/invite API) ──────────────────

async function cmdInvite(config: Config, email: string, flags: Record<string, string | boolean>): Promise<CmdResult> {
  if (!email) {
    throw new CliError(
      "bad_request",
      "Usage: grove invite <email> [--trail <trail-id>] [--vault <slug>] [--role owner|member|viewer]",
      1,
    );
  }
  const trailId = flags.trail as string | undefined;
  const vaultSlug = flags.vault as string | undefined;
  if (!trailId && !vaultSlug) {
    throw new CliError(
      "bad_request",
      "Must pass either --trail <trail-id> or --vault <slug>.\n" +
        "For vault invites: grove invite <email> --vault <slug> [--role member]",
      1,
    );
  }
  const role = (flags.role as string) ?? (vaultSlug ? "member" : "viewer");

  const payload = vaultSlug
    ? { email, vault: vaultSlug, role }
    : { email, trail_id: trailId, role };

  const url = new URL("/v1/admin/invite", config.server);
  const res = await httpDo("POST", url, { Authorization: `Bearer ${config.token}` }, JSON.stringify(payload));
  handleHttpStatus(res);
  const data = tryParseJson(res.body) ?? {};

  if (vaultSlug) {
    return {
      ok: true,
      ...data,
      _fmt: () => {
        const status = data.created ? "New user created" : "Existing user";
        const memStatus = data.newMembership ? "new membership" : "existing membership";
        return (
          `\nInvited: ${data.email}\n` +
          `User:    ${data.user_id} (${status})\n` +
          `Vault:   ${data.vault_slug} (${memStatus}, role=${data.role})\n` +
          `Key:     ${data.key_id}\n\n` +
          `${data.created ? "A welcome email with a magic link has been sent." : "A vault-invite email with Open + Add-to-Claude.ai links has been sent."}\n`
        );
      },
    };
  }

  return {
    ok: true,
    ...data,
    _fmt: () => {
      const status = data.created ? "New user created" : "Existing user";
      return `\nInvited: ${data.email}\nUser:    ${data.user_id} (${status})\nTrail:   ${data.trail_id}\nKey:     ${data.key_id}\n\nA welcome email with a magic link has been sent.\n`;
    },
  };
}

// ── Vault provisioning (P8-A4 — runs directly on the VPS) ───────

async function cmdVaultCreate(
  slug: string,
  flags: Record<string, string | boolean>,
): Promise<CmdResult> {
  if (!slug) {
    throw new CliError(
      "bad_request",
      "Usage: grove vault create <slug> --owner <email> [--dry-run]",
      1,
    );
  }
  const ownerEmail = typeof flags.owner === "string" ? flags.owner : "";
  if (!ownerEmail) {
    throw new CliError(
      "bad_request",
      "--owner <email> is required",
      1,
    );
  }

  const skipReload = flags["dry-run"] === true;
  const displayName = typeof flags["display-name"] === "string" ? flags["display-name"] : undefined;
  const { provisionVault, ProvisionError } = await import("./vault-provision.js");

  try {
    const result = await provisionVault(
      { slug, ownerEmail, displayName },
      { skipReload },
    );
    return {
      ok: true,
      vault_id: result.vaultId,
      slug: result.slug,
      git_path: result.gitPath,
      server_port: result.serverPort,
      discovery_port: result.discoveryPort,
      owner_user_id: result.ownerUserId,
      owner_api_token: result.ownerApiToken,
      connector_url: result.connectorUrl,
      ecosystem_path: result.ecosystemPath,
      _fmt: () =>
        `vault created: ${result.slug} (${result.vaultId})\n` +
        `  git_path:        ${result.gitPath}\n` +
        `  server_port:     ${result.serverPort}\n` +
        `  discovery_port:  ${result.discoveryPort}\n` +
        `  owner:           ${result.ownerUserId}\n` +
        `  connector_url:   ${result.connectorUrl}\n\n` +
        `Owner API token (shown once, save it now):\n\n  ${result.ownerApiToken}\n\n` +
        `Invite email body (paste into Gmail/Mail):\n\n` +
        `  Subject: You've been invited to ${result.slug} on Grove\n\n` +
        `  Hi — ${result.slug} is a Grove knowledge vault. Add it to Claude.ai:\n` +
        `    ${result.connectorUrl}\n` +
        `  and paste this token when asked:\n    ${result.ownerApiToken}\n`,
    };
  } catch (err) {
    if (err instanceof ProvisionError) {
      const code = err.code === "slug_taken" ? "conflict"
        : err.code === "invalid_slug" || err.code === "reserved_slug" ? "bad_request"
        : "internal_error";
      throw new CliError(code, err.message, code === "bad_request" ? 1 : code === "conflict" ? 2 : 3);
    }
    throw err;
  }
}

// ── Vault encryption (remote, via /v1/admin/vault API) ─────────

async function cmdVaultStatus(config: Config): Promise<CmdResult> {
  const data = await restGet(config, "/v1/admin/vault/status");
  return {
    ok: true,
    encrypted: !!data.encrypted,
    unlocked: !!data.unlocked,
    last_unlocked_at: data.last_unlocked_at ?? null,
    _fmt: () => {
      if (!data.encrypted) return "encrypted: no\n(Vault is plaintext. Run `grove vault encrypt` to encrypt.)";
      const state = data.unlocked ? "unlocked" : "locked";
      const last = data.last_unlocked_at ? new Date(data.last_unlocked_at).toISOString() : "never";
      return `encrypted:        yes\nstate:            ${state}\nlast unlocked at: ${last}`;
    },
  };
}

async function cmdVaultEncrypt(config: Config): Promise<CmdResult> {
  const passphrase = await promptPassphrase("Set a passphrase", { confirm: true });
  const res = await restPost(config, "/v1/admin/vault/encrypt", { passphrase });
  if (res.status === 409) {
    throw new CliError("bad_request", res.data?.message ?? "Vault is already encrypted.", 1);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new CliError("server_error", `Encrypt failed (${res.status}): ${JSON.stringify(res.data)}`, 3);
  }
  return {
    ok: true,
    encrypted: true,
    ...res.data,
    _fmt: () => "Vault encrypted. Keep your passphrase safe — there is no recovery.",
  };
}

async function cmdVaultUnlock(config: Config): Promise<CmdResult> {
  const passphrase = await promptPassphrase("Passphrase");
  const res = await restPost(config, "/v1/admin/vault/unlock", { passphrase });
  if (res.status === 401) {
    throw new CliError("auth_error", "Wrong passphrase.", 2);
  }
  if (res.status === 409) {
    throw new CliError("bad_request", res.data?.message ?? "Vault is not encrypted.", 1);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new CliError("server_error", `Unlock failed (${res.status}): ${JSON.stringify(res.data)}`, 3);
  }
  return {
    ok: true,
    unlocked: true,
    last_unlocked_at: res.data?.last_unlocked_at,
    _fmt: () => "Vault unlocked.",
  };
}

async function cmdVaultLock(config: Config): Promise<CmdResult> {
  const res = await restPost(config, "/v1/admin/vault/lock", {});
  if (res.status === 409) {
    throw new CliError("bad_request", res.data?.message ?? "Vault is not encrypted.", 1);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new CliError("server_error", `Lock failed (${res.status}): ${JSON.stringify(res.data)}`, 3);
  }
  return {
    ok: true,
    locked: true,
    _fmt: () => "Vault locked. Data endpoints will return 503 until unlocked.",
  };
}

// ── Snapshot / Rollback (local vault git operations) ─────────

function cmdSnapshot(args: string[]): CmdResult {
  const subcommand = args[1];

  if (subcommand === "list") {
    const result = execSync("git tag -l 'grove-snapshot-*' --sort=-creatordate", { cwd: VAULT_PATH, encoding: "utf-8" });
    const tags = result.trim().split("\n").filter(Boolean).slice(0, 10);
    return {
      ok: true,
      snapshots: tags,
      _fmt: () => {
        if (tags.length === 0) return "No snapshots found.";
        return "Snapshots (most recent first):\n" + tags.map((t) => `  ${t}`).join("\n");
      },
    };
  }

  const name = subcommand ?? "";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tagName = `grove-snapshot-${timestamp}`;
  const msgArgs = name ? ["-m", name] : [];
  execSync(`git tag ${tagName} ${msgArgs.map((a) => `"${a}"`).join(" ")}`.trim(), { cwd: VAULT_PATH });
  return {
    ok: true,
    tag: tagName,
    message: name || undefined,
    _fmt: () => {
      let out = `Snapshot created: ${tagName}`;
      if (name) out += `\n  Message: ${name}`;
      return out;
    },
  };
}

function cmdRollback(tag: string): CmdResult {
  if (!tag) throw new CliError("bad_request", "Usage: grove rollback <tag>\n  List snapshots: grove snapshot list", 1);

  try {
    execSync(`git rev-parse ${tag}`, { cwd: VAULT_PATH, stdio: "pipe" });
  } catch {
    throw new CliError("not_found", `Tag not found: ${tag}`, 1);
  }

  execSync(`git checkout ${tag} -- .`, { cwd: VAULT_PATH });
  execSync(`git add -A && git commit -m "grove (admin): rollback to ${tag}"`, {
    cwd: VAULT_PATH,
    shell: "/bin/sh",
  });
  return {
    ok: true,
    rolled_back_to: tag,
    _fmt: () => `Rolled back to: ${tag}\nFiles restored and committed. Reindex may be needed.`,
  };
}

function cmdLint(dir: string, flags: Record<string, string | boolean>): CmdResult {
  if (!dir) throw new CliError("bad_request", "Usage: grove lint <dir> [--dry-run]", 1);
  const dryRun = !!flags["dry-run"];

  if (dryRun) {
    const { readdirSync, readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { normalizeNote } = require("./sync-sources.js");
    const entries = readdirSync(dir, { withFileTypes: true });
    const wouldChange: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const raw = readFileSync(join(dir, entry.name), "utf-8");
      if (raw !== normalizeNote(raw)) wouldChange.push(entry.name);
    }
    return {
      ok: true,
      dry_run: true,
      would_change: wouldChange,
      _fmt: () => {
        const lines = wouldChange.map((f) => `  would normalize: ${f}`);
        lines.push(`\n${wouldChange.length} file(s) would be normalized`);
        return lines.join("\n");
      },
    };
  }

  const { changed, total } = normalizeDir(dir);
  return {
    ok: true,
    changed,
    total,
    _fmt: () => {
      if (changed.length === 0) return `All ${total} files already normalized.`;
      const lines = changed.map((f: string) => `  normalized: ${f}`);
      lines.push(`\n${changed.length}/${total} file(s) normalized.`);
      return lines.join("\n");
    },
  };
}

// ── Vault config ────────────────────────────────────────────────

function formatVaultConfig(data: Record<string, unknown>): string {
  const s = (data as any).structure as Record<string, any>;
  const lines: string[] = [];
  lines.push(`config_path: ${(data as any).config_path}`);
  lines.push(`exists:      ${(data as any).exists ? "yes" : "no (defaults in use)"}`);
  lines.push("");
  lines.push("entities:");
  for (const [k, v] of Object.entries(s.entities)) lines.push(`  ${k}: ${v}`);
  const typePaths = Object.entries(s.type_paths as Record<string, string>);
  if (typePaths.length) {
    lines.push("type_paths:");
    for (const [k, v] of typePaths) lines.push(`  ${k}: ${v}`);
  } else {
    lines.push("type_paths: (empty)");
  }
  const tagRules = s.tag_rules as Array<{ prefix: string; tags: string[] }>;
  if (tagRules.length) {
    lines.push("tag_rules:");
    for (const r of tagRules) lines.push(`  ${r.prefix} → ${r.tags.join(", ")}`);
  } else {
    lines.push("tag_rules: (empty)");
  }
  const priv = s.private_paths as string[];
  lines.push(priv.length ? `private_paths: ${priv.join(", ")}` : "private_paths: (empty)");
  lines.push(`archive_path: ${s.archive_path}`);
  lines.push(`journal_path: ${s.journal_path ?? "(none)"}`);
  lines.push(`journal_filename: ${s.journal_filename ?? "(none)"}`);
  return lines.join("\n");
}

function cmdConfigShow(): CmdResult {
  const configPath = join(VAULT_PATH, CONFIG_RELATIVE_PATH);
  const exists = existsSync(configPath);
  const config = loadVaultConfig(VAULT_PATH);
  return {
    ok: true,
    config_path: configPath,
    exists,
    structure: config.structure,
    _fmt: formatVaultConfig,
  };
}

async function cmdConfigInit(flags: Record<string, string | boolean>): Promise<CmdResult> {
  const configPath = join(VAULT_PATH, CONFIG_RELATIVE_PATH);
  const existed = existsSync(configPath);
  if (existed && !flags.yes) {
    await confirmTyped(
      "init",
      `re-detect vault structure and overwrite ${CONFIG_RELATIVE_PATH} — current config will be lost.`,
    );
  }
  const { pattern, config } = detectAndWriteConfig(VAULT_PATH);
  return {
    ok: true,
    action: existed ? "regenerated" : "generated",
    pattern,
    config_path: configPath,
    structure: config.structure,
    _fmt: (data: any) =>
      `${data.action} ${configPath}\ndetected pattern: ${data.pattern}\n\n` +
      formatVaultConfig({ ...data, exists: true }),
  };
}

// ── Tag backfill ────────────────────────────────────────────────

function walkVaultMd(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walkVaultMd(full, acc); continue; }
    if (entry.isFile() && entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

function cmdTagBackfill(flags: Record<string, string | boolean>): CmdResult {
  const dryRun = !!flags["dry-run"];

  // Create snapshot before modifying anything
  if (!dryRun) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tagName = `grove-snapshot-pre-backfill-${timestamp}`;
    execSync(`git tag ${tagName}`, { cwd: VAULT_PATH });
    process.stderr.write(`Snapshot created: ${tagName}\n`);
  }

  const allFiles = walkVaultMd(VAULT_PATH);
  let updated = 0;
  let skipped = 0;
  const changes: Array<{ path: string; added: string[] }> = [];

  for (const abs of allFiles) {
    const rel = relative(VAULT_PATH, abs);
    const raw = readFileSync(abs, "utf-8");
    const { frontmatter, content } = parseNote(raw);

    // Skip notes without type (not a proper note)
    if (!frontmatter.type || typeof frontmatter.type !== "string") {
      skipped++;
      continue;
    }

    // Only process notes with zero tags
    const existingTags = Array.isArray(frontmatter.tags)
      ? frontmatter.tags
      : typeof frontmatter.tags === "string"
        ? [frontmatter.tags]
        : [];
    if (existingTags.length > 0) {
      skipped++;
      continue;
    }

    const newTags = inferTags(rel, frontmatter);
    if (newTags.length === 0) {
      skipped++;
      continue;
    }

    if (!dryRun) {
      frontmatter.tags = newTags;
      writeFileSync(abs, serializeNote(frontmatter, content), "utf-8");
    }

    changes.push({ path: rel, added: newTags });
    updated++;
  }

  // Commit all changes in one go
  if (!dryRun && updated > 0) {
    execSync("git add -A", { cwd: VAULT_PATH });
    execSync(`git commit -m "grove (admin): tag-backfill ${updated} notes"`, {
      cwd: VAULT_PATH,
      shell: "/bin/sh",
    });
  }

  return {
    ok: true,
    dry_run: dryRun || undefined,
    updated,
    skipped,
    total: allFiles.length,
    changes,
    _fmt: () => {
      if (updated === 0) return `No notes needed tag backfill (${allFiles.length} scanned, ${skipped} skipped).`;
      const verb = dryRun ? "would update" : "updated";
      const lines = changes.slice(0, 20).map((c) => `  ${verb}: ${c.path}  → +${c.added.join(", +")}`);
      if (changes.length > 20) lines.push(`  ... and ${changes.length - 20} more`);
      lines.push(`\n${updated}/${allFiles.length} note(s) ${verb}.`);
      return lines.join("\n");
    },
  };
}

// ── Help system ─────────────────────────────────────────────────

interface CmdHelp {
  usage: string;
  description: string;
  flags?: string[];
  json_schema?: string;
  exit_codes?: string;
  examples?: string[];
}

const EXIT_CODES = "Exit: 0=success, 1=bad input/not found, 2=auth, 3=server";

export const HELP: Record<string, CmdHelp> = {
  search: {
    usage: "grove search <query> [-n N] [--json] [--paths]",
    description: "Search notes. Returns ranked results with snippets.",
    flags: ["-n N      Max results (default 10)", "--json    JSON output", "--paths   Paths only (for piping)"],
    json_schema: "{ok, results: [{path, title, score, snippet}], count}",
    exit_codes: EXIT_CODES,
    examples: ["grove search 'taste graph'", "grove search 'parametric design' -n 5", "grove search 'ML' --paths | xargs -I{} grove read '{}'"],
  },
  read: {
    usage: "grove read <path-or-title> [--json]",
    description: "Read a single note by path or title.",
    flags: ["--json    JSON output"],
    json_schema: "{ok, path, frontmatter, content, content_hash, resolved_from?}",
    exit_codes: EXIT_CODES,
    examples: ["grove read 'Taste Graph'", "grove read Resources/Concepts/taste-graph.md"],
  },
  list: {
    usage: "grove list <glob> [--aliases] [--paths] [--json]",
    description: "List notes matching a glob pattern.",
    flags: ["--aliases  Include aliases", "--paths    One path per line (for piping)", "--json     JSON output"],
    json_schema: "{ok, entries: [{path, type, modified_at, aliases?}], count}",
    exit_codes: EXIT_CODES,
    examples: ["grove list 'Resources/People/*'", "grove list 'Journal/2026/*' --json"],
  },
  write: {
    usage: "grove write <path> --type <type> [--content text | stdin] [--tags t1,t2] [--if-hash hash]",
    description: "Create or update a note. Content from --content flag or stdin.",
    flags: ["--type T      Note type (default: concept)", "--content S   Note content (alternative to stdin)", "--tags T1,T2  Comma-separated tags", "--if-hash H   Content hash from prior read (rejects on conflict)"],
    json_schema: "{ok, path, action, content_hash, url}",
    exit_codes: EXIT_CODES,
    examples: ["grove write Inbox/idea.md --type concept --content 'My idea'", "cat draft.md | grove write Resources/Concepts/new.md --type concept"],
  },
  delete: {
    usage: "grove delete <path> [--hard --yes] [--if-hash hash] [--json]",
    description: "Archive a note (default) or permanently delete it with --hard. Soft delete moves the note under the vault's archive path and adds archived_from/archived_at frontmatter. --hard removes the file outright and requires --yes.",
    flags: ["--hard        Permanently delete (file is removed, not archived)", "--yes         Required with --hard to confirm irreversible removal", "--if-hash H   Content hash from prior read (rejects on conflict)", "--json        JSON output"],
    json_schema: "{ok, action: 'archived'|'deleted', original_path, archive_path?, commit}",
    exit_codes: EXIT_CODES,
    examples: [
      "grove delete Inbox/old-idea.md",
      "grove delete Inbox/old-idea.md --hard --yes",
      "grove delete Resources/Concepts/x.md --if-hash abc123",
    ],
  },
  move: {
    usage: "grove move <from> <to> [--if-hash hash] [--json]",
    description: "Move or rename a note. Updates all exact wikilinks across the vault in the same commit. Destination must not already exist.",
    flags: ["--if-hash H   Content hash from prior read (rejects on conflict)", "--json        JSON output"],
    json_schema: "{ok, action: 'moved', from, to, links_updated, commit}",
    exit_codes: EXIT_CODES,
    examples: [
      "grove move Inbox/idea.md Resources/Concepts/idea.md",
      "grove move 'Inbox/taste graph.md' 'Resources/Concepts/taste-graph.md'",
    ],
  },
  init: {
    usage: "grove init --server <url> --token <token>",
    description: "Configure Grove CLI. Validates connection and writes ~/.grove/cli.json.",
    flags: ["--server URL  Server URL (default: https://api.grove.md)", "--token T     API token (required)"],
    json_schema: "{ok, server, config_path}",
    exit_codes: EXIT_CODES,
    examples: ["grove init --server https://api.grove.md --token grove_live_xxx"],
  },
  config: {
    usage: "grove config [init] [--yes] [--json]",
    description: "Show or regenerate the vault structure config at $VAULT/.grove/config.yaml. With no subcommand, prints the effective config (defaults used when the file is absent). `config init` re-detects the vault layout and writes a fresh config; it requires --yes or typed confirmation when a config already exists.",
    flags: ["--yes     Skip confirmation when overwriting an existing config", "--json    JSON output"],
    json_schema: "{ok, config_path, exists, structure} | {ok, action, pattern, config_path, structure}",
    exit_codes: EXIT_CODES,
    examples: ["grove config", "grove config --json", "grove config init", "grove config init --yes"],
  },
  graph: {
    usage: "grove graph [--json]",
    description: "Show vault knowledge graph — clusters, hubs, centrality.",
    flags: ["--json    JSON output"],
    json_schema: "{ok, total_nodes, total_edges, clusters, top_hubs}",
    exit_codes: EXIT_CODES,
  },
  digest: {
    usage: "grove digest [--json]",
    description: "Show note lifecycle stages — seeds, sprouts, growing, mature, dormant, withering.",
    flags: ["--json    JSON output"],
    json_schema: "{ok, stages, velocity_7d}",
    exit_codes: EXIT_CODES,
  },
  health: {
    usage: "grove health [--json]",
    description: "Check server component health.",
    flags: ["--json    JSON output"],
    json_schema: "{ok, status, components: {proxy, grove-server, qmd, embed}}",
    exit_codes: EXIT_CODES,
  },
  metrics: {
    usage: "grove metrics [--json]",
    description: "Show server request counts, latency, and error rates.",
    flags: ["--json    JSON output"],
    json_schema: "{ok, started_at, uptime_seconds, total_requests, error_rate, by_tool, search}",
    exit_codes: EXIT_CODES,
  },
  status: {
    usage: "grove status [--json]",
    description: "Vault health overview.",
    flags: ["--json    JSON output"],
    json_schema: "{ok, vault, freshness, graph, index, lifecycle, git}",
    exit_codes: EXIT_CODES,
  },
  history: {
    usage: "grove history [--since <date>] [--json]",
    description: "Recent vault changes.",
    flags: ["--since D  Date string (default: '1 week ago')", "--json     JSON output"],
    json_schema: "{ok, entries: [{date, message, files}]}",
    exit_codes: EXIT_CODES,
  },
  diagnostics: {
    usage: "grove diagnostics [--json]",
    description: "Run vault diagnostics — orphans, broken links, missing frontmatter.",
    flags: ["--json    JSON output"],
    json_schema: "{ok, total_notes, orphans, broken_links, missing_frontmatter, stale_inbox}",
    exit_codes: EXIT_CODES,
  },
  keys: {
    usage: "grove keys [list|create|revoke] [--json]",
    description: "Manage API keys.",
    flags: ["--json    JSON output"],
    json_schema: "{ok, keys: [{id, name, scopes, vault_id, created_at, last_used_at}]}",
    exit_codes: EXIT_CODES,
    examples: ["grove keys", "grove keys create laptop", "grove keys revoke key_abc123"],
  },
  trails: {
    usage: "grove trails [list|create|disable|delete] [--json]",
    description: "Manage trails (scoped read access).",
    flags: ["--allow-tags T   Allow tags", "--deny-tags T    Deny tags", "--allow-types T  Allow types", "--allow-paths P  Allow paths", "--yes            Confirm destructive delete", "--json           JSON output"],
    json_schema: "{ok, trails: [{id, name, enabled, allow_tags, allow_paths}]}",
    exit_codes: EXIT_CODES,
  },
  vault: {
    usage: "grove vault [status|encrypt|unlock|lock] [--json]",
    description: "Encryption lifecycle. Passphrase is read from stdin (interactive) or GROVE_VAULT_PASSPHRASE env var.",
    flags: ["--json    JSON output"],
    json_schema: "{ok, encrypted, unlocked, last_unlocked_at} | {ok, locked|unlocked|encrypted: true}",
    exit_codes: EXIT_CODES,
    examples: [
      "grove vault status",
      "grove vault encrypt",
      "grove vault unlock",
      "grove vault lock",
      "GROVE_VAULT_PASSPHRASE=... grove vault unlock --json",
    ],
  },
  sync: {
    usage: "grove sync <dir> [--dry-run] [--json]",
    description: "Sync archived Sources directory to Grove.",
    flags: ["--dry-run  Show what would be synced", "--json     JSON output"],
    json_schema: "{ok, action, created, failed, skipped, results}",
    exit_codes: EXIT_CODES,
  },
  ingest: {
    usage: "grove ingest <dir> [--dry-run] [--json]",
    description: "Import .md or .txt files into the vault (.txt is renamed to .md). Deduplicates by title against existing notes. Creates a snapshot before starting.",
    flags: ["--dry-run  Show what would be imported", "--json     JSON output"],
    json_schema: "{ok, action, imported, failed, skipped, enqueued, total, results: [{path, status}]}",
    exit_codes: EXIT_CODES,
    examples: ["grove ingest ./import/", "grove ingest ./export/ --dry-run"],
  },
  bookmarks: {
    usage: "grove bookmarks [--count N] [--json]",
    description: "Sync X bookmarks into Source notes. Deduplicates by tweet ID. Enqueues new notes for discovery.",
    flags: ["--count N  Number of bookmarks to fetch (default: 20)", "--json     JSON output"],
    json_schema: "{ok, action, fetched, created, skipped, enqueued, notes, errors}",
    exit_codes: EXIT_CODES,
    examples: ["grove bookmarks", "grove bookmarks --count 50"],
  },
  lint: {
    usage: "grove lint <dir> [--dry-run] [--json]",
    description: "Normalize YAML frontmatter in .md files.",
    flags: ["--dry-run  Show what would change", "--json     JSON output"],
    json_schema: "{ok, changed, total}",
    exit_codes: EXIT_CODES,
  },
  whoami: {
    usage: "grove whoami [--json]",
    description: "Show current identity — key name, scopes, vault.",
    flags: ["--json    JSON output"],
    json_schema: "{ok, key_id, key_name, scopes, vault_id, trail?}",
    exit_codes: EXIT_CODES,
  },
  "tag-backfill": {
    usage: "grove tag-backfill [--dry-run] [--json]",
    description: "Backfill inferred tags on notes with zero tags. Creates a snapshot first.",
    flags: ["--dry-run  Show what would change without writing", "--json     JSON output"],
    json_schema: "{ok, updated, skipped, total, changes: [{path, added}]}",
    exit_codes: EXIT_CODES,
  },
  snapshot: {
    usage: "grove snapshot [name] | grove snapshot list",
    description: "Create or list vault snapshots (git tags).",
    json_schema: "{ok, tag, message?} | {ok, snapshots: [string]}",
    exit_codes: EXIT_CODES,
  },
  rollback: {
    usage: "grove rollback <tag>",
    description: "Restore vault to a snapshot.",
    json_schema: "{ok, rolled_back_to}",
    exit_codes: EXIT_CODES,
  },
};

export function printCommandHelp(cmd: string): string {
  const h = HELP[cmd];
  if (!h) return `Unknown command: ${cmd}\nRun 'grove' for available commands.`;
  const lines: string[] = [h.usage, `  ${h.description}`, ""];
  if (h.flags?.length) {
    lines.push("Flags:");
    for (const f of h.flags) lines.push(`  ${f}`);
    lines.push("");
  }
  if (h.json_schema) lines.push(`JSON: ${h.json_schema}`);
  if (h.exit_codes) lines.push(h.exit_codes);
  if (h.examples?.length) {
    lines.push("\nExamples:");
    for (const e of h.examples) lines.push(`  ${e}`);
  }
  return lines.join("\n");
}

function printUsage(): string {
  return `grove — CLI client for the Grove knowledge API

Commands:
  search <query>          Search notes
  read <path-or-title>    Read a note
  list <glob>             List notes
  write <path>            Create/update a note
  delete <path>           Archive a note (or --hard --yes to remove)
  move <from> <to>        Move/rename a note; updates wikilinks
  graph                   Knowledge graph overview
  digest                  Note lifecycle stages
  history                 Recent changes
  status                  Vault health overview
  diagnostics             Run vault diagnostics

  health                  Server component health
  metrics                 Request counts and latency

  whoami                  Show current identity
  init                    Configure CLI connection
  config                  Show vault structure config; 'config init' auto-detects
  keys                    Manage API keys
  trails                  Manage trails (scoped access)
  vault                   Encryption lifecycle (status|encrypt|unlock|lock)
  sync <dir>              Sync archived Sources
  ingest <dir>            Import .md or .txt files into vault
  lint <dir>              Normalize frontmatter
  tag-backfill            Backfill inferred tags on untagged notes
  snapshot                Create/list vault snapshots
  rollback <tag>          Restore vault to snapshot

Flags:
  --json                  Force JSON output (auto-enabled when piped)
  --help                  Show help for a command

Config: ~/.grove/cli.json  |  Env: GROVE_SERVER, GROVE_TOKEN
Setup: grove init --server https://api.grove.md --token grove_live_...`;
}

// ── Output dispatcher ───────────────────────────────────────────

/**
 * Resolve output format from flags, honoring new --format + legacy --json/--paths.
 * Priority: explicit --format > --jsonl/--paths/--table > --json > TTY default.
 */
function resolveFormat(flags: Record<string, string | boolean>): Format {
  const view = {
    format: flags.format,
    json: flags.json,
    jsonl: flags.jsonl,
    paths: flags.paths,
    table: flags.table,
  };
  return selectFormat(view);
}

function emitResult(result: CmdResult, flags: Record<string, string | boolean>): void {
  const format = resolveFormat(flags);
  const nullDelimited = isNullDelimited(flags as any);
  const fields = parseFields(flags as any);

  // Legacy --paths behavior maps to --format paths (same rendering, path list only)
  if (flags.paths && format !== "paths") {
    // User passed both (unusual); legacy wins.
    const items = (result as any).results ?? (result as any).entries ?? [];
    for (const item of items) {
      if (item.path) process.stdout.write(item.path + (nullDelimited ? "\0" : "\n"));
    }
    return;
  }

  // For the new format system, we render the data payload (not _fmt) for json/jsonl/paths.
  // Table falls back to the command's bespoke _fmt if present — human-readable preferred.
  if (format === "table" && result._fmt) {
    process.stdout.write(result._fmt(result) + "\n");
    return;
  }

  // Strip internal _fmt before rendering.
  const { _fmt, ok: _ok, ...data } = result;
  if (format === "json" || format === "jsonl") {
    // Wrap in the standard envelope so agents see `ok: true`.
    const envelope = { ok: true, data };
    process.stdout.write(renderOutput(envelope, { format, nullDelimited, fields }) + "\n");
    return;
  }

  if (format === "paths") {
    // Try common payload shapes (results, entries, notes, paths) or data itself.
    const payload = (data as any).results ?? (data as any).entries ?? (data as any).notes ?? (data as any).paths ?? data;
    process.stdout.write(renderOutput(payload, { format, nullDelimited, fields }));
    return;
  }

  // Fallback for table with no _fmt.
  process.stdout.write(renderOutput(data, { format, nullDelimited, fields }) + "\n");
}

function emitError(err: CliError | GroveCliError, flags: Record<string, string | boolean>): void {
  const format = resolveFormat(flags);
  // Normalize to new envelope shape.
  const code = err.code;
  const message = err.message;
  const hint = (err as GroveCliError).hint;
  const suggestions = (err as GroveCliError).suggestions ?? [];
  const details = (err as GroveCliError).details;

  if (format === "json" || format === "jsonl") {
    const envelope: { ok: false; error: Record<string, unknown> } = {
      ok: false,
      error: { code, message },
    };
    if (hint) envelope.error.hint = hint;
    if (suggestions.length > 0) envelope.error.suggestions = suggestions;
    if (details) envelope.error.details = details;
    // Write machine-readable envelope to stdout (agent-consumable).
    process.stdout.write(JSON.stringify(envelope) + "\n");
    return;
  }
  // Human: stderr.
  const lines: string[] = [`error: ${message} [${code}]`];
  if (hint) lines.push(`hint: ${hint}`);
  if (suggestions.length > 0) {
    lines.push("suggestions:");
    for (const s of suggestions) lines.push(`  ${s}`);
  }
  process.stderr.write(lines.join("\n") + "\n");
}

/**
 * Legacy CliError → exit code mapping.
 * New GroveCliError uses `newExitCodeFor(code)` for the 0/1/2/3/4 scheme.
 * For legacy CliError, if the `code` string maps to a modern class (e.g.,
 * "not_found" or "conflict"), prefer the modern exit code; otherwise fall
 * back to the legacy `.exitCode` property.
 */
function exitCodeFor(err: CliError | GroveCliError): number {
  if (err instanceof GroveCliError) return err.exitCode;
  const legacyCode = (err as CliError).code;
  // Translate legacy codes to modern exit codes where the class is obvious.
  if (legacyCode === "not_found") return 4;
  if (legacyCode === "conflict") return 4;
  return (err as CliError).exitCode;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  // Install signal handlers FIRST so SIGPIPE never crashes the CLI.
  installSignalHandlers();

  // Ban tokens in argv (ps-aux leak protection). init is the lone exception.
  try {
    guardAgainstTokenInArgv(process.argv.slice(2));
  } catch (err) {
    if (err instanceof GroveCliError) {
      emitError(err, { json: !process.stdout.isTTY });
      process.exit(err.exitCode);
    }
    throw err;
  }

  const { command, positional, positionals, flags } = parseArgs(process.argv.slice(2));

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(printUsage() + "\n");
    return;
  }

  // Per-command --help
  if (flags.help) {
    process.stdout.write(printCommandHelp(command) + "\n");
    return;
  }

  try {
    let result: CmdResult;

    // Local-only commands (no server needed)
    if (command === "snapshot") { result = cmdSnapshot(process.argv.slice(3)); emitResult(result, flags); return; }
    if (command === "rollback") {
      // Destructive: require typed confirmation unless bypass env set.
      await confirmTyped(positional, `rollback will restore vault to snapshot "${positional}" and commit — existing uncommitted changes in the vault may be lost.`);
      result = cmdRollback(positional); emitResult(result, flags); return;
    }
    if (command === "lint") { result = cmdLint(positional, flags); emitResult(result, flags); return; }

    // Phase 3: grove completion <shell> — emit shell completion script to stdout.
    if (command === "completion") {
      const shell = positional || "bash";
      let body: string;
      switch (shell) {
        case "bash": body = completionBash(); break;
        case "zsh":  body = completionZsh(); break;
        case "fish": body = completionFish(); break;
        default:
          throw new CliError("bad_request", `Unknown shell: ${shell}\nUsage: grove completion {bash|zsh|fish}`, 1);
      }
      // Always emit to stdout regardless of --format (the whole point is a
      // source-able script, not JSON).
      process.stdout.write(body);
      return;
    }

    // Phase 3: grove logout — wipe local config, best-effort revoke.
    if (command === "logout") {
      const out = await doLogout();
      result = { ok: true, ...out, _fmt: () => out.removed_config ? `removed ${out.removed_config}` : "already logged out" } as CmdResult;
      emitResult(result, flags);
      return;
    }

    // Phase 3: grove doctor — self-diagnostics (run BEFORE loadConfig so it
    // can still run when config is broken).
    if (command === "doctor") {
      // Try to load config but do not throw — doctor needs to work pre-init.
      let cfg: Config | null = null;
      try { cfg = loadConfig(); } catch {}
      const report = await runDoctor(cfg);
      result = {
        ok: true,
        overall: report.overall,
        checks: report.checks,
        _fmt: () => {
          const lines: string[] = [];
          for (const c of report.checks) {
            const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
            lines.push(`${icon} ${c.name}: ${c.message}`);
            if (c.suggestion && c.status !== "ok") lines.push(`   suggestion: ${c.suggestion}`);
          }
          lines.push(`\noverall: ${report.overall.toUpperCase()}`);
          return lines.join("\n");
        },
      } as CmdResult;
      emitResult(result, flags);
      // Exit non-zero if any check failed, per POSIX `pg_isready` / `flyctl doctor` convention.
      if (report.overall === "fail") process.exit(3);
      return;
    }
    if (command === "tag-backfill") {
      warnDeprecated("tag-backfill", "grove backfill tags");
      result = cmdTagBackfill(flags);
      emitResult(result, flags);
      return;
    }
    if (command === "init") { result = await cmdInit(flags); emitResult(result, flags); return; }

    // Vault structure config — local only, reads/writes $VAULT/.grove/config.yaml.
    if (command === "config") {
      const sub = positional || "show";
      switch (sub) {
        case "show":
          result = cmdConfigShow();
          break;
        case "init":
          result = await cmdConfigInit(flags);
          break;
        default:
          throw new CliError(
            "bad_request",
            `Unknown config subcommand: ${sub}\nUsage: grove config [init] [--yes]`,
            1,
          );
      }
      emitResult(result, flags);
      return;
    }

    const config = loadConfig();

    // Key management — plural "keys" legacy and singular "key" canonical.
    if (command === "keys" || command === "key") {
      const sub = positional || "list";
      const subArg = process.argv.slice(4)[0] ?? "";
      switch (sub) {
        case "list":   result = await cmdKeysList(config); break;
        case "create": result = await cmdKeysCreate(config, subArg); break;
        case "revoke":
          await confirmTyped(subArg, `revoke API key "${subArg}" — this is immediate and irreversible.`);
          result = await cmdKeysRevoke(config, subArg); break;
        case "rotate":
          result = await cmdKeyRotate(config, subArg, flags); break;
        default:
          throw new CliError("bad_request", `Unknown key subcommand: ${sub}\nUsage: grove key [list|create|revoke|rotate]`, 1);
      }
      emitResult(result, flags);
      return;
    }

    // User management (admin-only, server enforces owner role).
    if (command === "user" || command === "users") {
      const sub = positional || "list";
      const subArg = process.argv.slice(4)[0] ?? "";
      switch (sub) {
        case "list":   result = await cmdUsersList(config); break;
        case "delete":
          if (!subArg) throw new CliError("bad_request", "Usage: grove user delete <user-id>", 1);
          await confirmTyped(subArg, `delete user "${subArg}" — this removes the user AND all their data. Irreversible.`);
          result = await cmdUserDelete(config, subArg); break;
        default:
          throw new CliError("bad_request", `Unknown user subcommand: ${sub}\nUsage: grove user [list|delete]`, 1);
      }
      emitResult(result, flags);
      return;
    }

    // Share
    if (command === "share") {
      result = await cmdShare(config, positional, flags);
      emitResult(result, flags);
      return;
    }

    // Invite
    if (command === "invite") {
      result = await cmdInvite(config, positional, flags);
      emitResult(result, flags);
      return;
    }

    // Vault encryption + provisioning lifecycle.
    if (command === "vault") {
      const sub = positional || "status";
      switch (sub) {
        case "status":  result = await cmdVaultStatus(config); break;
        case "encrypt": result = await cmdVaultEncrypt(config); break;
        case "unlock":  result = await cmdVaultUnlock(config); break;
        case "lock":    result = await cmdVaultLock(config); break;
        case "create": {
          // positionals[0] = "create", positionals[1] = slug
          const slugArg = positionals[1] ?? "";
          result = await cmdVaultCreate(slugArg, flags);
          break;
        }
        default:
          throw new CliError("bad_request", `Unknown vault subcommand: ${sub}\nUsage: grove vault [status|encrypt|unlock|lock|create]`, 1);
      }
      emitResult(result, flags);
      return;
    }

    // Trail management — plural "trails" legacy and singular "trail" canonical.
    if (command === "trails" || command === "trail") {
      const sub = positional || "list";
      const subArg = process.argv.slice(4)[0] ?? "";
      switch (sub) {
        case "list":    result = await cmdTrailsList(config); break;
        case "create":  result = await cmdTrailCreate(config, subArg, flags); break;
        case "update":  result = await cmdTrailUpdate(config, subArg, flags); break;
        case "disable": result = await cmdTrailDisable(config, subArg); break;
        case "delete":
          await confirmTyped(subArg, `delete trail "${subArg}" — this is permanent.`);
          result = await cmdTrailDelete(config, subArg, flags); break;
        default:
          throw new CliError("bad_request", `Unknown trail subcommand: ${sub}\nUsage: grove trail [list|create|update|disable|delete]`, 1);
      }
      emitResult(result, flags);
      return;
    }

    // grove edit — TTY-only interactive edit with conflict-recovery UX.
    if (command === "edit") {
      if (!positional) throw new CliError("bad_request", "Usage: grove edit <path>", 1);
      const deps: EditDeps = {
        getNote: async (p) => {
          const data = await restGet(config, `/v1/notes/${encodeURIComponent(p)}`);
          // Prefer source_hash (stable across discovery mutations); fall back
          // to content_hash for servers predating the two-hash model.
          const hash = (data.source_hash as string | undefined) ?? (data.content_hash as string | undefined) ?? "";
          return { content: data.content ?? "", source_hash: hash, frontmatter: data.frontmatter };
        },
        putNote: async (p, content, ifHash) => {
          // Preserve existing frontmatter — grove edit doesn't restructure it.
          const current = await restGet(config, `/v1/notes/${encodeURIComponent(p)}`);
          const body = { frontmatter: current.frontmatter ?? {}, content };
          return await restPut(config, `/v1/notes/${encodeURIComponent(p)}`, body, { "If-Match": `"${ifHash}"` });
        },
      };
      const outcome = await runEdit(positional, deps);
      result = {
        ok: true,
        action: outcome.status,
        path: outcome.path,
        new_source_hash: outcome.new_source_hash,
        ...(outcome.tempfile ? { tempfile: outcome.tempfile } : {}),
        _fmt: () => {
          switch (outcome.status) {
            case "unchanged":   return `no changes to ${outcome.path}`;
            case "written":     return `updated ${outcome.path}`;
            case "overwritten": return `overwrote ${outcome.path} (server change discarded)`;
            case "aborted":     return `aborted — edits at ${outcome.tempfile}`;
          }
        },
      } as CmdResult;
      emitResult(result, flags);
      return;
    }

    // Bookmark sync (local — no server needed). Deprecated: use `grove import --source=bookmarks`.
    if (command === "bookmarks") {
      warnDeprecated("bookmarks", "grove import --source=bookmarks");
      result = cmdBookmarkSync(flags);
      emitResult(result, flags);
      return;
    }

    // Phase 2: `grove inspect --mode=<diagnostics|graph|digest|discovery>` —
    // a single entry point for the truly modal inspection commands. Keeps
    // `health`, `history`, `status` as distinct verbs per CLI-design feedback.
    if (command === "inspect") {
      const mode = (flags.mode as string) ?? positional;
      switch (mode) {
        case "diagnostics": result = await cmdDiagnostics(config); break;
        case "graph":       result = await cmdGraph(config); break;
        case "digest":      result = await cmdDigest(config); break;
        case "discovery":
          // Use the MCP vault_status tool directly — no dedicated REST endpoint yet.
          const raw = await mcpCall(config, "vault_status", { mode: "discovery" });
          result = { ok: true, ...(tryParseJson(raw) ?? {}), _fmt: formatStatus } as CmdResult;
          break;
        default:
          throw new CliError(
            "bad_request",
            `Unknown inspect mode: ${mode || "(none)"}\nUsage: grove inspect --mode=<diagnostics|graph|digest|discovery>`,
            1,
          );
      }
      emitResult(result, flags);
      return;
    }

    // Phase 2: `grove import --source=<fs|sources|bookmarks>` — consolidates
    // ingest/sync/bookmarks. Default is --plan (dry-run); --apply required to execute.
    if (command === "import") {
      const source = (flags.source as string) ?? "fs";
      const apply = !!flags.apply;
      const plan = !!flags.plan || !apply; // default to plan if neither set
      // Route to existing commands, treating --plan as --dry-run.
      if (plan && !apply) flags["dry-run"] = true;
      switch (source) {
        case "fs":        result = await cmdIngest(config, positional, flags); break;
        case "sources":   result = await cmdSync(config, positional, flags); break;
        case "bookmarks": result = cmdBookmarkSync(flags); break;
        default:
          throw new CliError(
            "bad_request",
            `Unknown import source: ${source}\nUsage: grove import <dir> --source=<fs|sources|bookmarks> [--apply]`,
            1,
          );
      }
      emitResult(result, flags);
      return;
    }

    // Phase 2: `grove backfill tags` — renamed from `tag-backfill`.
    if (command === "backfill") {
      const sub = positional || "tags";
      switch (sub) {
        case "tags":
          result = cmdTagBackfill(flags);
          emitResult(result, flags);
          return;
        default:
          throw new CliError("bad_request", `Unknown backfill target: ${sub}\nUsage: grove backfill tags`, 1);
      }
    }

    // Phase 3: grove patch — update-only write, if-hash required. Agent-safe.
    if (command === "patch") {
      // Read content from stdin if not provided via --content.
      let content = typeof flags.content === "string" ? flags.content : "";
      if (!content && !process.stdin.isTTY) {
        // Same stdin-type quirk as cmdWrite; see that note.
        const chunks: Buffer[] = [];
        process.stdin.on("data", (c: string | Buffer) => {
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        });
        await new Promise<void>((resolve) => process.stdin.on("end", resolve));
        content = Buffer.concat(chunks).toString();
      }
      const ifHashFlag = flags["if-hash"];
      validatePatchArgs({ path: positional, ifHash: ifHashFlag, content });
      // Delegate to the existing PUT /v1/notes/:path path with If-Match header.
      // We reuse cmdWrite's flow but force --if-hash presence (validated above).
      flags.content = content;
      flags["if-hash"] = ifHashFlag;
      result = await cmdWrite(config, positional, flags);
      emitResult(result, flags);
      return;
    }

    // Phase 3: grove open — Obsidian URL scheme handoff (local only).
    if (command === "open") {
      if (!positional) throw new CliError("bad_request", "Usage: grove open <note-path>", 1);
      const vaultName = process.env.GROVE_OBSIDIAN_VAULT_NAME || (config as any).vault_id || "life";
      const url = obsidianUrl(vaultName, positional);
      try {
        await openInObsidian(vaultName, positional);
      } catch (err) {
        throw new CliError("server_error", `Could not open ${url}: ${err instanceof Error ? err.message : String(err)}`, 3);
      }
      result = { ok: true, url, _fmt: () => `opening ${positional} in Obsidian (${url})` } as CmdResult;
      emitResult(result, flags);
      return;
    }

    // Server commands (REST or MCP)
    switch (command) {
      case "search":      result = await cmdSearch(config, positional, flags); break;
      case "read":        result = await cmdRead(config, positional); break;
      case "get":         result = await cmdRead(config, positional); break; // alias
      case "list":        result = await cmdList(config, positional, flags); break;
      case "write":       result = await cmdWrite(config, positional, flags); break;
      case "delete":      result = await cmdDelete(config, positional, flags); break;
      case "move":        result = await cmdMove(config, positional, positionals[1] ?? "", flags); break;
      case "sync":
        warnDeprecated("sync", "grove import <dir> --source=sources --apply");
        result = await cmdSync(config, positional, flags); break;
      case "ingest":
        warnDeprecated("ingest", "grove import <dir> --source=fs --apply");
        result = await cmdIngest(config, positional, flags); break;
      case "history":     result = await cmdHistory(config, flags); break;
      case "status":      result = await cmdStatus(config); break;
      case "diagnostics":
        warnDeprecated("diagnostics", "grove inspect --mode=diagnostics");
        result = await cmdDiagnostics(config); break;
      case "graph":
        warnDeprecated("graph", "grove inspect --mode=graph");
        result = await cmdGraph(config); break;
      case "digest":
        warnDeprecated("digest", "grove inspect --mode=digest");
        result = await cmdDigest(config); break;
      case "health":      result = await cmdHealth(config); break;
      case "metrics":     result = await cmdMetrics(config); break;
      case "whoami":      result = await cmdWhoami(config); break;
      default:
        throw new CliError("bad_request", `Unknown command: ${command}\nRun 'grove' for available commands.`, 1);
    }
    emitResult(result, flags);
  } catch (err) {
    if (err instanceof CliError || err instanceof GroveCliError) {
      emitError(err, flags);
      process.exit(exitCodeFor(err));
    }
    // Unexpected error
    const msg = err instanceof Error ? err.message : String(err);
    emitError(new CliError("server_error", msg, 3), flags);
    process.exit(3);
  }
}

// Shared flags (in case this runs before parseArgs)
const flags = {} as Record<string, string | boolean>;

main();

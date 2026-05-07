/**
 * Graph analysis and garden lifecycle/digest computation for the vault.
 *
 * Called by server.ts for vault_status graph and digest modes.
 * Reads all .md files, extracts wikilinks, builds a directed graph,
 * and classifies notes into lifecycle stages using git history.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { exec } from "./vault-ops.js";

// ── Types ────────────────────────────────────────────────────────────

export interface GraphAnalysis {
  nodes: number;
  edges: number;
  density: number;
  most_connected: { name: string; path: string; links: number }[];
  orphans: string[];
  clusters: { id: number; size: number; members: string[] }[];
  bridges: { name: string; path: string; score: number }[];
}

export interface GardenDigest {
  total: number;
  seeds: { count: number; notes: { name: string; path: string; created: string }[] };
  sprouts: { count: number; notes: { name: string; path: string; created: string }[] };
  growing: { count: number; notes: { name: string; path: string }[] };
  mature: { count: number };
  dormant: { count: number; notes: { name: string; path: string; last_modified: string }[] };
  withering: { count: number; notes: { name: string; path: string; last_modified: string }[] };
  recently_active: { name: string; path: string; modified: string }[];
}

// ── Internals ────────────────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const SKIP = new Set([".obsidian", ".git", ".trash", "node_modules", ".claude"]);

interface NoteNode {
  name: string;
  path: string; // relative
}

function walkMd(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
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

/** Stem: strip path prefixes, keep just the note name */
function stem(link: string): string {
  const parts = link.split("/");
  return parts[parts.length - 1];
}

// ── Graph Analysis ───────────────────────────────────────────────────

export interface AnalyzeGraphOptions {
  /**
   * Skip Brandes betweenness centrality. Drops `bridges` to []. Use this
   * for the periodic vault-stats refresh — the dashboard / heartbeat
   * payload never reads `bridges`, but Brandes is O(n·(n+e)) and on a
   * 1949-node vault costs the entire 30s graph-section budget. The MCP
   * `vault_status mode=graph` tool keeps the default (false) so explicit
   * graph queries still return bridges.
   */
  skipBridges?: boolean;
}

export async function analyzeGraph(
  vaultPath: string,
  options: AnalyzeGraphOptions = {},
): Promise<GraphAnalysis> {
  const files = walkMd(vaultPath);

  // Build node index: stem → NoteNode
  const nodeByName = new Map<string, NoteNode>();
  const allNodes: NoteNode[] = [];

  for (const abs of files) {
    const rel = relative(vaultPath, abs);
    const name = basename(abs, ".md");
    const node: NoteNode = { name, path: rel };
    allNodes.push(node);
    // first file with this stem wins
    if (!nodeByName.has(name)) nodeByName.set(name, node);
  }

  // Adjacency: outgoing[stem] = Set<stem>, incoming[stem] = Set<stem>
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();

  for (const node of allNodes) {
    outgoing.set(node.name, new Set());
    incoming.set(node.name, new Set());
  }

  // Build edges
  let edgeCount = 0;
  for (const abs of files) {
    const srcName = basename(abs, ".md");
    let text: string;
    try {
      text = readFileSync(abs, "utf-8");
    } catch {
      // File may have been deleted between listing and reading — skip
      continue;
    }

    const links = extractWikilinks(text);
    const srcOut = outgoing.get(srcName)!;

    for (const raw of links) {
      const target = stem(raw);
      if (target === srcName) continue; // skip self-links

      if (!srcOut.has(target)) {
        srcOut.add(target);
        edgeCount++;

        // Ensure target exists in incoming map (phantom nodes too)
        if (!incoming.has(target)) incoming.set(target, new Set());
        incoming.get(target)!.add(srcName);

        // Ensure outgoing entry exists for phantom nodes
        if (!outgoing.has(target)) outgoing.set(target, new Set());
      }
    }
  }

  const nodeCount = outgoing.size; // includes phantoms
  const density = nodeCount > 1 ? edgeCount / (nodeCount * (nodeCount - 1)) : 0;

  // Degree: in + out for each node
  const degree = new Map<string, number>();
  for (const [name, out] of outgoing) {
    const inDeg = incoming.get(name)?.size ?? 0;
    degree.set(name, out.size + inDeg);
  }

  // Most connected (top 20)
  const sorted = [...degree.entries()].sort((a, b) => b[1] - a[1]);
  const most_connected = sorted.slice(0, 20).map(([name, links]) => ({
    name,
    path: nodeByName.get(name)?.path ?? "",
    links,
  }));

  // Orphans: zero degree among real (non-phantom) nodes
  const realNames = new Set(allNodes.map((n) => n.name));
  const orphans = allNodes
    .filter((n) => (degree.get(n.name) ?? 0) === 0)
    .map((n) => n.path);

  // Connected components (undirected) via BFS
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const name of outgoing.keys()) {
    if (visited.has(name)) continue;
    const component: string[] = [];
    const queue = [name];
    visited.add(name);

    while (queue.length > 0) {
      const cur = queue.shift()!;
      component.push(cur);

      // Undirected neighbors: outgoing + incoming
      const neighbors = new Set<string>();
      for (const n of outgoing.get(cur) ?? []) neighbors.add(n);
      for (const n of incoming.get(cur) ?? []) neighbors.add(n);

      for (const nb of neighbors) {
        if (!visited.has(nb)) {
          visited.add(nb);
          queue.push(nb);
        }
      }
    }

    components.push(component);
  }

  components.sort((a, b) => b.length - a.length);
  const clusters = components.slice(0, 5).map((members, i) => ({
    id: i,
    size: members.length,
    members: members.slice(0, 20), // cap member list
  }));

  // Betweenness centrality — Brandes' algorithm on undirected view.
  // O(n·(n+e)); the dominant cost on big vaults. Skipped when the caller
  // doesn't need bridges (timer-driven vault-stats refresh).
  let bridges: GraphAnalysis["bridges"] = [];
  if (!options.skipBridges) {
    const betweenness = brandes(outgoing, incoming);
    const bridgeSorted = [...betweenness.entries()]
      .filter(([name]) => realNames.has(name))
      .sort((a, b) => b[1] - a[1]);
    bridges = bridgeSorted.slice(0, 10).map(([name, score]) => ({
      name,
      path: nodeByName.get(name)?.path ?? "",
      score: Math.round(score * 1000) / 1000,
    }));
  }

  return { nodes: nodeCount, edges: edgeCount, density, most_connected, orphans, clusters, bridges };
}

/**
 * Brandes' algorithm for betweenness centrality on an undirected graph.
 * Operates on the union of outgoing + incoming adjacency.
 */
function brandes(
  outgoing: Map<string, Set<string>>,
  incoming: Map<string, Set<string>>,
): Map<string, number> {
  const nodes = [...outgoing.keys()];
  const CB = new Map<string, number>();
  for (const v of nodes) CB.set(v, 0);

  // Build undirected adjacency
  const adj = new Map<string, string[]>();
  for (const v of nodes) {
    const nb = new Set<string>();
    for (const n of outgoing.get(v) ?? []) nb.add(n);
    for (const n of incoming.get(v) ?? []) nb.add(n);
    adj.set(v, [...nb]);
  }

  for (const s of nodes) {
    const S: string[] = [];
    const P = new Map<string, string[]>();
    const sigma = new Map<string, number>();
    const d = new Map<string, number>();
    const delta = new Map<string, number>();

    for (const t of nodes) {
      P.set(t, []);
      sigma.set(t, 0);
      d.set(t, -1);
      delta.set(t, 0);
    }

    sigma.set(s, 1);
    d.set(s, 0);
    const Q: string[] = [s];
    let qi = 0;

    while (qi < Q.length) {
      const v = Q[qi++];
      S.push(v);
      const dv = d.get(v)!;

      for (const w of adj.get(v) ?? []) {
        if (d.get(w)! < 0) {
          Q.push(w);
          d.set(w, dv + 1);
        }
        if (d.get(w) === dv + 1) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!);
          P.get(w)!.push(v);
        }
      }
    }

    while (S.length > 0) {
      const w = S.pop()!;
      for (const v of P.get(w)!) {
        const contrib = (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!);
        delta.set(v, delta.get(v)! + contrib);
      }
      if (w !== s) {
        CB.set(w, CB.get(w)! + delta.get(w)!);
      }
    }
  }

  // Normalize: undirected graph, divide by 2
  const n = nodes.length;
  const norm = n > 2 ? 2 / ((n - 1) * (n - 2)) : 1;
  for (const [v, val] of CB) CB.set(v, val * norm / 2);

  return CB;
}

// ── Git History ──────────────────────────────────────────────────────

interface GitDates {
  created: string; // ISO
  modified: string; // ISO
}

/**
 * Build a map of relative file path → { created, modified } from a single
 * git log command. Newest commits appear first, so first_seen gets
 * overwritten to older dates, and last_seen stays as the first (newest).
 */
async function buildGitHistory(vaultPath: string): Promise<Map<string, GitDates>> {
  const map = new Map<string, GitDates>();

  let raw: string;
  try {
    raw = await exec(
      "git",
      ["log", "--format=COMMIT %aI", "--name-only", "--diff-filter=ACMR"],
      vaultPath,
      30_000,
    );
  } catch {
    // git log can fail if vault isn't a git repo or has no commits — return empty map
    return map;
  }

  let currentDate: string | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("COMMIT ")) {
      currentDate = trimmed.slice(7);
      continue;
    }

    if (!currentDate) continue;
    if (!trimmed.endsWith(".md")) continue;

    const existing = map.get(trimmed);
    if (!existing) {
      map.set(trimmed, { created: currentDate, modified: currentDate });
    } else {
      // git log is newest-first → overwrite created to older dates
      existing.created = currentDate;
    }
  }

  return map;
}

// ── Lifecycle Classification ─────────────────────────────────────────

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function daysBetween(isoDate: string, now: Date): number {
  const d = new Date(isoDate);
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86_400_000));
}

export async function computeDigest(vaultPath: string): Promise<GardenDigest> {
  const files = walkMd(vaultPath);
  const now = new Date();
  const gitHistory = await buildGitHistory(vaultPath);

  // Build backlink index
  const backlinks = new Map<string, number>(); // stem → count
  const fileContents = new Map<string, string>(); // abs → text

  for (const abs of files) {
    let text: string;
    try {
      text = readFileSync(abs, "utf-8");
    } catch {
      // File may have been deleted between listing and reading — skip
      continue;
    }
    fileContents.set(abs, text);

    const links = extractWikilinks(text);
    for (const raw of links) {
      const target = stem(raw);
      backlinks.set(target, (backlinks.get(target) ?? 0) + 1);
    }
  }

  // Classify each note in Resources/, Notes/, Areas/
  const CATEGORIZE_ROOTS = new Set(["Resources", "Notes", "Areas", "Sources", "Inbox"]);

  const seeds: { name: string; path: string; created: string }[] = [];
  const sprouts: { name: string; path: string; created: string }[] = [];
  const growing: { name: string; path: string }[] = [];
  const mature: string[] = [];
  const dormant: { name: string; path: string; last_modified: string }[] = [];
  const withering: { name: string; path: string; last_modified: string }[] = [];

  // Track recently active across all files
  const recentlyActive: { name: string; path: string; modified: string; ts: number }[] = [];

  for (const abs of files) {
    const rel = relative(vaultPath, abs);
    const name = basename(abs, ".md");
    const topFolder = rel.split("/")[0];

    // Get dates from git or fallback to filesystem
    const git = gitHistory.get(rel);
    let created: string;
    let modified: string;

    if (git) {
      created = git.created;
      modified = git.modified;
    } else {
      try {
        const stat = statSync(abs);
        created = stat.birthtime.toISOString();
        modified = stat.mtime.toISOString();
      } catch {
        // File may have been deleted between listing and stat — skip
        continue;
      }
    }

    // Track recently modified (all files)
    recentlyActive.push({ name, path: rel, modified, ts: new Date(modified).getTime() });

    // Only classify notes in categorizable roots
    if (!CATEGORIZE_ROOTS.has(topFolder)) continue;

    const bl = backlinks.get(name) ?? 0;
    const ageDays = daysBetween(created, now);
    const modDaysAgo = daysBetween(modified, now);
    const text = fileContents.get(abs) ?? "";
    const words = wordCount(text);

    // Classification — order matters, first match wins
    if (ageDays <= 7 && words < 200 && bl < 3) {
      seeds.push({ name, path: rel, created });
    } else if (ageDays <= 30 && bl < 3) {
      sprouts.push({ name, path: rel, created });
    } else if (modDaysAgo < 30 || (ageDays <= 90 && bl > 3)) {
      growing.push({ name, path: rel });
    } else if (ageDays > 180 && bl >= 5 && modDaysAgo >= 30) {
      mature.push(name);
    } else if (ageDays > 365 && bl < 2 && modDaysAgo >= 180) {
      withering.push({ name, path: rel, last_modified: modified });
    } else if (modDaysAgo >= 180) {
      dormant.push({ name, path: rel, last_modified: modified });
    } else {
      growing.push({ name, path: rel });
    }
  }

  // Sort recently active, take top 10
  recentlyActive.sort((a, b) => b.ts - a.ts);
  const recently_active = recentlyActive.slice(0, 10).map(({ name, path, modified }) => ({
    name,
    path,
    modified,
  }));

  const total = seeds.length + sprouts.length + growing.length + mature.length + dormant.length + withering.length;

  return {
    total,
    seeds: { count: seeds.length, notes: seeds },
    sprouts: { count: sprouts.length, notes: sprouts },
    growing: { count: growing.length, notes: growing },
    mature: { count: mature.length },
    dormant: { count: dormant.length, notes: dormant },
    withering: { count: withering.length, notes: withering },
    recently_active,
  };
}

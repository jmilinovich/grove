// Brandes' betweenness-centrality is O(n·(n+e)) and the dominant cost in
// analyzeGraph(). On the production personal vault (~1949 notes) it eats the
// entire 30s graph-section budget while the rest of the function (file walk,
// adjacency, BFS components) finishes in seconds. Vault-stats.graph never
// exposes the `bridges` field Brandes produces, so on the timer-driven path
// the work was being thrown away.
//
// `skipBridges: true` is the timer-path opt-out. The MCP tool keeps the
// default (false) so explicit graph queries still return bridges.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeGraph } from "../src/vault-graph.js";

let vaultDir: string;

function writeNote(rel: string, content: string) {
  const abs = join(vaultDir, rel);
  const dir = abs.slice(0, abs.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, content);
}

beforeAll(() => {
  vaultDir = mkdtempSync(join(tmpdir(), "grove-graph-skip-bridges-"));
  // A small graph with a clear bridge: B sits between A's cluster and C's.
  // Without B, A and C are disconnected — exactly the structural role
  // Brandes scores high.
  writeNote("A1.md", "Linked to [[A2]] and [[B]].\n");
  writeNote("A2.md", "Linked to [[A1]].\n");
  writeNote("B.md", "Linked to [[A1]] and [[C1]].\n");
  writeNote("C1.md", "Linked to [[C2]] and [[B]].\n");
  writeNote("C2.md", "Linked to [[C1]].\n");
});

afterAll(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

describe("analyzeGraph skipBridges option", () => {
  it("default behavior: computes bridges via Brandes", async () => {
    const g = await analyzeGraph(vaultDir);
    expect(g.bridges.length).toBeGreaterThan(0);
    // B is the structural bridge between {A1,A2} and {C1,C2}; should rank
    // at the top of the bridge list.
    expect(g.bridges[0].name).toBe("B");
  });

  it("skipBridges: true returns empty bridges array", async () => {
    const g = await analyzeGraph(vaultDir, { skipBridges: true });
    expect(g.bridges).toEqual([]);
  });

  it("skipBridges does not affect non-bridge fields", async () => {
    const full = await analyzeGraph(vaultDir);
    const skipped = await analyzeGraph(vaultDir, { skipBridges: true });

    // Everything except `bridges` should match. Sort `most_connected` ties
    // are stable across calls because the same graph produces the same
    // pre-sort order, but compare by content to be defensive.
    expect(skipped.nodes).toBe(full.nodes);
    expect(skipped.edges).toBe(full.edges);
    expect(skipped.density).toBeCloseTo(full.density, 6);
    expect(skipped.orphans).toEqual(full.orphans);
    expect(skipped.clusters).toEqual(full.clusters);
    expect(skipped.most_connected).toEqual(full.most_connected);
  });

  it("skipBridges: false (explicit) matches default", async () => {
    const explicitFalse = await analyzeGraph(vaultDir, { skipBridges: false });
    const defaulted = await analyzeGraph(vaultDir);
    expect(explicitFalse.bridges).toEqual(defaulted.bridges);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

// ── Isolate DB before importing anything that touches it ─────────────
const SUITE_DIR = mkdtempSync(join(tmpdir(), "grove-health-suite-"));
const TEST_DB_PATH = join(SUITE_DIR, "grove.db");
process.env.GROVE_DB_PATH = TEST_DB_PATH;
// Point QMD index at a path that does not exist so index-health stays
// in its "unavailable" branch (embedding_coverage = -1).
process.env.QMD_INDEX = join(SUITE_DIR, "no-index.sqlite");

import {
  getDb,
  resetDb,
  createSchema,
  getHealthFlags,
} from "../src/db.js";
import {
  computeHealthMetrics,
  calculateHealthScore,
  storeHealthSnapshot,
  getLatestHealthSnapshot,
  getHealthHistory,
  getPriorSnapshotWithin,
  detectAlerts,
  runHealthCheck,
  getCurrentHealth,
  getUnresolvedFlags,
  resolveFlag,
  DEFAULT_ALERT_THRESHOLDS,
  type GraphHealthMetrics,
} from "../src/graph-health.js";

// ── Helpers ──────────────────────────────────────────────────────────

function baseMetrics(overrides: Partial<GraphHealthMetrics> = {}): GraphHealthMetrics {
  return {
    total_notes: 100,
    total_links: 250,
    link_density: 2.5,
    orphan_count: 2,
    orphan_rate: 0.02,
    broken_link_count: 0,
    embedding_coverage: 0.98,
    stale_embedding_count: 0,
    missing_frontmatter: 0,
    growth_velocity_7d: 3,
    growth_velocity_30d: 12,
    avg_links_per_note: 2.5,
    cluster_count: 1,
    largest_cluster_pct: 1,
    ...overrides,
  };
}

// Alias for p13-api tests that used makeMetrics with different defaults
function makeMetrics(overrides: Partial<GraphHealthMetrics> = {}): GraphHealthMetrics {
  return baseMetrics({
    orphan_count: 4,
    orphan_rate: 0.04,
    broken_link_count: 1,
    embedding_coverage: 0.96,
    stale_embedding_count: 2,
    growth_velocity_7d: 5,
    growth_velocity_30d: 18,
    cluster_count: 3,
    largest_cluster_pct: 0.92,
    ...overrides,
  });
}

function writeNote(
  vault: string,
  rel: string,
  fm: { type?: string; tags?: string[] } | null,
  body: string,
): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  let content = "";
  if (fm) {
    const tags = fm.tags && fm.tags.length > 0 ? `\ntags: [${fm.tags.join(", ")}]` : "";
    const type = fm.type ? `\ntype: ${fm.type}` : "";
    content = `---${type}${tags}\n---\n`;
  }
  writeFileSync(abs, content + body);
}

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-health-vault-"));
  // Initialise as an empty git repo so growth velocity path doesn't
  // error out. Commit nothing — velocity should be 0.
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  } catch {
    // If git isn't available the module degrades to zero velocity.
  }
  return dir;
}

// ── Setup ────────────────────────────────────────────────────────────

beforeEach(() => {
  resetDb();
  createSchema();
  // Wipe between tests — resetDb only drops the handle, not the file.
  getDb().exec("DELETE FROM graph_health");
  getDb().exec("DELETE FROM graph_health_flags");
});

afterEach(() => {
  resetDb();
});

// ── calculateHealthScore ─────────────────────────────────────────────

describe("calculateHealthScore", () => {
  it("awards maximum score to a pristine vault", () => {
    const m = baseMetrics();
    expect(calculateHealthScore(m)).toBe(100);
  });

  it("penalises high orphan rate", () => {
    const perfect = calculateHealthScore(baseMetrics());
    const withOrphans = calculateHealthScore(baseMetrics({ orphan_rate: 0.2 }));
    expect(withOrphans).toBeLessThan(perfect);
    expect(withOrphans).toBe(perfect - 20);
  });

  it("partially credits orphan rate between 5% and 10%", () => {
    const m = baseMetrics({ orphan_rate: 0.07 });
    const perfect = calculateHealthScore(baseMetrics());
    expect(calculateHealthScore(m)).toBe(perfect - 10);
  });

  it("penalises broken links", () => {
    const perfect = calculateHealthScore(baseMetrics());
    expect(
      calculateHealthScore(baseMetrics({ broken_link_count: 50 })),
    ).toBe(perfect - 20);
    expect(
      calculateHealthScore(baseMetrics({ broken_link_count: 3 })),
    ).toBe(perfect - 10);
  });

  it("penalises low embedding coverage", () => {
    const perfect = calculateHealthScore(baseMetrics());
    expect(
      calculateHealthScore(baseMetrics({ embedding_coverage: 0.5 })),
    ).toBe(perfect - 20);
    expect(
      calculateHealthScore(baseMetrics({ embedding_coverage: 0.9 })),
    ).toBe(perfect - 10);
  });

  it("treats unknown embedding coverage (-1) as non-penalising", () => {
    const m = baseMetrics({ embedding_coverage: -1 });
    expect(calculateHealthScore(m)).toBe(100);
  });

  it("penalises stagnant vaults", () => {
    const perfect = calculateHealthScore(baseMetrics());
    const stagnant = calculateHealthScore(
      baseMetrics({ growth_velocity_7d: 0, growth_velocity_30d: 0 }),
    );
    expect(stagnant).toBe(perfect - 10);
  });

  it("clamps to 0-100", () => {
    const terrible = calculateHealthScore(
      baseMetrics({
        orphan_rate: 0.8,
        broken_link_count: 200,
        embedding_coverage: 0.1,
        link_density: 0.1,
        growth_velocity_7d: 0,
        growth_velocity_30d: 0,
        missing_frontmatter: 300,
      }),
    );
    expect(terrible).toBeGreaterThanOrEqual(0);
    expect(terrible).toBeLessThanOrEqual(100);
  });
});

// ── computeHealthMetrics ─────────────────────────────────────────────

describe("computeHealthMetrics", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeVault();
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("counts notes, links, and orphans against a fixture vault", async () => {
    writeNote(vault, "Alpha.md", { type: "concept", tags: ["a"] }, "Links to [[Beta]] and [[Gamma]].");
    writeNote(vault, "Beta.md", { type: "concept", tags: ["b"] }, "Back to [[Alpha]].");
    writeNote(vault, "Gamma.md", { type: "concept", tags: ["g"] }, "No outbound links.");
    writeNote(vault, "Lonely.md", { type: "concept", tags: ["x"] }, "No links at all.");

    const m = await computeHealthMetrics(vault);

    expect(m.total_notes).toBe(4);
    // Alpha→Beta, Alpha→Gamma, Beta→Alpha = 3 real edges
    expect(m.total_links).toBe(3);
    // Lonely has no in/out — one orphan
    expect(m.orphan_count).toBe(1);
    expect(m.orphan_rate).toBeCloseTo(0.25, 4);
    expect(m.broken_link_count).toBe(0);
    // All four notes have full frontmatter
    expect(m.missing_frontmatter).toBe(0);
    // Two clusters: {Alpha,Beta,Gamma} and {Lonely}
    expect(m.cluster_count).toBe(2);
    expect(m.largest_cluster_pct).toBeCloseTo(0.75, 4);
    // Index unavailable — coverage reported as -1
    expect(m.embedding_coverage).toBe(-1);
  });

  it("counts broken wikilinks to non-existent notes", async () => {
    writeNote(vault, "A.md", { type: "concept", tags: ["a"] }, "See [[Missing]] and [[AlsoMissing]].");
    writeNote(vault, "B.md", { type: "concept", tags: ["b"] }, "See [[A]].");

    const m = await computeHealthMetrics(vault);
    expect(m.broken_link_count).toBe(2);
    expect(m.total_links).toBe(1);
  });

  it("flags notes missing required frontmatter", async () => {
    writeNote(vault, "Complete.md", { type: "concept", tags: ["ok"] }, "Good.");
    writeNote(vault, "NoType.md", { tags: ["ok"] }, "No type.");
    writeNote(vault, "NoTags.md", { type: "concept" }, "No tags.");
    writeNote(vault, "Bare.md", null, "No frontmatter at all.");

    const m = await computeHealthMetrics(vault);
    expect(m.total_notes).toBe(4);
    expect(m.missing_frontmatter).toBe(3);
  });

  it("returns zeros for an empty vault without throwing", async () => {
    const m = await computeHealthMetrics(vault);
    expect(m.total_notes).toBe(0);
    expect(m.total_links).toBe(0);
    expect(m.orphan_count).toBe(0);
    expect(m.orphan_rate).toBe(0);
    expect(m.largest_cluster_pct).toBe(0);
  });
});

// ── Persistence ──────────────────────────────────────────────────────

describe("storeHealthSnapshot", () => {
  it("persists a snapshot and returns it via getLatest", () => {
    const m = baseMetrics();
    const stored = storeHealthSnapshot(m, calculateHealthScore(m));

    const latest = getLatestHealthSnapshot();
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(stored.id);
    expect(latest!.score).toBe(stored.score);
    expect(latest!.metrics.total_notes).toBe(m.total_notes);
    expect(latest!.measured_at).toBe(stored.measured_at);
  });

  it("returns history within the window, oldest first", () => {
    // Use recent dates so snapshots fall within the default 30-day window
    const now = new Date();
    const iso = (daysAgo: number) =>
      new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
    storeHealthSnapshot(baseMetrics(), 90, iso(2));
    storeHealthSnapshot(baseMetrics(), 95, iso(1));
    storeHealthSnapshot(baseMetrics(), 100, iso(0));

    const history = getHealthHistory(10);
    expect(history).toHaveLength(3);
    expect(history[0].score).toBe(90);   // oldest first
    expect(history[2].score).toBe(100);  // newest last
  });

  it("finds the prior snapshot within a 24h window", () => {
    storeHealthSnapshot(baseMetrics(), 80, "2026-04-18T00:00:00.000Z"); // out of window
    storeHealthSnapshot(baseMetrics(), 90, "2026-04-19T06:00:00.000Z"); // in window
    const prior = getPriorSnapshotWithin("2026-04-20T00:00:00.000Z");
    expect(prior).not.toBeNull();
    expect(prior!.score).toBe(90);
  });
});

// ── detectAlerts ─────────────────────────────────────────────────────

describe("detectAlerts", () => {
  it("fires no alerts on a healthy vault with no prior", () => {
    const m = baseMetrics();
    const alerts = detectAlerts(m, 100, null);
    expect(alerts).toHaveLength(0);
  });

  it("fires score_drop when the 24h delta exceeds the threshold", () => {
    const m = baseMetrics();
    const prior = {
      id: "health_prior",
      measured_at: "2026-04-19T00:00:00.000Z",
      metrics: m,
      score: 95,
    };
    const alerts = detectAlerts(m, 80, prior);
    expect(alerts.map((a) => a.type)).toContain("score_drop");
  });

  it("does not fire score_drop for small fluctuations", () => {
    const m = baseMetrics();
    const prior = {
      id: "health_prior",
      measured_at: "2026-04-19T00:00:00.000Z",
      metrics: m,
      score: 95,
    };
    const alerts = detectAlerts(m, 90, prior);
    expect(alerts.map((a) => a.type)).not.toContain("score_drop");
  });

  it("fires orphan_rate when rate exceeds 15%", () => {
    const alerts = detectAlerts(
      baseMetrics({ orphan_rate: 0.25 }),
      100,
      null,
    );
    expect(alerts.map((a) => a.type)).toContain("orphan_rate");
  });

  it("fires broken_links when count exceeds threshold", () => {
    const alerts = detectAlerts(
      baseMetrics({ broken_link_count: 25 }),
      100,
      null,
    );
    expect(alerts.map((a) => a.type)).toContain("broken_links");
  });

  it("fires embedding_coverage when coverage drops below 80%", () => {
    const alerts = detectAlerts(
      baseMetrics({ embedding_coverage: 0.6 }),
      100,
      null,
    );
    expect(alerts.map((a) => a.type)).toContain("embedding_coverage");
  });

  it("suppresses embedding_coverage alerts when coverage is unknown (-1)", () => {
    const alerts = detectAlerts(
      baseMetrics({ embedding_coverage: -1 }),
      100,
      null,
    );
    expect(alerts.map((a) => a.type)).not.toContain("embedding_coverage");
  });

  it("respects custom thresholds", () => {
    const m = baseMetrics({ broken_link_count: 5 });
    const alerts = detectAlerts(m, 100, null, {
      ...DEFAULT_ALERT_THRESHOLDS,
      broken_links: 3,
    });
    expect(alerts.map((a) => a.type)).toContain("broken_links");
  });
});

// ── runHealthCheck (end-to-end) ──────────────────────────────────────

describe("runHealthCheck", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeVault();
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("stores a snapshot and returns alerts for a degraded vault", async () => {
    // Stage an existing baseline that we'll diverge from.
    storeHealthSnapshot(
      baseMetrics(),
      95,
      new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    );

    // Build a deliberately bad fixture: many broken links, many orphans.
    writeNote(vault, "Hub.md", { type: "concept", tags: ["x"] }, "No real targets.");
    for (let i = 0; i < 30; i++) {
      writeNote(vault, `Orphan${i}.md`, { type: "concept", tags: ["x"] }, "Alone.");
    }
    // 25 broken links out of Hub → trips broken_links threshold
    const hub = join(vault, "Hub.md");
    const manyBroken = Array.from({ length: 25 }, (_, i) => `[[Missing${i}]]`).join(" ");
    writeFileSync(hub, `---\ntype: concept\ntags: [x]\n---\n${manyBroken}`);

    const alerts: string[] = [];
    const result = await runHealthCheck(vault, {
      onAlert: (a) => alerts.push(a.type),
    });

    expect(result.snapshot.metrics.broken_link_count).toBe(25);
    expect(result.snapshot.metrics.orphan_count).toBeGreaterThan(20);
    expect(alerts).toContain("broken_links");
    expect(alerts).toContain("orphan_rate");

    // Persisted
    const latest = getLatestHealthSnapshot();
    expect(latest!.id).toBe(result.snapshot.id);
  });

  it("does not alert on a healthy vault", async () => {
    writeNote(vault, "A.md", { type: "concept", tags: ["a"] }, "[[B]] [[C]]");
    writeNote(vault, "B.md", { type: "concept", tags: ["b"] }, "[[A]] [[C]]");
    writeNote(vault, "C.md", { type: "concept", tags: ["c"] }, "[[A]] [[B]]");

    const alerts: string[] = [];
    const result = await runHealthCheck(vault, {
      onAlert: (a) => alerts.push(a.type),
    });

    expect(result.snapshot.metrics.broken_link_count).toBe(0);
    expect(result.snapshot.metrics.orphan_count).toBe(0);
    expect(alerts).toHaveLength(0);
  });
});

// ── P13-API query helpers tests ──────────────────────────────────────

function insertSnapshot(id: string, measuredAt: string, score: number, metrics: GraphHealthMetrics): void {
  getDb()
    .prepare("INSERT INTO graph_health (id, measured_at, metrics, score) VALUES (?, ?, ?, ?)")
    .run(id, measuredAt, JSON.stringify(metrics), score);
}

function insertFlag(
  id: string,
  flagType: string,
  opts: {
    source_path?: string;
    target_path?: string;
    details?: Record<string, unknown>;
    created_at?: string;
    resolved_at?: string | null;
  } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO graph_health_flags
        (id, flag_type, source_path, target_path, details, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      flagType,
      opts.source_path ?? null,
      opts.target_path ?? null,
      opts.details ? JSON.stringify(opts.details) : "{}",
      opts.created_at ?? new Date().toISOString(),
      opts.resolved_at ?? null,
    );
}

describe("graph-health query helpers", () => {
  beforeEach(() => {
    resetDb();
    createSchema();
    const db = getDb();
    db.exec("DELETE FROM graph_health_flags");
    db.exec("DELETE FROM graph_health");
  });

  afterEach(() => {
    resetDb();
  });

  describe("getCurrentHealth", () => {
    it("returns null when no snapshots have been recorded", () => {
      expect(getCurrentHealth()).toBeNull();
    });

    it("returns the most recent snapshot with parsed metrics", () => {
      insertSnapshot("health_01", "2026-04-18T00:00:00Z", 70, makeMetrics({ total_notes: 50 }));
      insertSnapshot("health_02", "2026-04-19T00:00:00Z", 82, makeMetrics({ total_notes: 100 }));
      insertSnapshot("health_03", "2026-04-17T00:00:00Z", 60, makeMetrics({ total_notes: 30 }));

      const current = getCurrentHealth();
      expect(current).not.toBeNull();
      expect(current!.id).toBe("health_02");
      expect(current!.score).toBe(82);
      expect(current!.metrics.total_notes).toBe(100);
      expect(current!.measured_at).toBe("2026-04-19T00:00:00Z");
    });
  });

  describe("getHealthHistory", () => {
    it("returns an empty array when no snapshots exist", () => {
      expect(getHealthHistory(30)).toEqual([]);
    });

    it("returns snapshots within the window, oldest first", () => {
      const now = new Date();
      const iso = (daysAgo: number) =>
        new Date(now.getTime() - daysAgo * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");

      insertSnapshot("h_2", iso(2), 80, makeMetrics());
      insertSnapshot("h_10", iso(10), 75, makeMetrics());
      insertSnapshot("h_45", iso(45), 60, makeMetrics()); // outside 30-day window

      const history = getHealthHistory(30);
      expect(history.map((s) => s.id)).toEqual(["h_10", "h_2"]);
      expect(history[0].metrics.total_notes).toBe(100);
    });

    it("clamps the window to at least 1 day", () => {
      // Subqueries with days=0 would include nothing; ensure it doesn't throw
      const history = getHealthHistory(0);
      expect(history).toEqual([]);
    });
  });

  describe("getUnresolvedFlags", () => {
    it("returns only unresolved flags, most recent first", () => {
      insertFlag("flag_a", "duplicate_candidate", {
        source_path: "a.md",
        target_path: "b.md",
        details: { similarity: 0.87 },
        created_at: "2026-04-15T00:00:00Z",
      });
      insertFlag("flag_b", "long_orphan", {
        source_path: "c.md",
        created_at: "2026-04-18T00:00:00Z",
      });
      insertFlag("flag_c", "duplicate_candidate", {
        source_path: "d.md",
        target_path: "e.md",
        created_at: "2026-04-10T00:00:00Z",
        resolved_at: "2026-04-11T00:00:00Z",
      });

      const flags = getUnresolvedFlags();
      expect(flags.map((f) => f.id)).toEqual(["flag_b", "flag_a"]);
      expect(flags[1].details).toEqual({ similarity: 0.87 });
      // Schema requires details NOT NULL — absent details stored as '{}'
      expect(flags[0].details).toEqual({});
    });
  });

  describe("resolveFlag", () => {
    it("marks an unresolved flag as resolved and returns true", () => {
      insertFlag("flag_x", "cluster_island", { source_path: "x.md" });
      expect(resolveFlag("flag_x")).toBe(true);

      const row = getDb()
        .prepare("SELECT resolved_at FROM graph_health_flags WHERE id = ?")
        .get("flag_x") as { resolved_at: string | null };
      expect(row.resolved_at).not.toBeNull();

      // The same flag is no longer in the unresolved list
      expect(getUnresolvedFlags().map((f) => f.id)).not.toContain("flag_x");
    });

    it("returns false for a flag that does not exist", () => {
      expect(resolveFlag("flag_missing")).toBe(false);
    });

    it("returns false for a flag that was already resolved", () => {
      insertFlag("flag_y", "duplicate_candidate", {
        source_path: "y.md",
        resolved_at: "2026-04-19T00:00:00Z",
      });
      expect(resolveFlag("flag_y")).toBe(false);
    });
  });
});

// Best-effort cleanup of the temp DB dir
process.on("exit", () => {
  try { rmSync(SUITE_DIR, { recursive: true, force: true }); } catch {}
});

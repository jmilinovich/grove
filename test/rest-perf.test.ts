import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock external side-effects that handleStatusPerf's callees might touch.
vi.mock("../src/vault-ops.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault-ops.js")>();
  return {
    ...actual,
    gitCommit: vi.fn().mockResolvedValue("abc123"),
    qmdReindex: vi.fn().mockResolvedValue(undefined),
    gitPush: vi.fn().mockResolvedValue(undefined),
  };
});

let tempVault: string;

beforeEach(() => {
  tempVault = mkdtempSync(join(tmpdir(), "grove-perf-"));
  process.env.GROVE_VAULT = tempVault;
  process.env.GROVE_DB_PATH = join(tempVault, "grove.db");
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.GROVE_VAULT;
  delete process.env.GROVE_DB_PATH;
  rmSync(tempVault, { recursive: true, force: true });
});

async function loadRest() {
  vi.resetModules();
  const db = await import("../src/db.js");
  db.resetDb();
  db.createSchema();
  return import("../src/rest.js");
}

describe("handleStatusPerf", () => {
  it("returns the expected top-level shape", async () => {
    const { handleStatusPerf } = await loadRest();
    const result = await handleStatusPerf();

    expect(result).toHaveProperty("uptime_seconds");
    expect(result).toHaveProperty("total_requests");
    expect(result).toHaveProperty("total_errors");
    expect(result).toHaveProperty("error_rate");
    expect(result).toHaveProperty("tools");
    expect(result).toHaveProperty("search");
    expect(result).toHaveProperty("write_queue");
    expect(result).toHaveProperty("discovery");
    expect(result).toHaveProperty("window_ms");
  });

  it("reports an empty tools map when no requests have been recorded", async () => {
    const { handleStatusPerf } = await loadRest();
    const result = await handleStatusPerf();
    expect(result.tools).toEqual({});
  });

  it("reports zero write-queue depth when idle", async () => {
    const { handleStatusPerf } = await loadRest();
    const result = await handleStatusPerf();
    const wq = result.write_queue as Record<string, unknown>;
    expect(wq.depth).toBe(0);
    expect(wq.oldest_queued_age_ms).toBe(0);
  });

  it("reflects tool-latency samples recorded on the metrics singleton", async () => {
    const { handleStatusPerf } = await loadRest();
    const { metrics } = await import("../src/metrics.js");

    metrics.record("query", 12, false);
    metrics.record("query", 24, false);
    metrics.record("query", 300, true);

    const result = await handleStatusPerf();
    const tools = result.tools as Record<string, Record<string, unknown>>;
    expect(tools.query).toBeDefined();
    expect(tools.query!.count).toBe(3);
    expect(tools.query!.errors).toBe(1);
    // p50 of [12, 24, 300] with our percentile impl (ceil(n*p)-1) → 24
    expect(tools.query!.latency_p50).toBe(24);
  });

  it("reports discovery.queue_depth and last_processed_at keys", async () => {
    const { handleStatusPerf } = await loadRest();
    const result = await handleStatusPerf();
    const d = result.discovery as Record<string, unknown>;
    expect(d).toHaveProperty("queue_depth");
    expect(d).toHaveProperty("last_processed_at");
    expect(typeof d.queue_depth).toBe("number");
  });
});

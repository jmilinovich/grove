import { describe, it, expect } from "vitest";
import {
  buildWatchdogReport,
  extractEcosystemNames,
} from "../src/admin-watchdog.js";

describe("admin-watchdog", () => {
  const FIXED_NOW = new Date("2026-05-15T03:30:00Z");
  const baseOpts = {
    now: () => FIXED_NOW,
    readEcosystem: () => `module.exports = {
      apps: [
        { name: "grove-proxy", script: "/bin/bash" },
        { name: "grove-server-personal", script: "/bin/bash" },
        { name: "grove-discovery-personal", script: "/bin/bash" },
        { name: "grove-scheduler-personal", script: "/bin/bash" },
      ]
    };`,
    diskCheck: () => ({ root_used_pct: 42, root_available_kb: 25_000_000 }),
    logStatIso: () => "2026-05-15T03:25:00Z",
  };

  it("transforms pm2 jlist into a clean shape", () => {
    const jlist = [
      {
        name: "grove-proxy",
        pm_id: 11,
        pm2_env: {
          status: "online",
          restart_time: 5,
          unstable_restarts: 0,
          pm_uptime: FIXED_NOW.getTime() - 60_000, // started 60s ago
        },
        monit: { memory: 100 * 1024 * 1024, cpu: 2 },
      },
    ];
    const r = buildWatchdogReport({ ...baseOpts, pm2Jlist: () => jlist });

    expect(r.pm2).toHaveLength(1);
    expect(r.pm2[0].name).toBe("grove-proxy");
    expect(r.pm2[0].status).toBe("online");
    expect(r.pm2[0].uptime_ms).toBe(60_000);
    expect(r.pm2[0].memory_bytes).toBe(100 * 1024 * 1024);
    expect(r.pm2[0].out_log_mtime_iso).toBe("2026-05-15T03:25:00Z");
    expect(r.ran_at).toBe(FIXED_NOW.toISOString());
  });

  it("flags orphans: pm2 names not in the generated ecosystem", () => {
    const jlist = [
      // legit
      { name: "grove-proxy", pm_id: 0, pm2_env: { status: "online" }, monit: {} },
      // orphan — leftover from a removed vault, but ecosystem doesn't list it
      { name: "grove-server-deleted-vault", pm_id: 1, pm2_env: { status: "online" }, monit: {} },
    ];
    const r = buildWatchdogReport({ ...baseOpts, pm2Jlist: () => jlist });

    expect(r.ecosystem_names).toContain("grove-proxy");
    expect(r.ecosystem_names).not.toContain("grove-server-deleted-vault");
    expect(r.orphans).toEqual(["grove-server-deleted-vault"]);
  });

  it("returns 0 orphans when every pm2 process is in the ecosystem", () => {
    const jlist = [
      { name: "grove-proxy", pm_id: 0, pm2_env: { status: "online" }, monit: {} },
      { name: "grove-server-personal", pm_id: 1, pm2_env: { status: "online" }, monit: {} },
    ];
    const r = buildWatchdogReport({ ...baseOpts, pm2Jlist: () => jlist });
    expect(r.orphans).toEqual([]);
  });

  it("surfaces crash-loop signals: restart_time, unstable_restarts, uptime_ms", () => {
    // The shape the daily watchdog reads to decide "is this in a loop?".
    // Compare to today's incident: 1300+ restarts with uptime <5s.
    const jlist = [
      {
        name: "grove-scheduler-personal",
        pm_id: 18,
        pm2_env: {
          status: "online",
          restart_time: 1300,
          unstable_restarts: 16,
          pm_uptime: FIXED_NOW.getTime() - 2000, // 2s ago
        },
        monit: { memory: 80 * 1024 * 1024, cpu: 5 },
      },
    ];
    const r = buildWatchdogReport({ ...baseOpts, pm2Jlist: () => jlist });
    const p = r.pm2[0];
    expect(p.restart_time).toBe(1300);
    expect(p.unstable_restarts).toBe(16);
    expect(p.uptime_ms).toBe(2000);
  });

  it("handles a missing ecosystem file gracefully (empty names, every pm2 is orphan)", () => {
    const r = buildWatchdogReport({
      ...baseOpts,
      readEcosystem: () => null,
      pm2Jlist: () => [
        { name: "grove-proxy", pm_id: 0, pm2_env: { status: "online" }, monit: {} },
      ],
    });
    expect(r.ecosystem_names).toEqual([]);
    expect(r.orphans).toEqual(["grove-proxy"]);
  });

  it("handles missing log files (statSync ENOENT) by returning null mtimes", () => {
    const r = buildWatchdogReport({
      ...baseOpts,
      pm2Jlist: () => [
        { name: "grove-proxy", pm_id: 0, pm2_env: { status: "online" }, monit: {} },
      ],
      logStatIso: () => null,
    });
    expect(r.pm2[0].out_log_mtime_iso).toBeNull();
    expect(r.pm2[0].err_log_mtime_iso).toBeNull();
  });

  it("extractEcosystemNames: pulls names from CommonJS-ish text via regex (no eval)", () => {
    const text = `module.exports = {
      apps: [
        { name: "grove-proxy" },
        { name: 'grove-server-personal' },
        { name: "grove-discovery-personal" },
      ]
    };`;
    expect(extractEcosystemNames(text)).toEqual([
      "grove-proxy",
      "grove-server-personal",
      "grove-discovery-personal",
    ]);
  });

  it("extractEcosystemNames: ignores other 'name:' keys that aren't app names", () => {
    // The generator may emit nested name fields somewhere (e.g., env_static
    // would not, but be defensive). Today the only `name:` field at any
    // depth in the generated CommonJS is the app name, so this asserts
    // current behavior.
    const text = `module.exports = { apps: [{ name: "grove-proxy", env: {} }] };`;
    expect(extractEcosystemNames(text)).toEqual(["grove-proxy"]);
  });
});

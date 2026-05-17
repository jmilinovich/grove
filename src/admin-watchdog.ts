/**
 * Admin watchdog endpoint — exposes PM2 + disk + ecosystem state behind
 * the existing admin auth so the daily `/grove:watchdog` routine can
 * spot crash loops, orphan processes, stuck schedulers, etc. without
 * needing SSH to prod.
 *
 * Lives in its own module so the proxy.ts handler can stay thin and so
 * tests can inject the three sources (pm2 jlist, ecosystem file, df)
 * instead of shelling out.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

export interface WatchdogProcess {
  name: string;
  pm_id: number;
  status: string;
  restart_time: number;
  unstable_restarts: number;
  uptime_ms: number;
  memory_bytes: number;
  cpu_percent: number;
  out_log_mtime_iso: string | null;
  err_log_mtime_iso: string | null;
}

export interface WatchdogReport {
  ran_at: string;
  pm2: WatchdogProcess[];
  ecosystem_names: string[];
  orphans: string[];
  disk: { root_used_pct: number; root_available_kb: number };
}

export interface BuildOpts {
  pm2Jlist?: () => unknown[];
  readEcosystem?: () => string | null;
  diskCheck?: () => { root_used_pct: number; root_available_kb: number };
  logStatIso?: (path: string) => string | null;
  now?: () => Date;
}

const DEFAULT_ECOSYSTEM_PATH = "/root/grove/ecosystem.runtime.config.cjs";
const DEFAULT_PM2_LOG_DIR = "/root/.pm2/logs";

export function buildWatchdogReport(opts: BuildOpts = {}): WatchdogReport {
  const now = opts.now?.() ?? new Date();
  const pm2Raw = opts.pm2Jlist?.() ?? defaultPm2Jlist();
  const ecoText = opts.readEcosystem?.() ?? defaultReadEcosystem();
  const disk = opts.diskCheck?.() ?? defaultDiskCheck();
  const logStat = opts.logStatIso ?? defaultLogStatIso;

  const ecosystem_names = ecoText ? extractEcosystemNames(ecoText) : [];
  const ecosystem_set = new Set(ecosystem_names);

  const pm2: WatchdogProcess[] = [];
  const orphans: string[] = [];

  for (const raw of pm2Raw) {
    const p = raw as Record<string, unknown>;
    const env = (p["pm2_env"] ?? {}) as Record<string, unknown>;
    const monit = (p["monit"] ?? {}) as Record<string, unknown>;
    const name = String(p["name"] ?? "");
    if (!name) continue;

    const status = String(env["status"] ?? "unknown");
    const restart_time = Number(env["restart_time"] ?? 0);
    const unstable_restarts = Number(env["unstable_restarts"] ?? 0);
    const pm_uptime = Number(env["pm_uptime"] ?? 0);
    const uptime_ms = pm_uptime > 0 ? Math.max(0, now.getTime() - pm_uptime) : 0;

    pm2.push({
      name,
      pm_id: Number(p["pm_id"] ?? -1),
      status,
      restart_time,
      unstable_restarts,
      uptime_ms,
      memory_bytes: Number(monit["memory"] ?? 0),
      cpu_percent: Number(monit["cpu"] ?? 0),
      out_log_mtime_iso: logStat(`${DEFAULT_PM2_LOG_DIR}/${name}-out.log`),
      err_log_mtime_iso: logStat(`${DEFAULT_PM2_LOG_DIR}/${name}-error.log`),
    });

    if (!ecosystem_set.has(name)) orphans.push(name);
  }

  return {
    ran_at: now.toISOString(),
    pm2,
    ecosystem_names,
    orphans,
    disk,
  };
}

// Match `name: "..."` or `name: '...'` — the generated ecosystem uses
// JSON-ish output where each app object has a `name` field. We don't
// require()/eval the file (avoids running attacker-controlled code if
// the file is ever compromised).
export function extractEcosystemNames(text: string): string[] {
  const out: string[] = [];
  const re = /name:\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

function defaultPm2Jlist(): unknown[] {
  const out = execFileSync("pm2", ["jlist"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 5000,
  });
  return JSON.parse(out) as unknown[];
}

function defaultReadEcosystem(): string | null {
  if (!existsSync(DEFAULT_ECOSYSTEM_PATH)) return null;
  return readFileSync(DEFAULT_ECOSYSTEM_PATH, "utf8");
}

function defaultDiskCheck(): { root_used_pct: number; root_available_kb: number } {
  // `df -P /` is POSIX-portable: 1024-byte blocks, single fixed line.
  // Output:
  //   Filesystem     1024-blocks    Used Available Capacity Mounted on
  //   /dev/root         50305476 9876512  37750580      21% /
  const out = execFileSync("df", ["-P", "/"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const lines = out.split("\n").filter((l) => l.trim());
  const last = lines[lines.length - 1] ?? "";
  const parts = last.split(/\s+/);
  // Capacity is the 5th column, with a trailing `%`.
  const pct = Number((parts[4] ?? "0").replace("%", ""));
  const avail = Number(parts[3] ?? "0");
  return {
    root_used_pct: Number.isFinite(pct) ? pct : 0,
    root_available_kb: Number.isFinite(avail) ? avail : 0,
  };
}

function defaultLogStatIso(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

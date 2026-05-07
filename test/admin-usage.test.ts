// Admin usage dashboard — pure aggregation logic. We feed UsageInputs
// directly so the tests don't need a real sqlite or log file; the
// loadUsageInputs() helper that bridges to those is exercised in the
// proxy integration test path.

import { describe, it, expect } from "vitest";
import {
  aggregateUsage,
  parseLogEvents,
  renderUsageHtml,
  sparkline,
  type UsageInputs,
} from "../src/admin-usage.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const NOW = new Date("2026-05-07T12:00:00Z");

function makeInputs(events: { ts: string; key_name: string; msg: string; tool: string }[]): UsageInputs {
  return {
    users: [
      { id: "u_john", email: "jrmilinovich@gmail.com", role: "owner" },
      { id: "u_sumon", email: "modernmedici88@gmail.com", role: "viewer" },
      { id: "u_ryan", email: "ryan.p.parker@gmail.com", role: "viewer" },
    ],
    vaults: [
      { id: "v_personal", slug: "personal", owner_id: "u_john", git_repo_path: "/p" },
      { id: "v_test", slug: "test-vault", owner_id: "u_john", git_repo_path: "/t" },
      { id: "v_sharp", slug: "sharpshoot", owner_id: "u_sumon", git_repo_path: "/sh" },
      { id: "v_ryan", slug: "ryan", owner_id: "u_ryan", git_repo_path: "/r" },
    ],
    keys: [
      { name: "jm-cli", vault_id: "v_personal", user_id: "u_john", created_at: "", last_used_at: null },
      { name: "smoke-prod", vault_id: "v_test", user_id: "u_john", created_at: "", last_used_at: null },
      { name: "sumon-cli", vault_id: "v_sharp", user_id: "u_sumon", created_at: "", last_used_at: null },
    ],
    events,
    contentByVaultSlug: new Map(),
    logRange: { earliest: "2026-04-01T00:00:00Z", latest: NOW.toISOString() },
  };
}

describe("aggregateUsage", () => {
  it("attributes events to the right user/vault via key_name", () => {
    const summary = aggregateUsage(makeInputs([
      { ts: "2026-05-07T11:00:00Z", key_name: "jm-cli", msg: "mcp.request", tool: "query" },
      { ts: "2026-05-07T11:30:00Z", key_name: "sumon-cli", msg: "mcp.request", tool: "get" },
    ]), NOW);
    const john = summary.users.find((u) => u.label === "john");
    const sumon = summary.users.find((u) => u.label === "sumon");
    expect(john?.vaults.find((v) => v.slug === "personal")?.requests["24h"]).toBe(1);
    expect(sumon?.vaults.find((v) => v.slug === "sharpshoot")?.requests["24h"]).toBe(1);
  });

  it("classifies handshake separately from real reads/writes", () => {
    const summary = aggregateUsage(makeInputs([
      // handshake noise
      { ts: "2026-05-07T11:00:00Z", key_name: "jm-cli", msg: "mcp.request", tool: "initialize" },
      { ts: "2026-05-07T11:00:01Z", key_name: "jm-cli", msg: "mcp.request", tool: "tools/list" },
      { ts: "2026-05-07T11:00:02Z", key_name: "jm-cli", msg: "mcp.request", tool: "GET" },
      // real work
      { ts: "2026-05-07T11:01:00Z", key_name: "jm-cli", msg: "mcp.request", tool: "query" },
      { ts: "2026-05-07T11:02:00Z", key_name: "jm-cli", msg: "rest.put_note", tool: "rest.put_note" },
    ]), NOW);
    const personal = summary.users.find((u) => u.label === "john")!.vaults.find((v) => v.slug === "personal")!;
    expect(personal.handshake_7d).toBe(3);
    expect(personal.real_reads_7d).toBe(1);
    expect(personal.real_writes_7d).toBe(1);
  });

  it("respects 24h / 7d / 30d windows", () => {
    const events = [
      // 1h ago — counts in all three
      { ts: "2026-05-07T11:00:00Z", key_name: "jm-cli", msg: "mcp.request", tool: "query" },
      // 3 days ago — counts in 7d + 30d only
      { ts: "2026-05-04T12:00:00Z", key_name: "jm-cli", msg: "mcp.request", tool: "query" },
      // 20 days ago — counts in 30d only
      { ts: "2026-04-17T12:00:00Z", key_name: "jm-cli", msg: "mcp.request", tool: "query" },
      // 60 days ago — outside all windows
      { ts: "2026-03-08T12:00:00Z", key_name: "jm-cli", msg: "mcp.request", tool: "query" },
    ];
    const summary = aggregateUsage(makeInputs(events), NOW);
    const v = summary.users.find((u) => u.label === "john")!.vaults.find((vv) => vv.slug === "personal")!;
    expect(v.requests["24h"]).toBe(1);
    expect(v.requests["7d"]).toBe(2);
    expect(v.requests["30d"]).toBe(3);
  });

  it("collects unattributed (revoked) keys with recent activity", () => {
    const summary = aggregateUsage(makeInputs([
      { ts: "2026-05-07T11:00:00Z", key_name: "jm-cli", msg: "mcp.request", tool: "query" },
      { ts: "2026-05-07T11:01:00Z", key_name: "old-revoked-key", msg: "mcp.request", tool: "query" },
      { ts: "2026-05-07T11:02:00Z", key_name: "old-revoked-key", msg: "mcp.request", tool: "query" },
    ]), NOW);
    expect(summary.unattributed_recent_keys).toEqual([
      { name: "old-revoked-key", recent_count: 2 },
    ]);
  });

  it("sorts users by 7d total descending", () => {
    const events = [
      { ts: "2026-05-07T11:00:00Z", key_name: "sumon-cli", msg: "mcp.request", tool: "query" },
      { ts: "2026-05-07T11:00:01Z", key_name: "jm-cli", msg: "mcp.request", tool: "query" },
      { ts: "2026-05-07T11:00:02Z", key_name: "jm-cli", msg: "mcp.request", tool: "query" },
      { ts: "2026-05-07T11:00:03Z", key_name: "jm-cli", msg: "mcp.request", tool: "query" },
    ];
    const summary = aggregateUsage(makeInputs(events), NOW);
    expect(summary.users.map((u) => u.label).slice(0, 2)).toEqual(["john", "sumon"]);
  });

  it("daily_30d returns 30 entries oldest-first with zero-filled gaps", () => {
    const summary = aggregateUsage(makeInputs([
      { ts: "2026-05-07T11:00:00Z", key_name: "jm-cli", msg: "mcp.request", tool: "query" },
      { ts: "2026-05-01T11:00:00Z", key_name: "jm-cli", msg: "mcp.request", tool: "query" },
      { ts: "2026-05-01T11:01:00Z", key_name: "jm-cli", msg: "mcp.request", tool: "query" },
    ]), NOW);
    const personal = summary.users.find((u) => u.label === "john")!.vaults.find((v) => v.slug === "personal")!;
    expect(personal.daily_30d).toHaveLength(30);
    expect(personal.daily_30d[0].day).toBe("2026-04-08");
    expect(personal.daily_30d[29].day).toBe("2026-05-07");
    expect(personal.daily_30d.find((d) => d.day === "2026-05-01")?.count).toBe(2);
    expect(personal.daily_30d.find((d) => d.day === "2026-05-07")?.count).toBe(1);
  });
});

describe("parseLogEvents", () => {
  it("parses JSON lines and extracts ts / key_name / msg / tool", () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-usage-log-"));
    const path = join(dir, "log.txt");
    writeFileSync(
      path,
      [
        // valid mcp.request
        '{"ts":"2026-05-07T11:00:00.000Z","msg":"mcp.request","key_name":"jm-cli","tool":"query"}',
        // valid rest.get_note
        '{"ts":"2026-05-07T11:01:00.000Z","msg":"rest.get_note","key_name":"jm-cli"}',
        // mcp.request with mcp_method but no tool
        '{"ts":"2026-05-07T11:02:00.000Z","msg":"mcp.request","key_name":"jm-cli","mcp_method":"initialize","tool":null}',
        // missing key_name — skipped
        '{"ts":"2026-05-07T11:03:00.000Z","msg":"auth.missing"}',
        // non-json line — skipped
        "not a json line",
        // empty line — skipped
        "",
      ].join("\n"),
    );
    const { events, logRange } = parseLogEvents(path);
    rmSync(dir, { recursive: true, force: true });
    expect(events).toHaveLength(3);
    expect(events[0].tool).toBe("query");
    expect(events[1].tool).toBe("rest.get_note"); // falls back to msg when no tool
    expect(events[2].tool).toBe("initialize"); // falls back to mcp_method
    expect(logRange.earliest).toBe("2026-05-07T11:00:00.000Z");
    expect(logRange.latest).toBe("2026-05-07T11:02:00.000Z");
  });

  it("returns empty result for missing file", () => {
    const { events, logRange } = parseLogEvents("/no/such/path/log.txt");
    expect(events).toEqual([]);
    expect(logRange).toEqual({ earliest: null, latest: null });
  });
});

describe("renderUsageHtml", () => {
  it("produces HTML with one row per (user, vault) pair", () => {
    const summary = aggregateUsage(makeInputs([
      { ts: "2026-05-07T11:00:00Z", key_name: "jm-cli", msg: "mcp.request", tool: "query" },
      { ts: "2026-05-07T11:01:00Z", key_name: "sumon-cli", msg: "mcp.request", tool: "get" },
    ]), NOW);
    const html = renderUsageHtml(summary);
    expect(html).toContain("<title>Grove · Usage</title>");
    expect(html).toContain("john");
    expect(html).toContain("sumon");
    expect(html).toContain("personal");
    expect(html).toContain("sharpshoot");
  });

  it("escapes user-supplied content (key names, emails) safely", () => {
    const inputs = makeInputs([
      { ts: "2026-05-07T11:00:00Z", key_name: "<script>alert(1)</script>", msg: "mcp.request", tool: "query" },
    ]);
    const summary = aggregateUsage(inputs, NOW);
    const html = renderUsageHtml(summary);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("sparkline", () => {
  it("maps a single max value to a full block", () => {
    expect(sparkline([5]).split("")).toEqual(["█"]);
  });
  it("maps zeroes to the lowest block", () => {
    expect(sparkline([0, 0, 0])).toBe("▁▁▁");
  });
  it("scales relative to max", () => {
    const s = sparkline([0, 1, 2, 4, 8]);
    expect(s).toHaveLength(5);
    expect(s[0]).toBe("▁");
    expect(s[4]).toBe("█");
  });
});

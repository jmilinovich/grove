#!/usr/bin/env tsx
/**
 * Eval 4a: context-byte budget per command.
 *
 * Each command has a ceiling on default-output stdout bytes. Agents consume
 * stdout as prompt context, so regressions in output size hurt them directly.
 *
 * Gate: every command at default settings must produce stdout <= its ceiling.
 * Over-ceiling = fail. Exit 1 if any fail.
 */

import { spawnStub, runCli, reportHeader, pass, fail } from "./_eval-harness.js";

interface Budget {
  name: string;
  args: string[];
  ceiling_bytes: number;
  route_key?: string;
  route_body?: unknown;
}

// Fixture payloads (kept modest so ceilings are meaningful).
const FIXTURES = {
  whoami: { key_id: "key_123", key_name: "test", scopes: ["read", "write"], vault_id: "life" },
  list_small: {
    entries: Array.from({ length: 25 }, (_, i) => ({
      path: `Resources/People/Person-${String(i).padStart(2, "0")}.md`,
      type: "person",
      modified_at: "2026-01-01T00:00:00Z",
    })),
    count: 25,
  },
  search: {
    results: Array.from({ length: 10 }, (_, i) => ({
      path: `Resources/Concepts/Concept-${i}.md`,
      title: `Concept ${i}`,
      score: 0.9 - i * 0.05,
      snippet: `A modest-length snippet about concept ${i} — under 120 characters.`,
    })),
    count: 10,
  },
  health: { ok: true, checks: { proxy: true, "grove-server": true, embed: true } },
  stats: {
    vault: { total_notes: 1083, total_bytes: 5_200_000 },
    freshness: { stale_days: 3 },
    graph: { total_nodes: 1083, total_edges: 4211 },
  },
};

const BUDGETS: Budget[] = [
  { name: "whoami", args: ["whoami", "--format", "json"], ceiling_bytes: 600, route_key: "GET /v1/whoami", route_body: FIXTURES.whoami },
  { name: "health", args: ["health", "--format", "json"], ceiling_bytes: 500, route_key: "GET /health", route_body: FIXTURES.health },
  { name: "list (25 items)", args: ["list", "Resources/People/", "--format", "json"], ceiling_bytes: 4000, route_key: "GET /v1/list", route_body: FIXTURES.list_small },
  { name: "search (10 results)", args: ["search", "concept", "--format", "json"], ceiling_bytes: 3000, route_key: "GET /v1/search", route_body: FIXTURES.search },
  { name: "status", args: ["status", "--format", "json"], ceiling_bytes: 2000, route_key: "GET /v1/stats", route_body: FIXTURES.stats },
];

async function main(): Promise<void> {
  reportHeader("eval/budget");

  // Collect all routes so a single stub can serve every command.
  const routes: Record<string, { status: number; body: unknown }> = {};
  for (const b of BUDGETS) {
    if (b.route_key) routes[b.route_key] = { status: 200, body: b.route_body };
  }

  const stub = await spawnStub(routes);
  let failures = 0;
  const report: Record<string, { bytes: number; ceiling: number; pct: number; passed: boolean }> = {};

  for (const b of BUDGETS) {
    const r = await runCli(stub.configDir, b.args);
    const pct = Math.round((r.bytes / b.ceiling_bytes) * 100);
    report[b.name] = { bytes: r.bytes, ceiling: b.ceiling_bytes, pct, passed: r.bytes <= b.ceiling_bytes && r.exit === 0 };
    if (r.exit !== 0) {
      fail(b.name, `exit=${r.exit} stderr=${r.stderr.slice(0, 200)}`);
      failures++;
    } else if (r.bytes > b.ceiling_bytes) {
      fail(b.name, `${r.bytes} bytes > ${b.ceiling_bytes} ceiling (${pct}%)`);
      failures++;
    } else {
      pass(`${b.name}: ${r.bytes}/${b.ceiling_bytes} bytes (${pct}%)`);
    }
  }

  await stub.close();

  process.stdout.write(`\n  summary: ${BUDGETS.length - failures}/${BUDGETS.length} within budget\n`);
  process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`eval/budget crashed: ${e}\n`);
  process.exit(2);
});

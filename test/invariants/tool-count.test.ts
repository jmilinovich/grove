/**
 * Architecture rule #6 — keep MCP tool count bounded.
 *
 * From CLAUDE.md: "Current count: 6. The original rule said ≤6 because
 * selection degrades past ~10 — 2026 benchmarks showed the real cliff
 * is around 50 tools. The value of the rule was never the number 6
 * specifically; it was tool overlap risk... If count climbs past 12,
 * stop and reconsider the design."
 *
 * This test trips when src/server.ts grows past 12 registerTool calls.
 * The threshold is intentionally loose (12, not 6) — adding a 7th tool
 * is fine if it earns its slot. The point is to force a design review
 * once we cross the cliff into selection-degradation territory.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("architecture invariant: MCP tool count", () => {
  it("server.ts registers no more than 12 MCP tools", () => {
    const source = readFileSync(join(process.cwd(), "src/server.ts"), "utf8");
    const count = (source.match(/server\.registerTool\(/g) ?? []).length;
    expect(count).toBeGreaterThan(0);
    expect(
      count,
      `server.ts registers ${count} MCP tools — past 12 the model's tool selection ` +
        `quality degrades enough to warrant a design review (CLAUDE.md rule #6).`,
    ).toBeLessThanOrEqual(12);
  });

  it("CLAUDE.md tool-count comment matches src/server.ts", () => {
    const source = readFileSync(join(process.cwd(), "src/server.ts"), "utf8");
    const count = (source.match(/server\.registerTool\(/g) ?? []).length;
    // Look for the "X tools registered" log line that documents the count
    const logMatch = source.match(/(\d+)\s+tools registered:/);
    expect(logMatch, "expected `N tools registered:` log line in server.ts").not.toBeNull();
    expect(
      Number(logMatch![1]),
      `the 'N tools registered' log line says ${logMatch![1]} but ${count} tools are actually registered`,
    ).toBe(count);
  });
});

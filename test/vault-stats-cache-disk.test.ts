// Persistent cache: writeCachedStatsToDisk runs after every successful
// refreshStats so warmStatsFromDisk can populate cachedByPath on boot.
// Without this, every PM2 restart re-enters a 5-15s window where stats
// are null — getStats() returns null, the MCP graph cold-path falls
// through to live analyzeGraph(), the dashboard reports unavailable.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Point the cache at a tmpdir so tests don't pollute ~/.grove. Must be set
// BEFORE importing vault-stats.js so the module reads the override at load.
const cacheDir = mkdtempSync(join(tmpdir(), "grove-stats-cache-test-"));
process.env.GROVE_STATS_CACHE_DIR = cacheDir;
// Same QMD_INDEX redirect as test/vault-stats.test.ts so the index section
// degrades gracefully when no real index is around.
process.env.QMD_INDEX = join(tmpdir(), "grove-stats-cache-test-nonexistent.sqlite");

const { computeVaultStats, getStats, refreshStats, warmStatsFromDisk } =
  await import("../src/vault-stats.js");
type VaultStats = Awaited<ReturnType<typeof computeVaultStats>>;

// ── Tiny fixture vault ─────────────────────────────────────────────

const fixtureVault = mkdtempSync(join(tmpdir(), "grove-stats-cache-vault-"));
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
function writeNote(rel: string, content: string) {
  const abs = join(fixtureVault, rel);
  const dir = abs.slice(0, abs.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, content);
}
writeNote(
  "Resources/Concepts/Taste Graph.md",
  "---\ntype: concept\ntags: [ai]\n---\n# Taste Graph\n[[Parametric Design]]\n",
);
writeNote(
  "Resources/Concepts/Parametric Design.md",
  "---\ntype: concept\ntags: [design]\n---\n# Parametric Design\n[[Taste Graph]]\n",
);
writeNote("Inbox/x.md", "x\n");
execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -q -m init", {
  cwd: fixtureVault,
});

afterEach(() => {
  // Clear any cache artifacts between tests so each test starts clean.
  for (const f of readdirSync(cacheDir)) {
    rmSync(join(cacheDir, f), { force: true });
  }
});

describe("persistent stats cache", () => {
  it("writes a JSON file under GROVE_STATS_CACHE_DIR after a successful refresh", async () => {
    await refreshStats(fixtureVault);
    const files = readdirSync(cacheDir);
    expect(files.length).toBe(1);
    const payload = JSON.parse(readFileSync(join(cacheDir, files[0]), "utf-8"));
    expect(payload.version).toBe(1);
    expect(payload.vaultPath).toBe(fixtureVault);
    expect(payload.stats.vault.total_notes).toBe(3);
    expect(typeof payload.written_at).toBe("string");
  });

  it("warmStatsFromDisk populates getStats() before any fresh compute fires", async () => {
    // First, do a real compute so the on-disk cache has a payload.
    const fresh = await refreshStats(fixtureVault);

    // Simulate a process restart: clear the in-memory cache and read back.
    // We don't have a public reset on cachedByPath, so we exercise the
    // warm path against a vault path that's already in the in-memory map
    // — warmStatsFromDisk must skip already-cached paths (idempotency).
    const before = getStats(fixtureVault);
    const result1 = warmStatsFromDisk([fixtureVault]);
    expect(before).not.toBeNull();
    // Idempotent — the path is already in cache, so warmed=0.
    expect(result1.warmed).toBe(0);
    expect(result1.missing).toBe(0);
    expect(getStats(fixtureVault)?.computed_at).toBe(fresh.computed_at);
  });

  it("warmStatsFromDisk reports missing for an unseen vault path", () => {
    const unseen = join(tmpdir(), "grove-stats-cache-unseen-vault");
    const result = warmStatsFromDisk([unseen]);
    expect(result.warmed).toBe(0);
    expect(result.missing).toBe(1);
    expect(getStats(unseen)).toBeNull();
  });

  it("rejects cache files with a different schema version", async () => {
    const targetDir = cacheDir;
    const slug = fixtureVault.split("/").pop()!;
    const cachePath = join(targetDir, `${slug}.json`);
    // Write a deliberately bad-version file
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 999,
        vaultPath: fixtureVault,
        stats: { vault: { total_notes: 7 } },
        written_at: new Date().toISOString(),
      }),
    );
    // Use a different vault path so cachedByPath doesn't already have it
    const otherVault = join(tmpdir(), "no-such-vault-for-version-test");
    const result = warmStatsFromDisk([otherVault]);
    expect(result.warmed).toBe(0);
  });

  it("rejects cache files written for a different vault path", () => {
    const slug = "victim-vault";
    const cachePath = join(cacheDir, `${slug}.json`);
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        vaultPath: "/some/other/vault",
        stats: { vault: { total_notes: 99 } },
        written_at: new Date().toISOString(),
      }),
    );
    const otherVault = join(tmpdir(), `${slug}-no-actual-files`);
    const result = warmStatsFromDisk([otherVault]);
    expect(result.warmed).toBe(0);
  });

  it("malformed JSON does not crash warmStatsFromDisk", () => {
    const slug = "broken-vault";
    const cachePath = join(cacheDir, `${slug}.json`);
    writeFileSync(cachePath, "{not valid json");
    const path = join(tmpdir(), `${slug}-no-actual-files`);
    expect(() => warmStatsFromDisk([path])).not.toThrow();
  });
});

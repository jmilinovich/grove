import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

/**
 * Cross-process serialization test for runMigration().
 *
 * On 2026-04-28 we observed `SQLITE_BUSY at migrateMultiVault` when 4×
 * grove-server-<slug> + grove-proxy + grove-discovery-<slug> processes
 * all booted at once and called runMigration() against the same db.
 * Each lost race throws → PM2 restarts → same race → restart loop.
 *
 * Fix: getDb() sets busy_timeout=5000, runMigration() wraps the body in
 * BEGIN IMMEDIATE, _migration_state gates re-runs once the leader
 * commits. This test spawns N child processes that hammer the same db
 * file concurrently and asserts (a) all exit 0, (b) the resulting db is
 * structurally valid, (c) only one process actually wrote the version
 * stamp (best-effort — the others either short-circuited or no-op'd).
 */
describe("migration concurrency (cross-process serialization)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-migrate-conc-"));
    dbPath = join(tempDir, "grove.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function spawnMigrator(): Promise<{ code: number; stderr: string }> {
    return new Promise((resolve) => {
      const fixture = join(__dirname, "fixtures", "run-migration-and-exit.ts");
      const child = spawn("npx", ["tsx", fixture], {
        env: {
          ...process.env,
          GROVE_DB_PATH: dbPath,
          // Avoid polluting test output — runMigration() logs to console
          // on fresh-install paths.
          NODE_ENV: "test",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("exit", (code) => resolve({ code: code ?? 1, stderr }));
    });
  }

  it("runs 5 concurrent migrations without SQLITE_BUSY", async () => {
    // Spawn all 5 in the same tick — closest we can get to the real
    // pm2-reload-storm startup pattern without standing up grove-server.
    const results = await Promise.all([
      spawnMigrator(),
      spawnMigrator(),
      spawnMigrator(),
      spawnMigrator(),
      spawnMigrator(),
    ]);

    const failures = results.filter((r) => r.code !== 0);
    if (failures.length > 0) {
      throw new Error(
        `${failures.length}/5 migrators failed:\n${failures.map((f) => f.stderr).join("\n---\n")}`,
      );
    }

    // No "SQLITE_BUSY" or "database is locked" anywhere in stderr.
    for (const r of results) {
      expect(r.stderr).not.toMatch(/SQLITE_BUSY|database is locked/i);
    }

    // Db is structurally valid: schema_version stamped, vaults table
    // populated with the default vault, _migration_state has exactly
    // one row.
    const db = new Database(dbPath, { readonly: true });
    try {
      const state = db
        .prepare("SELECT id, schema_version FROM _migration_state")
        .all() as Array<{ id: number; schema_version: number }>;
      expect(state).toHaveLength(1);
      expect(state[0].id).toBe(1);
      expect(state[0].schema_version).toBeGreaterThan(0);

      const vault = db
        .prepare("SELECT slug FROM vaults WHERE id = ?")
        .get("vault_00000000") as { slug: string } | undefined;
      expect(vault?.slug).toBe("personal");

      // The concurrent IMMEDIATE-mode tx + sentinel gate means the
      // schema is single-writer-coherent; no partial-rebuild artefacts
      // from the destructive shared_links / discovery_queue paths.
      const fkErrors = db.prepare("PRAGMA foreign_key_check").all();
      expect(fkErrors).toEqual([]);
    } finally {
      db.close();
    }
  }, 30_000); // 30s — child spawn + npx warmup is slow on cold caches

  it("second migrator short-circuits when version already stamped", async () => {
    // Run once to stamp the version.
    const first = await spawnMigrator();
    expect(first.code).toBe(0);

    // Read updated_at, run again, confirm updated_at didn't move
    // (because alreadyMigrated short-circuit skips the INSERT OR REPLACE).
    const dbBefore = new Database(dbPath, { readonly: true });
    const tsBefore = (
      dbBefore.prepare("SELECT updated_at FROM _migration_state").get() as { updated_at: string }
    ).updated_at;
    dbBefore.close();

    // Sleep 1.1s — datetime('now') has 1s resolution, so we need a gap
    // bigger than that to make a re-stamp visible if the gate failed.
    await new Promise((r) => setTimeout(r, 1100));

    const second = await spawnMigrator();
    expect(second.code).toBe(0);

    const dbAfter = new Database(dbPath, { readonly: true });
    const tsAfter = (
      dbAfter.prepare("SELECT updated_at FROM _migration_state").get() as { updated_at: string }
    ).updated_at;
    dbAfter.close();

    expect(tsAfter).toBe(tsBefore);
  }, 30_000);
});

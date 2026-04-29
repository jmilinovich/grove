/**
 * Test fixture: opens grove.db at GROVE_DB_PATH, runs the full migration,
 * closes, and exits 0. Spawned N×concurrently by
 * test/migration-concurrency.test.ts to exercise the IMMEDIATE-mode lock
 * without the noise of a real grove-server boot.
 */
import { runMigration, closeDb } from "../../src/db.js";

try {
  runMigration();
  closeDb();
  process.exit(0);
} catch (err) {
  console.error((err as Error).stack ?? String(err));
  process.exit(1);
}

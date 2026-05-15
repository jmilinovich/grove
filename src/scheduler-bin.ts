#!/usr/bin/env tsx
/**
 * Scheduler PM2 entry point (P23-1).
 *
 * One process per vault, pinned via `GROVE_VAULT_ID`. The PM2 ecosystem
 * generator (`src/ecosystem-gen.ts`) emits one `grove-scheduler-<slug>`
 * row per provisioned vault — mirrors `grove-discovery-<slug>`.
 *
 * Usage:
 *   pm2 start src/scheduler-bin.ts --interpreter tsx --name grove-scheduler-personal
 *   GROVE_VAULT_ID=vault_xxx GROVE_VAULT_SLUG=personal
 */

import { createSchema } from "./db.js";
import { getVaultDb, closeAllVaultDbs } from "./db-per-vault.js";
import { startScheduler, stopScheduler } from "./scheduler.js";

// Ensure control-db schema exists (idempotent — same call pattern as
// discovery-worker.ts). The per-vault state.db migration runs lazily on
// first `getVaultDb(vaultId)` call below.
createSchema();

const vaultId = process.env.GROVE_VAULT_ID;
if (!vaultId) {
  console.error(
    "[scheduler-bin] GROVE_VAULT_ID is required — refusing to run unpinned. " +
      "An unpinned scheduler would race siblings on the same task queue and " +
      "trigger cross-vault dispatches.",
  );
  process.exit(1);
}

// Touch the per-vault state.db so migrations apply before the loops
// start hitting it. Same trick the discovery worker uses indirectly
// through `recoverOrphanedDiscoveryProcessing`.
getVaultDb(vaultId);

void startScheduler(vaultId).catch((err) => {
  console.error(`[scheduler-bin] failed to start: ${(err as Error).message}`);
  process.exit(1);
});

let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[scheduler-bin] ${signal} received, stopping`);
    stopScheduler();
    try {
      closeAllVaultDbs();
    } catch (err) {
      console.error(
        `[scheduler-bin] closeAllVaultDbs error: ${(err as Error).message}`,
      );
    }
    process.exit(0);
  });
}

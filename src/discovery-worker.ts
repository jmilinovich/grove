#!/usr/bin/env tsx
/**
 * Discovery worker — PM2 entry point.
 *
 * Initializes the database, starts the discovery polling loop,
 * and handles graceful shutdown on SIGTERM/SIGINT.
 *
 * Usage:
 *   pm2 start src/discovery-worker.ts --interpreter tsx --name discovery
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { runMigration } from "./db.js";
import { startDiscoveryLoop, stopDiscoveryLoop } from "./discovery.js";
import {
  startHealthCronLoop,
  stopHealthCronLoop,
  DEFAULT_HEALTH_INTERVAL_MS,
} from "./graph-health.js";

// Ensure schema exists. runMigration wraps the body in BEGIN IMMEDIATE +
// busy_timeout so concurrent workers (4 discovery + 4 scheduler + 4
// server + proxy) serialize on cold start instead of racing destructive
// DROP/RENAME paths into SQLITE_BUSY.
runMigration();

// Per-vault binding. PM2 sets GROVE_VAULT_ID for every grove-discovery-*
// process via the generated ecosystem.config.cjs. If it's missing we fall
// back to the personal vault's id so legacy single-vault deployments keep
// working, but log loudly — in a multi-vault server, silence here would
// mean workers race on one another's queue entries.
const vaultId = process.env.GROVE_VAULT_ID ?? "vault_00000000";
const vaultPath = process.env.GROVE_VAULT ?? join(homedir(), "life");
if (!process.env.GROVE_VAULT_ID) {
  console.warn(
    "[discovery-worker] GROVE_VAULT_ID not set — defaulting to vault_00000000 " +
    "(personal). This is only safe in legacy single-vault setups.",
  );
}

console.log(`[discovery-worker] starting (vault_id=${vaultId}, path=${vaultPath})`);
startDiscoveryLoop(undefined, undefined, vaultId);

const healthIntervalMs = process.env.GROVE_HEALTH_INTERVAL_MS
  ? Number(process.env.GROVE_HEALTH_INTERVAL_MS)
  : DEFAULT_HEALTH_INTERVAL_MS;
startHealthCronLoop(vaultPath, {
  intervalMs: healthIntervalMs,
  runImmediately: true,
  vaultId,
});

// Graceful shutdown
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[discovery-worker] ${signal} received, stopping loops`);
    stopDiscoveryLoop();
    stopHealthCronLoop();
    process.exit(0);
  });
}

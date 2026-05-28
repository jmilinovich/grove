#!/usr/bin/env tsx
/**
 * Discovery worker — standalone entry point.
 *
 * Initializes the database, starts the discovery polling loop, and starts
 * the daily graph-health cron. Handles graceful shutdown on SIGTERM/SIGINT.
 *
 * Usage:
 *   GROVE_VAULT=/path/to/vault npx tsx src/discovery-worker.ts
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

runMigration();

const vaultPath = process.env.GROVE_VAULT ?? join(homedir(), "life");

console.log(`[discovery-worker] starting (path=${vaultPath})`);
startDiscoveryLoop();

const healthIntervalMs = process.env.GROVE_HEALTH_INTERVAL_MS
  ? Number(process.env.GROVE_HEALTH_INTERVAL_MS)
  : DEFAULT_HEALTH_INTERVAL_MS;
startHealthCronLoop(vaultPath, {
  intervalMs: healthIntervalMs,
  runImmediately: true,
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

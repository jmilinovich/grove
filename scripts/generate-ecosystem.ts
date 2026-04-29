/**
 * scripts/generate-ecosystem.ts
 *
 * Regenerate the PM2 runtime ecosystem file from the current vaults
 * table. Runs on every deploy (CI invokes it between `git pull` and
 * `pm2 reload`) so the runtime file is always derived from the
 * authoritative vaults DB — never an artifact left over from a
 * previous deploy or an out-of-band edit.
 *
 * Output path: /root/grove/ecosystem.runtime.cjs by default. Override
 * with --path <file> or env GROVE_ECOSYSTEM_PATH.
 *
 * Why a separate runtime file instead of the legacy
 * `ecosystem.config.cjs`:
 *   - The repo previously committed an ecosystem.config.cjs that hard-
 *     coded the legacy 3-process layout (grove-server / grove-discovery
 *     / grove-proxy on :8190). vault-provision.ts overwrote this on the
 *     box at provision time, but `git reset --hard` (CI's rollback
 *     path) reverted that overwrite, re-spawning the legacy procs and
 *     causing them to crash-loop on EADDRINUSE 8190. That's the cause
 *     of the 2026-04-28 orphan PM2 restart loop (621 restarts in
 *     116 min).
 *   - Renaming to a gitignored runtime path makes the runtime file
 *     immune to `git reset --hard` and removes the two-sources-of-
 *     truth ambiguity. The file is regenerated from SQLite on every
 *     deploy.
 *
 * Exits 0 on success, 1 on error. CI fails loud if the file is
 * missing post-run.
 */
import { regenerateEcosystem } from "../src/vault-provision.js";

const args = process.argv.slice(2);
let pathArg: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--path" && args[i + 1]) {
    pathArg = args[i + 1];
    i++;
  }
}

const ecosystemPath =
  pathArg ?? process.env.GROVE_ECOSYSTEM_PATH ?? "/root/grove/ecosystem.runtime.cjs";

regenerateEcosystem({ ecosystemPath, skipReload: true, prune: false })
  .then((result) => {
    console.log(
      `[generate-ecosystem] wrote ${result.expectedApps.length} apps to ${result.ecosystemPath}`,
    );
    console.log(`[generate-ecosystem] apps: ${result.expectedApps.join(", ")}`);
    if (result.orphans.length > 0) {
      console.log(`[generate-ecosystem] orphan PM2 apps (not in config): ${result.orphans.join(", ")}`);
      console.log(`[generate-ecosystem] orphans not auto-pruned — see scripts/check-pm2-drift.sh`);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[generate-ecosystem] failed: ${(err as Error).stack ?? String(err)}`);
    process.exit(1);
  });

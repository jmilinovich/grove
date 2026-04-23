/**
 * Ecosystem config generator (P8-A4).
 *
 * Given the current `vaults` table, emit the PM2 `ecosystem.config.cjs`
 * CommonJS module that spawns one `grove-server-<slug>` + one
 * `grove-discovery-<slug>` process per vault, plus the shared
 * `grove-proxy` and `qmd-server`.
 *
 * Generation is deterministic and alphabetical-by-slug so `grove vault
 * create` produces a minimal diff each run. PLAN.md mandates a full
 * regenerate (no append) — this keeps the file auditable via git diff.
 */

import type Database from "better-sqlite3";

export interface VaultRow {
  id: string;
  slug: string;
  git_repo_path: string;
  server_port: number;
  discovery_port: number;
}

export interface EcosystemOptions {
  /** Absolute path on the VPS to the grove checkout (defaults to /root/grove). */
  repoRoot?: string;
  /** Proxy port (defaults to 8420). */
  proxyPort?: number;
  /** QMD port (defaults to 8177). */
  qmdPort?: number;
  /** Path to the qmd binary (defaults to /usr/bin/qmd on the VPS). */
  qmdBin?: string;
}

/**
 * Path to the `qmd` binary on the VPS. The shared QMD search service is
 * installed system-wide (APT package) at /usr/bin/qmd, not under the
 * grove checkout's node_modules. The previous default pointed at the
 * node_modules path, which broke `pm2 reload` the first time a vault
 * was provisioned (binary not found).
 */
const DEFAULT_QMD_BIN = "/usr/bin/qmd";

/**
 * Pull provisioned vaults (those with both ports set) from the DB, ordered
 * by slug. Only vaults that are fully provisioned show up — a vault row
 * without ports is a half-finished provision and shouldn't be spawned.
 */
export function readProvisionedVaults(db: Database.Database): VaultRow[] {
  return db
    .prepare(
      `SELECT id, slug, git_repo_path, server_port, discovery_port
         FROM vaults
        WHERE server_port IS NOT NULL AND discovery_port IS NOT NULL
        ORDER BY slug ASC`,
    )
    .all() as VaultRow[];
}

export function generateEcosystemConfig(
  vaults: VaultRow[],
  opts: EcosystemOptions = {},
): string {
  const repoRoot = opts.repoRoot ?? "/root/grove";
  const proxyPort = opts.proxyPort ?? 8420;
  const qmdPort = opts.qmdPort ?? 8177;
  // qmdBin is kept in the options shape for compatibility — see comment
  // below about why `qmd-server` is no longer emitted.
  void (opts.qmdBin ?? DEFAULT_QMD_BIN);

  const apps: Record<string, unknown>[] = [];

  // All TypeScript processes run under `/bin/bash -c 'npx tsx <file>'`
  // so CI's `npm ci --production` (which skips devDependencies where
  // tsx lives) doesn't break PM2 start-up. npx resolves tsx from node's
  // own cache or fetches it on demand. Matches the legacy hand-rolled
  // ecosystem.config.cjs that the VPS ran for months before multi-vault.
  const tsxRunner = "/bin/bash";
  const tsxArgs = (script: string) => `-c 'npx tsx ${repoRoot}/src/${script}'`;

  // Proxy — one process, not vault-scoped. `env_static` is the static,
  // per-process override that sits on top of `.env` at PM2 load time.
  apps.push({
    name: "grove-proxy",
    script: tsxRunner,
    args: tsxArgs("proxy.ts"),
    cwd: repoRoot,
    env_static: {
      NODE_ENV: "production",
      GROVE_PORT: String(proxyPort),
      QMD_PORT: String(qmdPort),
    },
    autorestart: true,
    max_restarts: 10,
  });

  // QMD — intentionally NOT emitted.
  //
  // The legacy `qmd-server` process wrapped a BM25-over-HTTP service on
  // :8177, used by `proxy.ts` at the `/search` endpoint + in the deep
  // `/health` check. qmd ≥ 2.1 removed that server mode (no `qmd serve`
  // command exists), so every attempt to start it crashes. Proxy-side
  // fallbacks already handle port 8177 being unreachable (503 + soft
  // degrade), and `hybrid-search.ts` runs BM25 in-process via FTS5 —
  // so nothing currently needs qmd-server. Leaving this commented so
  // the next operator knows why it's absent; bring it back only once
  // a working BM25 HTTP server is in place.

  for (const v of vaults) {
    apps.push({
      name: `grove-server-${v.slug}`,
      script: tsxRunner,
      args: tsxArgs("server.ts"),
      cwd: repoRoot,
      env_static: {
        NODE_ENV: "production",
        GROVE_VAULT: v.git_repo_path,
        GROVE_VAULT_ID: v.id,
        GROVE_SERVER_PORT: String(v.server_port),
      },
      kill_timeout: 60_000,
      autorestart: true,
      max_restarts: 10,
    });
    apps.push({
      name: `grove-discovery-${v.slug}`,
      script: tsxRunner,
      args: tsxArgs("discovery-worker.ts"),
      cwd: repoRoot,
      env_static: {
        NODE_ENV: "production",
        GROVE_VAULT: v.git_repo_path,
        GROVE_VAULT_ID: v.id,
        GROVE_DISCOVERY_PORT: String(v.discovery_port),
      },
      autorestart: true,
      max_restarts: 10,
    });
  }

  // The generated CJS wrapper reads `.env` at PM2 load time and spreads
  // it UNDER each process's static overrides. This matches the legacy
  // hand-rolled config, which relied on a `loadDotenv(".env")` spread to
  // pipe VOYAGE_API_KEY, R2_*, GROVE_CSRF_SECRET, GROVE_ADMIN_KEY,
  // GROVE_URL, GROVE_WWW_ORIGIN, GROVE_DB_PATH, etc. into every process.
  // Dropping this broke embeddings, image uploads, and cross-domain auth
  // the first time a second vault was provisioned.
  //
  // `env_static` wins over `.env` so per-vault pinning (GROVE_VAULT_ID,
  // GROVE_SERVER_PORT) can't be accidentally overridden from the shared
  // env file.
  const body = JSON.stringify({ apps }, null, 2);
  return `/**
 * Grove PM2 ecosystem — GENERATED by scripts/vault-provision + ecosystem-gen.ts.
 * Re-generated on every \`grove vault create\`. Do not edit by hand — your changes
 * will be overwritten on the next provision.
 *
 * Reads \`.env\` from this directory and spreads it into every process env,
 * matching the legacy hand-rolled config. Static per-process overrides sit
 * on top so the generator retains authority over vault-pinning vars.
 */
function __loadDotenv(file) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    var fs = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    var path = require("node:path");
    var text = fs.readFileSync(path.join(__dirname, file), "utf8");
    var env = {};
    var lines = text.split("\\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === "#") continue;
      var eq = line.indexOf("=");
      if (eq < 0) continue;
      var key = line.slice(0, eq).trim();
      var val = line.slice(eq + 1).trim();
      if ((val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') ||
          (val.charAt(0) === "'" && val.charAt(val.length - 1) === "'")) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
    return env;
  } catch (_err) {
    return {};
  }
}

var __dotenv = __loadDotenv(".env");
var __raw = ${body};
module.exports = {
  apps: __raw.apps.map(function (a) {
    var merged = {};
    for (var k in __dotenv) merged[k] = __dotenv[k];
    if (a.env_static) {
      for (var k2 in a.env_static) merged[k2] = a.env_static[k2];
    }
    var out = {};
    for (var field in a) {
      if (field !== "env_static") out[field] = a[field];
    }
    out.env = merged;
    return out;
  }),
};
`;
}

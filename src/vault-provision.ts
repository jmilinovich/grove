/**
 * Vault provisioning (P8-A4).
 *
 * `grove vault create <slug> --owner <email>` lives here. The operation:
 *
 *   1. validate slug + reserved-list
 *   2. allocate unused `server_port` + `discovery_port` via the unique
 *      indexes created in P8-A1 — race-safe even under concurrent calls
 *   3. create the vault's git repo at /root/vaults/<slug>/
 *   4. insert the rows: `vaults`, maybe `users`, `vault_members (owner)`,
 *      `api_keys` (fresh token returned once)
 *   5. regenerate `ecosystem.config.cjs` from the updated DB state (NOT
 *      append — the comment in ecosystem-gen explains why)
 *   6. `sudo pm2 reload ecosystem.config.cjs` + health-poll the new
 *      grove-server port until /health returns `{ok: true}`
 *
 * Side-effecting steps (git, qmd, pm2, health poll) are factored behind
 * an `Effects` interface so tests can mock them while exercising the
 * core logic.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { getDb } from "./db.js";
import {
  generateEcosystemConfig,
  readProvisionedVaults,
  type EcosystemOptions,
} from "./ecosystem-gen.js";
import { SLUG_PATTERN, RESERVED_SLUGS } from "./vault-router.js";
import { hashToken } from "./keys.js";

const FIRST_SERVER_PORT = 8191; // 8190 is the personal vault
const FIRST_DISCOVERY_PORT = 8092; // 8091 is the personal vault

export interface ProvisionInput {
  slug: string;
  ownerEmail: string;
  gitPath?: string;
  displayName?: string;
}

export interface ProvisionResult {
  vaultId: string;
  slug: string;
  gitPath: string;
  serverPort: number;
  discoveryPort: number;
  ownerUserId: string;
  ownerApiToken: string; // full token shown once
  connectorUrl: string;
  ecosystemPath: string;
}

export class ProvisionError extends Error {
  constructor(
    public code: "invalid_slug" | "reserved_slug" | "slug_taken" | "port_exhausted" | "reload_failed" | "health_failed",
    message: string,
  ) {
    super(message);
    this.name = "ProvisionError";
  }
}

export interface Effects {
  /** git init + initial .grove/config.yaml. Called once per new vault. */
  initRepo(gitPath: string): void;
  /** `qmd init` in the per-vault QMD data directory. */
  initQmd(qmdPath: string): void;
  /** Write the PM2 ecosystem config atomically. */
  writeEcosystem(path: string, content: string): void;
  /** Trigger `sudo pm2 reload ecosystem.config.cjs`. */
  reloadPm2(ecosystemPath: string): void;
  /**
   * `sudo pm2 start <ecosystem> --only <csv>` — bring up only the named
   * apps without restarting the others. Used by `provisionVault` so a new
   * vault's grove-server/discovery come online without bouncing the proxy
   * (the old `pm2 reload` path 502'd /healthz for ~10s during onboarding).
   */
  startPm2Apps(ecosystemPath: string, appNames: string[]): void;
  /** Poll the new server's /health until {ok: true} or timeout. */
  waitForHealth(port: number, timeoutMs: number): Promise<void>;
  /** List all app names currently registered with PM2. */
  listPm2Apps(): string[];
  /** `sudo pm2 delete <name>` — used to prune apps no longer in the ecosystem. */
  deletePm2App(name: string): void;
}

export const defaultEffects: Effects = {
  initRepo(gitPath: string): void {
    mkdirSync(gitPath, { recursive: true });
    if (!existsSync(join(gitPath, ".git"))) {
      execSync("git init --initial-branch=main", { cwd: gitPath });
    }
    // We don't seed `.grove/config.yaml` anymore — grove-server's
    // `loadVaultConfig` falls back to `getDefaultConfig()` when the file
    // is absent, which is the right shape. Writing a minimal stub (just
    // `version: 1`) caused `validateConfig` to crash with "missing
    // 'structure' object" at boot, crash-looping grove-server-<slug>.
    // Operators who want to customize structure should `grove vault
    // config init` after provisioning.
  },
  initQmd(qmdPath: string): void {
    // Reserve the per-vault QMD directory for future use (shared QMD
    // doesn't index per-vault today). Skipping the `qmd init` call —
    // qmd 2.1+ removed that subcommand, so invoking it just prints an
    // unknown-command error. The mkdir is idempotent and harmless.
    mkdirSync(qmdPath, { recursive: true });
  },
  writeEcosystem(path: string, content: string): void {
    writeFileSync(path, content, "utf8");
  },
  reloadPm2(ecosystemPath: string): void {
    execSync(`sudo pm2 reload ${ecosystemPath}`, { stdio: "inherit" });
  },
  startPm2Apps(ecosystemPath: string, appNames: string[]): void {
    if (appNames.length === 0) return;
    const csv = appNames.join(",");
    execSync(`sudo pm2 start ${ecosystemPath} --only ${csv}`, { stdio: "inherit" });
  },
  async waitForHealth(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (res.ok) {
          const body = (await res.json()) as { ok?: boolean };
          if (body?.ok === true) return;
        }
      } catch {
        // ignore — retry
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new ProvisionError("health_failed", `grove-server on :${port} never became healthy`);
  },
  listPm2Apps(): string[] {
    const raw = execSync("sudo pm2 jlist", { encoding: "utf8" });
    const list = JSON.parse(raw) as Array<{ name?: string }>;
    return list.map((p) => p.name ?? "").filter(Boolean);
  },
  deletePm2App(name: string): void {
    execSync(`sudo pm2 delete ${name}`, { stdio: "inherit" });
  },
};

export function validateSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new ProvisionError(
      "invalid_slug",
      `slug must match /^[a-z][a-z0-9-]{1,29}$/ (got ${JSON.stringify(slug)})`,
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new ProvisionError(
      "reserved_slug",
      `slug ${JSON.stringify(slug)} is reserved`,
    );
  }
}

/**
 * Find an unused server_port + discovery_port pair. The unique indexes
 * from P8-A1 mean we can race: a concurrent caller that picks the same
 * port will fail its INSERT; our caller retries with the next pair.
 */
export function nextAvailablePorts(db = getDb()): { serverPort: number; discoveryPort: number } {
  const rows = db
    .prepare(
      `SELECT server_port, discovery_port FROM vaults
       WHERE server_port IS NOT NULL AND discovery_port IS NOT NULL`,
    )
    .all() as Array<{ server_port: number; discovery_port: number }>;

  const usedServer = new Set(rows.map((r) => r.server_port));
  const usedDiscovery = new Set(rows.map((r) => r.discovery_port));

  let serverPort = FIRST_SERVER_PORT;
  while (usedServer.has(serverPort)) serverPort++;
  let discoveryPort = FIRST_DISCOVERY_PORT;
  while (usedDiscovery.has(discoveryPort)) discoveryPort++;

  if (serverPort > 8300 || discoveryPort > 8200) {
    throw new ProvisionError("port_exhausted", "ran out of ports in the 819x/809x range");
  }
  return { serverPort, discoveryPort };
}

export interface ProvisionOptions extends EcosystemOptions {
  ecosystemPath?: string;
  vaultsRoot?: string;
  qmdRoot?: string;
  effects?: Effects;
  /** Skip the pm2 reload + health-poll step (useful for dry runs / tests). */
  skipReload?: boolean;
  /** Base URL for the connector (defaults to https://api.grove.md). */
  connectorBaseUrl?: string;
}

export async function provisionVault(
  input: ProvisionInput,
  opts: ProvisionOptions = {},
): Promise<ProvisionResult> {
  validateSlug(input.slug);

  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM vaults WHERE slug = ?")
    .get(input.slug) as { id: string } | undefined;
  if (existing) {
    throw new ProvisionError("slug_taken", `slug ${JSON.stringify(input.slug)} already exists`);
  }

  const effects = opts.effects ?? defaultEffects;
  const vaultsRoot = opts.vaultsRoot ?? "/root/vaults";
  const qmdRoot = opts.qmdRoot ?? "/root/qmd";
  const ecosystemPath = opts.ecosystemPath ?? "/root/grove/ecosystem.config.cjs";
  const connectorBaseUrl = opts.connectorBaseUrl ?? "https://api.grove.md";
  const gitPath = input.gitPath ?? join(vaultsRoot, input.slug);
  const qmdPath = join(qmdRoot, input.slug);

  effects.initRepo(gitPath);
  effects.initQmd(qmdPath);

  const vaultId = `vault_${randomBytes(4).toString("hex")}`;
  const rawToken = `grove_live_${randomBytes(32).toString("hex")}`;
  const hashedToken = hashToken(rawToken);

  // Allocate ports + insert everything in a single transaction. UNIQUE
  // constraints on server_port/discovery_port mean a concurrent provision
  // that picks the same ports will fail here with SQLITE_CONSTRAINT_UNIQUE;
  // the caller can retry. For MVP we don't retry automatically.
  const { serverPort, discoveryPort } = nextAvailablePorts(db);

  const displayName = input.displayName ?? input.slug.charAt(0).toUpperCase() + input.slug.slice(1);

  // Match invite.ts — store/lookup users by lowercased+trimmed email so
  // `--owner Foo@x.com` and a later `grove invite foo@x.com` resolve to
  // the same row instead of creating a duplicate user.
  const normalizedEmail = input.ownerEmail.toLowerCase().trim();

  let ownerUserId = "";

  const tx = db.transaction(() => {
    const existingUser = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(normalizedEmail) as { id: string } | undefined;
    if (existingUser) {
      ownerUserId = existingUser.id;
    } else {
      ownerUserId = `user_${randomBytes(4).toString("hex")}`;
      db.prepare(
        "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)",
      ).run(ownerUserId, normalizedEmail.split("@")[0], normalizedEmail, "owner");
    }

    db.prepare(
      `INSERT INTO vaults
         (id, owner_id, slug, display_name, git_repo_path, server_port, discovery_port)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(vaultId, ownerUserId, input.slug, displayName, gitPath, serverPort, discoveryPort);

    db.prepare(
      `INSERT OR IGNORE INTO vault_members (user_id, vault_id, role) VALUES (?, ?, ?)`,
    ).run(ownerUserId, vaultId, "owner");

    const keyId = `key_${randomBytes(4).toString("hex")}`;
    db.prepare(
      `INSERT INTO api_keys (id, user_id, vault_id, name, hashed_token, scopes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(keyId, ownerUserId, vaultId, `${input.slug}-owner`, hashedToken, "read,write");
  });
  tx();

  const ecosystem = generateEcosystemConfig(readProvisionedVaults(db), opts);
  effects.writeEcosystem(ecosystemPath, ecosystem);

  if (!opts.skipReload) {
    // Compute which apps are new vs already running. `pm2 reload <ecosystem>`
    // would restart every app (bouncing the proxy and causing a 502 window
    // on /healthz); `pm2 start --only <new-csv>` only spins up the additions
    // and leaves the rest untouched.
    const expected = extractAppNames(ecosystem);
    const current = new Set(effects.listPm2Apps());
    const newApps = expected.filter((n) => !current.has(n));
    try {
      if (newApps.length > 0) {
        effects.startPm2Apps(ecosystemPath, newApps);
      } else {
        // No new apps — config-only change. Fall back to reload so the
        // updated env/args reach the existing processes.
        effects.reloadPm2(ecosystemPath);
      }
    } catch (err) {
      throw new ProvisionError("reload_failed", `pm2 start/reload failed: ${(err as Error).message}`);
    }
    await effects.waitForHealth(serverPort, 60_000);
  }

  return {
    vaultId,
    slug: input.slug,
    gitPath,
    serverPort,
    discoveryPort,
    ownerUserId,
    ownerApiToken: rawToken,
    connectorUrl: `${connectorBaseUrl}/v/${input.slug}/mcp`,
    ecosystemPath,
  };
}

export interface RegenOptions extends EcosystemOptions {
  ecosystemPath?: string;
  effects?: Effects;
  /** Skip rewriting the ecosystem file. Useful for --dry-run. */
  skipWrite?: boolean;
  /** Skip `sudo pm2 reload`. */
  skipReload?: boolean;
  /** Also `pm2 delete` any app present in PM2 but not in the regenerated config. */
  prune?: boolean;
}

export interface RegenResult {
  ecosystemPath: string;
  expectedApps: string[];
  currentApps: string[];
  orphans: string[];
  pruned: string[];
  wrote: boolean;
  reloaded: boolean;
}

/**
 * Regenerate `ecosystem.config.cjs` from the current `vaults` table and,
 * optionally, reload PM2 and prune orphan apps.
 *
 * Why this exists: `generateEcosystemConfig` evolves (e.g. P8 dropped
 * `qmd-server` once qmd 2.1 removed `qmd serve`), but the file on disk
 * only refreshes when `provisionVault` runs. A VPS provisioned before a
 * generator change carries the stale config indefinitely — and `pm2
 * reload` never deletes apps that disappear from the config, so a
 * removed process stays crash-looping forever. `--prune` closes that gap.
 */
export async function regenerateEcosystem(
  opts: RegenOptions = {},
): Promise<RegenResult> {
  const effects = opts.effects ?? defaultEffects;
  const ecosystemPath = opts.ecosystemPath ?? "/root/grove/ecosystem.config.cjs";
  const db = getDb();
  const vaults = readProvisionedVaults(db);
  const content = generateEcosystemConfig(vaults, opts);

  const expectedApps = extractAppNames(content);
  const currentApps = effects.listPm2Apps();
  const orphans = currentApps.filter((n) => !expectedApps.includes(n));

  const wrote = !opts.skipWrite;
  if (wrote) effects.writeEcosystem(ecosystemPath, content);

  const reloaded = wrote && !opts.skipReload;
  if (reloaded) {
    try {
      effects.reloadPm2(ecosystemPath);
    } catch (err) {
      throw new ProvisionError("reload_failed", `pm2 reload failed: ${(err as Error).message}`);
    }
  }

  const pruned: string[] = [];
  if (opts.prune && orphans.length > 0) {
    for (const name of orphans) {
      effects.deletePm2App(name);
      pruned.push(name);
    }
  }

  return { ecosystemPath, expectedApps, currentApps, orphans, pruned, wrote, reloaded };
}

/** Parse the generated CJS and return the ordered list of `apps[].name`. */
function extractAppNames(generated: string): string[] {
  const names: string[] = [];
  const re = /"name":\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(generated)) !== null) names.push(m[1]);
  return names;
}

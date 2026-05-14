/**
 * v2 dashboard server surface — skills endpoint.
 *
 * Standalone `GET /v/<slug>/v1/skills`. Joins the hardcoded
 * `SKILL_REGISTRY` (built-in metadata) with each vault's `skill_configs`
 * rows (per-vault user state — enabled flag, cadence override) to
 * produce the `Skill[]` shape grove-www's `fetchSkills` consumes.
 *
 * Per-module convention matches `share.ts` / `waitlist.ts` — one focused
 * file per surface area, route dispatch in `proxy.ts`.
 *
 * Shape contract: `grove-www/src/lib/grove-api.v2.types.ts` `Skill` is
 * authoritative. The TS interface in this file MUST mirror it byte-for-byte
 * (camelCase, optional `starterPendingTasks`, union types intact). Drift
 * here breaks the v2 dashboard contract.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getVaultDb } from "./db-per-vault.js";
import type { Cadence, SkillConfigRow } from "./db-types.js";
import {
  SKILL_REGISTRY,
  getSkillBySlug,
  type SkillDomain,
  type TaskArtifactType,
} from "./skills/registry.js";
import type { VaultContext } from "./vault-router.js";

/** A skill's per-vault install state. */
export type SkillInstallState = "installed" | "available" | "disabled";

/**
 * Wire shape returned by `GET /v1/skills`. Mirrors `Skill` in
 * `grove-www/src/lib/grove-api.v2.types.ts`. Field names are camelCase;
 * snake_case lives only in SQLite.
 */
export interface SkillResponse {
  id: string;
  slug: string;
  name: string;
  domain: SkillDomain;
  author: "builtin";
  description: string;
  sampleTasks: string[];
  cadenceOptions: Cadence[];
  defaultCadence: Cadence | null;
  defaultArtifactType: TaskArtifactType;
  installState: SkillInstallState;
  starterPendingTasks?: string[];
}

/**
 * Build the `Skill[]` payload for a vault. Pure compute — no I/O beyond
 * a single SELECT against the per-vault `skill_configs` table. Exported
 * so P21-3's `BacklogPayload` can reuse the same join without round-tripping
 * through HTTP.
 */
export function listSkillsForVault(vaultId: string): SkillResponse[] {
  const db = getVaultDb(vaultId);

  // Aliased SELECT so rows come back already in camelCase shape — no
  // hand-converted mapper needed (PLAN.md Phase 21 architecture smell #3).
  // Only the fields used to derive installState + cadence overrides are
  // read; everything else on `skill_configs` is irrelevant to this endpoint.
  const rows = db
    .prepare(
      `SELECT skill_slug AS slug,
              enabled,
              cadence AS configuredCadence
         FROM skill_configs`,
    )
    .all() as Array<Pick<SkillConfigRow, "enabled"> & {
      slug: string;
      configuredCadence: Cadence;
    }>;

  const bySlug = new Map(rows.map((r) => [r.slug, r] as const));

  return SKILL_REGISTRY.map((entry): SkillResponse => {
    const config = bySlug.get(entry.slug);
    // Default when no skill_configs row exists: installState='available'
    // and cadence falls back to the registry default. enabled=0 also maps
    // to 'available'. enabled=1 → 'installed'. The 'disabled' state is
    // reserved for an explicit user disable (future Pro feature); no row
    // shape produces it today, but the union stays in place so the column
    // is forward-compatible.
    const installState: SkillInstallState =
      config && config.enabled === 1 ? "installed" : "available";

    const result: SkillResponse = {
      id: entry.id,
      slug: entry.slug,
      name: entry.name,
      domain: entry.domain,
      author: entry.author,
      description: entry.description,
      sampleTasks: [...entry.sampleTasks],
      cadenceOptions: [...entry.cadenceOptions],
      defaultCadence: entry.defaultCadence,
      defaultArtifactType: entry.defaultArtifactType,
      installState,
    };
    if (entry.starterPendingTasks) {
      result.starterPendingTasks = [...entry.starterPendingTasks];
    }
    return result;
  });
}

/**
 * HTTP handler for `GET /v/<slug>/v1/skills`. Auth + vault context have
 * already been resolved by the `vaultV1Match` block in `proxy.ts` — this
 * handler just renders the JSON.
 */
export function handleV2SkillsList(
  res: ServerResponse,
  vault: VaultContext,
  corsOrigin: string,
): void {
  // Bare-array response — matches `fetchSkills(vault): Promise<Skill[]>`
  // in grove-www. The BacklogPayload-embedded `skills` field uses the
  // same shape, so this is also the row format P21-3 reuses internally.
  const skills = listSkillsForVault(vault.vaultId);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": corsOrigin,
  });
  res.end(JSON.stringify(skills));
}

// ─── P22-4: configure / enable / disable ────────────────────────────────

const MAX_SKILL_CONFIG_BODY = 64 * 1024;
const VALID_CADENCES: ReadonlySet<Cadence> = new Set([
  "daily",
  "weekly",
  "on-trigger",
  "on-demand",
]);

function corsOrigin(): string {
  return process.env.GROVE_WWW_ORIGIN ?? "https://grove.md";
}

function readJsonBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_SKILL_CONFIG_BODY) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": corsOrigin(),
  });
  res.end(JSON.stringify(body));
}

/**
 * SQLite datetime expression for the next run after `enable`. `on-demand`
 * and `on-trigger` never auto-enqueue (scheduler decision lock, P23-1) so
 * their `next_run_at` is NULL. `daily` ticks +1 day; `weekly` ticks +7 days.
 */
function nextRunSqlForCadence(cadence: Cadence): string | null {
  switch (cadence) {
    case "daily":
      return "datetime('now', '+1 day')";
    case "weekly":
      return "datetime('now', '+7 days')";
    case "on-demand":
    case "on-trigger":
      return null;
  }
}

/**
 * Build the post-update Skill response for a single slug, joining the
 * registry metadata with the latest skill_configs row. Mirrors the
 * per-vault join in `listSkillsForVault` so writes return exactly what
 * a subsequent read would. Returns null for unknown slugs (already
 * filtered upstream, but defensive).
 */
function buildSkillResponse(
  vaultId: string,
  slug: string,
): SkillResponse | null {
  const entry = getSkillBySlug(slug);
  if (!entry) return null;

  const db = getVaultDb(vaultId);
  const row = db
    .prepare(
      `SELECT enabled FROM skill_configs WHERE skill_slug = ? LIMIT 1`,
    )
    .get(slug) as Pick<SkillConfigRow, "enabled"> | undefined;

  const installState: SkillInstallState =
    row && row.enabled === 1 ? "installed" : "available";

  const result: SkillResponse = {
    id: entry.id,
    slug: entry.slug,
    name: entry.name,
    domain: entry.domain,
    author: entry.author,
    description: entry.description,
    sampleTasks: [...entry.sampleTasks],
    cadenceOptions: [...entry.cadenceOptions],
    defaultCadence: entry.defaultCadence,
    defaultArtifactType: entry.defaultArtifactType,
    installState,
  };
  if (entry.starterPendingTasks) {
    result.starterPendingTasks = [...entry.starterPendingTasks];
  }
  return result;
}

function fetchExistingConfig(
  vaultId: string,
  slug: string,
): Pick<SkillConfigRow, "enabled" | "cadence"> | undefined {
  return getVaultDb(vaultId)
    .prepare(
      "SELECT enabled, cadence FROM skill_configs WHERE skill_slug = ? LIMIT 1",
    )
    .get(slug) as Pick<SkillConfigRow, "enabled" | "cadence"> | undefined;
}

/**
 * `POST /v/<slug>/v1/skills/<skill-slug>/configure` — body `{cadence}`.
 *
 * UPSERT into per-vault `skill_configs`: updates the cadence; preserves
 * the row's `enabled` state when it already exists; inserts a disabled
 * row (enabled=0) when no row exists yet. Does NOT touch `next_run_at` —
 * `/enable` is the cadence→next_run_at materialization edge.
 *
 * Returns the post-update Skill wire shape so the dashboard can render
 * the new cadence label without a follow-up GET.
 *
 * Auth/CORS enforced upstream by proxy.ts's `vaultV1Match` block.
 */
export async function handleV2SkillConfigure(
  req: IncomingMessage,
  res: ServerResponse,
  vault: VaultContext,
  slug: string,
): Promise<void> {
  if (!getSkillBySlug(slug)) {
    // Drain body so the socket isn't left half-read.
    try {
      await readJsonBody(req);
    } catch {
      /* fall through to the 404 — the slug is the load-bearing error */
    }
    sendJson(res, 404, { error: "skill_not_found" });
    return;
  }

  let raw: string;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "read_error" });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }

  const cadence =
    parsed && typeof parsed === "object" && "cadence" in parsed
      ? (parsed as { cadence: unknown }).cadence
      : undefined;
  if (typeof cadence !== "string" || !VALID_CADENCES.has(cadence as Cadence)) {
    sendJson(res, 400, { error: "invalid_cadence" });
    return;
  }

  const db = getVaultDb(vault.vaultId);
  // Preserve `enabled` on an existing row; default to 0 on insert. Doing
  // this in a single UPSERT keeps `created_at` untouched on updates.
  db.prepare(
    `INSERT INTO skill_configs (skill_slug, enabled, cadence)
     VALUES (?, 0, ?)
     ON CONFLICT(skill_slug) DO UPDATE SET
       cadence = excluded.cadence,
       updated_at = datetime('now')`,
  ).run(slug, cadence);

  sendJson(res, 200, buildSkillResponse(vault.vaultId, slug));
}

/**
 * `POST /v/<slug>/v1/skills/<skill-slug>/enable`.
 *
 * UPSERT `enabled = 1`. Uses the existing row's cadence if one is set,
 * otherwise the registry's `defaultCadence` (which is non-null for all
 * builtins). Recomputes `next_run_at` from cadence: `daily` → +1d,
 * `weekly` → +7d, `on-demand`/`on-trigger` → NULL (cron never enqueues
 * these — they fire only via `/run` or a trigger source).
 */
export async function handleV2SkillEnable(
  req: IncomingMessage,
  res: ServerResponse,
  vault: VaultContext,
  slug: string,
): Promise<void> {
  const entry = getSkillBySlug(slug);
  if (!entry) {
    try {
      await readJsonBody(req);
    } catch {
      /* slug is the load-bearing error */
    }
    sendJson(res, 404, { error: "skill_not_found" });
    return;
  }

  // /enable takes no parameters today — drain any body so the socket
  // isn't left half-read on the next pipelined request.
  try {
    await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "read_error" });
    return;
  }

  const existing = fetchExistingConfig(vault.vaultId, slug);
  // Registry guarantees defaultCadence is set for every shipped skill
  // (P21-5 invariant). Fall back to "on-demand" only as a structural
  // safety net so the column stays NOT NULL even if a future registry
  // entry forgets to set defaultCadence.
  const cadence: Cadence =
    existing?.cadence ?? entry.defaultCadence ?? "on-demand";
  const nextRunExpr = nextRunSqlForCadence(cadence);

  const db = getVaultDb(vault.vaultId);
  // Two SQL shapes — one with a datetime() expression for next_run_at,
  // one with NULL. Bound parameters can't carry SQL expressions, so the
  // string template stays static per-branch.
  if (nextRunExpr) {
    db.prepare(
      `INSERT INTO skill_configs (skill_slug, enabled, cadence, next_run_at)
       VALUES (?, 1, ?, ${nextRunExpr})
       ON CONFLICT(skill_slug) DO UPDATE SET
         enabled = 1,
         cadence = excluded.cadence,
         next_run_at = ${nextRunExpr},
         updated_at = datetime('now')`,
    ).run(slug, cadence);
  } else {
    db.prepare(
      `INSERT INTO skill_configs (skill_slug, enabled, cadence, next_run_at)
       VALUES (?, 1, ?, NULL)
       ON CONFLICT(skill_slug) DO UPDATE SET
         enabled = 1,
         cadence = excluded.cadence,
         next_run_at = NULL,
         updated_at = datetime('now')`,
    ).run(slug, cadence);
  }

  sendJson(res, 200, buildSkillResponse(vault.vaultId, slug));
}

/**
 * `POST /v/<slug>/v1/skills/<skill-slug>/disable`.
 *
 * UPSERT `enabled = 0, next_run_at = NULL`. Cadence is preserved (so a
 * later /enable restores the prior cadence) or falls back to the
 * registry default on first insert.
 */
export async function handleV2SkillDisable(
  req: IncomingMessage,
  res: ServerResponse,
  vault: VaultContext,
  slug: string,
): Promise<void> {
  const entry = getSkillBySlug(slug);
  if (!entry) {
    try {
      await readJsonBody(req);
    } catch {
      /* slug is the load-bearing error */
    }
    sendJson(res, 404, { error: "skill_not_found" });
    return;
  }

  try {
    await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "read_error" });
    return;
  }

  const existing = fetchExistingConfig(vault.vaultId, slug);
  const cadence: Cadence =
    existing?.cadence ?? entry.defaultCadence ?? "on-demand";

  const db = getVaultDb(vault.vaultId);
  db.prepare(
    `INSERT INTO skill_configs (skill_slug, enabled, cadence, next_run_at)
     VALUES (?, 0, ?, NULL)
     ON CONFLICT(skill_slug) DO UPDATE SET
       enabled = 0,
       next_run_at = NULL,
       updated_at = datetime('now')`,
  ).run(slug, cadence);

  sendJson(res, 200, buildSkillResponse(vault.vaultId, slug));
}

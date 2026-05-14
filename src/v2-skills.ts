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

import type { ServerResponse } from "node:http";
import { getVaultDb } from "./db-per-vault.js";
import type { Cadence, SkillConfigRow } from "./db-types.js";
import {
  SKILL_REGISTRY,
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

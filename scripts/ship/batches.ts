/**
 * Batch registry for scripts/ship.ts.
 *
 * Each batch is a named unit of work with 1+ agent entries. The orchestrator
 * runs the entries in parallel, then merges all resulting worktree branches
 * into a single `ship/<batch-id>` branch which becomes a PR.
 *
 * Task discipline (commit format, grove-www rules, exit behavior) lives in
 * `.claude/settings.json`'s systemPrompt — DON'T duplicate it in each entry's
 * prompt. Just describe the task.
 */

export interface BatchEntry {
  /** Short slug used as the worktree branch name (worktree-<branch>). */
  branch: string;
  /** Prompt for the agent. Keep it spec-only; commit discipline comes from settings. */
  prompt: string;
}

export interface Batch {
  /** Stable identifier: p8a-1, p8a-2, … */
  id: string;
  /** One-line summary for the ship PR title. */
  title: string;
  /** Prerequisite batch IDs (merged before this one runs). */
  requires?: string[];
  entries: BatchEntry[];
  /**
   * If true, ship.ts opens the PR but does NOT enable `gh pr merge --auto`.
   * Required for batches whose diff triggers AGENTS.md's "Ask before merging"
   * rules — e.g. schema changes (src/db.ts, src/db-migration*.ts), where the
   * deploy workflow's schema-change guard needs a human to enter
   * `confirm_schema_change=true` before the landed code can ship to prod.
   * ship.ts halts the run after opening the PR so the user can review + merge
   * manually; resume with `ship --from <next-batch-id>`.
   */
  noAutoMerge?: boolean;
}

/**
 * Batches pending execution. Shipped batches are NOT listed here — they live
 * in git history. Add new batches by appending; do not rearrange.
 *
 * Convention: solo entries get a batch with a single entry. Parallel batches
 * get 2-3 entries — they run concurrently in separate worktrees, then merge
 * into one `ship/<id>` PR.
 */
export const BATCHES: Batch[] = [
  // ── Phase 8A: Multi-Vault plumbing ────────────────────────────────
  {
    id: "p8a-1",
    title: "feat(P8-A1, P8-A5): schema migration + graceful shutdown",
    // Schema change — AGENTS.md requires human review before merge, and deploy
    // needs confirm_schema_change=true. ship.ts opens the PR and stops.
    noAutoMerge: true,
    entries: [
      {
        branch: "p8a-schema",
        prompt:
          "Read PLAN.md task P8-A1. Add schema migration: vaults gains slug/git_path/server_port/discovery_port columns (backfill existing row as personal @ /root/life ports 8190/8091); add vault_id to discovery_queue/discovery_results/graph_health/graph_health_flags; add vault_usage_daily table. Write idempotent up + down migrations, transactional in one BEGIN/COMMIT. Verify PRAGMA foreign_key_check passes after migration. Run npm test. Commit as feat(P8-A1).",
      },
      {
        branch: "p8a-shutdown",
        prompt:
          "Read PLAN.md task P8-A5. Add SIGTERM + SIGUSR2 handlers to src/server.ts that stop accepting new requests, drain the write queue, fsync git state, exit 0. Write a graceful-shutdown test that verifies no data loss on pm2 reload semantics. Run npm test. Commit as feat(P8-A5).",
      },
    ],
  },
  {
    id: "p8a-2",
    title: "feat(P8-A2, P8-A3, P8-A6): router + backend self-auth + observability",
    requires: ["p8a-1"],
    entries: [
      {
        branch: "p8a-router",
        prompt:
          "Read PLAN.md task P8-A2. Create src/vault-router.ts: load slug→port map on startup, reload on SIGHUP. In src/proxy.ts wire middleware that hashes bearer, resolves api_keys.vault_id, extracts URL slug, forwards to 127.0.0.1:<server_port>/<path> with X-Grove-Vault-Id header. 403 on slug mismatch (don't leak 404). Legacy /v1/* and /mcp without slug: fall through to token's vault with Sunset header. 503 + Retry-After: 5 on ECONNREFUSED. 504 on slow backend. Max 1 retry at 500ms. Run npm test. Commit as feat(P8-A2).",
      },
      {
        branch: "p8a-backend-auth",
        prompt:
          "Read PLAN.md task P8-A3. In src/server.ts add per-request auth: read GROVE_VAULT_ID env var on startup, reject any request whose api_keys.vault_id does not match the pinned ID. Applies to all MCP tools AND REST endpoints — no exceptions. Write test/backend-auth.test.ts verifying localhost curl with cross-vault token returns 403. Run npm test. Commit as feat(P8-A3).",
      },
      {
        branch: "p8a-observability",
        prompt:
          "Read PLAN.md task P8-A6. Extend src/logger.ts so every line includes vault_id + vault_slug. Add src/vault-usage.ts with in-memory counters (requests/writes/embed_tokens/search_queries) that flush to vault_usage_daily every 60s via upsert. Propagate X-Grove-Vault-Id from grove-server to embed-server so embed logs include vault context. Run npm test. Commit as feat(P8-A6).",
      },
    ],
  },
  {
    id: "p8a-3",
    title: "feat(P8-A4): grove vault create CLI + ecosystem generator",
    requires: ["p8a-2"],
    entries: [
      {
        branch: "p8a-cli",
        prompt:
          "Read PLAN.md task P8-A4. Implement src/vault-provision.ts + src/ecosystem-gen.ts + a `grove vault create <slug> --owner <email>` CLI subcommand. Steps: validate slug regex + reserved-list, allocate unused ports race-safe (INSERT ... ON CONFLICT FAIL), create /root/vaults/<slug>/ with git init + .grove/config.yaml, create /root/qmd/<slug>/ QMD index, insert vaults row + users find-or-create + vault_members owner + mint API key, regenerate ecosystem.config.cjs from SELECT * FROM vaults (fully regenerate — do NOT append), sudo pm2 reload, poll http://127.0.0.1:<port>/health until body parses as {ok: true}, print connector URL + owner key + sample invite email. Update docs/cli.md. Run npm test. Commit as feat(P8-A4).",
      },
    ],
  },
  {
    id: "p8a-4",
    title: "test(P8-A7): multi-vault isolation smoke test",
    requires: ["p8a-3"],
    entries: [
      {
        branch: "p8a-e2e",
        prompt:
          "Read PLAN.md task P8-A7. Write test/smoke/08-multi-vault.smoke.sh covering all 10 acceptance steps: migration runs, personal /health {ok:true}, grove vault create test works, pm2 shows test processes, test /health {ok:true}, write+search in test vault works, search in personal does NOT find test vault note (isolation verified), kill -TERM clean shutdown, vault_usage_daily has rows for both, log lines include vault_id + vault_slug. Update docs/operations.md with run instructions. Run the smoke test locally. Commit as test(P8-A7).",
      },
    ],
  },

  // ── Phase 8B: Multi-Vault collaboration ───────────────────────────
  {
    id: "p8b-1",
    title: "feat(P8-B1, P8-B2): vault_members + invite flow",
    requires: ["p8a-4"],
    // Schema change (creates vault_members table + drops users.role) — same
    // reasoning as p8a-1. Human review + confirm_schema_change=true required.
    noAutoMerge: true,
    entries: [
      {
        branch: "p8b-members",
        prompt:
          "Read PLAN.md task P8-B1. Populate vault_members table (declared in A1 migration). Backfill one row per existing user with their pre-migration users.role for the personal vault. Write up + down migrations. DO NOT drop users.role yet — that's a separate later release. Run npm test. Commit as feat(P8-B1).",
      },
      {
        branch: "p8b-invite",
        prompt:
          "Read PLAN.md task P8-B2. Extend `grove invite` CLI to require --vault <slug>. If user exists by email: find-or-create vault_members row + mint vault-scoped key. If new: create users row + vault_members + magic link. Update src/email.ts template with two CTAs: primary 'Open <vault>' link to grove.md/@<owner>/<slug>/, secondary 'Add to Claude.ai' deep-link with api.grove.md/v/<slug>/mcp. Update docs/cli.md. Run npm test. Commit as feat(P8-B2).",
      },
    ],
  },
  {
    id: "p8b-2",
    title: "feat(P8-B3, P8-B4): scoped grove-www routes + vault switcher",
    requires: ["p8b-1"],
    entries: [
      {
        branch: "p8b-routes",
        prompt:
          "Read PLAN.md task P8-B3. In grove-www move every authenticated route under /@<handle>/<vault-slug>/: dashboard, profile, images, settings. Bare /dashboard etc. become 301 redirects to the user's most-recently-used vault (first-time users → earliest-joined vault). Extend /api/me to return vaults: [{slug, name, role}]. Update last_active_at on navigation (throttled to once per minute). Commit as feat(P8-B3).",
      },
      {
        branch: "p8b-switcher",
        prompt:
          "Read PLAN.md task P8-B4. Add grove-www/src/components/vault-switcher.tsx: header dropdown labeled '@<handle> / <vault-slug>' showing all user's vaults. Cmd+Shift+V shortcut (NOT Cmd+Shift+K — collides with Slack/Linear). Rendered always but disabled at n=1. ARIA combobox with aria-expanded + aria-live polite announcement on switch. Wire into Header. Playwright test covers shortcut, keyboard nav, aria-live announcement. Run npm run test:mobile. Commit as feat(P8-B4).",
      },
    ],
  },
  {
    id: "p8b-3",
    title: "feat(P8-B5): connected-vaults settings page",
    requires: ["p8b-2"],
    entries: [
      {
        branch: "p8b-settings",
        prompt:
          "Read PLAN.md task P8-B5. Add grove-www page at /@<handle>/<vault>/settings/vaults listing every vault the user has access to with role, joined_at, last_active_at, and 'Add to Claude.ai' deep-link button per vault. Owners see a 'Manage members' placeholder link (no functionality in v1). Commit as feat(P8-B5).",
      },
    ],
  },
];

export function findBatch(id: string): Batch | undefined {
  return BATCHES.find((b) => b.id === id);
}

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
 *
 * Parallel-overlap constraint
 * ───────────────────────────
 * Parallel entries in the same batch run as independent worktrees and are
 * merged sequentially into `ship/<id>`. If two entries write to the SAME
 * file, the second merge hits a CONFLICT and ship.ts halts with exit 78
 * (manual intervention required). Patterns we've burned on:
 *
 *   p21-3  → 2 entries wrote `src/v2-tasks.ts`, 3 modified `src/proxy.ts`
 *   p22-1  → both entries modified `src/v2-tasks.ts` + `src/proxy.ts`
 *   p22-2  → both entries modified `src/v2-tasks.ts` (or v2-skills.ts) + proxy
 *
 * When fanning out parallel agents, partition the file space cleanly:
 *
 *   - Give each entry its OWN source file (one writes v2-tasks.ts, the
 *     other writes v2-skills.ts) — don't fan out tasks that both edit
 *     v2-tasks.ts in parallel.
 *   - For shared anchor files like `src/proxy.ts`, route all dispatch
 *     wiring through ONE entry; the others export handlers from their
 *     own files. Avoids the 3-way proxy.ts merge that bit p21-3.
 *
 * If you do declare overlapping `targetFiles`, ship.ts logs a warning at
 * batch start so the operator can choose to abort before agents run.
 */

export interface BatchEntry {
  /** Short slug used as the worktree branch name (worktree-<branch>). */
  branch: string;
  /** Prompt for the agent. Keep it spec-only; commit discipline comes from settings. */
  prompt: string;
  /**
   * Files this entry is expected to write. Used by ship.ts for the
   * pre-flight overlap check — if two entries in the same batch declare
   * the same file, ship.ts logs a warning before launching agents.
   * Optional: when omitted, the overlap check skips this entry.
   */
  targetFiles?: string[];
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
          "Read PLAN.md task P8-A6. Extend src/logger.ts so every line includes vault_id + vault_slug. Add src/vault-usage.ts with in-memory counters (requests/writes/embed_tokens/search_queries) that flush to vault_usage_daily every 60s via upsert. NOTE: the embed-server was retired (#22) — embeddings go direct to Voyage AI from grove-server. Instead of header propagation, log vault_id + vault_slug + embed_tokens around each Voyage call in src/embed.ts (or wherever the Voyage API is invoked). Run npm test. Commit as feat(P8-A6).",
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

  // ── Phase 8B follow-up: route restructure (P8-B3) ────────────────
  //
  // Resolved via /grill-me on 2026-04-22 after the in-session P8-B3 deferral:
  //
  //   - Second-user onboarding is imminent (1–2 weeks); that user will
  //     *own* their own vault AND *consume* John's → cross-user URL
  //     sharing makes bare `/dashboard` ambiguous from day 1.
  //   - B3 ships BEFORE onboarding so the new user never sees bare URLs.
  //   - Bundle MRU plumbing (`vault_members.last_active_at` updates + the
  //     bare-route 301 logic) into this batch so the feature lands complete.
  //   - Scope: ALL authenticated routes move — dashboard (+ 9 subroutes),
  //     profile, images, trails, settings. `/s/<share-id>`, `/login`,
  //     `/callback`, `/home` stay bare (not vault-scoped).
  //
  // Requires grove-www PR flow (ship.ts pushes directly to grove-www/main,
  // but a refactor this size should really go through a review cycle —
  // the agent is pre-briefed to open a PR rather than push direct).
  {
    id: "p8b-3-routes",
    title: "feat(P8-B3): grove-www route restructure → /@<handle>/<vault>/*",
    requires: ["p8b-3"],
    entries: [
      {
        branch: "p8b-3-mru-hook",
        prompt:
          "Read PLAN.md tasks P8-B3 and the 'Locked design decisions' table (decision #11: MRU landing). " +
          "Goal: wire MRU plumbing so bare `/dashboard` can 301 to the user's most-recently-used vault. " +
          "In src/proxy.ts, after successful bearer validation, throttled 1/min per (user_id, vault_id), " +
          "run `UPDATE vault_members SET last_active_at = datetime('now') WHERE user_id = ? AND vault_id = ?`. " +
          "The throttle is in-memory Map keyed by `${user_id}\\0${vault_id}` → last-update timestamp. " +
          "Skip the update on /health, /metrics, and any unauthenticated path. " +
          "Add test/vault-members-mru.test.ts covering: first request writes, second within 60s is debounced, " +
          "second after 60s writes again, no-op when vault_members row missing. " +
          "Run `npm test`. Commit as feat(P8-B3).",
      },
      {
        branch: "p8b-3-routes-move",
        prompt:
          "Read PLAN.md task P8-B3 and /Users/jm/src/grove/CLAUDE.md cross-repo rules. " +
          "This batch also works in /Users/jm/src/grove-www via PR (not direct push — the design-lint + " +
          "playwright hooks are strict). Goal: move every authenticated grove-www route under " +
          "/@<atHandle>/<vaultSlug>/*. Concretely:\n" +
          "\n" +
          "1. Create grove-www/src/app/(resident)/[atHandle]/[vaultSlug]/layout.tsx that resolves the " +
          "   vault from vaultSlug + sets up the app shell (header + sidebar).\n" +
          "2. Move dashboard/, profile/, images/, trails/, settings/ from src/app/ → " +
          "   src/app/(resident)/[atHandle]/[vaultSlug]/. This includes dashboard's 10 subroutes.\n" +
          "3. `src/components/dashboard-nav.tsx` and `src/components/breadcrumbs.tsx` — every internal " +
          "   link currently like `/dashboard/keys` must become `/@${handle}/${slug}/dashboard/keys`. " +
          "   Derive handle + slug from params via a useScopedLink() hook or similar — do NOT hardcode.\n" +
          "4. Replace the old src/app/dashboard/, profile/, images/, trails/, settings/ entries with " +
          "   redirect shims that 301 to `/@<handle>/<mru-or-earliest>/<same-path>`. Call the backend's " +
          "   /v1/me to resolve MRU; fall back to earliest-joined by `vault_members.joined_at` ASC when " +
          "   `last_active_at` is null. Preserve query string.\n" +
          "5. `src/app/api/auth/callback/route.ts` — post-magic-link redirect currently goes to /dashboard. " +
          "   Update to resolve MRU vault + redirect to /@<handle>/<mru>/dashboard.\n" +
          "6. Mount the already-built `connected-vaults-list.tsx` (landed in grove-www PR #18) at " +
          "   `/@<handle>/<vault>/settings/vaults/page.tsx`. Closes P8-B5's route-wiring follow-up.\n" +
          "7. Wire the already-built `vault-switcher.tsx` (grove-www PR #17) into `src/components/header.tsx`. " +
          "   Feed it `vaults` from /v1/me + currentSlug from params.\n" +
          "\n" +
          "Out of scope: /s/<share-id> (public, stays bare), /login, /callback, /home. Do NOT move these.\n" +
          "\n" +
          "Tests: update every Playwright spec that references bare /dashboard, /profile, /images, /trails, " +
          "/settings (~37 lines across ~7 specs per the ship run on 2026-04-22). Add one new spec that " +
          "verifies bare-route 301 preserves query string + lands at the MRU vault. Do not remove the " +
          "existing legacy-redirects spec — extend it. " +
          "\n" +
          "Open a PR on grove-www (do NOT push direct to main — the design-lint pre-push hook + playwright " +
          "mobile suite need review-loop gates for a change this size). Run `npm run test:mobile` locally " +
          "before opening. Commit as feat(P8-B3).",
      },
    ],
  },

  // ── Phase 20A: Dashboard IA — collapse to Home + Access ─────────────
  //
  // Spec: /Users/jm/src/grove/PLAN.md § Phase 20 (committed 2026-04-23).
  // Pre-req: grove-www PR #29 (P8-B6 profile hoist) must be merged first —
  // the avatar menu imports `userScopedPath()` + `userLink()` from
  // grove-www/src/lib/vault-context.ts + src/hooks/use-scoped-link.ts which
  // land in that PR.
  //
  // Cross-repo batch:
  //   - `p20a-grove`      → grove/src/proxy.ts (remove handleStatusGraph)
  //   - `p20a-grove-www`  → everything else, opens PR in grove-www
  // The two entries are independent: grove's endpoint can 404 before the UI
  // ships (the graph page is being deleted anyway). Follow p8b-3-routes
  // precedent for grove-www PR flow — the design-lint pre-push + playwright
  // gates are strict, so the agent must open a PR not push direct.
  {
    id: "p20a-1",
    title: "feat(P20-A): dashboard IA — Home + Access, delete Graph",
    requires: ["p8-b6"],
    entries: [
      {
        branch: "p20a-grove",
        prompt:
          "Read PLAN.md task P20-A5 (grove portion only). " +
          "In /Users/jm/src/grove/src/proxy.ts: remove the `handleStatusGraph` " +
          "import, the dispatch block that calls `handleStatusGraph()`, AND " +
          "the function body itself (plus any helpers called only by it). " +
          "Locate by grep token `handleStatusGraph` — do NOT rely on line numbers. " +
          "DO NOT TOUCH src/vault-graph.ts — `analyzeGraph()` is still called " +
          "by src/vault-stats.ts and src/server.ts. " +
          "Verify: `grep -rn 'handleStatusGraph' src/` returns zero matches; " +
          "`grep -rn 'analyzeGraph' src/` still shows vault-stats.ts + server.ts. " +
          "Run `npm test` and `npx tsc --noEmit`. Commit as feat(P20-A5).",
      },
      {
        branch: "p20a-grove-www",
        prompt:
          "Read PLAN.md tasks P20-A1 through P20-A5 (grove-www portions). This batch " +
          "works in /Users/jm/src/grove-www via PR (not direct push — design-lint + " +
          "playwright hooks are strict). Pre-req: grove-www PR #29 (P8-B6) merged.\n" +
          "\n" +
          "P20-A1 (Access route + move principals):\n" +
          "1. Create src/app/(resident)/[atHandle]/[vaultSlug]/dashboard/access/layout.tsx " +
          "   (server component) rendering <AccessTabs> above {children}.\n" +
          "2. Create dashboard/access/page.tsx calling " +
          "   `permanentRedirect(scopedPath('/dashboard/access/keys'))` using scopedPath() " +
          "   from src/lib/vault-context.ts (DO NOT use relative './keys' — resolves wrong).\n" +
          "3. Move page content (not files) from dashboard/{keys,trails,shares,users}/page.tsx " +
          "   to dashboard/access/{keys,trails,shares,members}/page.tsx. Same data-fetching, " +
          "   same component imports.\n" +
          "4. Rename src/components/user-table.tsx → member-table.tsx; rename component " +
          "   export UserTable → MemberTable. Grep confirms only one importer.\n" +
          "5. Members page: read useSearchParams().get('member'); if present render " +
          "   <MemberDrawer> fetching from existing /v1/admin/users (NO new API). " +
          "   Clicks call router.replace(?member=<id>). Esc clears param.\n" +
          "6. DELETE dashboard/{keys,trails,shares,users}/ folders after move (route " +
          "   collision with the P20-A2 redirects otherwise — file routes win).\n" +
          "\n" +
          "Tab labels (trust-radius order): Keys · Scoped Keys · Shares · Members.\n" +
          "aria-current='page' on active tab based on usePathname().startsWith('/dashboard/access/<tab>').\n" +
          "access-tabs.tsx and member-drawer.tsx are client components.\n" +
          "\n" +
          "P20-A2 (next.config.ts redirects): add async redirects() returning 6 entries for " +
          "/dashboard/{keys→access/keys, trails→access/trails, shares→access/shares, users→access/members, " +
          "graph→dashboard, lifecycle→dashboard} — all permanent: true. Parameters " +
          "'/@:atHandle/:vaultSlug/...'. Extend test/legacy-redirects.spec.ts: import " +
          "nextConfig directly, call `await nextConfig.redirects()`, assert each new entry. " +
          "Assert no redirect source equals another redirect's destination (no chains). " +
          "Don't test query preservation (framework does it); don't test fragments " +
          "(browser-side only).\n" +
          "\n" +
          "P20-A3 (DashboardNav rewrite): src/components/dashboard-nav.tsx — exactly 2 rail " +
          "links: Home (scopedPath('/dashboard')) and Access (scopedPath('/dashboard/access')). " +
          "Home active on exact pathname match; Access active on pathname.startsWith('/dashboard/access'). " +
          "aria-current='page' on active. Use useScopedLink() from src/hooks/use-scoped-link.ts. " +
          "Add test/dashboard-nav.spec.ts mocking usePathname per case.\n" +
          "\n" +
          "P20-A4 (Avatar menu): new src/components/avatar-menu.tsx (client) showing initials " +
          "button (no gravatar). Dropdown: 'Signed in as <email>' | Profile (userScopedPath('/profile')) " +
          "| Account settings (userScopedPath('/settings/vaults')) | Sign out (reuse existing handler; " +
          "grep signOut). Closes on outside-click, Esc, link-click. No portal; no focus trap. " +
          "aria-haspopup='menu', aria-expanded, aria-label='Account menu'; menu role='menu'. " +
          "Fallback: if email missing from /v1/me, use handle initials. Wire into header.tsx " +
          "right of vault switcher. Add test/avatar-menu.spec.ts.\n" +
          "\n" +
          "P20-A5 (grove-www deletions): delete dashboard/graph/ and dashboard/lifecycle/ folders " +
          "entirely. Edit package.json to remove d3 + @types/d3 (keep mermaid). Regenerate " +
          "package-lock.json via npm install. Verify `grep -rn \"from ['\\\"]d3['\\\"]\" src/` returns zero.\n" +
          "\n" +
          "Open a PR on grove-www. Run `npm run test` + `npx tsc --noEmit` + `npm run test:mobile` " +
          "locally before opening. Commit as feat(P20-A).",
      },
    ],
  },

  // ── Phase 21: v2 Server Surface — Reads ────────────────────────────
  {
    id: "p21-1",
    title: "feat(P21-1): per-vault SQLite tooling",
    entries: [
      {
        branch: "p21-per-vault-db",
        prompt:
          "Read PLAN.md task P21-1. Create src/db-per-vault.ts exporting getVaultDb(vaultId) → SQLite handle bound to ~/.grove/vaults/<slug>/state.db (connection pool keyed by vaultId; lazy-create directory + file if missing). Also export forEachVaultDb(fn) that iterates all vaults in the control db. Add src/migrations/vault/001_init_vault_state.sql creating only a _migration_state table. Add a per-vault migration runner that applies src/migrations/vault/*.sql files in lexical order, tracked in _migration_state. Extend scripts/backup-s3.sh to enumerate ~/.grove/vaults/*/state.db files into the backup tarball. Tests: test/db-per-vault.test.ts (pool reuse, missing-vault throws, runner idempotent). Run npm test. Commit as feat(P21-1).",
      },
    ],
  },
  {
    id: "p21-2",
    title: "feat(P21-2): v2 tasks schema",
    requires: ["p21-1"],
    // Schema change — AGENTS.md requires human review before merge.
    noAutoMerge: true,
    entries: [
      {
        branch: "p21-tasks-schema",
        prompt:
          "Read PLAN.md task P21-2. Add src/migrations/vault/002_v2_tasks.sql creating per-vault tables: tasks (id, skill_slug, state CHECK IN ('pending','running','review','done','dismissed','failed'), title, body, source_note_path, estimated_minutes, actual_minutes, scheduled_for, started_at, completed_at, source_flag_id, created_at, updated_at) with idx_tasks_state_scheduled + idx_tasks_skill_slug; task_results (task_id PK REFERENCES tasks(id) ON DELETE CASCADE, artifact_json, note_change_json, provenance_*, created_at); skill_configs (skill_slug PK, enabled, cadence CHECK IN ('daily','weekly','on-demand'), last_run_at, next_run_at, created_at, updated_at). Add src/db-types.ts with TS types Task, TaskResult, SkillConfig matching grove-www/src/lib/grove-api.v2.types.ts field names. Migration must be idempotent (CREATE TABLE IF NOT EXISTS) and transactional. Tests: test/db-migration-v2-tasks.test.ts. Run npm test. Commit as feat(P21-2).",
      },
    ],
  },
  {
    id: "p21-3",
    title: "feat(P21-3, P21-4, P21-5): v2 read endpoints",
    requires: ["p21-2"],
    entries: [
      {
        branch: "p21-tasks-list",
        prompt:
          "Read PLAN.md task P21-3 AND the Phase 21 revision-note block above the Goal. Create src/v2-tasks.ts (per existing share.ts/waitlist.ts convention — NOT a generic v2-routes.ts) exporting handleV2TasksList(req, res, vault). Wire dispatch INSIDE the existing vaultV1Match block at src/proxy.ts:1742+ — the path is GET /v/<slug>/v1/tasks (path-style, NOT query-string ?vault=). This inherits the existing auth/role/CORS block; do NOT bypass it. Query per-vault state.db: reviewTasks (state='review' DESC), pendingTasks (state IN ('pending','running') by scheduled_for ASC NULLS LAST, created_at DESC), clearedTasks (state='done' DESC LIMIT 20). Use SELECT column-aliases (skill_slug AS skillId, ...) so query results pass through as the typed shape; no separate mapper module. Build BacklogPayload matching grove-www/src/lib/grove-api.v2.types.ts EXACTLY (Task.description is the DB column 'body'; Task.skillId is DB 'skill_slug'). throughput call delegates to a shared computeThroughput(vault_id) helper. skills returns the registry-merged Skill[] (3 skills only, see P21-5). planTier='free' for v2. 403 on slug mismatch (proxy already handles this — your handler runs AFTER the auth gate). Test: test/v2-tasks-list.test.ts. Run npm test. Commit as feat(P21-3).",
      },
      {
        branch: "p21-task-detail-throughput",
        prompt:
          "Read PLAN.md task P21-4 AND the Phase 21 revision-note block. In src/v2-tasks.ts add handleV2TaskDetail(req, res, vault, taskId). Also export computeThroughput(vault_id) helper for P21-3 reuse. Standalone /v1/throughput endpoint CUT (Scope Cop) — throughput lives inside BacklogPayload only. Wire dispatch INSIDE vaultV1Match block at src/proxy.ts:1742+ for GET /v/<slug>/v1/tasks/<id>. Detail: read tasks + task_results from per-vault state.db. task_results.provenance is a single JSON column (provenance_json TEXT) parsed back to GroveProvenance object; if artifact.type='note-change', join note_blame rows from control.db via ATTACH (BEGIN IMMEDIATE; ATTACH 'grove.db' AS control; ...). 404 on unknown task. computeThroughput(vault_id): rollingWeekVelocity = tasks_completed_last_28d / 4 (or null if 0 completed); cleared7d count; estimatedClearText = (velocity > 0) ? `≈${Math.ceil(pending/velocity)} weeks at your pace` : 'warming up'; showCeiling=false when earliest vault_members.created_at < 14d old. Tests: test/v2-task-detail.test.ts + test/v2-throughput.test.ts (helper-direct). Run npm test. Commit as feat(P21-4).",
      },
      {
        branch: "p21-skills-list",
        prompt:
          "Read PLAN.md task P21-5 (heavily revised — match grove-www/src/lib/grove-api.v2.types.ts Skill interface EXACTLY). Create src/skills/registry.ts with hardcoded metadata for ONLY 3 skills (4 metadata-only entries CUT by Scope Cop): daily-vault-review, concept-graph-cleanup, dup-people-detection. Each registry entry matches the Skill interface: {id (uuid), slug, name, domain: enum 'knowledge'|'journal'|'relationships'|'health'|'finances'|'system', author: 'builtin', description, sampleTasks: string[] (camelCase!), cadenceOptions: Cadence[] where Cadence = 'daily'|'weekly'|'on-trigger'|'on-demand', defaultCadence: Cadence|null, defaultArtifactType: TaskArtifactType, starterPendingTasks?: string[]}. Create src/v2-skills.ts (separate from src/v2-tasks.ts) exporting handleV2SkillsList. Wire dispatch INSIDE vaultV1Match block at src/proxy.ts:1742+ for GET /v/<slug>/v1/skills. installState derivation: skill_configs row missing or enabled=0 → 'available'; enabled=1 → 'installed'. Default values when no skill_configs row: defaultCadence from registry + installState='available'. Test: test/v2-skills-list.test.ts — assert each result satisfies Skill via TS type satisfies. Run npm test. Commit as feat(P21-5).",
      },
    ],
  },

  // ── Phase 22: v2 Server Surface — Writes ───────────────────────────
  {
    id: "p22-1",
    title: "feat(P22-1, P22-2): task run + defer/dismiss",
    requires: ["p21-3"],
    entries: [
      {
        branch: "p22-task-run",
        prompt:
          "READ PLAN.md Phase 22 REVISION NOTES FIRST — they override inline details below. Task P22-1. Create src/v2-task-run.ts with the execution dispatcher. In src/v2-tasks.ts (NOT v2-routes.ts) add handleV2TaskRun(req, res, vault, taskId). Wire POST /v/<slug>/v1/tasks/<id>/run dispatch INSIDE the vaultV1Match block at src/proxy.ts:1742+. Async pattern (per revision notes): handler reads task, validates state, transitions pending→running, RETURNS 202 IMMEDIATELY with current state. Actual execution happens in the task-worker loop (setInterval(1000) polling tasks WHERE state='running' AND started_at < 1s ago LIMIT 1) which lives in src/scheduler.ts (Phase 23) OR a minimal in-process version landed here. NO 25s in-line timeout. State transitions in HTTP handler only: pending → running (returns 202); review (returns 200 with current task — idempotent); terminal (done/dismissed/failed) → 409; already-running → 409. Skill executor invoked via dynamic import from src/skills/<slug>.ts inside the worker loop; for P22-1 a stub executor is acceptable (P22-5 lands the real daily-vault-review). On executor error: state='failed', task_results.artifact contains the error. Test: test/v2-task-run.test.ts. Run npm test. Commit as feat(P22-1).",
      },
      {
        branch: "p22-task-defer-dismiss",
        prompt:
          "READ PLAN.md Phase 22 REVISION NOTES FIRST — they override inline details. Task P22-2. In src/v2-tasks.ts (NOT v2-routes.ts) add handleV2TaskDefer and handleV2TaskDismiss. Wire POST /v/<slug>/v1/tasks/<id>/defer and POST /v/<slug>/v1/tasks/<id>/dismiss dispatch INSIDE the vaultV1Match block at src/proxy.ts:1742+. Defer: body {until: ISO}, sets scheduled_for, only valid for pending|review (others 409), bad ISO → 400. Dismiss: state=dismissed, idempotent. Write-through: if source_flag_id non-null on dismiss, UPDATE graph_health_flags SET resolved_at=datetime('now') in control.db via ATTACH (BEGIN IMMEDIATE; ATTACH '<grove.db path>' AS control; UPDATE control.graph_health_flags SET resolved_at=datetime('now') WHERE id = ?; COMMIT) in same transaction. Tests: test/v2-task-defer.test.ts + test/v2-task-dismiss.test.ts (including the ATTACH path). Run npm test. Commit as feat(P22-2).",
      },
    ],
  },
  {
    id: "p22-2",
    title: "feat(P22-3, P22-4): task review + skill config",
    requires: ["p22-1"],
    entries: [
      {
        branch: "p22-task-review",
        prompt:
          "READ PLAN.md Phase 22 REVISION NOTES FIRST. Task P22-3. Create src/v2-task-review.ts with action dispatch. In src/v2-tasks.ts (NOT v2-routes.ts) add handleV2TaskReview. Wire POST /v/<slug>/v1/tasks/<id>/review dispatch INSIDE the vaultV1Match block at src/proxy.ts:1742+. Body {action: 'confirm-durable'|'refine'|'dismiss'|'mark-stale', refinement?: string}. Validate task in state='review' (else 409). confirm-durable: if artifact.type='note-change', apply via existing write queue (src/vault-ops.ts) with provenance {voice:'durable', by: <api_key.user_id from auth resolution>}; state→done. refine: require refinement field; apply user-authored edit via write queue with provenance {voice:'durable', by:'human'}; state→done. dismiss: state→dismissed + graph_health_flags write-through (use the same ATTACH pattern as P22-2). mark-stale: state→dismissed, append stale marker to body (NOT the description column — body is the DB column). Test: test/v2-task-review.test.ts — verify each action produces correct commit trailers (Provenance-Voice + Provenance-By). Run npm test. Commit as feat(P22-3).",
      },
      {
        branch: "p22-skill-config",
        prompt:
          "READ PLAN.md Phase 22 REVISION NOTES FIRST. Task P22-4. In src/v2-skills.ts (NOT v2-routes.ts) add handleV2SkillConfigure, handleV2SkillEnable, handleV2SkillDisable. Wire POST /v/<vault-slug>/v1/skills/<skill-slug>/configure, /enable, /disable dispatch INSIDE the vaultV1Match block at src/proxy.ts:1742+. configure: body {cadence: 'daily'|'weekly'|'on-trigger'|'on-demand'} — note: cadence enum includes 'on-trigger' per grove-www/src/lib/grove-api.v2.types.ts; UPSERT skill_configs. enable: UPSERT enabled=1, set next_run_at by cadence (1d/7d/NULL for on-demand and on-trigger). disable: UPSERT enabled=0, next_run_at=NULL. All three return the post-update Skill shape matching the Skill interface (with installState='installed' when enabled=1). Unknown skill slug → 404. Invalid cadence → 400. Tests: test/v2-skill-configure.test.ts + test/v2-skill-enable-disable.test.ts. Run npm test. Commit as feat(P22-4).",
      },
    ],
  },
  {
    id: "p22-3",
    title: "feat(P22-5): daily-vault-review executor",
    requires: ["p22-2"],
    entries: [
      {
        branch: "p22-daily-vault-review",
        prompt:
          "READ PLAN.md Phase 22 REVISION NOTES FIRST — sampling/partial CUT per Scope Cop. Task P22-5. Create src/skills/cost-ceiling.ts (shared helper) with estimateRunCost(vault_size) → number + recordRunCost(skill_slug, tokens) + exceededCeiling(estimate, ceiling) → boolean. NO shouldSample function — hard-fail on ceiling exceeded. Create src/skills/daily-vault-review.ts exporting runDailyVaultReview(vault, {mode, tokenCeiling}) → Promise<TaskResult>. Read up to 5 unresolved graph_health_flags rows (where resolved_at IS NULL) + up to 5 high-confidence discovery_results (cosine ≥ 0.9). Construct 3-5 review tasks per run. LLM call via Anthropic SDK using claude-haiku-4-5 with cache_control on the prompt (mirror P7-COST-7 pattern). For each task generated: skill_slug='daily-vault-review', source_flag_id set when derived from a flag, body contains LLM-synthesized framing. Cost ceiling: pre-call estimate; if exceeded, return TaskResult with artifact.type='surface' and a surfaceText explaining the vault is too large for this run + no LLM call made. mode='surface-only' never produces note-change artifacts; mode='writes-allowed' can. Update src/skills/registry.ts to wire executor reference. Real executor replaces the P22-1 stub. Test: test/skills-daily-vault-review.test.ts with seeded fixture vault — assert ceiling-exceeded path produces surface artifact, not partial. Run npm test. Commit as feat(P22-5).",
      },
    ],
  },

  // ── Phase 23: v2 Server Surface — Autonomy ─────────────────────────
  {
    id: "p23-1",
    title: "feat(P23-1): grove-scheduler PM2 process",
    requires: ["p22-3"],
    entries: [
      {
        branch: "p23-scheduler",
        prompt:
          "READ PLAN.md Phase 23 REVISION NOTES FIRST — they significantly revise architecture. Task P23-1. Create src/scheduler.ts with TWO loops in one process: (1) cron tick loop (1-min setInterval) reads skill_configs WHERE enabled=1 AND next_run_at <= datetime('now') AND ENQUEUES tasks (INSERT pending row + UPDATE next_run_at by cadence). on-demand and on-trigger never auto-enqueue. (2) worker drain loop (1s setInterval) selects tasks WHERE state='pending' AND scheduled_for <= datetime('now') ORDER BY scheduled_for ASC LIMIT 1, claims it (UPDATE state='running'), invokes the executor via dynamic import from src/skills/<slug>.ts, writes task_results + transitions state to review/done/failed on completion. Process is PER-VAULT — pinned via GROVE_VAULT_ID env var, mirrors src/discovery-worker.ts:30 pattern. Create src/scheduler-bin.ts as PM2 entry that reads GROVE_VAULT_ID, opens getVaultDb(vault_id), starts both loops. Extend src/ecosystem-gen.ts to emit grove-scheduler-<slug> entries (one per vault, mirroring the existing grove-discovery-<slug> pattern at ecosystem-gen.ts:152) with GROVE_VAULT_ID pinned. Orphan recovery on boot: UPDATE tasks SET state='pending' WHERE state='running' AND started_at < datetime('now', '-5 minutes') (mirrors discovery's recoverOrphanedDiscoveryProcessing fix #151). Also: check vaults.bootstrap_pending=1 on boot and on each tick — if set, call bootstrapFirstRun(vault) (P23-2) and reset the flag. Add idx_tasks_state_started_at to P21-2 schema. Test: test/scheduler-tick.test.ts + test/scheduler-worker.test.ts + test/scheduler-orphan-recovery.test.ts. Update CLAUDE.md Architecture section adding grove-scheduler-<slug> to per-vault process list. Run npm test. Commit as feat(P23-1).",
      },
    ],
  },
  {
    id: "p23-2",
    title: "feat(P23-2): first-run choreography",
    requires: ["p23-1"],
    entries: [
      {
        branch: "p23-first-run",
        prompt:
          "READ PLAN.md Phase 23 REVISION NOTES FIRST — bootstrap pattern significantly revised. Task P23-2. Add a new column `bootstrap_pending INTEGER NOT NULL DEFAULT 0` to the existing vaults table in grove.db (migration step). Extend src/vault-provision.ts: after vault provisioned, simply UPDATE vaults SET bootstrap_pending=1 WHERE id=? — do NOT invoke any LLM call or skill executor synchronously in provision. The scheduler picks this up. Create src/skills/first-run.ts exporting bootstrapFirstRun(vault) — idempotent. bootstrapFirstRun: INSERT skill_configs for daily-vault-review (enabled=1, cadence='daily', next_run_at = next 6am America/Los_Angeles converted to UTC). INSERT 3-5 starter tasks (state='pending') from each enabled skill's starterPendingTasks registry field (note: starterPendingTasks, not sample_tasks — match Skill type). INSERT one immediate daily-vault-review task (state='pending', scheduled_for=datetime('now')). The scheduler's worker loop (P23-1) will drain this immediate task and run it surface-only. Reset vaults.bootstrap_pending=0 at the end. Idempotency: function is no-op if skill_configs already has daily-vault-review row. Tokens cap for first run: 50_000 input tokens (mirror P7 cost pattern). Slow-vault UX: if the worker hasn't finished within 25s, the task stays in state='running' and the dashboard renders 'still working — refresh in a minute' by detecting started_at > 25s ago. NO inline timeout in bootstrapFirstRun. Test: test/skills-first-run.test.ts — bootstrap flips flag + creates rows; idempotent; scheduler tick picks up flagged vault. Run npm test. Commit as feat(P23-2).",
      },
    ],
  },
  {
    id: "p23-3",
    title: "feat(P23-3, P23-4): concept-graph + dup-people executors",
    requires: ["p23-2"],
    entries: [
      {
        branch: "p23-concept-graph-cleanup",
        prompt:
          "Read PLAN.md task P23-3. Create src/skills/concept-graph-cleanup.ts exporting runConceptGraphCleanup(vault, options) → Promise<TaskResult>. Read graph_health metrics + vault note list. Identify candidates: thin concepts (<100 words + no outbound links), orphans, near-duplicate concept titles (Levenshtein ≤ 3 on slugified titles). Cap candidates at ~3 per run. For each: LLM-synthesize a proposed edit via claude-haiku-4-5 (use prompt caching). Produce note_change_json artifacts; state='review'. Token ceiling via src/skills/cost-ceiling.ts. Update src/skills/registry.ts executor reference. Test: test/skills-concept-graph-cleanup.test.ts with seeded fixture. Run npm test. Commit as feat(P23-3).",
      },
      {
        branch: "p23-dup-people-detection",
        prompt:
          "Read PLAN.md task P23-4. Create src/skills/dup-people-detection.ts exporting runDupPeopleDetection(vault, options) → Promise<TaskResult>. Iterate Resources/People/*.md paths. For each pair: combine cosine similarity (≥0.85 on Voyage embeddings) with Levenshtein name distance (≤4). Top ~3 candidates per run. LLM-synthesize merge proposals via claude-haiku-4-5 (with prompt caching). Artifact is note_change_json proposing merge (target note + redirect from duplicate). state='review'. Cost ceiling via shared helper. Update src/skills/registry.ts. Test: test/skills-dup-people-detection.test.ts. Run npm test. Commit as feat(P23-4).",
      },
    ],
  },
  // P23-5 (watchdog) CUT from Phase 23 per Scope Cop — runbook hardening,
  // not part of the v2 ship. File as a separate IDEAS spark post-Phase-23.
];

export function findBatch(id: string): Batch | undefined {
  return BATCHES.find((b) => b.id === id);
}

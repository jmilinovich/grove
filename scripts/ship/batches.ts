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
];

export function findBatch(id: string): Batch | undefined {
  return BATCHES.find((b) => b.id === id);
}

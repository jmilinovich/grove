# Grove Simplification — Working Doc & Resume Point

**Status:** Decision made 2026-05-27 — **TEARDOWN.** Grove served its purpose as an intellectual exercise. The hosted product is winding down; the cathedral becomes open source at `github.com/jmilinovich/grove` (already public).
**As of:** 2026-05-27 · **Companion:** [`ZOOM-OUT.md`](./ZOOM-OUT.md) (full analysis, diagram, matrix).

> John felt Grove was at a local maximum and wanted to zoom out across all interfaces (app, MCP, CLI, REST) to prune / consolidate / simplify. Six parallel audit subagents mapped the system. The zoom-out made the call obvious: tear it down, keep the core open source, accept that nobody (including John) needs to rely on it as a hosted product. This file is the resume point — read it + `ZOOM-OUT.md` and you're fully booted.

---

## The thesis (one sentence)

Grove is **one product John uses daily** — a personal knowledge API (6 MCP tools over a git-backed vault) — **wearing two costumes it has no users for**: a multi-tenant SaaS and an autonomous knowledge-gardening agent. Simplification = take off both costumes. Teardown = also retire the hosted infra and reshape the public repo into the cathedral-only library.

## ✅ The decision (made 2026-05-27)

**Personal tool, tearing down the hosted product.** Grove served its purpose as an intellectual exercise. Keep the cathedral pieces open source at the existing public repo; stop running it as a service.

- **Hosted product:** sunsetting. Sharpshoot (one active outside user) gets a hard-cut notice with vault bundle on request. Ryan (signed up 05-01, never used a key) gets no notice. Waitlist (1 real signup) gets no notice.
- **Personal MCP→vault access:** deferred. Obsidian-only for now. If John misses the AI integration later, spin up local-only Grove from the open-source core then.
- **Echo (autonomous agent on OpenClaw):** also loses its write path. Accept it goes quiet; can resurrect with local Grove if/when worth it.
- **The cathedral that survives:** 6-tool MCP · hybrid-search (BM25+vec RRF) · live per-write embed · git single-writer write-queue · provenance/blame · discovery extract→link engine.
- **The costumes that go:** trails · encryption · invite/waitlist/email · admin portal · v2-tasks/skills/decisions/scheduler · first-run auto-enable · multi-tenant routing/auth (collapse to single-vault, single-user).

---

## Teardown sequence (the layer above the Tier 0/1/2 plan)

### Day 0 — today, 2026-05-27 (safe, reversible)
- [x] Update this file with the decision + teardown sequence (this commit)
- [ ] Draft sharpshoot notice (`SHARPSHOOT-NOTICE.md`) for John's review before sending
- [ ] Generate sharpshoot vault git-bundle on prod (read-only, hold locally; send only if requested)
- [ ] Start Tier 0 deletes (provably dead, ~900 lines, zero behavior change)

### Day 1 — send notice + start visible cuts
- [ ] Send sharpshoot email (after John approves draft)
- [ ] Disable `first-run.ts:66` auto-enable on prod (stop new autonomous LLM spend immediately)
- [ ] Begin Tier 2 cuts on `main`: rip trails, encryption, invite/waitlist/email, admin portal HTML, HN-LAUNCH.md → archived; v2-tasks/skills/decisions/scheduler → archived
- [ ] Update `homepageUrl` and repo description to reflect new framing

### Days 2-5 — reshape the public repo
- [ ] Tier 1 consolidations (3-into-1 graph walks, single search path, single watchdog, fold `provenance-prior` → `provenance`, split `proxy.ts`)
- [ ] Collapse multi-tenant → single-vault: drop control-db, drop `vault_id` columns, single `~/.grove/state.db`, single API key from env
- [ ] Rewrite `README.md` for "personal MCP layer over an Obsidian vault, single-user, self-host"
- [ ] Rewrite `CLAUDE.md` for the simplified shape
- [ ] Rewrite `GOAL.md` (or delete — 175-pt fitness function is abandoned)
- [ ] Reconcile or delete `PLAN.md` (snapshot from 04-21, lying about state)

### Day 7 — shut down prod
- [ ] Final vault snapshot to local backup + S3 (personal + echo)
- [ ] `pm2 kill` on prod
- [ ] Terminate EC2 (i-instance) + release EBS + release elastic IP
- [ ] Retire `api.grove.md` DNS → static 410 page or NXDOMAIN
- [ ] Confirm next AWS invoice goes to $0
- [ ] Revoke Voyage AI key, Resend key, any other costed externals

### Day 7+ — close the chapter
- [ ] Tag `v1.0.0` on `main` as "the core"
- [ ] Tag `v0.999-archive` on a separate branch with the full pre-teardown history preserved
- [ ] Delete `~/src/grove-phase-1-2` (subsumed) and `~/src/grove-www-worktrees` (empty)
- [ ] Decide grove-www repo fate: archive vs delete vs keep as static landing
- [ ] Short retirement note as the repo README banner: "Grove was a hosted product 2026-04 to 2026-05. This repo is the open-source cathedral that came out of it."

---

## Plan checklist (update the boxes as work lands)

### Tier 0 — provably dead, zero behavior change (do anytime, no decision needed)
- [ ] Delete `src/embed.ts` (OpenAI-era, Voyage-superseded, zero importers — 279 lines)
- [ ] Delete `src/discovery-neighbors.ts` + dead `discovery_results` plumbing (`getDiscoveryResults`/`dismissResult`/`insertDiscoveryResult` in db.ts, the orphaned read in graph-health.ts:498) — no caller since 04-29, 186 lines
- [ ] Delete `autoHeal` + helpers from `src/graph-health.ts` (tests-only, ~400 lines)
- [ ] Delete repo `~/src/grove-phase-1-2` (fully subsumed by grove, last commit 04-22) and `~/src/grove-www-worktrees` (empty mount). LEAVE `~/src/dm/grove-dump-2026-05-03` (misnamed interview-prep, not Grove)
- [ ] Delete `~/src/grove-www/SPEC.draft.md` (superseded) + `iterations.jsonl` (dead tuning loop)
- [ ] Stale comment cleanup: remove the "not yet wired" TODO in `src/blame-warmup.ts:31` (it IS wired via `/internal/post-sync-warmup`)

### Tier 1 — consolidate duplicated capabilities (safe; reduces surface)
- [ ] **One vault-health surface** — merge `graph-health.ts` + `vault-graph.ts` + `vault-stats.ts` (3 graph-walks → 1); `/garden:tend` + `/garden:pulse` become the client lens, not parallel compute
- [ ] **One usage dashboard** — kill server `/admin/usage` HTML (`admin-usage.ts renderUsageHtml`); grove-www's styled page wins
- [ ] **One watchdog** — drop `admin-watchdog.ts`; `/grove:watchdog` skill owns ops health
- [ ] **One search path** — `query` MCP tool (server.ts:493-582) re-implements `rest.ts handleSearch`; route both through one function
- [ ] **One embed module** — merge `embed-single.ts` (live per-write) + `embed-node.ts` (bulk CLI); shared chunking constants are drifting by copy-paste
- [ ] **Fold** `provenance-prior.ts` → `provenance.ts` (98 lines, single importer)
- [ ] **Split** `proxy.ts` (4,043 lines; one 2,800-line handler) — extract `oauth.ts`, auth-page HTML/cookie-session routes, and the `/v1/*` dispatch table into routers. Falsifier before deleting vestigial QMD plumbing (`proxyToQmd`, `/search`→:8177, QMD_PORT=8181): `ssh prod 'sudo lsof -i :8177 -i :8181'` — if nothing listens, cut it
- [ ] **Finish** grove-www flat→scoped route migration; delete redirect shims once nothing links to flat paths

### Tier 2 — strategic cuts (GATED on the decision; assumes "personal")
- [ ] **Extract the agent** — move v2-tasks / server skills / decisions / scheduler to `goal-md` or its own repo (it hangs off `/v1/tasks*`, consumed only by grove-www; MCP core doesn't depend on it). At minimum: turn OFF `first-run.ts:66` auto-enable (it auto-enrolls every new vault into LLM-spending autonomous mutation in ~60s) and stop building
- [ ] **Retire trails** — `trails.ts` + CRUD routes + `filterByTrail` calls in rest.ts (50-pt GOAL bet, never consumed)
- [ ] **Retire encryption** — `crypto.ts` + `index-crypto.ts` + `encrypt/lock/unlock` CLI (0 vaults encrypted)
- [ ] **Retire/shelve funnel** — `invite.ts`, `waitlist.ts`, `email.ts`; shelve `HN-LAUNCH.md`
- [ ] **Freeze grove-www v2 dashboard** behind its prod guard; ship landing + reader + John's own admin views

### Meta — fix the steering doc (do alongside Tier 2)
- [ ] Rewrite `GOAL.md` to name the real core (the 175-pt fitness function is abandoned, last scored 04-07, and bets 50 pts on Trails which has been dead a month)
- [ ] Reconcile `PLAN.md` "current state" (snapshot from 04-21 undercounts codebase by ~66 modules: 25 → 91). Mark each bet: shipped / dark-launched / abandoned

---

## Evidence appendix (condensed from the 6 audits — so we never re-spawn them)

**Interfaces & what each exposes**
- **MCP** — exactly 6 tools, confirmed (server.ts:470-986): `query`, `get`, `multi_get`, `write_note`, `list_notes`, `vault_status` (7 modes). The disciplined product surface.
- **CLI** (`bin/grove`, cli.ts 3,186 lines) — ~45 commands = union of everything: vault ops · observability (status/diagnostics/graph/digest/health/metrics) · admin (keys/users/trails/share/invite/onboard/vault) · ingest (sync/ingest/bookmarks/sources) · crypto (encrypt/lock/unlock).
- **REST** — ~50 `/v1/*` endpoints, proxy.ts dispatch → rest.ts handlers. Consumed by grove-www only.
- **Web** (grove-www) — landing (live) + note/trail reader (live) + v2 "backlog is homepage" dashboard (built on mock data, hard-404s in prod behind `assertV2Available` unless `GROVE_API_MODE=live`).

**Core (load-bearing, KEEP):** 6-tool MCP · hybrid-search (BM25+vec RRF) + live `embed-single.ts` path · git single-writer `write-queue.ts` · `provenance.ts`/`blame.ts` (475 prod rows, 10 importers — promote into core narrative) · per-vault DB split (`db-per-vault.ts`, makes cross-tenant leaks structurally impossible) · discovery extract→link engine (auto-wikilinks on write, hot, runs as `grove-discovery-<slug>` PM2) · grove-www design system.

**SaaS costume (PRUNE if personal):**
- Trails — 4 exist, ALL trail-granted keys `last_used_at = NULL` (never consumed by any MCP client). 50/175 GOAL pts. Untouched since 04-24. `/trails/*` traffic is John's own browser.
- Encryption — `vault_keys` table empty; 0 `GROVE-ENCRYPTED-v1` files across all prod vaults.
- Users — 3 users / 5 vaults; active = John + sharpshoot only (ryan signed up 05-01, never used a key). Waitlist 5 rows: 4 John's smoke-tests + 1 real lead (jfu213, 05-11).
- HN-LAUNCH.md "ready to post" since 04-13, never fired.
- `share.ts` (share-a-note) got minor REAL use (one link hit 7×, ~15 active) — keep thin; it's the lightweight version of the sharing thesis that actually gets used.

**Agent costume (EXTRACT if personal):**
- v2-tasks + server skills + decisions + scheduler = ~8,300 src lines (22% of src) + ~8,600 test lines (27% of tests).
- Architecture: `grove-scheduler-<slug>` PM2 process; cron tick (60s) enqueues from `skill_configs`, worker drains `tasks`, runs skill executors (enrichment/disambiguation/links-suggestion/dup-people/concept-graph-cleanup), records reversible `Decision` (saga/compensation, forward-only, `.grove/decisions.jsonl` + projection).
- v1 (`daily-vault-review`) was built, shipped, DELETED for non-use; Inbox v2 is the 2nd attempt ("25 items untouched on prod"). 10-commit burst 05-20 then silence.
- Violates CLAUDE.md "Grove is plumbing, vault is cathedral, never make policy decisions about vault content" — enrichment rewrites Concept bodies, links-suggestion injects wikilinks. `first-run.ts:66` auto-enrolls new vaults without explicit consent.

**Duplication hotspots (systems problem):** "vault health" = 3 server modules × 4 interfaces × 2 client skills (~9 impls). "usage" = server HTML + grove-www page + CLI + MCP. Two watchdogs. Search logic in both MCP `query` and REST `handleSearch`.

**Dead repos:** `grove-phase-1-2` (same remote, 04-22, every src file subsumed by grove) + `grove-www-worktrees` (empty) → safe delete. `dm/grove-dump-2026-05-03` → NOT grove (interview-prep), leave it.

**File-size hotspots:** proxy.ts 4,043 · cli.ts 3,186 · db.ts 2,283 (36 tables, much is discovery) · rest.ts 2,046 · graph-health.ts 1,513 (~400 dead) · server.ts 1,411.

---

## Provenance of this analysis (6 subagents, 2026-05-25→26)

1. Core retrieval/data/multi-vault (proxy/server/rest/db/hybrid-search/embed/vault-*)
2. SaaS layer (auth/users/keys/invite/waitlist/email/crypto/trails/share/provenance/admin)
3. Autonomous agent (v2-*/decisions/scheduler/skills)
4. Discovery + images + graph-health + blame + sync
5. grove-www web product (routes, overlap with server portal, finished vs half-built)
6. Strategic/historical (docs vs git-drift, stalled bets, dead repos)

Their conclusions are condensed above; re-spawn only if a section needs deeper file:line detail.

---

## 🔌 Boot prompt (paste into a fresh session to resume)

> Read `~/src/grove/SIMPLIFY.md` and `~/src/grove/ZOOM-OUT.md`. We did a full zoom-out of Grove across all interfaces and found it's a personal knowledge API wearing a SaaS costume and an autonomous-agent costume. The strategic decision (personal tool vs product) is [PENDING / John chose ____]. Pick up at [Tier 0 / Tier 1 / Tier 2] in the SIMPLIFY.md checklist — confirm what's already done via git log, then continue.

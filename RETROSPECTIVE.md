# Grove — Retrospective

> Two months. ~1,065 commits. 68 source modules. 127 test files. Three users. Five vaults. One real waitlist signup. Zero HN posts. One teardown decision made calmly on 2026-05-27.
>
> This document is for compounding. It is written to the next senior engineer (probably you, John, six months from now) who is about to start a big build. Read it as if Grove is a closed lab notebook: what we learned, what we kept, what we threw away, and what we should never do again.

**Companion docs:** [`ZOOM-OUT.md`](./ZOOM-OUT.md) (the strategic audit) · [`SIMPLIFY.md`](./SIMPLIFY.md) (the resulting plan + the 2026-05-27 teardown decision). This retrospective absorbs both into a durable narrative.

---

## Table of contents

1. [What Grove was](#1-what-grove-was)
2. [What Grove tried to be](#2-what-grove-tried-to-be)
3. [The arc, week by week](#3-the-arc-week-by-week)
4. [Why it ended](#4-why-it-ended)
5. [Architecture wins — durable patterns](#5-architecture-wins--durable-patterns)
6. [Architecture losses — anti-patterns](#6-architecture-losses--anti-patterns)
7. [The incident log — hard-earned lessons](#7-the-incident-log--hard-earned-lessons)
8. [Process lessons — the doctrines](#8-process-lessons--the-doctrines)
9. [Tooling & infra lessons](#9-tooling--infra-lessons)
10. [Strategic lessons — the meta](#10-strategic-lessons--the-meta)
11. [AI-collaboration lessons — the meta-meta](#11-ai-collaboration-lessons--the-meta-meta)
12. [What carries forward](#12-what-carries-forward)
13. [What Grove leaves behind](#13-what-grove-leaves-behind)

---

## 1. What Grove was

The artifact that actually existed on the day the teardown decision was made.

### The shape

A hosted knowledge API. One AWS instance (g4dn.xlarge → t3.medium after the embeddings move), one domain (`api.grove.md`), one TLS-terminating nginx, one auth proxy on `:8420`, and a per-vault PM2 trio for each of five vaults (`grove-server-<slug>` on a unique port, `grove-discovery-<slug>` worker, `grove-scheduler-<slug>` worker). Five vaults: `personal`, `sharpshoot`, `echo`, `test-vault`, `ryan`. Three real human users; only two ever issued an MCP call (John daily, Sumon weekly). Cost ≈ $30/month.

The codebase: 68 TypeScript modules (`src/*.ts`), 37,905 source lines, 127 test files at 32,465 lines. Test-to-source ratio ≈ 0.86 — better than the 0.5 target in PLAN.md, materially better than the 0.39 baseline. Raw `node:http`, no web framework, ESM-only, Node ≥ 22, `better-sqlite3` for storage, SQLite FTS5 for BM25, Voyage AI (`voyage-4-large`, 1024-dim) for embeddings, RRF fusion for hybrid search.

### Interfaces — four surfaces over the same core

| Surface | Lines / shape | Audience | Status at teardown |
|---|---|---|---|
| **MCP** | 6 tools registered in `src/server.ts` lines 470, 584, 700, 763, 839, 874 | AI clients (Claude.ai, ChatGPT, Cursor, Echo on OpenClaw) | The product. Disciplined surface. |
| **CLI** | `bin/grove` over `src/cli.ts` (3,186 LOC), ~45 commands | John (ops cockpit), agents (`/garden:plant` etc.) | The cockpit. Sprawled but functional. |
| **REST** | ~50 `/v1/*` endpoints dispatched in `src/proxy.ts`, handlers in `src/rest.ts` (2,046 LOC) | grove-www only | The glue. Re-implemented MCP's logic. |
| **Web** | `grove-www` Next.js app (separate repo) — landing, note reader, v2 dashboard (404s in prod behind a feature gate) | John (admin), future users (landing) | The face. Half-built. |

### The 6 MCP tools

`query`, `get`, `multi_get`, `write_note`, `list_notes`, `vault_status` — registered in `src/server.ts`. The count was load-bearing per architecture rule #6 in `CLAUDE.md`: "≤6 because selection degrades past ~10." Late in the project, that rule was softened (rightly) to "the real cliff is around 50 tools" — Anthropic's Tool Search Tool largely killed count sensitivity in Q1 2026 — but the value of the constraint was never the number, it was the discipline of **avoiding tool-overlap risk**. Six tools that compose was the right design; the discipline held even after the underlying constraint relaxed.

### Capability core (the cathedral)

- **`src/hybrid-search.ts` (887 LOC)** — BM25 + Voyage vectors + title-only FTS5 fused via Reciprocal Rank Fusion (k=20), tuned weights (BM25 1.2, vec 1.2, title 3.0). Resource-note boost (1.3× BM25, 1.25× vec); Journal/Sources penalty (0.8× vec). Alias injection post-RRF. Bench landed at hybrid precision@5 = 90% / MRR = 0.86 on 55 hand-labeled cases (`reference_eval_framework`).
- **`src/write-queue.ts` (99 LOC)** — promise-chain mutex serializing every write through one queue. Trailing 30-second batched git push. Error-isolated (a failed write doesn't break the chain). This is the cleanest module in the repo.
- **`src/provenance.ts` (314 LOC) + `src/blame.ts` (646 LOC)** — per-commit provenance trailers (`Provenance-Voice: durable|perishable|legacy-unknown`) + `git blame -p --follow -M -C` read-side walker. 475 prod rows. 168 backfilled stamps on `vault-life`. The crown jewel.
- **`src/db-per-vault.ts` (160 LOC) + `src/migrations/vault/*.sql`** — per-vault `state.db` at `~/.grove/vaults/<slug>/state.db`. The structural answer to nine repeated cross-vault leaks: scope is a property of "which file you opened" rather than "which WHERE clause you remembered to add."
- **`src/discovery-*.ts`** (the extract→link engine — `discovery.ts`, `discovery-extract.ts`, `discovery-link.ts`, `discovery-batch.ts`, `discovery-cache.ts`) — auto-wikilinking on write via Anthropic Haiku 4.5. Vault grows its own graph.

### Storage

- `~/.grove/grove.db` — **control** SQLite database, 36 tables. `users`, `vaults`, `vault_members`, `vault_usage_daily`, `api_keys`, `trails`, `trail_grants`, `sessions`, `magic_links`, `oauth_clients`, `oauth_codes`, `auth_codes`, `shared_links`, `discovery_queue`, `discovery_batches`, `discovery_results`, `vault_keys`, `graph_health`, `graph_health_flags`, `handle_history`, `write_provenance`, `note_blame`, `waitlist`, `discovery_cost_daily`, `discovery_cache`, plus migration bookkeeping. Many tables are dead-on-arrival cosmetic (`vault_keys` empty across all prod vaults — zero encrypted files anywhere).
- `~/.grove/vaults/<slug>/state.db` — **per-vault** state. Currently holds `tasks`, `task_results`, `skill_configs`, `decisions`, `suppressions`, `migration_events`. The right shape; arrived too late to displace most of the control-db's per-tenant tables.
- `~/.cache/qmd/index.sqlite` — QMD's FTS5 + vec0 index. Shared across vaults via a `collection` column. The architectural mistake that produced the 04-29 search-layer leak. The 1-day proposed fix (per-vault `~/.cache/qmd/<slug>/index.sqlite`) was never executed.
- `/root/vaults/<slug>` — vault git repos on disk. Single source of truth; everything else derived.

### The costumes (what was speculative, no users)

- **`src/trails.ts` + `src/share.ts` + `src/invite.ts` + `src/waitlist.ts` + `src/email.ts` + `src/crypto.ts` + `src/index-crypto.ts`** — the SaaS apparatus. 4 trails ever created; all trail-granted keys had `last_used_at = NULL`. Zero encrypted vaults (`vault_keys` empty). 1 real waitlist signup (`jfu213@gmail.com`, 2026-05-11) + 4 of John's own smoke tests. HN-LAUNCH.md ready since 2026-04-13; never posted.
- **`src/v2-*.ts` + `src/scheduler*.ts` + `src/decision-*.ts` + `src/skills/*` + `src/discovery-*.ts`** (the agent half) — autonomous knowledge gardening. ~8,300 src lines + ~8,600 test lines = a quarter of the codebase. v1 of this idea (`daily-vault-review`) was built, shipped, and **deleted for non-use**. Inbox v2 was the second attempt, last touched 2026-05-20. Burst of 10 commits then silence.
- **`src/first-run.ts`** (i.e. `src/skills/first-run.ts`) — auto-enrolled every new vault into LLM-spending autonomous mutation within ~60 seconds of provisioning. Violated CLAUDE.md's own rule ("Grove is plumbing, the vault is the cathedral, should never make policy decisions about vault content") because `enrichment` rewrote Concept bodies and `links-suggestion` injected wikilinks. No user consent gate.

### The duplication matrix (the systems debt)

Same capability re-implemented N times across surfaces. The four core ops (search/read/write/list) are *intentionally* everywhere — that's the product. The rest is sprawl.

| Capability | MCP | CLI | REST | Web | Server compute | Client skill |
|---|---|---|---|---|---|---|
| Search | `query` | `search` | `/v1/search` | search box | `hybrid-search.ts` | `/garden:seek` |
| Read | `get`/`multi_get` | `read` | `/v1/notes` | reader | `rest.ts` | — |
| Write | `write_note` | `write/delete/move` | `/v1/notes` CRUD | — | `rest.ts` + `write-queue` | `/garden:plant` |
| List | `list_notes` | `list` | `/v1/list` | backlog | `rest.ts` | — |
| Health/graph | `vault_status` modes | `graph` · `health` · `diagnostics` · `digest` | `/v1/admin/health` · `/graph` | `/dashboard/health` | `graph-health.ts` + `vault-graph.ts` + `vault-stats.ts` (3 graph-walks) | `/garden:tend` + `/garden:pulse` |
| Watchdog | — | — | `/admin/watchdog` | — | `admin-watchdog.ts` | `/grove:watchdog` (skill) |
| Usage | — | `metrics` | `/v1/admin/metrics` + `/admin/usage` HTML | `/dashboard/usage` | `admin-usage.ts` + `metrics.ts` | — |
| Keys/admin | — | `keys`·`users`·`rotate`·`revoke` | `/v1/admin/*` | `/dashboard/access/keys` | `keys.ts` | — |
| **Trails** | — *(never consumed)* | `trail*` | `/v1/trails` | reader + access UI | `trails.ts` | — |
| **Encryption** | — | `encrypt`·`lock`·`unlock` | `/v1/vault/encrypt` | — | `crypto.ts` | — |
| Tasks/skills | — | — | `/v1/tasks` · `/v1/skills` | `/review`·`/task`·`/skills` | v2-*+ scheduler+ skills/ | — |

"Vault health" had three server modules, four interface flavors, and two client skills — ~9 implementations of "how's my vault." Two watchdogs (server-side + skill). That's where consolidation would have paid if we had kept going.

---

## 2. What Grove tried to be

The framing across the major docs.

### The one-line pitch (from README.md and HN-LAUNCH.md)

> "Open-source MCP server that makes your Obsidian vault accessible from any AI client. One URL. Claude, ChatGPT, Cursor — any MCP-compatible client connects and gets structured access — search, read, write-back, graph analysis. Your vault stays yours."

The thesis: **"your knowledge, everywhere your AI is."** The MCP gap — 24 Obsidian MCP servers existed at launch time; all local-only, all read-only, all treating the vault as a bag of files. Grove was meant to be **remote, bidirectional, and opinionated**.

### The aspiration (from GOAL.md — the 175-pt fitness function)

A scorecard divided into five components:

| Component | Points | What it measured |
|---|---|---|
| Security | 30 | Path traversal, CORS, body limits, scope enforcement, encryption, backups |
| Observability | 30 | Structured logs, correlation IDs, health, metrics, alerting |
| Portal | 25 | Web dashboard — admin auth, keys, usage, vault health |
| **Trails** | **50** | **Scoped sharing — config, filtering, eval, audit, consumer connect** |
| Foundation | 40 | No regressions — tests, code quality, coverage, CLI, docs |

50 of 175 points were bet on Trails — the differentiating SaaS feature, the "share a slice of your vault with a collaborator" idea. Trails was the entire pitch for why Grove was more than 24 local MCP servers.

The last time GOAL.md was scored honestly: **2026-04-07**, baseline 40/175. After that point, the doc lied about state — Trails shipped to 50/50 in code but never had a single MCP consumer; Security/Observability/Portal all hit their ceiling; the eval-keep-iterate loop the doc mandated stopped running.

### The launch plan (HN-LAUNCH.md, dated 2026-04-13)

The pitch: "~7,600 LOC TypeScript, raw node:http (no frameworks), 228 tests. Runs on an AWS t3.medium for ~$30/mo." Title queued ("Show HN: Grove – Open-source MCP server that makes your Obsidian vault accessible from any AI client"). Author comment drafted. Timing window: Tue/Wed 8–9am ET.

**It never fired.** Six weeks of "we'll post next Tuesday." That delay was the loudest signal nobody was listening to.

### The plan (PLAN.md — the implementation phases)

Phase 0–5 (foundation through trails) shipped April 5–13. Phase 7 (discovery) and Phase 8 (multi-vault) drove most of the April acceleration. Phase 9 (multi-user) sketched in. Phase 20 (dashboard IA) shaped late-April. Phase 21–23 (v2 dashboard + agent surface) shipped mid-May then went silent.

`PLAN.md` got a "Current State (as of 2026-04-21)" snapshot calling out 25 source modules. By 2026-05-25 the codebase had 91 modules — **undercount by ~66 modules**. The doc stopped being a steering tool and started being a fiction.

---

## 3. The arc, week by week

Reconstructed from `git log` (1,065 commits across all branches, 423 in April, 90 in May — a **~5× velocity drop**) and the dated memory files.

### Pre-history (March → 2026-04-05) — the spark

Grove began as a thin auth proxy in front of QMD (`tobi/qmd`, the BM25 search engine). The catalytic moment: "I opened Claude on my phone during a conversation and realized: it had no idea who I was." From that came `Phase 0: auth proxy + key management for QMD MCP server` (commit `52e332e`).

Decisions made in this window that survived to the end:

- TypeScript, raw `node:http`, no framework — locked in `CLAUDE.md`.
- Single-writer git invariant + write queue — locked as rule #3.
- The vault is the source of truth; the index is derived — rule #1.
- 6 MCP tools, no more — rule #6, the discipline that defined the surface.
- ESM only, Node ≥ 22, minimal deps.

### 2026-04-05 → 2026-04-13 — Phase 0–5: the cathedral gets built

Foundations + security + observability + portal + trails. Big commits:

- `4dc7510` — GOAL.md/score.sh: the 175-point fitness function lands. **This was the high-water mark of intent.**
- `4f140ec` — security 14→27 (path traversal, body limit, key TTLs).
- `7e25413` — observability 6→30 (structured logging, correlation IDs, health, metrics).
- `a7f9afa` — portal 20→25 (admin session cookies).
- `8c74884` — **trails 0→50** in one heroic commit. Filtering + eval + audit + per-trail rate limits + MCP handshake info — all shipped.
- `7fbc296` — swap embeddings from local Qwen3-on-T4 to Voyage AI API. **Saves ~$350/mo and is faster.** First time the architecture got *simpler* with experience.
- `d3ac3ac` — "launch: finalize HN title, post body, author comment, and align README." This was **2026-04-13. The day HN-LAUNCH.md was ready.**

By the end of this window, Grove scored its highest fitness number (`72881f6` — "score 109→150 — all components perfect"). README had a clean line, the auth proxy worked end-to-end on `api.grove.md`, and there was nothing structurally stopping a Show HN.

### 2026-04-13 → 2026-04-22 — the swerve into multi-tenancy

Instead of launching, Grove turned toward multi-tenant. Phase 7 (discovery — auto-wikilink-on-write via Haiku extraction) and Phase 8 (multi-vault routing — one server per vault, the proxy as router) became the focus.

Inflection commits:

- `e8324ef` — Phase 8 schema migration + graceful shutdown (P8-A1, P8-A5).
- `f4f1ebc` — vault router + backend self-auth + per-vault usage (P8-A2, P8-A3, P8-A6).
- `32eb4a3` — `grove vault create` CLI + ecosystem generator (P8-A4).
- `714cd91` — vault invite flow + `vault_members` backfill (P8-B1, P8-B2).
- `a20c6e4`, `318b1b9`, `5a7a3eb` — the multi-vault wire-up trilogy. Per the memory file (`project_phase8_wireup_2026_04_22.md`): P8-A2 was marked complete in PLAN.md but `decideRoute()` was never wired into the proxy request path. Multiple latent bugs only surfaced on the first live `grove vault create`.

**This was the costume's first thread.** Multi-tenant came with no validated demand. The motivation was a real onboarding moment (Sumon Sadhu, Sharpshoot Ventures) — but a 1-friend audience does not need multi-vault routing, vault_members, role-scoped keys, magic-link auth, and an invite flow. It needed a way to give Sumon a token. Everything else was speculative.

### 2026-04-23 → 2026-04-30 — the leak storm

Nine cross-vault leaks in fourteen days, documented in memory:

- **2026-04-28 ingest cross-vault leak** (`project_incident_2026_04_28_ingest_leak.md`). `grove ingest ~/life/Inbox/` with Sumon's token wrote 13 of John's daily journals into Sumon's vault. Auth was correct; the CLI never told you which vault you were writing to. Containment: kill keys, stop processes, snapshot, wipe disk, reset git. Fix: PR #105 (destination-vault confirmation prompt).
- **2026-04-28 onboarding reflection** (`project_2026_04_28_onboarding_reflection.md`). Sumon's onboarding tripped over six bugs that PR #95 (`feat(onboard)`) had **silently fixed** during the same debugging session. John was reading the pre-PR-95 file and SSH-patching prod for fixes that already existed in main. Lesson: read `git log` before patching.
- **2026-04-28 deploy storm** (`project_2026_04_28_overnight_hardening.md`). 12 PRs in 2 hours bounced per-vault servers ~34× each. A `grove-server` orphan PM2 process crash-looped 621 times in 116 min on `EADDRINUSE 8190`. The committed `ecosystem.config.cjs` defined the legacy 3 processes; `vault-provision` overwrote it locally; `git reset --hard` (CI rollback path) reverted to legacy and PM2 ran both. **Two sources of truth → orphan procs.** Hardening: PR #106 (deploy concurrency group), #107 (busy_timeout + IMMEDIATE on migrations), #108 (single-flight `vault-stats`), #109 (auto-prune PM2 orphans), #110 + #111 (two PM2 hotfixes — `pm2 startOrReload` is broken; `pm2 reload <file>` only parses names matching `*.config.{js,cjs,json}`).
- **2026-04-29 search-layer cross-vault leak** (`project_incident_2026_04_29_search_layer_leak.md`). Sumon's vector queries returned John's `Areas/Business/Legacy Holdings/...` content under sharpshoot URLs. **Not data contamination — search-layer scope leak.** Every grove-server-`<slug>` was hitting the same shared QMD index at `~/.cache/qmd/index.sqlite`. The MCP `query` tool called `hybridSearch(queryText, fetchLimit)` with no `collection` arg. PR #87 (the exact fix) had been sitting open since 2026-04-25 in rebase-rot. PR #114 shipped the port.
- **The verify-before-destroy moment.** John caught me about to recommend `rm -rf` on Sumon's vault on filename-pattern reasoning, with no `cmp`-based verification. The lesson is durable: `feedback_verify_before_destroy.md`. "Falsifier-first" became a project doctrine.

By 2026-04-29 the architecture-meta panel had concluded the nine leaks were not nine bugs — they were **one mistake repeated**: scope enforced by application code instead of by the storage layer. The proposed per-vault SQLite split (`project_per_vault_sqlite_split.md`) was the structural answer.

### 2026-05-01 → 2026-05-07 — autonomy hardening + provenance

- **2026-05-01** — keys-create `--vault` flag silent-drop (`project_incident_2026_05_01_keys_create_vault_flag_drop.md`). Provisioning Ryan's vault and pre-loading content: `grove keys create ingest-bootstrap --vault ryan` reported success at every step, but the four notes landed in `/root/life/Inbox/` instead. Two-layer bug: client never plumbed the flag into the POST body; server's audit-hardened `resolveMintVaultId` had no sanctioned path for platform-owner cross-vault seeding. Fix: PR #121 + new `grove vault seed-key <slug>` endpoint with `isPlatformOwner` gate. **Third cross-vault leak class in two weeks.**
- **2026-05-01 weekly assure sweep** (`project_2026_05_01_assure_run.md`). The `/grove:assure` skill found 4 real bugs, all the same shape: **server silently runs a different operation than the client requested.** Search `type:"lex"` triggered a Voyage embedding because `server.ts` always called `hybridSearch()`. `/oauth/authorize` accepted any `redirect_uri` without checking against `oauth_clients.redirect_uris`. `/oauth/token` never compared the `redirect_uri` against the value bound to the auth code (RFC 6749 §4.1.3). Pattern named in `feedback_honor_request_shape.md`. Shipped: PR #122.
- **2026-05-02 assure stalled** (`feedback_assure_subagents_stalled_2026_05_02.md`). All four `/grove:assure` sub-agents hit the 600s watchdog mid-investigation. Lesson: switch to inline grep-driven audits on first stall; don't relaunch identical prompts.
- **2026-05-07 provenance system shipped** (`project_provenance_system.md`). PRs #133/#134/#135/#136. Per-commit trailers (`Provenance-Voice: durable|perishable|legacy-unknown`) + `git blame -p --follow -M -C` read-side walker + classifier pipeline + `GROVE_REQUIRE_PROVENANCE` per-vault flag + tool-description directive that requires Claude to *verbally name* perishable segments before extending. 168 stamps backfilled on vault-life. **This is the crown jewel of the entire project.** It fixes a real, hard problem (future sessions reading past AI synthesis as durable user-philosophy) and the schema is locked, the read-path is wired, the eval shows 100% acknowledgment lift on a 20-cell smoke.

### 2026-05-08 → 2026-05-14 — cost hardening + the velocity break

Anthropic Haiku discovery cost climbed to $30/day (peaked at $137 on 2026-05-07). The watchdog skill added Signal 5 (per-key daily cost threshold). PR #144 emitted Resend emails. P7-COST-1 through P7-COST-7 added: per-vault daily cap, per-note cooldown, content-hash dedup, daily cost ingest, batch API for non-urgent extractions (50% off Haiku), cascade depth cap, vocab TTL cache.

This was the last sustained run of focused work. The cost hardening was excellent engineering — defensive, instrumented, telemetered — and at the same time a **clear sign the audience was wrong**. We were spending real attention to make a $30/day → $5/day reduction matter, with three users on the system.

Also in this window:

- **2026-05-14 scheduler crash loops** (`feedback_worker_entrypoints_use_runMigration.md` + `feedback_pm2_timer_unref_kills_process.md`). PR #175 — P23-1 schedulers shipped with raw `createSchema()` instead of `runMigration()`; 13 processes hammered control-db on cold boot, schedulers lost the race every time. 1300+ restarts each. PR #176 — `tickTimer.unref()` and `workerTimer.unref()` killed the process because timers were the only refs.
- **2026-05-18 echo vault + move-handler bug** (`feedback_move_handler_pathspec_bug.md`). `handleMoveNote` reliably failed its commit step on filenames with spaces. PR #192.

### 2026-05-15 → 2026-05-20 — Inbox v2 (the second attempt at the same bet)

10-commit burst (S-INBOX-1 through S-INBOX-10) shipping v2 of the autonomous knowledge-gardening surface. Decisions/suppressions schema. JSONL writer + atomic decision writer + Decision-Id commit trailers. Disambiguation / links-suggestion / enrichment skills. Forward-only compensation executor. Per-type review dispatch + refine-handler.

Then **silence**. The last human-facing feature commit was **2026-05-20** (`38a93cb` — the M-INBOX-1 migration script). Everything after that point was watchdog runs, defensive YAML parsing, a flag fix, the move handler fix, and the teardown decision itself.

The v1 of this exact bet (`daily-vault-review`) had been built, shipped, and **deleted for non-use** (`9e53528` — "retire legacy ReviewAction + delete daily-vault-review skill"). Inbox v2 was the second attempt at the same bet. The memory file (`project_2026_05_20_M-INBOX-1`, partially documented) notes "25 items sit untouched on prod."

### 2026-05-21 → 2026-05-27 — the zoom-out, the decision, the teardown

Velocity dropped 5×. April: 423 commits. May: 90 commits. Most of May's commits were `chore(watchdog): daily run`. The last week was about acknowledging the truth.

- **2026-05-25** — six parallel sub-agents mapped the system (`ZOOM-OUT.md`). Found Grove is one personal tool wearing two costumes. The "duplication matrix" made the systems debt visible.
- **2026-05-27** — teardown decision (`SIMPLIFY.md`). Personal tool, hosted product winding down. Cathedral becomes open source; costumes go.

### Inflection-point summary

| Date | Commit | Event | Interpretation |
|---|---|---|---|
| 2026-04-05 | `52e332e` | Phase 0 auth proxy lands | Project starts |
| 2026-04-08 | `7fbc296` | Voyage AI swap | First simplification win |
| 2026-04-13 | `d3ac3ac` | HN-LAUNCH.md ready | High-water mark of intent |
| 2026-04-22 | `f4f1ebc` | Multi-vault wire-up | Costume #1 first thread |
| 2026-04-28 | (incidents) | Cross-vault leak storm starts | Architecture mistake repeating |
| 2026-04-29 | PR #114 | Search-scope leak fix | Falsifier-first doctrine forged |
| 2026-05-01 | PR #122 | "Honor request shape" pattern | Audit-found anti-pattern named |
| 2026-05-07 | PRs #133–136 | **Provenance system ships** | **The crown jewel** |
| 2026-05-14 | PRs #175/#176 | Scheduler crash loops | Costume #2 stress-cracking |
| 2026-05-20 | `38a93cb` | Last human feature commit | The project went quiet |
| 2026-05-27 | `748b6e8` | Teardown decision committed | The honest call |

### Warning signs (read in retrospect)

These were visible at the time but ignored:

1. **HN-LAUNCH.md sat ready for 6 weeks unfired.** A launch that's "ready next Tuesday" for six Tuesdays is not ready.
2. **`vault_keys` table empty across all prod vaults.** Encryption was built, never used. Should have been a kill signal.
3. **All trail-granted keys had `last_used_at = NULL`.** 50 of 175 GOAL points bet on a surface nobody used.
4. **GOAL.md stopped being scored after 2026-04-07.** The fitness function was abandoned but stayed in the repo lying about direction.
5. **PLAN.md "Current State" snapshot from 2026-04-21 stayed stale.** 25 modules became 91; nobody updated the page.
6. **Velocity collapsed 5× April → May with no business-side trigger.** This was the body telling the brain.
7. **The cost-hardening burst (P7-COST-*)** was for $30/day across three users. Saving $25/day at this audience size = wrong-altitude work.
8. **Inbox v2 was the second attempt at v1.** The v1 had been *deleted for non-use*. Building v2 of a deleted feature is rebuilding a costume.

---

## 4. Why it ended

The local-maximum insight (verbatim from `ZOOM-OUT.md`):

> Grove is one product you use every day — a personal knowledge API (6 MCP tools over a git-backed vault) — wearing the costume of two products it has no users for: a multi-tenant SaaS and an autonomous knowledge-gardening agent. The sprawl isn't mess; it's building for a userbase of one.

The decisive evidence:

- **3 users total. 2 ever issued an MCP call (John daily, Sumon weekly).** Ryan signed up 2026-05-01, never used a key.
- **0 trail consumers.** 4 trails minted; all trail-granted keys `last_used_at = NULL`.
- **0 encrypted vaults.** `vault_keys` empty.
- **1 real waitlist signup** (`jfu213@gmail.com`).
- **HN launch ready for 44 days, never fired.**
- **5× velocity drop April → May with no external blocker.**
- **Last human-facing feature commit 2026-05-20.**
- **~$30/month AWS + attention overhead for 1 outside user.**

### The decision moment

`SIMPLIFY.md`, 2026-05-27:

> **Personal tool, tearing down the hosted product.** Grove served its purpose as an intellectual exercise. Keep the cathedral pieces open source at the existing public repo; stop running it as a service.

The criteria John used to decide:

1. **Userbase of one** outside himself, and that one was an occasional user, not a daily one.
2. **Cost-benefit collapsed.** $30/month + cognitive overhead of maintaining a hosted multi-tenant service for one outside user is too much.
3. **No business intent.** Grove was never going to be a startup; it was always an intellectual exercise. The HN launch was the path to *finding out if it should be a business* — and the fact that the launch sat ready for 44 days unfired was the answer to that question, just unspoken.
4. **The intellectual exercise was complete.** The patterns were extracted (provenance, hybrid search, write queue, per-vault SQLite, the 6-tool MCP discipline). Continuing to run it would be running infrastructure for infrastructure's sake.
5. **The vault survives Grove.** `~/life/` predates Grove and will outlive it. Killing Grove does not kill the knowledge.
6. **Local Grove is always an option.** If John misses the AI integration on his phone later, spin up local-only Grove from the open-source core then.

### The frame that made the decision easy

> "Pick one. The local maximum is the 'both' state."

`ZOOM-OUT.md` posed the binary cleanly: **Do you want Grove to onboard strangers, or to be "your knowledge, everywhere your AI is"?** Building both was the worst option — it paid the SaaS tax on a tool with no users. Once the question was put bluntly, the answer was obvious. The audit just made the avoidance impossible.

---

## 5. Architecture wins — durable patterns

These are the load-bearing patterns to carry forward. Each is described as a generalizable rule, not a Grove anecdote.

### 5.1 — The 6-tool MCP discipline

**Where it lives:** `src/server.ts:470` (`query`), `:584` (`get`), `:700` (`multi_get`), `:763` (`write_note`), `:839` (`list_notes`), `:874` (`vault_status`). Architecture rule #6 in `CLAUDE.md`.

**What it is:** Six tools, hand-shaped to compose into higher-level workflows without overlap. `query` for search. `get` for one note. `multi_get` for many. `write_note` for create/update/delete/move (via an `action` parameter — see `project_echo_no_cli_needed.md`). `list_notes` for browsing. `vault_status` for health/diagnostics/graph/digest/history/perf (modes inside one tool, not 6 separate tools).

**Why it was right:**

- Composition over surface area. `write_note` doesn't need siblings `delete_note` / `move_note` / `archive_note` — they're modes on one tool.
- `vault_status` could have been 6 tools (health, history, diagnostics, graph, digest, perf). Modes inside one tool is the same capability with one slot in the agent's tool selection budget.
- Skill code on the client side composed the 6 tools into garden workflows (`/garden:plant` = `list_notes` + `query` + `write_note`; `/garden:harvest` = `get` + `multi_get` + `write_note`). The boundary stayed clean.

**The count nuance (added late in the project):** The original rule said "≤6 because selection degrades past ~10." 2026 benchmarks showed that's not quite right — the real cliff is around 50, and Anthropic's Tool Search Tool (shipped Q1 2026) loads tool definitions on demand and largely kills count sensitivity. The value of the rule was never the number 6; it was **tool-overlap risk**. The pattern survives the count rule.

**Generalizable pattern:**
> **Before adding a tool, ask: "does an existing tool with a new parameter serve?"** A 7th or 8th tool is fine if it earns its slot by being orthogonal. A 20th isn't. If the surface climbs past ~12, stop and reconsider the design — you probably have overlap, and overlap hurts agent selection even at small model-side counts.

**Reuse directly:** Steal the pattern. Six tools, modes inside tools, the `action` parameter pattern from `write_note`, the `mode` parameter pattern from `vault_status`. This is the single most generalizable artifact of Grove.

### 5.2 — Hybrid search: BM25 + vector + title + RRF + tuned weights + live per-write embed

**Where it lives:** `src/hybrid-search.ts` (887 LOC). Tuned weights: BM25 1.2, vec 1.2, title 3.0; RRF k=20; Resource boost 1.3× BM25 / 1.25× vec; Journal/Sources penalty 0.8× vec. Embeddings via Voyage AI (`voyage-4-large`, 1024-dim). Alias injection post-RRF. Live per-write embed path in `src/embed-single.ts`.

**What it is:** Three backends fused by Reciprocal Rank Fusion. BM25 catches exact-term hits via SQLite FTS5. Vector embeddings catch semantic neighbors via Voyage AI. Title-only FTS5 catches concept notes by name when their bodies don't trigger BM25. RRF fuses the three by rank, not raw score. Alias injection: if the query contains a YAML alias declared in any note, that note is force-promoted to top-3 regardless of RRF score. The write path embeds the new note **synchronously before returning** so the next agent's search call sees it (architecture rule #5: synchronous reindex).

**Why it was right:**

- **The single biggest architectural win was title search**, not weight tuning (`project_search_architecture.md`). Title-only FTS5 finds "AI Coding Agents" when the query is "AI coding tools" because titles are short and term-dense. Vector alone returned journal entries; title rescued the concept notes.
- **Weight tuning has diminishing returns.** Eight rounds of tuning yielded **0 improvement** (`feedback_evolution_loop.md`). Adding new signals (title search, alias enrichment, type-aware boost) materially moved the needle from 68.8% → 90% precision@5.
- **Live per-write embed > batch embed.** Eventual consistency would have created duplicates because agents have no memory between calls (rule #5). Synchronous is non-negotiable for a write-back search system.

**Generalizable pattern:**

> **For a hybrid-search system: start with three orthogonal backends, fuse by RRF (not weighted score), boost by type / penalize by type, add alias injection as a post-RRF override.** Stop tuning weights after the first 2–3 rounds; add a new signal instead. Make the write path synchronously reindex — eventual consistency is a duplicate factory when consumers have no memory between calls.

**Falsifier discipline:** When eval shows 0% for any backend, **that's a bug, not a hard problem.** The FTS5 path-prefix mismatch (`project_fts5_path_prefix.md`) silently broke BM25 for months — the JOIN between `documents_fts` and `documents` failed because FTS5 stored paths with the `life/` collection prefix and `documents` didn't. The fix: `d.path = SUBSTR(f.filepath, 6)`. Debug before tuning.

**Reuse directly:** `hybrid-search.ts` is the most portable single file in the repo. Drop it into any system that needs hybrid search over a markdown corpus. Substitute Voyage for any hosted embed API; FTS5 is the SQLite standard.

### 5.3 — Git single-writer write queue

**Where it lives:** `src/write-queue.ts` (99 LOC — the cleanest module in the repo). Architecture rule #3 in `CLAUDE.md`: "the server is the sole writer to git." Rule #2: "all writes are serialized."

**What it is:** A `WriteQueue` class holding a promise chain that serializes every write. Error-isolated (a rejected promise rejects only that operation; the chain continues). Batched git push on a trailing 30-second timer (cleared and rescheduled on every new write, so a burst of writes pushes once at the end). Depth + age telemetry surfaced through `vault_status(mode: "perf")`.

**Why it was right:**

- **Single writer prevents corruption.** Concurrent git operations on the same repo create racing index lock files and split-brain commits. Grove's invariant — *the server is the sole writer; local machines pull* — is the simplest model that makes corruption impossible.
- **Promise chain is the simplest mutex.** No external lock, no async-mutex library, no semaphore. The chain itself enforces order. ~99 lines.
- **Batched push on trailing timer is the right cadence for write storms.** A burst of 50 notes during onboarding gets one push, not 50. Idle vaults push immediately on the next idle moment.
- **Telemetry on the queue itself** (`depth()`, `oldestQueuedAgeMs()`) is the canary for write stalls. Surfaced through MCP makes it visible to agents.

**Generalizable pattern:**

> **For any system with a shared mutable git repo: name one process the sole writer, push all mutations through a serialized queue, batch outbound sync on a trailing timer, expose queue depth + age to consumers.** This is the simplest correct shape.

**Caveats from incidents:**

- External writes to `origin/main` from a different machine **silently abort the prod cron pull** because `sync-all-vaults.sh` uses `--ff-only` (`feedback_vault_sync_ff_only.md`). Either pin all writes to one machine, or switch to `--rebase --autostash`.
- Subsystems that bypass the queue (discovery worker writing concept stubs, graph-health auto-heal) need to be deliberately whitelisted; their commits should be marked `legacy-unknown` for the read-side provenance walker so it knows they're mechanical (see 5.4).

**Reuse directly:** Lift `write-queue.ts` verbatim. The schedulePush / executePush / flush API is the right shape for any write-batching system.

### 5.4 — Provenance / blame doctrine

**Where it lives:** `src/provenance.ts` (314 LOC, write-side trailer composition + parse) + `src/blame.ts` (646 LOC, read-side walker over `git blame -p --follow -M -C`). The `note_blame` cache table. The `PERISHABLE_USAGE_DIRECTIVE` constant in `provenance.ts:260`. Provenance argument on every `write_note` and `mcp__grove__write_note` call. 168 backfilled stamps on `vault-life`. The classifier pipeline at `scripts/provenance/`.

**What it is:** Every write to the vault commits with a footer:

```
Provenance-Voice:     durable | perishable | legacy-unknown
Provenance-By:        claude-opus-4-7 | human | ...
Provenance-Written-At: 2026-05-07T19:23:11Z
Provenance-Basis:     <paths or URLs>
Provenance-Source:    <session id>
Provenance-Reason:    <one-line rationale>
```

On read, the server runs `git blame -p --follow -M -C` and attributes every line to the commit that introduced it. The trailers on that commit declare the voice. Each line therefore has a voice: `durable` (John's primary source / extracted from John / cited research), `perishable` (moment-in-time AI synthesis or prediction), or `legacy-unknown` (commits that predate provenance).

Then — the load-bearing piece — the tool description on `get` / `multi_get` / `query` / `list_notes` carries imperative MUST language: **"This note contains perishable segments. You MUST: (1) before using or quoting any perishable segment, name it explicitly; (2) not extend, refine, or build on perishable segments without first asking the user to confirm; (3) prefer durable segments when there's a conflict; (4) treat perishable content as a quoted historical artifact, not a standing claim."**

**The failure it prevents:** future Claude sessions reading past Claude-synthesized content as if it were durable John-philosophy. Three buckets that get conflated: human-authored (durable), Claude-extracted-from-human (durable), Claude-predicted-at-T (perishable — the bucket that screws John). **Asymmetric default: when in doubt, perishable.** False-perishable hurts less than false-durable — future sessions will name perishable content as a quoted artifact and ask before extending, which is exactly the right behavior for ambiguous cases.

**Why it was right:**

- **Per-commit, not per-file.** A note evolves across many commits, each authored by a different agent with different intent. File-level voice would lie about the durable segments John has typed since the last Claude synthesis.
- **`git blame -p --follow -M -C`** handles renames and moves natively. Provenance survives file restructuring.
- **The MUST language in tool descriptions is the actual lever.** The trailers are inert until the agent reads them; the directive forces the agent to name perishable content before extending.
- **`--allow-empty` stamp commits + topological order resolution.** Backfill stamps (`scripts/provenance/stamp.ts`) write empty commits with `Provenance-Stamp-Path: <relPath>`. The blame walker's `findLatestStampForPath` uses topological order (not author-time, since stamps are often backdated) to decide if the stamp overrides legacy-unknown segments.
- **Cache key includes git HEAD** (PR #134). Without HEAD in the key, `--allow-empty` stamps don't rotate `source_hash`, leaving stale blame cached forever after a stamp lands.
- **Per-vault opt-in via `GROVE_REQUIRE_PROVENANCE`** flag set in `src/ecosystem-gen.ts` for `slug === "personal"` only. Other tenants stayed default-off until their callers migrated. Forced migration is a hostile UX.

**Generalizable pattern:**

> **For any system where AI agents and humans co-author durable knowledge: stamp every write with a voice (durable / perishable). Surface the voice on read via tool description with imperative MUST language. Default to perishable when in doubt. Carry the voice through renames/moves via git blame following.** The third bucket — Claude synthesis filed as durable, future sessions reading it as John's standing thinking — is the failure mode this prevents. Worth the entire 1,000 LOC.

**Reuse directly:** The schema is locked (`durable`/`perishable`/`legacy-unknown`). The trailer format is portable. The classifier pipeline (`scripts/provenance/`) bootstraps a vault that didn't have provenance from day one. The PERISHABLE_USAGE_DIRECTIVE string is the keystone — copy it verbatim.

### 5.5 — Per-vault SQLite split

**Where it lives:** `src/db-per-vault.ts` (160 LOC). `src/migrations/vault/001_init_vault_state.sql` through `004_migration_events.sql`. Architectural decision documented in `project_per_vault_sqlite_split.md`.

**What it is:** Each vault gets its own `state.db` at `~/.grove/vaults/<slug>/state.db`. The control DB (`grove.db`) holds genuinely cross-vault tables (`users`, `vaults`, `vault_members`, `sessions`, OAuth tables). Per-tenant tables live in the vault's state.db: `tasks`, `task_results`, `skill_configs`, `decisions`, `suppressions`, `migration_events` (eventually `api_keys`, `shared_links`, `discovery_queue`, `graph_health` — the migration was incomplete at teardown).

**Why it was right:**

The insight was earned through nine cross-vault leaks in fourteen days. Each leak had a different surface (search, ingest, alias, graph-health, trail-admin, vault-stats, discovery_results, embed-single, key-mint). Each fix added a `WHERE vault_id = ?` clause. The architecture-meta panel made the call: **these are not nine bugs across nine surfaces. They are one architectural mistake repeated nine times: scope enforced by application code instead of by the storage layer.**

`scripts/check-invariants.ts` literally encoded "every callsite must remember to do X" — the storage-layer-mistake tell. At three tenants the discipline was feasible; at fifty tenants it is structurally lossy. Every new feature introduces a new scope-check obligation. The leak rate is bounded only by how thorough the next audit is.

**Per-vault files** kills the bug class structurally: search literally cannot see another vault's docs because it is not connected to that file.

**Generalizable pattern:**

> **For any multi-tenant system: enforce scope at the storage layer, not at the application layer.** If your callsite is morally obligated to add `WHERE tenant_id = ?` to every query, you have a leaky abstraction. The right shape is **per-tenant files** (SQLite, on-disk directories, separate object-store prefixes) — *not* per-tenant row predicates enforced by clever runtime invariants. Cross-tenant admin operations become explicit fan-out, which is a feature: an admin-style cross-tenant query should *look like* a cross-tenant query, not hide in a missing WHERE.

**What NOT to do at this scale:**
- Postgres + row-level security: overkill for 3-10 tenants on one VM. Operational cost dwarfs the bug it prevents.
- A `VaultScopedDb` query rewriter: parsing/rewriting SQL is fragile.
- SQLite triggers asserting `vault_id = current_session_vault`: requires a wrapper layer to inject the session vault; awkward.

**Reuse directly:** The `db-per-vault.ts` shape (connection pool keyed by tenant, lazy open, per-tenant migration directory) is portable. The shared-control / per-tenant table-partition decision tree is the right framework.

### 5.6 — Discovery extract→link engine (auto-wikilinking on write)

**Where it lives:** `src/discovery.ts` + `src/discovery-extract.ts` + `src/discovery-link.ts` + `src/discovery-batch.ts` + `src/discovery-cache.ts`. The `grove-discovery-<slug>` PM2 worker.

**What it is:** On every commit to a vault, a worker picks up the changed paths, calls Anthropic Haiku 4.5 to extract entity mentions (people, concepts, companies), matches them against the vocab of existing notes, and rewrites the source note with proper `[[wikilinks]]`. New entities get auto-created as stub notes. The cascade is depth-capped.

**Why it was right:**

- **Knowledge graphs require linking, and linking is the boring work humans don't do.** Auto-wikilinking removes the friction.
- **Cache by `(vault_id, path, content_sha256, cache_version)`** (P7-COST-3) made identical writes free. PR #145's vocab caching plus PR #157's vocab TTL cache restored prompt-cache hit rates.
- **Batch API for cron-driven extractions** (P7-COST-5) at 50% off Haiku list price. Real-time path stays uncached for user-driven writes.
- **Depth cap** (P7-COST-6) prevents the worker from descending indefinitely into bot-spawned stubs. Stub created by `discovery: create` is depth 1; stub-of-stub is depth 2; cap at depth 2 by default.

**Why it had risks:**

- It **autonomously mutates the vault content**. That violates `CLAUDE.md`'s "Grove is plumbing, the vault is the cathedral; should never make policy decisions about vault content." The wikilink injection is a policy decision: "this Concept exists; let me link to it."
- It's the only thing that costs real LLM dollars. The Haiku bill drove the entire P7 cost-hardening phase.
- It spawned the cascade-depth problem because `wireLinks` creates stubs which trigger more extractions.

**Generalizable pattern:**

> **For automatic graph-building on text corpora: extract entities with a cheap LLM (Haiku-class), match against existing vocab, inject wikilinks via the write queue, cache by content hash, cap cascade depth.** Treat it as a separate worker process so it doesn't block the write path. Batch non-user-facing extractions at half-price; real-time path stays uncached.

**Reuse directly:** The shape is portable. The content-hash cache + cascade-depth cap + batch API split is the right cost-control discipline.

### 5.7 — Vault-as-source-of-truth invariant

**Where it lives:** Architecture rule #1 in `CLAUDE.md`: "the vault (markdown files in git) is the sole source of truth. The QMD index is a derived view. If they diverge, the index is wrong."

**What it is:** Markdown files in `/root/vaults/<slug>` are canonical. Every other piece of state — the QMD index, the embeddings table, the alias index, the wikilink graph, the discovery cache — is derivable from the vault. If any of them diverges from the vault, the vault wins and the derived state gets rebuilt.

**Why it was right:**

- **Survivability.** If Grove dies tomorrow, the vault is fine. The vault predates Grove and will outlive it.
- **Recovery clarity.** When a discrepancy surfaces, you don't have to decide "which is right." The vault is right; rebuild the index.
- **Portability.** The vault is a git repo of markdown files. It's portable to Obsidian, to a different system, to nothing at all (read the files directly).
- **No vendor lock-in.** John can't be locked out of his own knowledge by anything Grove does.

**Generalizable pattern:**

> **For any system that builds derived state from user-owned data: name one substrate authoritative (the user-owned thing), make everything else strictly derived, document the invariant.** When derived state goes wrong, rebuild it from the substrate. Never the other way.

**Reuse directly:** The principle survives every project. The vault is sacred; Grove is plumbing; the cathedral is the data.

### 5.8 — Raw `node:http`, no framework

**Where it lives:** `src/proxy.ts`, `src/server.ts`, `src/rest.ts`. Plus `CLAUDE.md`'s "don't add web frameworks. Raw `node:http` is the choice and it's final."

**What it was right for:**

- **Small surfaces stay small.** No middleware sprawl, no plugin registry, no convention-over-configuration mystery box.
- **Deep introspection.** Every request handler is visible; no decorator magic.
- **Boot time is microseconds, not seconds.** Matters for PM2 reload cycles.
- **One dependency tree to audit.** `npm audit fix` doesn't pull in transitive Express plugins.
- **Streaming SSE for MCP works natively.** Frameworks tend to buffer.

**Where it became wrong:**

`proxy.ts` ended up at **4,043 lines with one 2,800-line handler function.** That's the same anti-pattern as a giant Express app, just without Express. The `/v1/*` dispatch table grew without a router abstraction. OAuth flows, cookie-session routes, auth-page HTML rendering, REST dispatch, MCP session management, vault routing, and admin pages all lived in the same file.

**Generalizable pattern:**

> **Pick raw `node:http` (or equivalent minimal HTTP) for systems with a small surface (≤30 endpoints, ≤2 concerns per surface). When the file passes 1,500 lines or the dispatch table outgrows a single `switch` statement, extract a tiny internal router — but keep the framework decision: no Express, no Fastify, no Koa. The lesson is "small framework"; "no framework at all" is a corollary, not the rule.**

**Reuse directly with discipline:** Use raw `node:http`. The instant you have more than ~10 routes, pull out an internal `router.ts` that owns the dispatch table. Extract handlers into modules per concern. Don't let one file become the entire app.

---

## 6. Architecture losses — anti-patterns

What we did wrong, generalized.

### 6.1 — Multi-tenant SaaS before validating demand

**The mistake:** Phase 8 (multi-vault routing, per-vault PM2 trios, vault_members, role-scoped keys, magic-link auth, invite flow) shipped between 2026-04-22 and 2026-04-30. Audience: one outside friend (Sumon). The architecture supported "many users sharing a Grove deployment." The product had two daily users — John and (occasionally) Sumon.

**The cost:**

- Nine cross-vault leak incidents in 14 days (§7 below). Each leak was a real bug, each fix was real engineering, **none of them would have existed if Grove had stayed single-vault**.
- The deploy storm of 2026-04-28 (12 PRs in 2 hours, 34× per-vault server bounces, 621-restart orphan PM2 loop) — every one of those PRs was multi-vault wire-up.
- A per-vault PM2 trio meant 9 processes at ~75MB each on a 4GB box — headroom fine through ~10 vaults, uncomfortable past 20. We had 5 vaults, 4 of them quiet.
- `vault_keys` table + `crypto.ts` + `index-crypto.ts` + encrypt/lock/unlock CLI — **zero encrypted vaults across all of prod.**
- `invite.ts` + `waitlist.ts` + `email.ts` (Resend integration) — 1 real waitlist signup.
- `trails.ts` + share UI + per-trail rate limits — 0 trail consumers.

**Generalizable pattern:**

> **Don't build multi-tenant infrastructure until you have at least 5 active outside users on the single-tenant version.** Single-tenant is a stronger product hypothesis for a 1-friend audience: it's faster to ship, easier to debug, structurally impossible to leak, and trivially convertible to multi-tenant later when demand is real. **The cost of multi-tenant is paid in bugs you can't see during ground state and in capabilities you build for an audience that doesn't exist.**

**Tell:** if your fitness function bets 50/175 points on a feature (`Trails`), and the table for that feature shows zero consumers after a month, that's not "trails needs marketing." That's the audience telling you the feature is speculative.

### 6.2 — Application-layer enforcement of tenancy

**The mistake:** Tenancy enforced by `WHERE vault_id = ?` clauses scattered across ~200 callsites in `db.ts`. The "discipline" required every new query to remember the predicate. We caught some misses in audits; the rest leaked into production.

**The cost:**

- Nine production leaks in two weeks (see §7).
- `scripts/check-invariants.ts` was a static-analysis test that grep-asserted "every callsite must remember to do X" — encoding the discipline as a CI test instead of fixing the architecture. **When you're writing tests for "people must remember to do X," the bug is in the architecture, not in the people.**
- Each leak fix required diagnostic clarity that wasn't always there — see the 2026-04-29 leak where I almost recommended `rm -rf` Sumon's vault on filename-pattern reasoning (`feedback_verify_before_destroy.md`).

**Generalizable pattern:**

> **Tenancy belongs in the storage layer, not in the application layer.** If your code requires every developer (or agent) to remember to scope every query, the bug class is structural. Make it impossible to query across tenants by accident: per-tenant files / per-tenant connection / per-tenant prefix. Cross-tenant ops become explicit fan-out, which is what you want — admin-style cross-tenant access should look like cross-tenant access, not hide in a missing clause.

This is `project_per_vault_sqlite_split.md` distilled. The pattern repeats for any system with `tenant_id` columns on shared tables.

### 6.3 — Autonomous mutation without consent gates

**The mistake:** `src/skills/first-run.ts` auto-enrolled every newly-provisioned vault into LLM-spending autonomous mutation within ~60 seconds. **Three default suggestion skills were seeded automatically** — `enrichment` (rewrites Concept bodies), `disambiguation` (suggests entity disambiguation), `links-suggestion` (injects wikilinks). The justification in the source comment: *"enabling Grove already implies consent for autonomous work."*

That's the rationalization. The reality: **there was no consent gate.** Provisioning a vault for a friend meant Grove started spending Anthropic dollars and mutating their notes within a minute, with no opt-in screen, no email confirmation, no "want to enable AI gardening?" prompt.

**The cost:**

- `enrichment` rewrote Concept bodies. **Violates `CLAUDE.md` rule "should never restructure or make policy decisions about vault content."**
- `links-suggestion` injected wikilinks at depth 1. Cascade-depth cap eventually prevented runaway, but only after the cost-hardening work.
- v1 of this whole bet (`daily-vault-review`) was built, shipped, deleted for non-use.
- 25 untouched review items sat in prod on the inbox dashboard for two weeks before teardown.

**Generalizable pattern:**

> **For any system that spends money or mutates user-owned data on the user's behalf: an explicit opt-in is non-negotiable.** Default-on is theft of attention and budget. The framing "enabling X already implies consent for Y" is almost always wrong — users consent to X, not to Y. Make Y opt-in with a single click; the click is the gate.

**Generalize further:** *autonomous behavior should be off by default and visibly off.* The user should be able to see, at any time, what the system is doing on their behalf and turn it off in one action. If "the user enabled this skill" is the only audit trail, you haven't built a consent gate — you've built a license.

### 6.4 — The 4,043-line `proxy.ts` god file

**The mistake:** `src/proxy.ts` grew to 4,043 lines with one handler function ~2,800 lines long, dispatching `/v1/*`, `/mcp`, `/oauth/*`, `/v/<slug>/*`, `/admin/*`, auth-page HTML rendering, cookie-session management, vault routing, OAuth code/token, rate limiting, and the legacy `qmd` proxy path (vestigial, dead since Phase 8 inlined BM25). Every audit found something in this file.

**The cost:**

- New developers (and agents) couldn't fit it in context. The 2026-05-02 `/grove:assure` sub-agents all stalled at 600s while reading large files (`feedback_assure_subagents_stalled_2026_05_02.md`) — proxy.ts was the primary culprit. Lesson: switch to inline grep-driven audits on stall.
- Cross-cutting changes (like the 2026-04-29 search-scope fix) required edits across multiple regions of the file, increasing rebase friction. PR #87 sat 4 days in rebase-rot.
- The `/v1/*` dispatch table was a giant switch statement — adding a new route meant editing the switch + adding a handler + remembering to register it.
- **The duplication matrix's worst row.** Search logic in MCP `query` + REST `handleSearch`; "health" in `vault_status` + multiple REST endpoints + a separate HTML page. Same capability re-implemented inside the same file.

**Generalizable pattern:**

> **Set hard size limits on files before they grow.** ~1,000 lines is uncomfortable; ~2,000 is a problem; ~4,000 is a god file. The signs: agent stalls on read, audits flag the same patterns repeatedly, PRs collide. The fix is mechanical — extract concerns into modules, with a dispatch file that only routes. **Don't let "raw `node:http` means no framework" become "raw `node:http` means no internal abstraction."**

**For proxy.ts specifically (the unfinished Tier 1 work):** extract `oauth.ts`, `auth-pages.ts` (HTML rendering), and `routes.ts` (the dispatch table) into separate modules. Keep `proxy.ts` as the wire-up entry point. Estimated reduction: ~2,500 lines moved out.

### 6.5 — The 175-pt fitness function that wasn't maintained

**The mistake:** `GOAL.md` was the project's steering doc. Its iteration log shows the last scored entry was **2026-04-07**, baseline 40/175. After that, the operating mode the doc mandates ("run scripts/score.sh, identify lowest-scoring component, pick highest-impact action, implement, re-run") stopped happening. The doc still claims 50/175 points are bet on Trails, which never had a single MCP consumer.

**The cost:**

- The doc lied about direction. Anyone (human or agent) reading it for "what should I work on next?" got a wrong answer.
- The fitness function had no measurement of cost (Haiku spend hit $137/day), no measurement of multi-vault correctness (the leak storm), no measurement of autonomy spend (the costume cost). The dimensions we cared about by 2026-05 were not the dimensions the scorecard scored.
- `iterations.jsonl` was the canonical scoring log; it had one entry.

**Generalizable pattern:**

> **A fitness function that isn't run is a fiction that misleads.** Either keep it current (every shipped feature touches the score; every milestone re-prices the components) or delete it. Don't leave it sitting in the repo lying about direction. The mode you want is "score is a button you press, and you press it." If you stop pressing it for a month, the score doesn't lie — it's just gone.

**Worse anti-pattern:** point allocations that don't track value. 50 points on Trails was reasonable in April 2026 *when Trails was a hypothesis*. By mid-May, evidence said Trails had zero consumers. The function should have been re-priced — either Trails proves itself or its points migrate to where the energy actually went (cost-hardening, multi-vault, autonomy). The function calcified instead.

### 6.6 — `PLAN.md` "current state" snapshots that drift

**The mistake:** `PLAN.md`'s "Current State (as of 2026-04-21)" section claimed 25 source modules and listed them. By 2026-05-25 the codebase had 91 modules — an undercount by ~66 modules. The phase listings showed Phases 7, 8, 9, 20, 21, 22, 23 all in flight or "active"; in reality some were dead, some were silently complete, some were renamed.

**The cost:** Same as 6.5 — the doc misled. Cold-start agents arriving in the repo read it and built mental models that didn't match reality.

**Generalizable pattern:**

> **"Current state" sections in long-lived planning docs decay. Either auto-generate them from the code (a script that counts modules + lists them) or delete them.** The truth is in `git log`, `find src -name '*.ts'`, and `wc -l`. Anything that pretends to be a snapshot of those will drift.

**Better shape:** instead of "Current State (as of <date>)", have a "Snapshot" script (`scripts/state.sh`) that prints the current module count, LOC, test count, etc. Commit its output to a file the doc links to. Or just don't have the section at all.

### 6.7 — Building both options simultaneously (the local-maximum insight)

**The mistake:** Grove tried to be both a personal tool *and* a hosted SaaS *and* an autonomous-agent platform — at the same time, on the same codebase, with the same operator. The result was the worst of all three: the personal tool had SaaS overhead (multi-vault routing, OAuth flows, key minting); the SaaS had no users; the agent platform violated the personal tool's own constitution.

**The cost:**

- Every shipped feature paid the SaaS tax (auth, scope, consent, audit, rate-limit) even though one user used it.
- The 4,043-line `proxy.ts` is the size it is because it has to handle three product shapes.
- The fitness function had to balance dimensions that didn't share a unit (personal-tool usability vs SaaS funnel metrics vs autonomy spend).
- The 5× velocity drop in May was the body refusing the contradiction.

`ZOOM-OUT.md` named this: **the local maximum is the 'both' state.** Picking either pole (pure personal or pure SaaS) was strictly better than the middle.

**Generalizable pattern:**

> **When a project has two plausible identities (personal tool / hosted product, library / framework, internal tool / open-source release), pick one early — before the architecture forks for both.** The cost of choosing late is paying the worst of both indefinitely. The signal that you've delayed too long is when the same codebase needs different priorities at different layers (e.g., "the MCP surface is for me, but the OAuth flow is for strangers").

### 6.8 — Building infrastructure for a userbase of one

**The mistake:** Many features were built for a user that didn't exist.

- `waitlist.ts` — collected signups for a launch that hadn't happened (HN-LAUNCH.md ready since 2026-04-13, never fired). 1 real signup, 4 of John's own smoke tests.
- Encryption (`crypto.ts`, `index-crypto.ts`, encrypt/lock/unlock CLI) — zero encrypted vaults across all of prod. Behind TLS + EBS-at-rest, app-layer crypto buys ~nothing for a 1-user tool.
- Magic-link auth + cross-domain auth + persistent SQLite sessions — built for a multi-user funnel that never materialized.
- Per-trail rate limits — for trails nobody used.
- Trail audit logging — for trails nobody used.
- The grove-www v2 dashboard — half-built, 404s in prod behind a feature gate.

**The cost:** Pure attention drain. Every speculative feature took time away from the cathedral. Some of them created bugs (encryption added complexity to the QMD index format; sessions added complexity to the proxy; the trail filtering layer added complexity to every search response). **The user that justified the work didn't exist.**

**Generalizable pattern:**

> **Before building infrastructure, ask: "who specifically will use this in the next 30 days?"** If the answer is hypothetical (potential users, "when we launch", "this would be ready for X"), the answer is no. Build it when the use materializes. **Speculative infrastructure is just unmaintained code with extra steps.**

A sharper rule: **the user must be named.** "John, daily" is a user. "Anyone who signs up after the launch we haven't done" is not a user.

---

## 7. The incident log — hard-earned lessons

Chronological. Each incident is the cheapest possible re-derivation: what happened, what we thought it was, what it actually was, the falsifier we missed, the systemic fix.

### 7.1 — 2026-04-23: stale MCP session bug

**What happened:** After `grove-server-personal` restarts, `claude.ai`'s MCP connector held a stale `mcp-session-id`. Every tool call errored until John disconnected and reconnected the Grove connector.

**What we thought:** Routine MCP protocol churn.

**What it actually was:** The proxy is supposed to catch the backend's 400, re-initialize a fresh session, and replay the request (`src/proxy.ts:2814-2853` at time of writing). That fallback silently fails — logs say `[proxy] failed to get new session from Grove` with no status or body. Likely root contributor: `grove-server-test-vault` was in a restart loop (126 restarts as of 2026-04-23) because it can't run `git log origin/main..HEAD --oneline` on startup — the freshly-provisioned test-vault had no `origin/main`. The churn took other processes down with it.

**The falsifier we missed:** `pm2 describe grove-server-test-vault | grep restart` was the cheap check; it would have shown the crash loop immediately.

**Systemic fix:** Stop `grove-server-test-vault` from flapping; instrument + fix stale-session rehydration in `proxy.ts`. Neither fix shipped before teardown. Workaround was always "reconnect Grove in claude.ai."

**Generalizable lesson:** A flaky downstream restart-loop is sometimes the upstream symptom. When the proxy's session rehydration is failing, look at *all* the restart counters in PM2, not just the one that obviously matches.

**Memory:** `project_stale_mcp_session.md`

### 7.2 — 2026-04-28: ingest cross-vault leak

**What happened:** `grove ingest ~/life/Inbox/` authenticated with Sumon's owner token wrote 13 of John's daily journals into Sumon's `sharpshoot` vault. `grove-discovery-sharpshoot` then auto-derived ~50 entity notes from that content. Sumon's MCP queries returned John's content under his own vault URL.

**What we thought:** Auth bypass. Multi-tenant isolation breach.

**What it actually was:** Auth was correct. The writes were properly bound to the token's vault. **The hole was at the operator surface**: `grove ingest` never told you which vault you were about to write to. A token swap (testing the new onboard paved-path with John's local directory) silently routed writes to the wrong place. From the panicked-user perspective it looked like a vault-isolation bug.

**The falsifier we missed:** `SELECT vault_id FROM api_keys WHERE id = ?` would have shown the token's binding. If the data is in the destination vault on disk, auth did its job; the writer was wrong.

**Systemic fix:** PR #105 — destination-vault confirmation prompt in any CLI flow that writes >1 note. `--yes`/`-y` for scripts, error on non-TTY without `--yes`. `/v1/whoami` now returns `vault_slug`/`vault_name`/`owner_email` for any new client surface that shows the active credential.

**Generalizable lesson:** Treat "User X can see User Y's content" complaints as **potential client-side misdirection first, not auth bypass.** Check the token's `vault_id`; check the file's on-disk path. The diagnostic question is "is the data on disk in the destination vault?" — if yes, auth worked, the writer was misdirected; if no, it's a search-layer leak (see 7.4).

**Memory:** `project_incident_2026_04_28_ingest_leak.md`

### 7.3 — 2026-04-28 evening: deploy storm + orphan PM2 + migration race

**What happened:** Three overlapping incidents drove an overnight hardening run: (a) the morning's ingest leak; (b) a deploy storm of 12 PRs in 2 hours that bounced per-vault servers ~34× each; (c) a `grove-server` orphan PM2 process crash-looping 621 times in 116 min on `EADDRINUSE 8190`.

**What we thought:** A noisy day. Probably a flaky CI run.

**What it actually was:**

- **Deploy storm.** The workflow-level `cancel-in-progress` could have SIGKILL'd a `pm2 reload` mid-flight. Near-miss for actual data loss.
- **Orphan PM2.** The committed `ecosystem.config.cjs` defined the legacy 3 procs; `vault-provision` overwrote it locally; `git reset --hard` (CI rollback path) reverted to legacy and PM2 happily ran *both* — the legacy 3 procs and the multi-vault procs. **Two sources of truth → orphan.** "Single source of truth" was rhetorical, not enforced.
- **Migration race.** Concurrent SQLite migrations on the same control DB. `SQLITE_BUSY` errors on the destructive `DROP+RENAME` paths in `migrateSharedLinks` / `migrateDiscoveryQueue`.

**Systemic fixes (PRs #106–#111):**
- #106 — `concurrency: { group: grove-prod-deploy, cancel-in-progress: false }` on the deploy job. Subsequent deploys queue, never cancel mid-flight.
- #107 — `BEGIN IMMEDIATE` + `busy_timeout=5000` + `_migration_state` sentinel in `src/db.ts`. Cross-process migration serialization.
- #108 — single-flight `analyzeGraphSingleflight` / `computeDigestSingleflight` in `src/vault-stats.ts`. The 30s outer timeout returns fallbacks fast; the inner work keeps running and the next caller picks it up via the per-path Map.
- #109 — eliminate static `ecosystem.config.cjs` from repo; deploy auto-prunes PM2 apps not in the generated ecosystem.
- #110 — hotfix for #109 — `pm2 reload` + `pm2 start` instead of `pm2 startOrReload` (the latter throws on configs without a `deploy` block — `API.js:945` reads `config.deploy` without null-check).
- #111 — hotfix for #110 — rename `ecosystem.runtime.cjs` to `ecosystem.runtime.config.cjs` (PM2 only treats the argument as an ecosystem file if the basename matches `*.config.{js,cjs,json}`).

**Generalizable lessons:**

- **Two sources of truth → orphan processes.** If the deploy generates an ecosystem file but the repo also commits one, you have two sources. Pick one (the generated one) and assert at deploy time that running == expected.
- **Concurrent SQLite writes need transaction-level locking.** `busy_timeout` alone isn't enough for destructive migrations; you need `BEGIN IMMEDIATE`.
- **PM2 verbs are not unit-tested.** Test deploy verbs against the prod-pinned binary (see 8.2).

**Memory:** `project_2026_04_28_overnight_hardening.md`

### 7.4 — 2026-04-29: search-layer cross-vault leak

**What happened:** Sumon's MCP `query` (`type: vec`) against `/v/sharpshoot/mcp` returned a result titled `Marketing agents are the fourth horizontal layer...` with URL `https://grove.md/@modernmedici88/sharpshoot/areas/business/legacy-holdings/notes/marketing-agents-...`. Sharpshoot's vault has no `Areas/` folder — that path lives in `/root/life/Areas/`. John's content was being returned to Sumon under Sumon's URL.

**What we thought (the cognitive trap):** Data contamination, like the 04-28 incident. I was about to recommend `rm -rf` on Sumon's vault.

**What it actually was:** Every `grove-server-<slug>` reads from one shared QMD index at `~/.cache/qmd/index.sqlite`. Each vault's documents live under a `collection` keyed by the vault's on-disk basename. The MCP `query` tool in `src/server.ts` was calling `hybridSearch(queryText, fetchLimit)` with no `collection` arg → search returned matches from every collection. The proxy then minted URLs using the requesting vault's slug over John's file paths. **Not contamination. Scope leak in the search layer.**

**The falsifier I missed:** Take one URL from the leaked result, derive the path in the requesting vault's filesystem, and check if it exists there. If NO → search-layer leak. If YES → ingest contamination. `cmp` between the two would have settled it in 200ms. **I almost cashed in trust I had not earned for that decision.** John caught it with one sentence: "bro those are sumons that he ingested." (Actually they weren't — they were John's content surfaced via the leak, but the disk-path falsifier would have shown ENOENT either way.)

**Also:** PR #87 (the exact fix) had been open since 2026-04-25 in rebase-rot. We had already diagnosed and patched this issue four days earlier; the patch just hadn't shipped.

**Systemic fix:** PR #114 — `security: scope per-vault MCP search to its QMD collection.` Plus `test/cross-vault-search-scope.test.ts` enforcing that any per-vault search caller passes a `collection` arg.

**Generalizable lessons:**

- **Falsifier-first before destructive operations.** Doctrine: §8.1.
- **Check open PRs before assuming a bug is new.** Doctrine: §8.3.
- **Search-layer leaks vs data contamination need different diagnostics.** Path-check before pattern-match.

**Memory:** `project_incident_2026_04_29_search_layer_leak.md`, `feedback_verify_before_destroy.md`, `feedback_check_open_prs_first.md`

### 7.5 — 2026-05-01: keys-create `--vault` flag silent-drop + seed-key bypass

**What happened:** Provisioning Ryan's vault and pre-loading content:

```
grove onboard ryan.p.parker@gmail.com --slug ryan
grove keys create ingest-bootstrap --vault ryan
GROVE_TOKEN=<minted> grove ingest /tmp/ryan-content/Inbox/ --yes
```

The CLI reported success at every step. The four notes landed in `/root/life/Inbox/` (John's vault) instead of Ryan's. Discovery cascaded into 7 derived concept notes before the leak was caught. Cleaned with 11× `grove delete --hard --yes`.

**What we thought:** Another scope-check miss.

**What it actually was — two layers of bug:**

1. **Client bug.** `cmdKeysCreate` in `src/cli.ts:1211` only took `name`. The `--vault` flag was parsed by the global flag-parser but never plumbed into the POST `/keys` body. Server-side `resolveMintVaultId` saw no `vault_slug`, took the implicit-fallback branch, bound the key to caller's default vault. Banner gave no indication anything was wrong.
2. **Server gap.** Even with the client fix, John's `cli-master` token (Grove-wide owner, *not* a `vault_members` row in Ryan's vault) hit the audit-hardened gate in `resolveMintVaultId` and got denied — by design, post-2026-04-26. That gate is correct for tenant-facing `/keys`. But it left **no sanctioned path** for "I just onboarded a friend, now I want to pre-load their vault."

**Third cross-vault leak class in two weeks.** The first was a misdirected token (04-28). The second was a search-scope bug (04-29). This one was a CLI flag silently dropped — the worst variant, because the server's defenses never engage because the bad request shape never arrives.

**Systemic fix:** PR #121 — plumb `flags.vault` and `flags.scopes` into the POST body; new `POST /v1/admin/vaults/seed-key` endpoint with strict `isPlatformOwner` gate that mints a vault-bound key without modifying `vault_members`. New CLI: `grove vault seed-key <slug>`. New regression test: `test/integration/cli-vault-flag-and-seed-key.int.test.ts` — `harness({ routes: ... })` records the body, assertions check `parsed.vault_slug`.

**Generalizable lessons:**

- **For any cross-tenant key minting, falsifier-first:** write a single probe note, then `ssh prod 'sudo test -e /root/vaults/<slug>/Inbox/_routing-probe.md && echo YES || echo NO'` BEFORE bulk ingest.
- **If a CLI flag in `--help` doesn't show up in any test or in the `cmd*` handler signature, assume it's a silent-drop and write a contract test that asserts the wire format.** CI grep can't catch missing flag plumbing; only contract tests can.
- **Localized bypass beats widening a high-traffic gate.** When a security gate is correct for the common case but blocks a legitimate platform-owner action, add a separate explicitly-gated endpoint, don't relax the high-traffic gate.

**Memory:** `project_incident_2026_05_01_keys_create_vault_flag_drop.md`, `feedback_honor_request_shape.md`

### 7.6 — 2026-05-02: `/grove:assure` sub-agents stalled at 600s

**What happened:** Weekly `/grove:assure` sweep launched 4 parallel sub-agents in worktree isolation on Sonnet (URL/handle, cross-vault paths, admin endpoints, ingest pipeline). All four hit `Agent stalled: no progress for 600s` mid-investigation — between 12 and 25 minutes of wall clock each — without shipping a PR. The cross-vault agent had reported "I found two real bugs. Let me verify them precisely before writing fixes" and was killed before fixing. The relaunched URL agent stalled the same way.

**What we thought:** Agent infrastructure regression.

**What it actually was:** The assure prompt template asked the agent to "read `<files>` end-to-end" — token-heavy on a codebase with `proxy.ts` (4,043 LOC), `cli.ts` (3,186 LOC), `server.ts` (1,411 LOC). Sub-agents stopped streaming for long enough that the watchdog claimed they were stalled. The findings the agents had already proven got lost because the parent can't read the JSONL transcript without context-blowing it.

**Systemic fix (the inline-on-stall pattern):**

- If a sub-agent stalls on first try, **do NOT relaunch with the same shape.** The relaunch will stall too. (Confirmed: relaunched URL agent killed at the watchdog the same way.)
- Switch to **inline grep-driven audit**: parent does `Grep` for the SQL/auth/URL pattern, reads only the matching ~50-line windows, ships findings as the parent.
- If you do relaunch, give a **time budget** ("this audit should take ~15 min; ship partial findings if you hit a wall") and explicitly forbid reading whole files.

**Generalizable lessons:**

- **Sub-agent context budgets are smaller than parent context budgets.** Workflows that ask sub-agents to "read everything end-to-end" exceed those budgets.
- **The right shape for parallel audits is grep-driven, not read-driven.** Find the pattern across the codebase; only read the matching windows.
- **Inline-on-stall is a process pattern, not an emergency fallback.** Build it into the skill template.

**Memory:** `feedback_assure_subagents_stalled_2026_05_02.md`

### 7.7 — 2026-05-07: provenance system shipped

Not an incident — a deliberate release. Documented here because it's the inflection where Grove's most durable artifact landed. PRs #133–#136. 168 stamps backfilled on `vault-life`. Phase A–C of the design.

**Generalizable lesson:** sometimes the most important commit of a project is not a bug fix but a deliberate primitive that enables future work. Provenance was that primitive for Grove. It would have been worth building even if everything else got torn down (and it is — the doctrine survives the teardown).

**Memory:** `project_provenance_system.md`

### 7.8 — 2026-05-14: scheduler crash loops (runMigration + timer.unref)

**What happened:** P23-1 schedulers (`grove-scheduler-<slug>`) shipped on 2026-05-14 and immediately crash-looped. 1300+ restarts each in the first hour. No stderr.

**What we thought:** Schema corruption.

**What it actually was — two bugs:**

1. **`runMigration` vs `createSchema`.** Schedulers called `createSchema()` directly. 4 schedulers + 4 servers + 4 discovery + 1 proxy = 13 processes hammering `/root/.grove/grove.db` on cold boot. Schedulers lost the race every time → `SQLITE_BUSY` on destructive DROP/RENAME paths in `migrate*()` helpers. Fix: PR #175 — one-line import swap per file. Use `runMigration()` (which wraps body in `BEGIN IMMEDIATE` + 5s busy_timeout).
2. **Timer `.unref()` killed the process.** `scheduler.ts` had `tickTimer.unref()` and `workerTimer.unref()` "to match the discovery worker." Discovery uses a non-unref'd `setTimeout` chain and has additional refs; the parity claim was wrong. Schedulers had only the timers as refs; `.unref()` told Node "these don't count as work" → process exited clean on every restart, no stderr, just `[scheduler] starting` looping in the out-log. Fix: PR #176.

**Falsifiers we missed:**
- For runMigration: `pm2 logs grove-scheduler-personal --err` would have shown SQLITE_BUSY immediately.
- For timer.unref: `grep '.unref(' src/scheduler.ts` would have shown the smoking gun.

**Systemic generalizations:**

- **PM2 worker entry points must call `runMigration()`, not raw `createSchema()`, on shared control DBs.** `runMigration` is the correct entry point for any process touching a shared SQLite file.
- **For PM2-managed worker processes whose entire job is timer-driven: never call `.unref()`.** The timer is the only ref keeping the event loop alive. `.unref()` is for short-lived utility processes that should exit when their *real* work is done — not for long-running workers. If the body is "schedule timers and return," don't unref.
- **The symptom "clean exit, no stderr, restarts climbing ~1/sec"** is the signature of unref'd timers. Grep for `.unref(` first.

**Memories:** `feedback_worker_entrypoints_use_runMigration.md`, `feedback_pm2_timer_unref_kills_process.md`

### 7.9 — 2026-05-18: echo vault provisioning + move-handler pathspec bug

**What happened:** Provisioning the `echo` vault for the autonomous-agent OpenClaw runtime. `grove vault create echo` succeeded (vault row, PM2 trio, git repo), but every request to `/v/echo/*` returned 403 `route_denied` until proxy was restarted. Then `handleMoveNote` reliably failed its commit step on 11 different moves during cleanup, leaving the vault in a stuck half-state.

**What we thought:** Two unrelated bugs.

**What it actually was — two unrelated bugs:**

1. **`vault create` doesn't refresh the proxy map** (`feedback_vault_create_proxy_refresh.md`). The proxy holds a cached vault map and doesn't reload it when a new vault row is inserted. `grove onboard` runs a proxy refresh step; `grove vault create` does not. Workaround: `sudo pm2 restart grove-proxy` after `vault create`.
2. **`handleMoveNote` git pathspec bug** (`feedback_move_handler_pathspec_bug.md`). `git mv A B` stages the rename; the working tree has B and no A. Then `git add -A -- A` runs and fails with `fatal: pathspec 'A' did not match any files`. Vault enters dirty + staged + uncommitted state. Cascade fails on the next move. Recovery: SSH to prod, `git add -A && git commit` as a synthetic operator — violates rule #3 (server is sole writer) but it's the only way. Fix: PR #192.

**Generalizable lessons:**

- **Provisioning paths must touch every downstream cache.** If `onboard` refreshes the proxy and `vault create` doesn't, the user gets confusing 403s. The right shape is one provisioning function with all the side effects; multiple entry points (CLI commands) are thin wrappers.
- **Git pathspecs after `git mv` are subtle.** `git add -A -- <src>` fails because `<src>` is already index-deleted and not in the working tree. Use `git commit <paths>` (bypasses `git add`) or `git commit -a` (commits all staged + tracked-modified).
- **Test against real git, not mock.** `move-handler-real-git.test.ts` was added post-fix and now catches this class.

**Memories:** `feedback_vault_create_proxy_refresh.md`, `feedback_move_handler_pathspec_bug.md`

### 7.10 — 2026-05-20: M-INBOX-1 single-vault when should have iterated all

**What happened:** A one-shot migration script (M-INBOX-1) was run against `personal` only — should have iterated all vaults. Echo's vault had 36 unmigrated rows rendering with no UI affordance until caught.

**What we thought:** Migration scripts naturally scope to the vault being worked on.

**What it actually was:** Grove is multi-vault. Any operational action against prod — migrations, one-shot scripts, manual SQL fixes, deploys, cleanups — must enumerate and iterate ALL vaults. The pattern of "I'll run it against personal first and check" is fine for *checking*, but not for *finishing*. Two operating modes (validate, then iterate) are not the same script.

**Systemic fix:** PR #214 — add `--all-vaults` flag. Codify: "every script iterates." `CLAUDE.md` was updated to say:

> Any operational action against prod — migrations, one-shot scripts, manual SQL fixes, deploys, cleanups — enumerates and iterates ALL vaults. Never scope to `personal` (or any single vault) without an explicit reason stated in the action description.

**Generalizable lesson:**

> **In a multi-tenant system, every operational script must default to "iterate all tenants" unless explicitly scoped.** A `--tenant <slug>` flag without an `--all-tenants` flag is a plan bug — flag it at review time.

---

### Patterns across the incidents

If you read the 10 incidents above as one event, the shape is:

1. **The 9 cross-vault leaks (7.2, 7.4, 7.5, plus six earlier scope-check misses in PRs #66, #85, #86, #87, #88, #89, #90)** are *one architectural mistake repeated nine times.* Storage layer doesn't enforce scope; application layer is morally obligated; the bug class can't be eliminated by audits, only by storage-layer rearchitecting.

2. **The 3 PM2 / deploy incidents (7.3 deploy storm, 7.8 scheduler, 7.9 vault create + move)** are *the deploy surface is untested.* CI runs vitest + tsc + audit + gitleaks; none of them touch `pm2`, `ssh`, or shell verbs.

3. **The 1 stale MCP session (7.1)** is *intermittent connector hiccups when grove-server restarts; reconnect is the workaround; instrumented fix never shipped.*

4. **The 1 assure stall (7.6)** is *sub-agent context budgets are smaller than parent context budgets; god files exceed them.*

5. **The 1 provenance ship (7.7)** is the doctrine that survives the teardown.

6. **The 1 multi-vault script gap (7.10)** is *operational scripts default-iterate, never default-scope.*

---

## 8. Process lessons — the doctrines

The rules that came out of incidents. Each is generalizable.

### 8.1 — Falsifier-first before destructive operations

**The rule:** Before recommending or executing `rm`, `DROP`, force-push, vault wipe, key revoke, or a deploy-verb change, write the single command whose output would prove the plan wrong — then run it before the destructive one. If no <60-second falsifier exists, say so explicitly and ask.

**Forged from:** the 2026-04-29 near-miss where I almost recommended `rm -rf` Sumon's vault on filename-pattern reasoning. A single `cmp` between Sumon's `Inbox/<weekday>-april-XX-2026.md` and John's `~/life/Inbox/<same-name>` would have falsified the contamination theory in 200ms.

**The cognitive trap to name:** representativeness heuristic — the symptom looks like a known cause, so I assume that cause without checking the mechanism-fingerprint (path, author, version, byte-equality). Symptom-similarity is a weak prior. Mechanism-fingerprints are strong evidence.

**Trigger words in your own draft response:** `wipe`, `delete`, `drop`, `reset`, `revoke`, `deploy`, `restart`, `force-push`, `migrate`. When any of these appears in a recommendation, stop and write the falsifier first.

**Examples:**
- Wipe vault X → `git -C /root/vaults/X log --all --format='%ae' | sort -u` (any author beyond me means real user content); `cmp <suspected> <my-original>` per file.
- Search-vs-data leak → `ssh prod 'test -e /root/vaults/<reporting-tenant>/<path-from-screenshot>'` (ENOENT means search-layer leak, not contamination).
- Deploy verb change → `pm2 --version && pm2 reload <stub-ecosystem>` against the prod-pinned PM2.
- Force-push → `git log <upstream>..HEAD --format='%an %s'` to see what's about to be discarded.

**Generalizable pattern:**

> **The autonomy a user grants is conditional on the agent being its own falsification test.** The user is not the safety net. Substituting reasoning for verification at a moment where verification is cheap is cashing in trust the agent has not earned for that decision.

**Memory:** `feedback_verify_before_destroy.md`

### 8.2 — Test deploy verbs against the prod-pinned binary

**The rule:** If a PR edits any `pm2`, `ssh`, `systemctl`, `nginx`, or shell verb inside `.github/workflows/ci.yml` or `scripts/deploy.sh`, treat it as untested code until proven otherwise. CI greenness is not evidence the deploy works — only evidence the application code compiles.

**Forged from:** PR #109 (deploy storm fix) → PR #110 (hotfix) → PR #111 (hotfix). Three deploys to learn one PM2 quirk. PR #109 used `pm2 startOrReload <file>` and named the runtime ecosystem `ecosystem.runtime.cjs`. Both passed all 1129 vitest tests, `tsc --noEmit`, `npm audit`, and gitleaks. Both broke on the first prod deploy. `pm2 startOrReload` throws on configs without a `deploy` block (`API.js:945`). PM2 only treats a filename as an ecosystem file if basename matches `*.config.{js,cjs,json}`.

**Cheapest validation:** `npm i -g pm2@<prod-version> && cd /tmp && <generate stub ecosystem> && <run the exact verb sequence ci.yml uses>`. ~30 lines, runs in any GHA runner. Shipped as `pm2-deploy-smoke` CI job (PR #115).

**Generalizable pattern:**

> **Generic test suites exercise the application code, not the deploy script's interaction with external binaries at specific versions.** Pin the test tool to the prod tool's version. When prod bumps, the test bumps. Echo the version in the deploy log so version drift surfaces in successful runs, not just failed ones.

**Memory:** `feedback_test_deploy_verbs_locally.md`

### 8.3 — Check open PRs before assuming a bug is new

**The rule:** `gh pr list --state open` is the first or second command in any incident triage. Before reading code, before SSH-ing prod, scan the open PR titles for keywords matching the symptom.

**Forged from:** 2026-04-29 cross-vault leak. PR #87 (the exact fix) had been open since 2026-04-25 in rebase-rot. We had diagnosed and patched this exact issue four days earlier; the patch just hadn't shipped. The troubleshooter assumed it was new and almost recommended destructive containment for a problem already fixed in a sitting PR.

**Triggers in your own thinking that mean "stop and check open PRs":** "this is new," "let me investigate," "I haven't seen this before," "this looks like the X incident from yesterday."

**Stale-PR triage rule (compounded later):** Run `gh pr list --state open --json number,headRefName,mergeStateStatus,autoMergeRequest -q '.[] | select(.mergeStateStatus == "BEHIND")'` at the start of every assure/audit run. For each BEHIND PR with auto-merge enabled: `git checkout`, `git rebase main`, `git push --force-with-lease`. CI re-runs against the new HEAD; auto-merge fires on green. Don't ask first — that defeats the autonomy granted in `feedback_pr_unblock_autonomy.md`.

**Generalizable pattern:**

> **Open PRs aren't just deferred work; they're a source of false novelty during incidents.** The thing you're investigating may already be solved upstairs. Treating every incident as net-new is overpriced when an existing PR matches the symptom. Rebase friction (no merge queue) is structural in most repos — auto-merge stays armed but never fires until someone manually rebases. Every stale fix risks misleading the next incident.

**Memories:** `feedback_check_open_prs_first.md`, `feedback_assure_rebase_stale_prs.md`

### 8.4 — Sub-agent side-effects must run inside sub-agents

**The rule:** When designing a skill that uses `Agent` for parallel work, every durable side-effect (PR merge flag, schema migration, write to durable store) MUST happen INSIDE the sub-agent's execution, before it returns. Don't defer to a "now apply auto-merge to all the PRs" parent step — that step may never run.

**Forged from:** `/grove:assure` 2026-04-25/26 nightly runs. Logs said `Exceeded USD budget (20)` and looked like total failures. In reality, sub-agents had created PRs #82-90 with passing CI before the parent died. The parent's planned `gh pr merge --auto` step never happened, so PRs sat OPEN with green checks, indistinguishable from "skill is broken." Reading `gh pr list` told a completely different story than reading the logs.

**Sub-agent prompt sequence:** do work → commit → push → open PR → enable auto-merge → THEN write summary text. The summary is the cheap last step; the irreversible/durable steps come first.

**Generalizable pattern:**

> **In any parallel-execution skill where the parent can die mid-run (budget cap, timeout, OOM, signal), durable actions belong in the sub-agent's tail.** Logs from killed runs underreport what happened. Always cross-check `git log`, `gh pr list`, and the actual artifact store before declaring a skill broken.

**Bonus rule:** For long-running skills, prefer Sonnet sub-agents to keep parent's Opus context budget free for synthesis. Opus parent + Opus sub-agents in parallel burns through budget very fast (~$1.20/min on Opus 4.7).

**Memory:** `feedback_subagent_durability.md`

### 8.5 — Auto-merge agent-opened PRs

**The rule:** Agent-opened PRs (from ship.ts batch runs, /mili:plan work, chore fixes) auto-merge on green CI without waiting for manual review. Exception: schema-change batches marked `noAutoMerge: true`.

**Forged from:** the user's stated preference. Agents are autonomous executors; the panel review / spec phase happens *before* the ship; once the ship is running, the user doesn't want to be a bottleneck on every downstream PR.

**Implementation:** `gh pr merge <num> --auto --squash --delete-branch` enabled on every agent-opened PR. For grove-www PRs opened by agents inside batches, the orchestrating session enables auto-merge (the agent in the worktree can't enable it itself — different auth context).

**Generalizable pattern:**

> **For autonomous agent execution to actually be autonomous, routine PR mechanics (rebase, regen baselines, enable auto-merge) must be pre-authorized.** Asking the user for permission on every routine step makes the agent worse than a human collaborator. Reserve explicit confirmation for: force-pushing to main, dismissing required reviews, merging without green checks, anything that touches another author's PR.

**Memory:** `feedback_auto_merge_prs.md`

### 8.6 — All scripts iterate all vaults by default

**The rule:** Any operational action against prod — migrations, one-shot scripts, manual SQL fixes, deploys, cleanups — enumerates and iterates ALL vaults. Never scope to a single vault without an explicit reason stated in the action description.

**Forged from:** 2026-05-20 M-INBOX-1 incident. Migration was run against `personal` only — should have iterated all vaults. Echo had 36 unmigrated rows rendering with no UI affordance until caught.

**Implementation:** every operational script takes an `--all-vaults` flag and defaults to it. A `--vault <slug>` flag is allowed for *checking*, never for *finishing*. If a script takes `--vault <slug>` without an `--all-vaults` flag, that's a plan bug — flag it at review.

**Generalizable pattern:**

> **In a multi-tenant system, "iterate all tenants" is the default; "scope to one" is the exception with a stated reason.** The cost of forgetting is one tenant in a stuck state with no UI affordance.

**Source:** `CLAUDE.md` (updated post-incident).

### 8.7 — PR unblock autonomy

**The rule:** For routine PR-unblocking actions on agent-opened PRs (rebase, regen visual baselines, enable auto-merge), proceed without confirmation.

**Forged from:** the user's explicit statement: "you don't need permission to do this kind of stuff" (2026-04-27).

**Routine =** PR mechanics on PRs the agent opened. Rebase, branch update, regen committed snapshots/baselines via the project's documented workflow, enable auto-merge.

**Still confirm before:** force-pushing to main, dismissing/overriding required reviews, merging without green checks, anything that touches another author's PR.

**Generalizable pattern:**

> **Pair with 8.5. Autonomy in execution requires autonomy in mechanics.** A skill that opens PRs and waits for human ack on rebase is a skill that creates a queue of stuck PRs. After acting, report what was done and why in the same turn — autonomy in motion, transparency in reporting.

**Memory:** `feedback_pr_unblock_autonomy.md`

### 8.8 — Honor the request shape

**The rule:** When an HTTP handler or RPC reads a structured field from the request body (a discriminated union type, a target URL, a mode flag, a scope string), the very next read of that field downstream must be a **check**, not a **use**. If you find yourself doing `body.X ?? defaultX` for a field that affects operation semantics — that's the smell. Either delete the field or enforce it.

**Forged from:** 2026-05-01 assure sweep, where three independent bugs all collapsed to this single pattern (`feedback_honor_request_shape.md`):
1. `searches[].type` accepted by the MCP `query` tool but `server.ts` always called `hybridSearch()` — `type:"lex"` triggered a Voyage embedding + vec scan and returned nearest-neighbor noise.
2. `/oauth/authorize` accepted any `redirect_uri` without validating against `oauth_clients.redirect_uris`.
3. `/oauth/token` accepted a `redirect_uri` parameter but never compared it to the value bound to the auth code (RFC 6749 §4.1.3).

**Generalizable pattern:**

> **The middle case — accept-but-ignore — is the bug.** Either the field is *load-bearing* (in which case enforce it) or it is *ornamental* (in which case don't accept it). During audits, grep handlers for `body.<field>` and follow each call to its first downstream consumer; the trip-wire is when the field appears in the parsed shape but not in the execution shape.

**Memory:** `feedback_honor_request_shape.md`

### 8.9 — Fix at the source, not at every consumer

**The rule:** When dirty data flows through a pipeline, clean it ONCE at the data entry point — not at each downstream consumer.

**Forged from:** 4 rounds of fixing wikilink-contaminated titles because each fix only patched one output surface (REST search, MCP formatResults, etc.). Every new surface was a new bug. Moving `stripWikilinks()` to the 3 data entry points in `hybrid-search.ts` (`ftsFileMeta`, `vectorSearch`, `getAliasIndex`) fixed all surfaces at once.

**Generalizable pattern:**

> **When adding data normalization, ask: "am I fixing this at the source or at one consumer?" If the latter, find the source.** Same principle for URL construction, path normalization, encoding, etc. The `vault_path` field (always clean, from filesystem) is the anchor of truth — `file` (display label) and `title` (from index) are derived and potentially dirty.

**Memory:** `feedback_fix_at_source.md`

### 8.10 — Read the log on arrival

**The rule:** Multiple agents work across these repos. When you start a session, check `git log` to understand what happened recently — other agents may have laid groundwork, created notes, or changed structure. Build on their work, don't duplicate or contradict it.

**Forged from:** 2026-04-28 onboarding session where I SSH-patched prod for fixes that PR #95 had silently shipped during my debugging session (`project_2026_04_28_onboarding_reflection.md`). I was reading the pre-PR-95 file in my context and applying old fixes.

**Specific protocol:** at the start of any prod-incident or bug-investigation session in this repo, `git log --oneline -20` first. If recent commits touch the area in question, read those diffs before patching.

**Generalizable pattern:**

> **In a multi-agent repo, your context is a snapshot, not the truth.** The truth is `git log`. Read it on arrival, not as a fallback when something seems wrong.

**Memory:** `project_2026_04_28_onboarding_reflection.md`. Codified in `CLAUDE.md` ("Read the log on arrival").

### 8.11 — Default to committing

**The rule:** Every meaningful unit of work should be shaped and logged as a commit. Commits are how we trace the evolution. Don't let work accumulate uncommitted. Don't wait to be asked.

**Source:** `CLAUDE.md`. Wasn't forged from an incident; it's a stated value that became operational doctrine.

**Generalizable pattern:**

> **Every commit should have a check you could run to know it's done: a test passes, a page loads, a note has the expected frontmatter, the script produces the expected output. Name the check first, then write the code that makes it true. A commit without a check is a gesture, not a unit of work.**

---

## 9. Tooling & infra lessons

The platform realities. Each is the kind of thing you only learn by hitting it.

### 9.1 — PM2 has three quirks worth retaining permanently

**Quirk 1: Filename pattern.** `pm2 reload /path/to/foo.cjs` does NOT parse the file as an ecosystem config unless the basename matches `*.config.{js,cjs,json}`, `processes.json`, or `ecosystem.{js,cjs,json}`. Anything else (e.g. `ecosystem.runtime.cjs`, `apps.cjs`, `deploy.cjs`) gets treated as a *process name* and PM2 emits `[PM2][ERROR] Process or Namespace ... not found` — which looks like the file is missing but isn't. Caught twice in one night (PR #109 → #110 → #111).

**Quirk 2: `reload` doesn't re-read script path.** `pm2 reload` keeps the OLD `script` and `args` they were registered with. Env vars are re-read, but structural changes to `script` / `args` / process names are silently ignored. Must `pm2 delete all && pm2 start` for structural changes. Hit on PR #66 deploy.

**Quirk 3: Timer `.unref()` kills the process if timers are the only ref.** `setInterval(fn, ms).unref()` inside a PM2 worker whose entire job is timer-driven causes silent crash loops with no stderr. Hit on PR #176 (scheduler).

**Quirk 4 (related): `pm2 startOrReload` is broken in many versions.** Reads `config.deploy` without null-check; throws on configs without a `deploy` block. Use the two-step `pm2 reload <file>` + `pm2 start <file> --only <new-csv>` pattern.

**Memories:** `feedback_pm2_filename_pattern.md`, `feedback_pm2_reload_script_path.md`, `feedback_pm2_timer_unref_kills_process.md`

**Generalizable pattern:**

> **External binaries have version-pinned behavior. Test your shell verbs against the prod-pinned version of the binary in CI** (see 8.2). Especially for: PM2, systemd, nginx config, Docker compose, kubectl.

### 9.2 — Vault sync `--ff-only` aborts on external pushes

**The setup:** `scripts/sync-all-vaults.sh` does `git pull --ff-only` on each vault on a 5-minute cron. The CLAUDE.md rule #2 ("server is the sole writer to git") makes that the right rule for the steady state — but it breaks the moment anything else pushes to origin.

**The bite:** If you push your own stamps to `origin/main` from a different machine, the next cron tick fetches them, then `--ff-only` aborts the merge because prod's HEAD has its own local discovery commits not in origin (histories diverged). The external pushes stay as fetched-but-unmerged objects on prod's git store. They never make it into HEAD's ancestry, so the read-side blame walker doesn't see them.

**Workaround:** SSH to prod, stop the discovery worker, `git pull --rebase origin main`, restart discovery, push back to origin.

**Proper fix:** change `git pull --ff-only` to `git pull --rebase --autostash` in the cron script.

**Memory:** `feedback_vault_sync_ff_only.md`

**Generalizable pattern:**

> **"Server is the sole writer" is a clean rule until you need to write from elsewhere (backfills, stamps, recovery). Build the sync script to handle reasonable divergence (`--rebase --autostash`) rather than abort (`--ff-only`).** The cost of the wrong choice is silent data invisibility on the read path.

### 9.3 — Voyage AI hosted > self-hosted TEI/sentence-transformers

**The setup before:** Local GPU embeddings (Qwen3-0.6B on T4 via Text Embeddings Inference). g4dn.xlarge instance, ~$385/mo.

**The setup after:** Voyage AI API (`voyage-4-large`, 1024-dim). t3.medium instance, ~$30/mo. ~$350/mo saved. Faster on cold start. Higher embedding quality.

**The key insight:** GPU was idle 99.9% of the time — only used on writes. Hosted embed pricing at small scale beats both self-host capex *and* op-ex of maintaining a GPU instance.

**Memory:** `project_infra_state.md`

**Generalizable pattern:**

> **For embedding-needing systems below ~10M embeds/month: use a hosted embed API. Don't self-host.** The math only flips at scale; at small scale the hosted API is cheaper, faster, higher-quality, and removes a class of ops work. Voyage AI specifically (`voyage-4-large` for quality, `voyage-3-large` for cost) is the right default for English knowledge bases.

### 9.4 — SQLite per-vault > shared with `vault_id` column

See §5.5. The structural answer to the application-layer-tenancy anti-pattern (§6.2).

### 9.5 — Git bundle as portable vault export

**The setup:** When sharpshoot's hosted product is sunset (per `SIMPLIFY.md` Day 7 plan), Sumon gets a vault git-bundle on request. A git bundle is a single file containing the full git history of the vault repo. It's portable: clone it, push it to a new remote, you have a working vault.

**Generalizable pattern:**

> **For any system that holds user-owned data: have a one-line export path that produces a portable artifact.** Git bundles for git repos, SQL dumps for SQL databases, JSONL for event streams, tarballs for filesystems. The export is the user's exit ramp; build it from day one.

### 9.6 — Worker entry points use `runMigration`, not raw `createSchema`

See 7.8. PM2 workers must call `runMigration()` (which wraps `BEGIN IMMEDIATE` + busy_timeout) on shared control DBs, never raw `createSchema()`. Otherwise N concurrent processes race on the writer lock and lose.

**Memory:** `feedback_worker_entrypoints_use_runMigration.md`

### 9.7 — Move handler git pathspec bug

See 7.9. `git add -A -- <src>` after `git mv` fails because `<src>` is index-deleted. Use `git commit <paths>` or `git commit -a`.

**Memory:** `feedback_move_handler_pathspec_bug.md`

### 9.8 — Stale MCP session bug

See 7.1. `claude.ai`'s MCP connector holds a stale `mcp-session-id` after `grove-server` restart. Proxy's rehydration fallback fails silently. Workaround: disconnect + reconnect Grove in claude.ai.

**Memory:** `project_stale_mcp_session.md`

### 9.9 — "Life" vault_id sentinel

**The setup:** Many pre-2026-04-24 rows in `api_keys` carry `vault_id = "life"` — a legacy sentinel string that matches no `vaults.id`. It was the hardcoded default in `/keys` POST before PR #49.

**The workaround:** Don't rely on `api_keys.vault_id` to identify a key's vault. Treat it as advisory. Authoritative membership is `vault_members (user_id, vault_id)`.

**Generalizable pattern:**

> **Schema-default sentinels become legacy debt. If you have a hardcoded default value in a foreign-key-like column, plan its migration the day you ship it.** Otherwise the sentinel survives forever in old rows, and downstream code accumulates membership-fallback paths.

**Memory:** `project_life_vault_id_sentinel.md`

### 9.10 — Server scripts must live in project dir

**The setup:** `npx tsx /tmp/foo.ts` fails with `MODULE_NOT_FOUND` on `better-sqlite3` because npx tsx resolves modules relative to cwd. Scripts outside the project tree can't find deps.

**Fix:** Write scripts in `scripts/`, git push, SSH in, git pull, `npx tsx scripts/foo.ts`. Delete debug scripts after use.

**Memory:** `feedback_server_scripts.md`

### 9.11 — Bash 3.2 compat

**The setup:** macOS ships bash 3.2.57. No `declare -A` (associative arrays), no `readarray`/`mapfile`, no `${!assoc[@]}`. `run-batch.sh` broke on first use because it used `declare -A`.

**Fix:** Use indexed arrays + case/switch. Test with `/bin/bash` explicitly.

**Memory:** `feedback_bash_compat.md`

### 9.12 — Worktree branches from origin/main

**The setup:** `claude --worktree <name>` creates a branch from `origin/main`, not local `main`. If local main has unpushed commits, agents work on a stale base and merges conflict.

**Fix:** Always `git push origin main` before launching batch agents. Built into `run-batch.sh` as a pre-flight check.

**Memory:** `feedback_worktree_base.md`

---

## 10. Strategic lessons — the meta

The meta-shape of the Grove arc.

### 10.1 — The "local maximum" pattern

**The shape:** A project tries to be two (or three) things simultaneously. Each is locally optimized within the constraints of the others. The "both" state is strictly worse than either pole would be alone.

**In Grove:** personal tool + multi-tenant SaaS + autonomous agent platform. Each surface paid for the other two: the personal tool paid SaaS overhead; the SaaS paid for autonomy violations of the personal-tool constitution; the autonomy paid for SaaS-shaped consent gates it didn't use.

**The signal:** when the same codebase needs different priorities at different layers ("the MCP surface is for me; the OAuth flow is for strangers"), you're at a local maximum.

**The fix:** pick a pole. The "both" state is the worst state.

**Generalizable pattern:**

> **A project with two plausible identities should pick one early — before the architecture forks for both.** Picking late is the most expensive option. The cost of picking is paid once; the cost of not picking is paid indefinitely.

### 10.2 — The "userbase of one" pattern

**The shape:** Features are built for users that don't exist. Each individual feature is defensible ("when we onboard users, this'll matter"). The aggregate is unmaintained code disguised as infrastructure.

**In Grove:** waitlist for an unlaunched product. Encryption for vaults that aren't encrypted. Magic-link auth for a one-user funnel. Per-trail rate limits for unused trails. Half-built v2 dashboard.

**The signal:** any feature table with zero usage after a month is the user telling you the feature is speculative.

**The fix:** **before building infrastructure, name the user.** "John, daily" is a user. "Anyone who signs up after the launch we haven't done" is not.

**Generalizable pattern:**

> **For every speculative feature, set a kill condition with a date.** "If by 2026-06-01 we have <5 active trail consumers, we retire trails." When the date hits, look at the metric. If you can't articulate a kill condition, you're building a feature without a hypothesis.

### 10.3 — The ZOOM-OUT discipline

**The shape:** Periodically map all interfaces and ask "who actually uses this?" The act of laying surface-by-surface side-by-side reveals what you've been doing.

**In Grove:** the 2026-05-25 zoom-out used six parallel sub-agents to audit (1) core retrieval/data/multi-vault, (2) SaaS layer, (3) autonomous agent, (4) discovery + images + graph-health + blame + sync, (5) grove-www web product, (6) strategic/historical. The duplication matrix made the systems debt visible. The user table made the costume visible. The 5× velocity drop made the body's no audible.

**The discipline:**

1. Pick a cadence (monthly is too short, quarterly is right for active projects).
2. Map every interface (or surface) the project exposes.
3. For each interface row, count concrete users (not registrations — real recent activity).
4. Highlight any row where users = 0 or 1 (and that 1 is yourself).
5. Build a duplication matrix: same capability × surfaces. Highlight overlap.
6. Compare current state to original intent (GOAL.md, fitness function, OKRs).
7. Pick a pole if you're at a local maximum.

**Generalizable pattern:**

> **The zoom-out is the antidote to the "I've been busy, things must be progressing" feeling.** Velocity is not the right metric; alignment is. **The act of writing the audit forces honesty** — you can't write a duplication matrix without seeing the duplication.

### 10.4 — Cost-benefit of own-tool vs hosted product

**The shape:** Building infrastructure for yourself has near-zero marginal cost (you're the only user; bugs are visible immediately; the bar is "useful to John"). Hosting a product has structural costs (uptime, multi-tenancy, support, security audits, compliance) that scale with the user count but also have a fixed minimum.

**In Grove:** ~$30/mo AWS + 1 outside user. The fixed-minimum hosting overhead (incident response, multi-vault correctness, OAuth flows, key minting, scope enforcement) was paid in full for an audience that didn't justify it.

**Generalizable pattern:**

> **The cost of running a hosted product is the fixed minimum, not the marginal cost. If the marginal user can't pay the fixed minimum's amortization, you don't have a business — you have a hobby with a billing system.** When the marginal user count is 1, the fixed minimum × time = the cost. Compare honestly to "use it yourself locally."

### 10.5 — When to kill a project — the explicit criteria

**The criteria John used:**

1. **Userbase of one** outside himself, and that one was occasional.
2. **Cost-benefit collapsed** ($30/mo AWS + cognitive overhead for one outside user).
3. **No business intent** — Grove was always an intellectual exercise, never a startup.
4. **The intellectual exercise was complete** — patterns were extracted.
5. **The vault survives Grove** — killing Grove doesn't kill the knowledge.
6. **Local Grove is always an option** — if missed later, spin up locally.

**The honest framing:** "Grove served its purpose as an intellectual exercise. Keep the cathedral pieces open source; stop running it as a service."

**Generalizable pattern:**

> **A kill decision is easiest when the project has a clear identity (intellectual exercise / startup / internal tool / open-source library) and a clear audience.** When both are crisp, the kill criteria are mechanical: who uses it, what does it cost, what does it teach, what survives if we stop.

> **The hardest kill decisions are projects without clear identity** — the "could be a product someday" or "useful for me but also maybe others" middle. Force the identity question. Once it's named, the kill criteria fall out.

### 10.6 — The "intellectual exercise" framing

**The shape:** Building to learn is valid. Pretending it's a product is not.

**In Grove:** the project taught John (and the agents working on it) about hybrid search tuning, the 6-tool MCP discipline, provenance/blame doctrine, per-vault storage scoping, autonomous agent containment, the local-maximum trap, sub-agent durability patterns, falsifier-first discipline, PM2 quirks. All of these will compound forward.

The mistake was the **HN launch fiction**. HN-LAUNCH.md was the artifact of pretending it was a product. The launch never fired because the body knew it wasn't a business — but the doc sitting in the repo created low-grade dishonesty about direction.

**Generalizable pattern:**

> **Be honest about the genre at the start.** "This is an intellectual exercise. I'm building it to learn. The goal is the patterns I extract, not the users I acquire." That framing makes the kill decision easy (you stop when the patterns are extracted) and keeps the speculative apparatus out (you don't need a waitlist for an intellectual exercise).

> **If at any point the genre shifts** ("this is actually a product"), commit to that shift fully — fire the launch, resource the funnel, charge for it. **Don't keep the dual identity.** It's the same lesson as 10.1; the dishonesty about genre is one face of the local maximum.

---

## 11. AI-collaboration lessons — the meta-meta

Grove was built almost entirely by Claude under John's direction. The collaboration patterns matter more than the artifact.

### 11.1 — What worked

**Auto-memory + typed memory files** (`~/.claude/projects/-Users-jm-src-grove/memory/`). Durable cross-session knowledge. The 45 memory files in this project's directory are the highest-density information about what was learned. Every memory file frames an incident as "what happened / why / how to apply" — that schema is portable.

**`CLAUDE.md` as constitution.** The repo's `CLAUDE.md` codified architecture rules (#1 vault is source of truth, #2 single writer, #3 serialized writes, #4 every write commits, #5 sync reindex, #6 tool count discipline) and diagnostic discipline (falsifier-first, test deploy verbs, check open PRs, sub-agent durability, auto-merge autonomy, all-vaults default). **Constitutional rules at the project root drift-resist better than scattered conventions.**

**The watchdog skill** (`/grove:watchdog`). Daily ops-health sweep. Detected PM2 crash loops, errored processes, orphan PM2 names, stale npx cache, prod/main drift, stuck schedulers. Auto-fixed known-safe issues, auto-PR'd (with auto-merge) for code bugs matching documented patterns, opened GitHub issues for novel ones. **The skill stayed useful across the entire project — it's the right shape for any production system you operate alone.**

**The assure skill** (`/grove:assure`). Weekly adversarial assurance sweep. Ran parallel audit agents against the most-stale surfaces, smoke-tested prod via MCP, opened PRs for findings. Caught: search-type-ignored (PR #122), OAuth redirect_uri (PR #122), key rotate vault binding drop (PR #122), graph-health flag table scope (PR #124), trail-admin scope (PR #118), discovery+trail-admin admin scopes (PR #120), 4 cross-vault scope misses in graph-health + embed-single + cli (PRs #124/#125), and more. **An adversarial sweep on a cadence is a different kind of value than incident response — it finds the bugs no user has hit yet.**

**Sub-agents for parallel audits.** The 6-agent zoom-out (`ZOOM-OUT.md`) couldn't have been done by one Claude session. Six agents in parallel, each with one surface (core, SaaS, autonomous-agent, discovery+blame, grove-www, strategic). Each returned findings; the parent synthesized. **The shape generalizes:** any complex audit benefits from parallel sub-agents on orthogonal surfaces.

**The skill system as workflow durability** (`~/.claude/skills/`). Every workflow that survived its first run got promoted to a skill. The garden suite (`/garden:plant`, `/garden:harvest`, `/garden:forage`, `/garden:wander`, `/garden:tend`, `/garden:pulse`, `/garden:seek`) was the lens over the vault; the grove suite (`/grove:watchdog`, `/grove:assure`) was the lens over prod ops. **Skills converted from "I have to remember to do this" to "I have a slash command for this."**

**The "agentic patterns" — scheduled agents that maintain the system.** `/grove:watchdog` daily, `/grove:assure` weekly. The system's health was an output of recurring agent work, not a thing John had to think about. **This is the right shape for any production system you don't want to babysit.**

**Auto-memory triggers.** When a non-obvious fact about the project / a feedback rule / a reference surfaces during a conversation, it gets written to a typed memory file (`project_*`, `feedback_*`, `reference_*`) inline, with the "why / how to apply" schema. The 45 memory files in this directory are the receipts.

### 11.2 — What didn't work

**Auto-merge without a gate produced PR sprawl.** Agent-opened PRs auto-merged on green CI — which was the right rule (8.5) — but with no rebase enforcement, stale PRs accumulated BEHIND main. PR #87 sat 4 days BEHIND in rebase-rot and caused the 2026-04-29 leak misdiagnosis (8.3). Fix: rebase stale assure PRs at the start of every assure run (`feedback_assure_rebase_stale_prs.md`). **Better fix:** GitHub merge queue. Never shipped.

**Sub-agent worktree branch hygiene drift.** Some sub-agents with `isolation: worktree` still commit onto branches in the parent worktree, switching the parent's HEAD. On 2026-04-30, 2 of 4 sub-agents did this (`feedback_assure_worktree_branch_hygiene.md`). Mitigation: parent does `git checkout main` at the start of synthesis. **The SDK's worktree isolation is best-effort; don't trust it.**

**Sub-agent PR collision when multiple agents converge on the same finding.** 3 of 4 assure agents on 2026-04-29 independently flagged the OAuth `proxy.ts:364` static-key fallback. Two opened parallel PRs (#118 and #120) before either saw the other's. Mitigations: each sub-agent runs `gh pr list` before opening; parent does post-collation dedupe. **Race window between `gh pr list` and `gh pr create` is too wide for parallel sub-agents.** Future fix: `.assure/inflight/<surface>.json` lockfile.

**Sub-agent stalls on token-heavy reads.** All 4 `/grove:assure` sub-agents stalled at 600s on 2026-05-02 trying to read `proxy.ts` end-to-end. **Sub-agent context budgets are smaller than parent context budgets.** Pattern: switch to inline grep-driven audits on first stall; don't relaunch identical prompts (7.6).

**Dead code accumulating.** Nobody was pruning. `src/embed.ts` (OpenAI-era, 279 LOC, no importer) sat in the repo from the Voyage AI swap (2026-04-08) until the zoom-out (2026-05-25). Same for `src/discovery-neighbors.ts` (186 LOC, no caller since 04-29) and `autoHeal` helpers in `graph-health.ts` (~400 LOC, tests-only). **An accumulating dead-code wedge is the absence of a recurring prune.** Fix: should have been a scheduled `/grove:assure` sub-agent dedicated to dead-code detection.

**The fitness function decayed silently.** GOAL.md was supposed to be run via `scripts/score.sh` on every shipped feature. It was last scored 2026-04-07. **No agent was watching for the score-decay.** Fix: a watchdog signal that flags "score hasn't been run in N days."

**No alarm when velocity dropped 5×.** The April-to-May 5× drop in commits should have triggered a "are we still aligned?" prompt. Nobody (human or agent) flagged it until the zoom-out. **Velocity should be a monitored signal.**

### 11.3 — Pattern: agentic systems need watchdogs *on the agents themselves*

The lesson is broader than Grove. AI-built systems have failure modes that classical systems don't:

- **Auto-merge sprawl** — agents open PRs faster than they get rebased.
- **Sub-agent worktree drift** — isolation is best-effort, not guaranteed.
- **Sub-agent stalls on big files** — context budgets are smaller.
- **Sub-agent PR collisions** — parallel agents converge on the same finding.
- **Dead code accumulation** — agents add, rarely subtract.
- **Doc drift** — agents update the code without updating the planning docs.
- **Costume accumulation** — agents are good at building *what was asked*, less good at saying "this is the wrong thing to build."

**Generalizable pattern:**

> **For any agentic system, build watchdogs on the agents.** Daily ops sweep (find what's flapping). Weekly adversarial sweep (find what no one's hit yet). Monthly zoom-out (find what we're building that nobody uses). Quarterly identity check (is this still the project we said it was?). **Agents are good at executing; humans (or other agents in a different mode) are good at noticing when the execution is wrong-altitude.**

### 11.4 — The "perishable vs durable" doctrine generalizes to AI collaboration

This is the meta-meta lesson. Provenance/blame (5.4) was designed for vault content but the doctrine is universal:

> **When AI agents and humans co-author durable artifacts (code, knowledge, decisions), every artifact has a voice — durable (human's primary source, AI extraction of human intent, cited research) or perishable (AI synthesis or prediction at moment T). When in doubt, default to perishable. Surface the voice to future readers with imperative MUST language: name the perishable framing before extending.**

This applies to:
- Code (every commit has an author and a moment; refactoring AI-suggested code 6 months later without re-asking the user is the wrong default).
- Documentation (the most-perishable doc kind is the "current state" snapshot; mark it).
- Planning docs (GOAL.md was perishable but treated as durable).
- Memory (auto-memory entries are *observations at a moment* — they should be marked perishable by default, see the `<system-reminder>` headers on memory files).

The third-bucket failure mode (Claude synthesis filed as durable, future sessions reading it as John's standing thinking) is the universal AI-collaboration trap. Provenance was Grove's specific fix; the doctrine is portable.

### 11.5 — `mili:` skills for shaping work; `garden:` skills for tending knowledge; `grove:` skills for operating prod

The skill namespacing convention worked. Three families:

- **`mili:*`** — project shaping (idea, spec, plan, loop, scaffold, fork). The "how do I think about / start / execute a project" lens.
- **`garden:*`** — vault practice (seek, plant, harvest, forage, wander, tend, pulse). The "how do I tend my knowledge" lens.
- **`grove:*`** — production ops (watchdog daily, assure weekly). The "how do I keep this running" lens.

Each family is a lens on a substrate (Grove vault, agent state, prod infra). The lens-over-substrate pattern from `CLAUDE.md` ("skills are domain overlays on Grove") generalized cleanly.

**Generalizable pattern:**

> **Group skills by lens, not by tool.** The verb is the skill; the noun is the lens namespace. `garden:plant` (verb=plant, lens=garden). `grove:watchdog` (verb=watchdog, lens=grove). Three-letter prefixes scale; ten-letter ones don't.

---

## 12. What carries forward

Explicit "rebuild this" / "avoid this" / "reuse directly" lists.

### 12.1 — Rebuild (the patterns to keep using)

| Pattern | Where it was | Why it's portable |
|---|---|---|
| **6-tool MCP discipline + mode-on-tool pattern** | `src/server.ts` | Tool-overlap risk is real even on modern models. The `action` / `mode` parameter is the right way to expand a tool without expanding the tool count. |
| **Hybrid search BM25 + vec + title via RRF, tuned weights, type boosts, alias injection** | `src/hybrid-search.ts` | The cleanest portable search implementation in the repo. ~900 LOC. Drop-in for any markdown corpus. |
| **Live per-write embed + synchronous reindex** | `src/embed-single.ts` + write path in `rest.ts` | Eventual consistency creates duplicates when consumers have no memory between calls. Sync is non-negotiable for write-back. |
| **Git single-writer write queue + trailing batched push** | `src/write-queue.ts` | 99 LOC. Promise chain mutex. Error-isolated. Trailing-timer batch. Telemetry. The right shape. |
| **Provenance / blame doctrine — per-commit trailers + read-side walker + perishable-default + tool-description MUST directive** | `src/provenance.ts` + `src/blame.ts` + classifier pipeline at `scripts/provenance/` | The crown jewel. Solves a hard universal AI-collab problem. Schema locked. |
| **Per-vault structural enforcement (per-tenant SQLite files)** | `src/db-per-vault.ts` + `src/migrations/vault/*.sql` | Storage-layer tenancy. Makes cross-tenant leaks structurally impossible. |
| **Vault-as-source-of-truth invariant** | `CLAUDE.md` rule #1 | Survivability + recovery clarity + no vendor lock-in. Applies to any system that derives state from user-owned data. |
| **Falsifier-first doctrine** | `feedback_verify_before_destroy.md` | Pre-destructive verification. The autonomy a user grants is conditional on the agent being its own falsification test. |
| **Watchdog + assure scheduled-agent patterns** | `~/.claude/skills/grove:watchdog/` + `~/.claude/skills/grove:assure/` | Daily ops health + weekly adversarial sweep. Right shape for any production system you operate alone. |

### 12.2 — Avoid (the anti-patterns)

| Anti-pattern | Where it bit | How to avoid |
|---|---|---|
| **Multi-tenant before users** | Phase 8 multi-vault, 9 leak incidents | Don't build multi-tenant until ≥5 active outside users on single-tenant. Single-tenant converts easily; multi-tenant is structural overhead. |
| **Application-layer enforcement of tenancy** | The nine cross-vault leaks | Tenancy belongs in storage layer. Per-tenant files. Don't write tests for "developers must remember to do X." |
| **Autonomous mutation without consent gates** | `src/skills/first-run.ts` auto-enable | Explicit opt-in for anything that spends money or mutates user data. Default-on is theft of attention. |
| **God files** | `src/proxy.ts` at 4,043 LOC | Set hard limits. ~1K uncomfortable, ~2K problem, ~4K is the bug class. Extract concerns early. |
| **Fitness functions that aren't maintained** | GOAL.md last scored 2026-04-07 | Either keep it current (every shipped feature touches the score) or delete it. |
| **PLAN.md "current state" snapshots** | The 2026-04-21 snapshot drifted by ~66 modules | Auto-generate from code or delete. The truth is in `git log` and `wc -l`. |
| **Building both options simultaneously** | Personal + SaaS + autonomy at once | Pick a pole early. The "both" state is the worst state. |
| **Infrastructure for a userbase of one** | Waitlist, encryption, magic-link auth, half-built dashboard | Name the user (specifically). If hypothetical, don't build. |
| **Deploy verbs untested** | PR #109/#110/#111 (PM2 quirks) | Test against prod-pinned binary in CI. Pin the test PM2 to the prod PM2. |
| **`git add -A -- <src>` after `git mv`** | `handleMoveNote` (PR #192) | Use `git commit <paths>` or `git commit -a`. |
| **PM2 timer `.unref()` in worker entry points** | `scheduler.ts` (PR #176) | Workers whose only refs are timers — never unref. |
| **PM2 ecosystem filenames not matching `*.config.{js,cjs,json}`** | PR #111 | Generator output paths must end in `.config.cjs`. |
| **`pm2 startOrReload`** | PR #110 | Use `pm2 reload + pm2 start --only`. |
| **`git pull --ff-only` on a vault that has external pushes** | The 2026-05-07 stamp incident | Use `git pull --rebase --autostash`. |
| **Raw `createSchema()` in worker entry points** | PR #175 | Use `runMigration()`. Serializes via `BEGIN IMMEDIATE`. |
| **Single-vault scripts in a multi-vault system** | M-INBOX-1 (PR #214) | Default to iterate-all. |

### 12.3 — Reuse directly (code you can lift into the next project)

These files are portable. Steal them.

| File | Purpose | LOC |
|---|---|---|
| `src/write-queue.ts` | Promise-chain mutex with trailing batched push | 99 |
| `src/hybrid-search.ts` | BM25 + vec + title RRF fusion + alias injection | 887 |
| `src/embed-single.ts` | Live per-write embed (substitute Voyage for any embed API) | ~170 |
| `src/provenance.ts` + `src/blame.ts` | Per-commit provenance + read-side blame walker | 314 + 646 |
| `src/db-per-vault.ts` | Per-tenant SQLite connection pool with lazy open + per-tenant migrations | 160 |
| `src/notes-validate.ts` | Frontmatter validation: type whitelist, required fields, path/type consistency | ~136 |
| `src/cli/lib/config.ts` + `tty.ts` + `signals.ts` + `deprecation.ts` | CLI scaffolding: config loading, TTY detection, signal handling, deprecation warnings | ~190 total |
| `scripts/eval-vector-search.ts` | 16-case search quality eval, precision@5 + MRR | — |
| `scripts/provenance/*.ts` | Classifier pipeline for backfilling provenance into legacy vaults | — |
| `~/.claude/skills/grove:watchdog/` + `~/.claude/skills/grove:assure/` | Daily + weekly scheduled-agent skills | — |
| `~/.claude/skills/garden:*` | Vault-as-substrate skill family (seek, plant, harvest, etc.) | — |

### 12.4 — Constitutional carry-forward

Lift these directly into the next project's `CLAUDE.md`:

1. **The vault (or substrate) is the sole source of truth. Everything else is derived.**
2. **All writes are serialized through one queue.**
3. **The server is the sole writer to the substrate. Local machines pull.**
4. **Every write creates a commit with the agent's identity in the commit message.**
5. **The search index updates synchronously on write.**
6. **Keep tools distinct and composable. ≤6 is a guideline; tool-overlap risk is the actual concern.**

Plus the diagnostic discipline:

1. **Falsifier-first before destructive operations.**
2. **Test deploy verbs against the prod-pinned binary.**
3. **Check open PRs before assuming a bug is new.**
4. **Sub-agent side-effects must run inside sub-agents (not in parent collation).**
5. **All scripts iterate all tenants by default.**
6. **PR unblock autonomy — routine mechanics are pre-authorized.**
7. **Honor the request shape — accept-but-ignore is the bug class.**
8. **Fix at the source, not at every consumer.**
9. **Read `git log` on arrival.**
10. **Default to committing.**

---

## 13. What Grove leaves behind

**The open-source library** at `github.com/jmilinovich/grove` — post-teardown, single-user core, MIT licensed.

The cathedral that survives:

- **6-tool MCP** over a git-backed vault
- **Hybrid search** (BM25 + vec + title + RRF + alias injection + tuned weights)
- **Live per-write embed** path
- **Git single-writer write queue** + trailing batched push
- **Provenance / blame** doctrine — per-commit trailers + read-side walker + perishable-default + MUST directive
- **Discovery extract→link engine** — auto-wikilinking on write, depth-capped, content-hash cached

The costumes that go:

- Trails (`src/trails.ts` + `src/share.ts` + share UI) → retire
- Encryption (`src/crypto.ts` + `src/index-crypto.ts` + encrypt/lock/unlock CLI) → retire
- Invite/waitlist/email (`src/invite.ts`, `src/waitlist.ts`, `src/email.ts`) → retire
- Admin portal HTML + `/admin/usage` (server-rendered) → retire
- HN-LAUNCH.md → archived
- v2-tasks / server skills / decisions / scheduler / `first-run` auto-enable → extracted to `goal-md` or its own repo; at minimum `first-run.ts` auto-enable disabled
- Multi-tenant routing / OAuth flows / magic-link auth → collapsed to single-vault, single-user, single API key from env

**The patterns** (above, §12) carry forward into John's future work.

**The vault** (`~/life/`, ~1,750 notes across People, Concepts, Companies, Journal, Sources, Recipes, Areas, Projects, Archives) — **untouched**, predates Grove, survives Grove. The vault was always the cathedral; Grove was always the plumbing. When the plumbing is removed, the cathedral is fine.

**The 45 memory files** at `~/.claude/projects/-Users-jm-src-grove/memory/` — durable cross-session knowledge. Every incident, every doctrine, every architectural insight. They're the primary input to this retrospective and they outlive both Grove and this document.

**The skills** (`~/.claude/skills/`) — `/garden:*` (lifecycle-aware vault practice), `/grove:watchdog` + `/grove:assure` (scheduled-agent ops patterns), `/mili:*` (project shaping). The watchdog + assure pattern survives even though Grove ops is sunsetting — the *patterns* generalize to any production system.

**The lesson:** **kill speculation early, keep utility.** Grove succeeded as an intellectual exercise. It would have failed as a hosted product, and the body knew this at least six weeks before the head admitted it. The next project starts with that ground truth pre-loaded.

---

## Coda

Two months. ~1,065 commits. 68 source modules. 127 test files. Three users. Five vaults. One real waitlist signup. Zero HN posts.

What Grove was: a hosted personal-knowledge MCP API wearing two costumes it had no users for.

What Grove taught: how to design 6 composable tools. How to fuse BM25 and vectors with RRF. How to serialize git writes through one queue without losing data. How to make AI synthesis safe to read months later via provenance. How to make multi-tenant scope structurally impossible to leak. How to autonomously run a production system with daily watchdogs and weekly adversarial sweeps. How to recognize a local maximum and pick a pole. How to kill a project calmly when its purpose is served.

What Grove leaves behind: the cathedral, the patterns, the vault, the memory, the skills, the constitution, the lesson.

The next project starts with all of it pre-loaded.

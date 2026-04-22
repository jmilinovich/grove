# Grove — Implementation Plan

> A hosted knowledge API that makes Obsidian vaults searchable and writable from any Claude surface.

This document is the authoritative implementation spec for Grove. Agents working on this project should read this file first, follow it precisely, and update it as decisions are made or tasks are completed.

## Overview

Grove is a TypeScript API server that wraps a git-tracked Obsidian vault and exposes it as MCP tools. Any Claude surface (app, phone, web, Code) connects to Grove and gets structured access to the vault — search, read, write, with proper auth, sync, and concurrency.

**Stack:** TypeScript, Node.js (>=22), raw `node:http`, SQLite (via QMD), git
**Repo:** `~/src/grove`
**Vault:** `~/life/` (primary), `~/canva/` (deferred — Phase 8)
**Depends on:** `@tobilu/qmd` (search engine), `@modelcontextprotocol/sdk` (MCP transport)
**Deploys to:** AWS t3.medium at `api.grove.md` (52.37.76.231), frontend on Vercel at `grove.md`
**Live:** Phases 0-5 complete, security hardened, observable, magic link auth, persistent sessions, S3 backups, cross-domain auth with grove.md
**Next:** Agent infrastructure (CI/CD, proxy extraction, graceful shutdown) → Ops dashboard (Phase 4b) → Multi-user (Phase 9a) → Discovery (Phase 7) → Knowledge views (P4-10+)

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Claude (any surface)                  │
│              phone · web · desktop · Code                │
└──────────────────────┬──────────────────────────────────┘
                       │ MCP (Streamable HTTP) or CLI
                       ▼
┌─────────────────────────────────────────────────────────┐
│                     Grove Server                         │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │   Auth    │  │  Router   │  │  Logger  │              │
│  │Middleware │→ │ /v1/...   │→ │  Audit   │              │
│  └──────────┘  └────┬──────┘  └──────────┘              │
│                     │                                    │
│       ┌─────────────┼─────────────┐                     │
│       ▼             ▼             ▼                      │
│  ┌─────────┐  ┌──────────┐  ┌─────────┐                │
│  │  Notes   │  │  Search  │  │  Vault  │                │
│  │ Service  │  │ Service  │  │ Service │                │
│  │          │  │  (QMD)   │  │  (git)  │                │
│  └────┬─────┘  └────┬─────┘  └────┬────┘                │
│       │             │              │                     │
│       ▼             ▼              ▼                     │
│  ┌──────────────────────────────────────┐               │
│  │         Write Queue (mutex)          │               │
│  │   All mutations serialized here      │               │
│  └──────────────┬───────────────────────┘               │
│                 ▼                                        │
│  ┌──────────────────────────────────────┐               │
│  │     Vault Filesystem (git repo)      │               │
│  │     + QMD SQLite Index               │               │
│  └──────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────┘
```

### Key architectural rules

1. **The vault (markdown files in git) is the sole source of truth.** The QMD index is a derived view. If they diverge, the index is wrong.
2. **All writes are serialized** through a single-threaded write queue. No concurrent git operations. Ever.
3. **The server is the sole writer to git.** Local machine pulls from git. One direction. No split brain.
4. **Every write creates a git commit** with the API key identity in the commit message.
5. **The search index updates synchronously on write** before returning 200. Eventual consistency is not acceptable — agents with no memory between calls will create duplicates.
6. **Notes are the domain model.** The API returns structured JSON (parsed frontmatter, resolved links, computed backlinks), not raw markdown.

---

## Current State (as of 2026-04-21)

Snapshot for cold-start agents. Verify against live system before acting.

**Services (VPS — api.grove.md, 52.37.76.231):**
| Process | Port | Purpose |
|---------|------|---------|
| `grove-proxy` | 8420 | Auth, OAuth, CORS, rate limiting, request routing |
| `grove-server` | 8190 | MCP server, 6 tools, write queue |
| `qmd-server` | 8177 | BM25 search (FTS5 index) |
| Embedding | Voyage AI API | Vector embeddings (voyage-4-large, 1024-dim) |
| nginx | 443 | TLS termination, reverse proxy to 8420 |

**Database schema (`~/.grove/grove.db`):** `users`, `vaults`, `api_keys`, `trails`, `trail_grants`, `sessions`, `magic_links`, `oauth_clients`, `oauth_codes`, `auth_codes`

**MCP Tools:** `query`, `get`, `multi_get`, `write_note`, `list_notes`, `vault_status`

**Vault:** ~1,083 notes, ~5,600 embeddings, git-tracked at GitHub (private)

**Source modules (25):** `proxy.ts` (1,351 LOC), `server.ts` (820), `hybrid-search.ts` (494), `vault-graph.ts` (462), `vault-stats.ts` (439), `auth.ts` (358), `db.ts` (330), `vault-ops.ts` (286), `embed.ts` (274), `trails.ts` (262), `embed-node.ts` (193), `embed-single.ts` (170), `keys.ts` (172), `metrics.ts` (164), `notes-validate.ts` (136), `rest.ts` (476), `sync-sources.ts` (117), `rate-limit.ts` (118), `logger.ts` (103), `cli.ts` (708), `email.ts` (33), `users.ts` (60)

**Test coverage:** 19 test files, 2,933 LOC, 228 tests, 0.39 test/code ratio. Coverage gaps: proxy.ts (64 LOC of tests for 1,351 LOC), no end-to-end write path test, no integration test harness.

---

## Agent Workflow

How autonomous coding agents should work on this repo. Follow this protocol exactly.

### Branch & PR Protocol

1. Create branch: `agent/<task-id>` (e.g., `agent/p4-api-2`)
2. Implement the task per its spec — do not touch files outside your spec's file list
3. Run `npm test` — all tests must pass
4. Run `npx tsc --noEmit` — must compile clean
5. Commit with descriptive message referencing the task ID
6. **Mark the task complete in PLAN.md** — edit the `#### <task-id>:` heading to append ` ✅ COMPLETE YYYY-MM-DD (<short-sha>)`. This commit can be in the same PR. Post-ship fixes don't need a new marker.
7. Open PR with task ID in title (e.g., `P4-API-2: User list endpoint + fix last_login_at`)
8. CI runs tests + typecheck + plan-drift check. If any fails, fix and push.
9. After merge to main, CI deploys automatically. Verify via health check.
10. If broken post-deploy: `git revert <merge-commit>`, open issue, re-spec task.

### PLAN.md Stewardship

PLAN.md is the single source of truth for what's shipped. Every agent that closes a task is responsible for marking it complete in the same PR — don't leave it to a later "reconciliation" pass, because reconciliation never happens on a parallel-merge day.

The `scripts/check-plan-drift.ts` CI check enforces this: if a PR's commit messages reference a task ID (`P11-1`, `P4-API-2`, `CLI-A3`, `REST-2`, `P5-TAG-1`, etc.) and PLAN.md on `main` doesn't already show that ID as `✅ COMPLETE`, then PLAN.md must be edited in the same PR. Run locally with `npm run check:plan`.

Bulk reconciliation is a fallback, not a strategy. If drift is ever detected, fix both the plan and whatever broke the stewardship rule.

### File Ownership Rules

When the execution strategy assigns files to specific agents, those are exclusive. Do not modify files outside your assignment. If you discover a bug in another file, document it as a follow-up task — don't fix it in your PR.

### Merge Conflict Resolution

If your branch conflicts with main:
1. `git fetch origin && git rebase origin/main`
2. Resolve conflicts preserving the intent of both changes
3. Re-run `npm test && npx tsc --noEmit`
4. Force-push your branch (not main)

### Testing Requirements

Every new endpoint, function, or behavior change needs tests. The test/code ratio is currently 0.39 — the goal is 0.5+.

**Unit tests (required for every PR):**
- Test the function in isolation. Mock external dependencies (HTTP, filesystem, SQLite).
- **Test file naming:** `test/<module>.test.ts` (match the source file name)
- **Fixtures:** Extend `test/fixtures/vault/` for vault-dependent tests. Document what you added in a comment at the top of the fixture file.
- **Acceptance criteria → tests:** Each acceptance criterion in the task spec maps to at least one test assertion. If the spec says "returns 409 on hash mismatch," there's a test for that.

**REST endpoint tests (required for every new endpoint):**
- Test request → response for success, validation error, auth error, not-found
- Test trail-scoped behavior (filtered results, write scope enforcement)
- Test with `If-Match` header for write endpoints

**CLI command tests (required for every new command):**
- Test JSON output schema matches the contract (parse output, verify fields)
- Test exit codes for success and each error type
- Test `--help` output includes usage, flags, and JSON schema
- Mock HTTP responses (after REST-4 migration) — no live server needed

**What NOT to test:**
- Don't test the framework (node:http, better-sqlite3, vitest itself)
- Don't snapshot test human-formatted output (it changes too often)
- Don't test internal implementation details that could change without affecting behavior

### Documentation Requirements

Documentation is a first-class deliverable, not an afterthought. Agents reading docs should be able to use any CLI command or REST endpoint without reading source code.

**REST API docs (`docs/api.md` — create when REST-2 ships):**
- Every endpoint: method, path, auth, request schema, response schema, error codes
- Examples with curl commands
- Trail filtering behavior per endpoint
- Rate limit information

**CLI docs (`docs/cli.md` — create when CLI-A7 ships):**
- Every command: usage, flags, examples, JSON output schema, exit codes
- Workflow examples showing multi-command composition
- Config setup instructions

**Inline code docs:**
- Exported functions get a JSDoc comment with param types, return type, and one-line description
- Non-obvious logic gets a comment explaining *why*, not *what*
- Don't add docs to internal/private functions unless the logic is genuinely surprising

**Update rules:**
- Adding a REST endpoint? Update `docs/api.md` in the same PR.
- Adding a CLI command? Update `docs/cli.md` in the same PR.
- Changing behavior of an existing endpoint/command? Update the relevant docs in the same PR.
- Don't create docs PRs that are separate from the feature — docs ship with the feature.

### Running Agents

One command per batch. Launches parallel agents, waits for all to finish, merges in order, runs tests, reports results.

```bash
./scripts/run-batch.sh <batch-name>
```

**Available batches:**
```bash
./scripts/run-batch.sh --list

# Output:
#   p4-prereq  (1 agent)    — CI + graceful shutdown
#   p4b-1      (4 agents)   — backend APIs
#   rest       (2 agents)   — REST write + status endpoints
#   cli-a      (2 agents)   — --json, exit codes, MCP→REST
#   cli-b      (1 agent)    — trails HTTP, --paths, --if-hash
#   p5-tag     (1 agent)    — auto-tagging + backfill
#   p7-1       (2 agents)   — discovery loop + ingest
#   p7-2       (2 agents)   — extraction + neighbors
#   p7-3       (2 agents)   — digest + bookmarks
#   p9-1       (3 agents)   — roles + invite + scoped keys
#   p9-2       (2 agents)   — user UI + trail sharing
#   p9-3       (1 agent)    — share-a-note
```

**What it does:**
1. Launches N `claude --worktree` agents in parallel (one per task)
2. Each agent works in an isolated worktree on its own branch
3. Waits for all agents to exit
4. Merges branches in the order specified (lowest-conflict first)
5. Runs `npm test` on the merged result
6. Cleans up worktrees and branches
7. Prints next steps (deploy command)

**Logs:** Each agent's output goes to `.agents/<batch>_<branch>_<timestamp>.log`. Monitor with:
```bash
tail -f .agents/p4b-1_*.log
```

**If an agent fails:** The script reports which agent failed and exits. Fix the issue, then re-run the batch (it skips branches that already exist).

**If a merge conflicts:** The script stops at the conflicting branch. Resolve manually (`git merge --continue`), then the script's remaining merges would need to be done by hand — or re-run the batch.

**Execution order (full roadmap):**
```bash
./scripts/run-batch.sh p4-prereq   # then deploy
./scripts/run-batch.sh p4b-1       # then deploy
./scripts/run-batch.sh rest        # then deploy
./scripts/run-batch.sh cli-a       # then deploy
./scripts/run-batch.sh cli-b       # then deploy
./scripts/run-batch.sh p5-tag      # can run anytime
./scripts/run-batch.sh p7-1        # then deploy
./scripts/run-batch.sh p7-2        # then deploy
./scripts/run-batch.sh p7-3        # then deploy
./scripts/run-batch.sh p9-1        # then deploy
./scripts/run-batch.sh p9-2        # then deploy
./scripts/run-batch.sh p9-3        # then deploy
```

---

## Dependency DAG

```
                    ┌─────────────────┐
                    │  P4-PREREQ      │
                    │  CI pipeline    │
                    │  Graceful shutdown│
                    └────────┬────────┘
                             │
         ┌───────────────────┼──────────────────┐
         ▼                   ▼                   ▼
  ┌────────────┐     ┌────────────┐      ┌────────────┐
  │  CLI-A     │     │ Phase 4b   │      │ Phase 7a   │
  │  Foundation│     │ Batch 1    │      │ Discovery  │
  │  --json,   │     │ (4 backend │      │ P7-1..P7-6 │
  │  exit codes│     │  agents)   │      │            │
  └──────┬─────┘     └─────┬──────┘      └──────┬─────┘
         │                 │                     │
         │          ┌──────▼──────┐       ┌──────▼─────┐
         │          │ Phase 4b    │       │ Phase 7b   │
         │          │ Batch 2+3   │       │ Bulk       │
         │          │ (FE agents) │       │ onboarding │
         │          └──────┬──────┘       └────────────┘
         │                 │
         ▼                 │
  ┌────────────┐           │
  │  CLI-B     │◄──────────┘ (needs P4-API-1 for trail HTTP)
  │  Consistency│
  │  --paths,  │
  │  trails HTTP│
  └──────┬─────┘
         │
         ▼
  ┌────────────┐     ┌────────────┐
  │ Phase 9a   │     │ Phase 4d   │
  │ User mgmt  │     │ Knowledge  │
  │ + CLI-D    │     │ views      │
  │ users cmd  │     └────────────┘
  └──────┬─────┘
         │
  ┌──────▼─────┐
  │ Phase 9b   │
  │ Trail UX   │
  │ + CLI-D    │
  │ share cmd  │
  └────────────┘
```

**Key dependency rules:**
- P4-PREREQ must complete before any other phase launches
- CLI-A can start immediately after P4-PREREQ — no server feature dependencies
- Phase 4b Batch 1 can run in parallel with CLI-A
- CLI-B needs CLI-A merged + P4-API-1 (trail HTTP endpoints) merged
- Phase 9a can start after CLI-B (needs `--json` for agent use + trail HTTP)
- Phase 7 has no dependency on CLI work — can run in parallel
- CLI-D commands land alongside their server phases (users with 9a, share with 9b, discovery with 7a)

---

## Phases

Active work only. Every phase before Phase 8 shipped, was deferred, or was removed from scope — detailed specs archived to [`docs/phases-shipped.md`](docs/phases-shipped.md). Summary of shipped work lives in the [Implementation Order](#implementation-order) section at the bottom of this file.

---


### Phase 8: Multi-Vault Onboarding

**Goal:** Multi-vault support on a single Grove server (`api.grove.md`) so you can onboard other humans. Some users will have access to multiple vaults simultaneously (personal + team + consulting-client). Ship vehicle: one Grove deployment, many vaults — not federation across deployments.

**Prerequisites:** Phases 9 (multi-user), 10 (vault-agnostic), 12 (encryption at rest), 13 (graph health), 16 (multi-resident URL) complete. All shipped.

**Status:** Spec'd 2026-04-21 via `/mili:spec` with 3-panel expert critique. Phased ship: Phase A (plumbing, 1 week) → Phase B (collaboration, 1 week).

**Scope boundary:**
- IN: multi-vault routing on one server, per-vault keys, vault switcher UI, admin provisioning CLI, invite existing/new users, per-vault observability substrate
- OUT of v1: federation across Grove deployments, self-serve vault creation, cross-vault search, cross-vault wikilinks, storage quotas, billing policy, member-removal UX, vault deletion

#### Locked design decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Topology:** multi-vault on one server | Matches onboarding goal. Keeps ops at one deployment. |
| 2 | **Process model:** one `grove-server` + `grove-discovery` per vault; `grove-proxy` routes by `vault_id` | Single-process refactor touches ~40 files; per-process is 3–4× cheaper to ship. Hits a ceiling at ~25 vaults / 6GB RSS (see §Revisit triggers). |
| 3 | **MCP connectors:** one OAuth endpoint URL per vault (`api.grove.md/v/<slug>/mcp`) | Zero hallucination risk, per-vault token-leak blast radius, Claude.ai native support. Multi-connector friction is low because vault joins are infrequent. |
| 4 | **URL shape:** `/@<handle>/<vault-slug>/...` for all grove-www content AND chrome routes; `api.grove.md/v/<slug>/...` for REST | No session-stored "current vault" — kills stale-primary-vault bugs. Shareable URLs stay unambiguous. |
| 5 | **Handle scope:** globally unique (GitHub model) | Simplest schema. One `@jm` across all vaults. |
| 6 | **Membership:** new `vault_members(user_id, vault_id, role)` table; drop `users.role` (separate release) | Per-vault roles — owner of vault A, viewer of vault B. Matches GitHub orgs. |
| 7 | **Provisioning:** admin-only `grove vault create` CLI for v1 | Lowest-stakes launch. Self-serve is v2. |
| 8 | **Spawn mode:** immediate (CLI regenerates `ecosystem.config.cjs`, `sudo pm2 reload`, health-checks) | Clear errors at creation. No cold-start latency on first request. |
| 9 | **Cross-vault search:** deferred — switcher is the UX | Power users open separate Claude conversations if needed. |
| 10 | **Switcher UX:** header dropdown in grove-www; `Cmd+Shift+V` shortcut; rendered always but disabled at n=1 | Conditional rendering that appears mid-session is jarring (UX panel). Cmd+Shift+K collides with Slack/Linear. |
| 11 | **Landing:** most-recently-used vault on login, persisted in `vault_members.last_active_at` | Sticky per Notion/Slack. Deep-links override via URL. |
| 12 | **Invite flow:** existing users get new `vault_members` row + new vault-scoped key; no re-auth | Matches "add vault to dashboard" UX. Email includes deep-link to vault + "Add to Claude.ai" button. |
| 13 | **Key migration:** backfill existing keys to `personal` vault | Zero user-visible change on migration day. Claude.ai connectors keep working via legacy route fallback. |
| 14 | **Legacy routes:** `api.grove.md/mcp` and `/v1/*` (no slug) → fall through to personal for 90 days, then 410 Gone with migration hint | Soft grace. Hard cutoff forces migration. No permanent silent fallback. |
| 15 | **Observability first:** per-vault structured logs + `vault_usage_daily` from day one. Rate limiting + billing layer on top later. | Measurement substrate in place so policy can retrofit without backfill. |

#### Security invariants

1. **Backend processes independently authenticate every request** against their pinned `vault_id`. Proxy routing is defense-in-depth, not the sole control — closes SSRF/bypass holes.
2. **Vault slug mismatch returns 403, not 404.** We don't leak which vault slugs exist.
3. **Per-vault encryption keys** (P12) unchanged. No cross-vault key reuse.
4. **Audit log entries carry `vault_id`** so per-vault audit is possible.
5. **API keys are bound to vault at mint time**. Rotation creates a new key; old one is revoked. No rebinding.

#### Phase 8A — Plumbing (1 week)

Everything required to serve a second vault. No collaboration UX yet.

##### P8-A1: Schema migration (`src/db.ts`, `src/migrations/`)

Add multi-vault schema with up + down migrations. Transactional; entire migration in one `BEGIN ... COMMIT`.

**Up:**
- `vaults`: add columns `slug TEXT UNIQUE NOT NULL`, `git_path TEXT NOT NULL`, `server_port INTEGER UNIQUE NOT NULL`, `discovery_port INTEGER UNIQUE NOT NULL`. Backfill existing row with `slug='personal', git_path='/root/life', server_port=8190, discovery_port=8091`.
- `discovery_queue`, `discovery_results`, `graph_health`, `graph_health_flags`: add `vault_id INTEGER NOT NULL REFERENCES vaults(id)` with default 1. Backfill, then drop default in a follow-up pass.
- `api_keys`, `trails`: already have `vault_id` — `UPDATE ... SET vault_id=1 WHERE vault_id IS NULL`, add `NOT NULL` constraint.
- `vault_members`: new table (see P8-B1 schema).
- **New** `vault_usage_daily(vault_id, date, requests, writes, embed_tokens, search_queries, bytes_stored, PRIMARY KEY (vault_id, date))` for observability.

**Files:** `src/db.ts`, `src/migrations/YYYY-MM-DD-multi-vault.up.sql`, `src/migrations/YYYY-MM-DD-multi-vault.down.sql`
**Tests:** `test/db-migration.test.ts` — runs migration on pre-populated fixture DB; asserts all rows preserved + schema changed + FK integrity passes. Runs down-migration after and asserts schema reverts + data preserved. Idempotent.
**Acceptance:**
- All new columns exist with correct types/constraints
- `SELECT COUNT(*) FROM vaults WHERE slug IS NULL` returns 0 post-backfill
- `PRAGMA foreign_key_check` passes
- Running migration twice is a no-op (schema version check)
- Down-migration restores pre-migration schema + data

##### P8-A2: Vault router in grove-proxy (`src/proxy.ts`, `src/vault-router.ts`)

New routing middleware.

**Behavior:**
1. On startup: `SELECT id, slug, server_port FROM vaults` → in-memory map (slug → port, id → slug).
2. On SIGHUP: reload map from DB.
3. For each authenticated request:
   - Hash bearer token → look up `api_keys.hashed_token` → get `vault_id`
   - Extract URL slug (`/v/<slug>/...`) if present
   - **If URL slug ≠ token's `vault_id.slug`: 403** (don't leak existence)
   - If URL has no slug (legacy `/v1/*`, `/mcp`): use token's vault_id, log deprecation, include `Sunset: <date>` header
   - Forward to `http://127.0.0.1:<server_port>/<path>` with `X-Grove-Vault-Id: <id>` added

**Failure contract:**
- Backend unreachable (ECONNREFUSED) → 503 + `Retry-After: 5`
- Backend slow (>10s) → 504
- Auth key not found → 401
- Vault slug mismatch → 403
- No silent fallbacks. Max 1 retry at 500ms on transient failures.

**Files:** `src/vault-router.ts` (new), `src/proxy.ts` (wire middleware)
**Tests:** `test/vault-router.test.ts` — slug match, slug mismatch returns 403, legacy no-slug falls through to token's vault with sunset header, backend unreachable returns 503 + Retry-After, retry at 500ms then fail, reload on SIGHUP picks up new vault row
**Acceptance:**
- Slug mismatch returns 403 (not 404)
- Legacy `/v1/*` and `/mcp` fall through to personal vault with `Sunset` header
- Backend down returns 503 with `Retry-After: 5`
- No retry storms under load (1 retry max)

##### P8-A3: Backend self-authentication (`src/server.ts`)

Per security panel: `grove-server` must independently validate every token. Proxy routing is defense-in-depth, not the sole control.

**Behavior:**
1. On startup: read `GROVE_VAULT_ID` env var (set by PM2 from generated `ecosystem.config.cjs`).
2. On each request with an `Authorization` header: hash token → look up `api_keys.vault_id` → compare to `GROVE_VAULT_ID`. Mismatch → 403.
3. Applies to ALL endpoints (MCP + REST). No exceptions.

Closes SSRF/localhost-bypass holes: even if the proxy is bypassed, the backend refuses cross-vault tokens.

**Files:** `src/server.ts` (add middleware), `src/auth.ts` (extract validation helper if needed)
**Tests:** `test/backend-auth.test.ts` — localhost curl with token from another vault returns 403; token from correct vault passes; no-auth returns 401 (existing); write endpoints enforce the same check
**Acceptance:**
- Backend rejects cross-vault tokens with 403 even when request bypasses the proxy
- All MCP tool invocations and REST endpoints enforce the check uniformly

##### P8-A4: Vault provisioning CLI (`src/cli.ts`, `src/vault-provision.ts`)

`grove vault create <slug> --owner <email> [--git-path <path>]`:

1. Validate slug matches `/^[a-z][a-z0-9-]{1,29}$/`
2. Refuse reserved slugs: `admin`, `api`, `mcp`, `v`, `v1`, `oauth`, `health`, `metrics`, `login`, `dashboard`, `profile`
3. `SELECT 1 FROM vaults WHERE slug = ?` — refuse if exists
4. Allocate unused `server_port` starting at 8191, `discovery_port` starting at 8091. Race-safe via `INSERT ... ON CONFLICT FAIL`
5. Create `/root/vaults/<slug>/` with `git init` + write default `.grove/config.yaml`
6. Create `/root/qmd/<slug>/` with empty QMD index (call `qmd init` subprocess)
7. `INSERT INTO vaults`; find-or-create `users` row by email; `INSERT INTO vault_members` (owner role); mint API key with `vault_id=<new-id>`
8. **Regenerate `ecosystem.config.cjs` from `SELECT * FROM vaults`** (don't append — Caleb's point)
9. `sudo pm2 reload ecosystem.config.cjs`
10. Poll `http://127.0.0.1:<server_port>/health` until the response body parses as `{ok: true}` (timeout 60s). Note: since Tier 2 (commit `e7f55a9`) the handler returns `{ok, sha, started_at, uptime_sec, checks}` and emits HTTP 503 when any dependency is down — a 200 response no longer implies full readiness on its own, so check the body.
11. Print: slug, ports, git_path, owner's API key (once), connector URL, sample invite email body

**Files:** `src/vault-provision.ts` (new), `src/ecosystem-gen.ts` (new), `src/cli.ts` (new `vault create` subcommand), `docs/cli.md` (document)
**Tests:** `test/vault-provision.test.ts` — slug validation, reserved-word rejection, duplicate-slug refusal, port allocation race-safe, ecosystem.config.cjs regenerated deterministically; `test/ecosystem-gen.test.ts` — output matches snapshot for known `vaults` table state
**Acceptance:**
- Creating a vault takes <60s and returns a working connector URL
- Invalid slugs rejected with clear error
- Ports never collide across concurrent invocations
- `ecosystem.config.cjs` is fully regenerated, not appended — diffs stay small

##### P8-A5: Graceful shutdown + write queue drain (`src/server.ts`, `src/write-queue.ts`)

Per panels: `pm2 reload` currently cuts in-flight writes.

**Behavior:**
1. SIGTERM handler: stop accepting new requests, drain the write queue (await all in-flight), fsync git state (`git status` completes cleanly), exit 0.
2. SIGUSR2 (PM2 graceful reload): same behavior.
3. In-flight MCP session: close gracefully with connection-closing message.

**Files:** `src/server.ts` (signal handlers), `src/write-queue.ts` (drain method)
**Tests:** `test/graceful-shutdown.test.ts` — SIGTERM mid-write drains queue; SIGUSR2 same; no data loss observed via post-shutdown git log
**Acceptance:**
- `pm2 reload` drains write queue cleanly; no orphaned writes
- In-flight MCP clients reconnect and re-auth gracefully
- Git repo is in a clean state post-shutdown (`git status` exits 0)

##### P8-A6: Per-vault observability (`src/logger.ts`, `src/proxy.ts`, `src/vault-usage.ts`, embed server)

Measurement substrate for future rate limiting + billing.

**Structured log fields (every request):**
- `vault_id`, `vault_slug`, `user_id`, `api_key_id`
- `route`, `method`, `status`, `duration_ms`
- For tool calls: `tool_name`, `tool_args_size`, `tool_result_size`
- For embed calls: `embed_tokens_in`, `embed_latency_ms`, `embed_upstream_status`

**Daily usage counter:** grove-proxy bumps per-request counters in-memory; flushes to `vault_usage_daily` via upsert every 60s. Batched to avoid hot write path.

**Embed server header propagation:** grove-server passes `X-Grove-Vault-Id` upstream to the embed server so shared-embed logs include vault context. Lets us see "top N chatty vaults over last hour" before we need to act on it.

**Files:** `src/logger.ts` (extend log schema), `src/proxy.ts` (counter hooks), `src/vault-usage.ts` (new — in-memory bump + flush), `src/embed-node.ts` (propagate header), `docs/api.md` (new observability spec)
**Tests:** `test/vault-usage.test.ts` — counter increments on request, flushes every 60s, upsert correctly accumulates, zero rows when inactive; integration — request produces log line with vault_id + vault_slug; embed call carries X-Grove-Vault-Id
**Acceptance:**
- Every log line includes `vault_id` + `vault_slug`
- `vault_usage_daily` has rows for both vaults after activity in each
- Embed server logs show vault_id in `X-Grove-Vault-Id` header
- Flush overhead <1ms per minute per vault (measured)

##### P8-A7: End-to-end isolation test (manual script + CI)

Test script that provisions a second vault and verifies isolation.

**Steps:**
1. Run migration
2. `curl https://api.grove.md/v/personal/health` → 200
3. `grove vault create test --owner test@example.com`
4. Verify new `grove-server-test` + `grove-discovery-test` in pm2
5. `curl https://api.grove.md/v/test/health` → 200
6. Auth as owner of `test`, write a note, search for it
7. Auth as owner of `personal`, search for the test vault's note — expect 404 (isolation verified)
8. `kill -TERM <grove-server-test-pid>` → verify clean shutdown in logs
9. Verify `vault_usage_daily` has rows for both `personal` and `test` after step 6
10. Verify structured logs include `vault_id` + `vault_slug` on every line

**Files:** `test/smoke/08-multi-vault.smoke.sh` (new), `docs/operations.md` (document how to run)
**Acceptance:** all 10 steps pass end-to-end in CI or manual run

#### Phase 8B — Collaboration (1 week, after 8A stabilizes)

##### P8-B1: vault_members table + migration (`src/db.ts`, `src/migrations/`)

Create the table (declared in 8A but populated here):
```sql
CREATE TABLE vault_members (
  user_id INTEGER NOT NULL REFERENCES users(id),
  vault_id INTEGER NOT NULL REFERENCES vaults(id),
  role TEXT NOT NULL CHECK(role IN ('owner', 'member', 'viewer')),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT,
  PRIMARY KEY (user_id, vault_id)
);
CREATE INDEX idx_vault_members_user ON vault_members(user_id);
CREATE INDEX idx_vault_members_vault ON vault_members(vault_id);
```

Backfill: insert one row per existing user with their old `users.role` for the `personal` vault. Drop `users.role` in a **separate release** after 8B ships.

**Files:** `src/db.ts`, `src/migrations/YYYY-MM-DD-vault-members.up.sql`, `src/migrations/YYYY-MM-DD-vault-members.down.sql`
**Tests:** `test/vault-members.test.ts` — backfill covers all users with correct role; insert/update/delete patterns; constraints enforced
**Acceptance:**
- Every existing user has a `vault_members` row for `personal` with their pre-migration role
- Role CHECK constraint rejects unknown values
- Rollback restores `users.role` from backfill

##### P8-B2: Invite flow for multi-vault (`src/invite.ts`, `src/cli.ts`, `src/email.ts`)

`grove invite <email> --vault <slug> [--role viewer|member]`:

- Require `--vault` parameter (was implicit personal before)
- If user exists by email: find-or-create `vault_members` row; mint new vault-scoped key; send email
- If user doesn't exist: create `users` row + `vault_members` row + magic link
- Email template (both existing and new users):
  - Primary CTA: "Open `<vault-name>` in Grove" → `https://grove.md/@<owner>/<vault-slug>/`
  - Secondary CTA: "Add to Claude.ai" → deep-link prefilled with `https://api.grove.md/v/<slug>/mcp`

**Files:** `src/invite.ts` (extend), `src/cli.ts` (add `--vault`), `src/email.ts` (new template), `docs/cli.md`
**Tests:** `test/invite.test.ts` — invite new user creates all three rows; invite existing user only adds vault_members + key; email body includes both CTAs with correct URLs
**Acceptance:**
- Inviting an existing user takes 1 API call; they see the new vault in switcher without re-auth
- Inviting a new user creates account + membership + key atomically
- Email deep-link into Claude.ai is a real working URL (tested against Claude.ai's connector-add flow)

##### P8-B3: grove-www route restructure (`src/app/...`)

Move every authenticated grove-www route under `/@<handle>/<vault-slug>/`:

- `/dashboard` → `/@<handle>/<vault>/dashboard`
- `/profile` → `/@<handle>/<vault>/profile`
- `/images` → `/@<handle>/<vault>/images`
- Existing `/@<handle>/<vault>/<path>` content routes unchanged

Bare `/dashboard`, `/profile`, etc. → 301 redirect to user's most-recently-used vault. First-time users land on their earliest-joined vault.

`last_active_at` updates: on every authenticated request, `UPDATE vault_members SET last_active_at = now() WHERE user_id = ? AND vault_id = ?` (throttled to once per minute via in-memory debounce).

**Files:** `grove-www/src/app/@[atHandle]/[vaultSlug]/dashboard/page.tsx` (new — moved), `grove-www/src/app/@[atHandle]/[vaultSlug]/profile/page.tsx` (moved), etc.; `grove-www/src/app/dashboard/page.tsx` (redirect shim); `grove-www/src/app/api/me/route.ts` (return `vaults: [...]`); `grove-www/test/route-structure.spec.ts`
**Tests:** `grove-www/test/route-structure.spec.ts` — signed-in redirect to most-recently-used; first-timer to earliest-joined; deep-link to specific vault overrides stickiness; bare-route redirects preserve query string
**Acceptance:**
- Every dashboard/profile/images page has vault in the URL
- Redirects from legacy bare routes preserve query params
- `last_active_at` updates on navigation but not more than once per minute

##### P8-B4: Vault switcher component (`grove-www/src/components/vault-switcher.tsx`)

Header dropdown in `grove-www/src/components/header.tsx`:

- Label: `@<handle> / <vault-slug>` (monospace)
- Click reveals dropdown listing all vaults the user has access to (from `GET /api/me` which now returns `vaults: [{slug, name, role}]`)
- Selecting a vault navigates to `/@<handle>/<slug>/dashboard` (or current page equivalent)
- Keyboard shortcut: `Cmd+Shift+V` (avoid Slack/Linear collision on Cmd+Shift+K)
- Rendered **always** when user has vault access, disabled at n=1
- ARIA: `role="combobox"`, `aria-expanded`, `aria-label="Switch vault"`. Current vault announced in `aria-live="polite"` region on change.

**Files:** `grove-www/src/components/vault-switcher.tsx` (new), `grove-www/src/components/header.tsx` (integrate), `grove-www/test/vault-switcher.spec.ts`
**Tests:** Playwright — switcher renders always, disabled at n=1, enabled at n≥2, keyboard shortcut opens, selection navigates correctly, ARIA attributes present, aria-live announces vault change, assistive tech compatible (JAWS/NVDA simulated via role queries)
**Acceptance:**
- Switching vaults takes <500ms
- Scroll position preserved across switch
- Screen readers announce the new vault context

##### P8-B5: Connected-vaults settings page (`grove-www/src/app/...`)

`/@<handle>/<vault>/settings/vaults`:

- Lists all vaults the user has access to (from `GET /api/me`)
- Shows role, join date, last-active date per vault
- For owners: "Manage members" link (v2 scope — placeholder in v1)
- For all vaults: "Add to Claude.ai" button (idempotent connector-add deep-link)

**Files:** `grove-www/src/app/@[atHandle]/[vaultSlug]/settings/vaults/page.tsx` (new), `grove-www/src/components/connected-vaults-list.tsx` (new), `grove-www/test/connected-vaults.spec.ts`
**Tests:** renders all user's vaults with correct roles; "Add to Claude.ai" deep-link has correct URL; owner sees member-management placeholder
**Acceptance:**
- Every vault the user belongs to appears in the list
- Role badge reflects the user's role in that vault (owner/member/viewer)
- "Add to Claude.ai" button produces a working deep-link

#### Migration plan (Phase 8A cutover)

##### Day 0: pre-migration
- Backup `~/.grove/grove.db`, `/root/life/.git`, QMD index
- Snapshot EBS volume
- Deploy schema-migration code to canary; verify no existing traffic breaks

##### Day 1: schema migration
- Take 30-second write-freeze (queue drains, pauses). Reads continue.
- Run migration in single transaction (see P8-A1)
- Resume writes
- Verify: every row has non-null vault_id; every user has a vault_members row

##### Day 2–5: router + Phase A end-to-end
- Deploy grove-proxy with router code
- Legacy `/mcp` and `/v1/*` requests fall through to personal (sunset header set)
- Verify existing Claude.ai connector still works
- Run `grove vault create test --owner test@example.com`; verify isolation (P8-A7)

##### Day 6: cutover announcement
- Email existing Claude.ai connector users: "Your Grove URL is now `api.grove.md/v/personal/mcp`. Legacy URL works until <date+90d>."
- Update Claude.ai connector setup docs

##### Day 6+30: monitor legacy traffic
- Log every hit to legacy routes with the key that hit them. Should drop to zero as users migrate.

##### Day 6+90: legacy sunset
- Remove legacy fallback. `/mcp` and `/v1/*` without slug return 410 Gone with migration hint.

##### Rollback
- Stop grove-proxy
- Run `src/migrations/YYYY-MM-DD-multi-vault.down.sql`
- Restart grove-proxy with pre-migration binary
- Restore from EBS snapshot if down.sql fails
- Rollback window: 24h. After that, data drift (new `vault_members` rows, `last_active_at` updates) requires manual recovery.

#### Revisit triggers (when to deprecate process-per-vault)

Re-evaluate single-process-with-`vault_id`-keyed-Map refactor when any of:
- Total vault count exceeds 25 on a single machine
- Total RSS exceeds 6GB at idle
- File handle usage exceeds 50% of ulimit
- Spawning a new vault takes >60s (pm2 reload cascade)
- Cold-start latency complaints from real users

#### Phase 8 Execution Strategy

**Batch p8a-1 (2 parallel agents, after Batch 0):**
- Agent A: P8-A1 — schema migration + `vault_members` + `vault_usage_daily` (touches `src/db.ts`, migrations)
- Agent B: P8-A5 — graceful shutdown (independent of A, touches `src/server.ts`, `src/write-queue.ts`)

**Batch p8a-2 (3 parallel agents, after p8a-1):**
- Agent C: P8-A2 — vault router in grove-proxy (depends on schema)
- Agent D: P8-A3 — backend self-auth in grove-server (depends on schema)
- Agent E: P8-A6 — per-vault observability (touches logger + proxy + embed client)

**Batch p8a-3 (solo, after p8a-2):**
- Agent F: P8-A4 — `grove vault create` CLI (depends on all of A2/A3/A5/A6 shipping)

**Batch p8a-4 (solo, after p8a-3):**
- Agent G: P8-A7 — end-to-end isolation test script

**— Phase 8A exit: deploy to prod under legacy fallback. Verify 2nd vault works before proceeding. —**

**Batch p8b-1 (2 parallel agents):**
- Agent H: P8-B1 — vault_members table + backfill
- Agent I: P8-B2 — invite flow extensions (depends on H but works on different files)

**Batch p8b-2 (2 parallel agents, after p8b-1):**
- Agent J: P8-B3 — grove-www route restructure
- Agent K: P8-B4 — vault switcher component

**Batch p8b-3 (solo, after p8b-2):**
- Agent L: P8-B5 — connected-vaults settings page

#### Phase 8 Success Criteria

**Phase 8A is done when:**
- A second vault on the same server responds to HTTP + MCP with zero cross-vault data leakage
- Creating a vault takes <60s and returns a working connector URL + owner key
- Existing Claude.ai connector continues working unchanged (legacy fallback)
- `pm2 reload` drains in-flight writes cleanly; no data loss observed
- Backend rejects requests whose token vault_id doesn't match pinned vault (verified with localhost bypass)
- Every log line includes `vault_id` + `vault_slug`; `vault_usage_daily` populates per vault

**Phase 8B is done when:**
- Inviting a new user delivers them into their vault in 1 click from the email
- Inviting an existing Grove user adds vault to switcher without re-auth
- Switching vaults via dropdown takes <500ms, preserves scroll position
- Same user can be owner of one vault and viewer of another with correct role-scoped UX

**Ship is complete when:**
- John onboards at least 2 other people, each to at least one vault
- Legacy `/mcp` and `/v1/*` routes are sunset (Day+90)
- No support incidents from first 2 onboarded users in their first week
- Per-vault metrics visible on `/dashboard/admin/metrics` (or CLI equivalent)

#### What's explicitly NOT in Phase 8

- **Single-process vault-id-keyed Map** — rejected for v1. 40-file refactor; benefit emerges at 30+ vaults; we're not there. Revisit at triggers above.
- **Subdomain-per-vault** — wildcard TLS + DNS automation is infra tax for no user benefit at this scale.
- **Cross-vault search fan-out** — switcher is the UX. Power users open separate Claude conversations.
- **vault-as-tool-parameter** on MCP tools — hallucination risk outweighs connector-list convenience.
- **Federation across Grove deployments** — not a goal. Users connect to separate deployments via separate Claude.ai connectors.
- **Rate limiting and billing** as policies — observability substrate is in P8-A6; policy layers on top when real signal emerges.
- **Self-serve vault creation, vault deletion, member removal UX** — deferred to v2 once admin-provisioning proves out.

---

## Design Decisions Log

Decisions made during planning. Reference these when implementing — don't re-litigate settled questions.

| Decision | Chosen | Alternatives considered | Why |
|----------|--------|------------------------|-----|
| API style | Domain (knowledge API) | Filesystem (read/write/glob) | Agents need structured data, not raw markdown. Fewer tools = better tool selection. |
| Endpoint count | 6 MCP tools | 15 filesystem primitives | AI tool selection degrades past ~10 tools. |
| Write concurrency | Serialized queue (mutex) | Git merge, CRDTs | Git merge corrupts YAML frontmatter. CRDTs are overkill for single-user. Mutex is simple and correct. |
| Sync direction | Server writes, local pulls | Bidirectional | Prevents split brain. One source of truth for remote writes. |
| Obsidian Sync | Disabled (git only) | Keep both | Two sync systems = conflicts. Git handles everything. |
| Embeddings | Self-hosted TEI (bge-base-en-v1.5) | OpenAI API, local sentence-transformers | Privacy-first. Same model on Mac (embedding) and VPS (query). No data leaves our infra. |
| Embed runtime | Node.js (embed-node.ts) | Python sentence-transformers | Python 3.14 + sqlite-vec vec0 = catastrophic GC (25-47GB). Node.js + better-sqlite3 works perfectly. |
| Search pipeline | BM25 + vector + RRF | + grep + reranker + query expansion | Over-engineered for <10K docs. Reranker/expansion add latency, not quality at this scale. |
| Garden API design | Workflows compose 6 primitives | Dedicated endpoints per garden operation | Plant/harvest compose naturally. Tend/wander need server-side computation folded into `vault_status`. |
| MCP server | Proper SDK-based server | Extend proxy interceptors | Expert panel unanimous: interceptors are tech debt. Proxy stays for auth, Grove server owns the tools. |
| Write sync | VPS writes + pushes, Mac pulls | Mac-only writes | Closes the two-way loop. Push retry with rebase-abort handles conflicts. |
| Auth tokens | SHA-256 hashed, scoped, prefixed | Simple bearer strings | Hashing survives token leaks. Scopes survive multi-user. Prefix enables secret scanning. |
| Vault scoping | In URL path from day 1 | Implicit single vault | `/v1/vaults/{id}/` is free now, breaking change later. |
| Language | TypeScript | Go, Python | QMD is TypeScript. MCP SDK is TypeScript. Same ecosystem. |
| HTTP framework | None (raw node:http) | Express, Fastify | Server is <2K LOC. No framework needed. |
| TLS | nginx + certbot | Caddy, built-in | Already running on VPS, certbot auto-renews. |
| Agent deletes | Soft delete (archive) by default, hard delete opt-in | Not allowed, allowed with scope | Agents can archive notes safely. Hard delete requires explicit opt-in (`?hard=true` or `--hard --yes`). Archive preserves data in configured archive path. |
| Git push cadence | Batched every 30s | Per-write | Cleaner history, fewer push/pull races. |
| Scoped access naming | Trails | Views, lenses, channels, gardens | Extends the grove metaphor naturally — trails are paths through a grove. |
| Trail boundaries | Tag/type/path prefilter only | + LLM judge, semantic-only | Prefilter is fast, deterministic, covers 90%+. LLM judge cancelled — solution looking for a problem. If filtering proves too coarse, use Claude API as rerank signal. |
| Trail filter location | Server layer (`server.ts`) | Proxy layer | Server has frontmatter, tags, search pipeline. Proxy only resolves trail context. |
| Hidden note response | 404 (not 403) | 403 Forbidden | 403 leaks that the note exists. 404 is indistinguishable from non-existent. |
| Encryption at rest | EBS encryption (AWS-managed) | LUKS, git-crypt, defer | LUKS is wrong for AWS — volume is decrypted at runtime. EBS encryption is free, automatic, protects snapshots. |
| Monitoring | BetterStack | Grafana Cloud, custom-built | Free tier covers this scale. Uptime + logs + alerting in one product. |
| Metrics format | JSON `/metrics` endpoint | Prometheus exposition | No scraper needed at this scale. Internal counters serve the dashboard directly. |
| Dashboard data source | Internal counters | BetterStack API | Avoids external dependency for own dashboard. Counters reset on restart (fine). Daily rollups to SQLite for history. |
| Admin auth | Magic link + API key + persistent SQLite sessions | GitHub OAuth, passkey, JWT | Magic links are frictionless and establish email identity. Sessions survive restarts. Foundation for multi-user. |
| Cross-domain auth | Auth code exchange (one-time code redirect) | Shared cookie domain, iframe, proxy all requests | Auth codes are single-use, 60s TTL, don't require same domain. Frontend keeps working with Bearer auth unchanged. |
| Email delivery | Resend API (one fetch call) | SES, Mailgun, custom SMTP | Minimal integration — one fetch, no SDK. Dev mode falls back to console.log. |
| Annotations | Out of scope | Inline in notes, separate annotation files | Not building social features until collaborative usage patterns emerge. |
| User creation | Invite-only (owner sends magic link) | Public signup, OAuth providers | Grove is private-first. Access is granted, not requested. |
| LLM judge | Cancelled | Ship with trails, rule-based only | Prefilter covers 90%+. LLM adds latency, fragility, and infra (Ollama doesn't fit on t3.medium). If needed later, use Claude API as rerank signal — no local model. |
| Discovery extraction | Claude API (claude-haiku-4-5) | Local LLM (Ollama) | VPS is t3.medium (4GB RAM) — Ollama + Qwen needs 3-4GB minimum. Claude API is simpler, no GPU, no model management, pay-per-use. |
| CI/CD | GitHub Actions CI + manual deploy trigger | Manual SSH deploy | CI gives agents automated feedback on PRs. Deploy stays manual — the VPS runs a live personal knowledge API, so deploys are a human decision. |
| CLI as canonical interface | CLI-first, dashboard reads from CLI | Dashboard-first, CLI as secondary | Agents need full control via CLI. The dashboard is a view, not the control plane. Every server capability gets a CLI command. |
| CLI output | Human default, `--json` for machines, auto-detect non-TTY | JSON-only, human-only | Humans and agents use the same tool. Auto-detection means agents get JSON without asking when piped. |
| CLI taxonomy | Flat verbs + noun-verb for resources | Nested namespaces (grove admin keys list) | Flat is fewer keystrokes. Noun-verb (grove keys create) is natural for CRUD on resources. No deeper nesting. |
| Destructive CLI ops | Require `--yes` flag, no interactive prompts | Interactive confirmation | Agents can't answer prompts. `--yes` is scriptable and explicit. Without it, command shows what would happen and exits 1. |
| CLI communication | All ops through REST HTTP | MCP JSON-RPC, local SQLite | MCP requires stateful session handshake for every CLI invocation. REST is single-request. CLI migrates from MCP to REST. Local ops (lint, snapshot) stay local. |
| REST API scope | Full read/write (PUT /v1/notes/) | Read-only (GET only) | Writes through MCP require session dance. REST PUT is a single HTTP call. Both call the same service layer — no protocol hop. |
| REST write method | PUT (client specifies path) | POST (server generates ID) | Notes have user-specified paths. PUT is textbook REST for this. If-Match header for optimistic concurrency. |
| Graceful shutdown | SIGTERM handler + write queue flush | None (PM2 kills after 1.6s) | PM2 restart was killing in-flight writes. Flush + 15s kill_timeout prevents data loss. |
| Consumer discovery | `filtered_count` in responses | Hide filtering entirely | Consumers should know results are scoped so they can request broader access. |
| Portal framework | Next.js on Vercel | Extend node:http server with HTML routes | API server stays minimal (raw node:http). Portal is a separate app with real framework needs (routing, auth middleware, SSR). Vercel deployment is free for this scale. |
| Portal scope | Ops first, knowledge views later | Ship graph explorer immediately | Ops dashboard is needed now (key/trail management). Knowledge views are nice-to-have — design the shell so they can grow in, but don't block shipping on them. |
| Portal auth | Admin key + JWT session cookie | OAuth provider, passkey | Single user, single key. Simplest thing that works. Re-evaluate if trail consumers need portal access. |
| Vault structure | Convention-based defaults + `.grove/config.yaml` | Hard-coded PARA, type-only | Smart defaults that match current PARA behavior. Config file is dead simple. Auto-detection for new vaults. Frontmatter `type` is always authoritative over folder. |
| Encryption model | Encrypted at rest, plaintext in memory | True E2E (client-side), no encryption | Server needs plaintext for search/discovery/embedding. Encrypt disk, git, backups. Trust story: "we can't read your data without your passphrase." |
| Encryption keys | Per-vault, server-escrowed with passphrase | Per-note, per-trail, user-held only | Per-vault is simple. Passphrase escrow enables multi-device. Trail scoping remains server-enforced. Lost passphrase = lost access (by design). |
| Image storage | Cloudflare R2 (external object storage) | Git-tracked, Git LFS | Git repos bloat with binaries. R2 has no egress fees, S3-compatible API, CDN-friendly. Vault note references image by URL. |
| Delete semantics | Soft delete (archive) by default, hard delete opt-in | Hard delete only, no delete | Archive preserves data, user can undo. Hard delete available for intentional cleanup. Both create git commits. |
| Graph auto-healing | Auto-fix non-risky only, flag everything else | Fully automatic, manual-only | Broken link repair and re-embedding are safe. Merging duplicates or deleting orphans requires human judgment. |
| Product model | Hosted SaaS (grove.md) + open source self-host | SaaS only, self-host only | Primary offering is hosted. Open source allows sovereignty. Like Plausible or GitLab. |

---

## Constraints

- **No new frontmatter types** without updating the validation list in notes service.
- **Agent-facing delete is soft delete (archive) by default.** Hard delete requires explicit opt-in. Both require write scope.
- **Max note size:** 100KB. Reject larger writes.
- **Max batch size:** 50 notes per batch_read.
- **Max search results:** 50 per query.
- **Rate limits:** 120 reads/min, 20 writes/min per key.
- **Git commit messages:** Always `"grove (<key-name>): <action> <path>"` format.
- **File extensions:** Only `.md` and `.json` files accessible through the API.
- **Path validation:** Resolve symlinks, reject anything outside vault root. No `..` traversal.

---

## Open Questions (resolve during implementation)

1. ~~**QMD embedding backend:**~~ **Resolved.** Bypassed entirely. TEI handles query embedding on VPS; embed-node.ts handles doc embedding on Mac via TEI over SSH tunnel. QMD's node-llama-cpp is never loaded.

2. **Backlink computation cost:** Grepping the entire vault for `[[Note Name]]` on every read is expensive. Options: (a) cache backlinks and invalidate on write, (b) precompute backlink index on startup, (c) make backlinks a separate endpoint/field. Decide based on vault size and latency requirements.

3. ~~**MCP tool descriptions:**~~ **Resolved.** QMD's built-in MCP tool descriptions work well. The `query` tool accepts structured searches (lex/vec/hyde). Iterate based on Claude.ai usage.

4. ~~**Domain name:**~~ **Resolved.** `api.grove.md`

5. ~~**Auto-embed on vault change:**~~ **Resolved.** Phase 1b (P1-10) added fire-and-forget `embedFile()` after write_note.

6. ~~**Tag hygiene for trails:**~~ **Resolved.** 15% tag coverage (160/1083 notes). Path-based filtering is the primary mechanism. Tags supplement but don't carry trails alone. Current trail config uses both — working correctly.

7. ~~**Admin dashboard exposure:**~~ **Resolved.** Portal is grove-www on Vercel. Auth via magic link + API key with persistent sessions. Cross-domain auth code exchange bridges api.grove.md and grove.md.

8. ~~**Ollama GPU sharing:**~~ **Resolved.** Phase 6 (LLM Judge) cancelled. Phase 7 uses Claude API instead of local LLM. No Ollama needed. VPS stays on t3.medium.

9. **Integration test harness:** No way to boot proxy + server on random ports and make real HTTP requests in tests. Needed for verifying end-to-end behavior. Options: (a) `test/helpers/test-server.ts` that starts both, (b) supertest-style wrapper, (c) defer until test coverage becomes a bottleneck.

10. **Schema versioning:** No `schema_version` table or numbered migrations. Schema changes are `CREATE TABLE IF NOT EXISTS` + ad-hoc `ALTER TABLE`. Works for now but agents adding tables may create ordering issues. Consider a lightweight migration framework before Phase 9 (which adds new tables).

---

## Success Criteria

**Phase 0 is successful when:**
- ✅ You can search your vault from Claude.ai on your phone and get relevant results
- ✅ You can read a note and see its content
- ✅ Hybrid search (keyword + semantic) returns high-quality results
- [x] You've used it daily for 2 weeks and documented what's missing (P0-5b)

**Phase 1 is successful when:**
- Claude.ai can create a concept note, and the next conversation (any surface) finds it via search
- Harvest works: read a journal entry, find people mentioned, create/link entity notes
- Tend works: vault_status(diagnostics) returns orphans, broken links, missing frontmatter
- All writes are traceable in git log to the key that made them
- No data loss or corruption after a week of daily use

**Phase 2 (Security) is successful when:**
- Path traversal tests pass — `../../etc/passwd` returns 400, not file contents
- CORS rejects requests from non-allowed origins
- Read-only keys get 403 on write operations
- EBS volume is encrypted, S3 backups are encrypted
- No plaintext secrets in JSON files

**Phase 3 (Observability) is successful when:**
- Every request produces a structured JSON log line with correlation ID
- `/health` returns unhealthy when QMD or embed server is down
- BetterStack alerts fire within 2 minutes of downtime
- `/metrics` returns request counts, latency percentiles, error rates
- Dead man's switch fires if daily cron stops

**P4-PREREQ (Agent Infrastructure) is successful when:**
- PRs get automated test + typecheck results via GitHub Actions
- Deploy is available as a manual workflow trigger (not automatic)
- `pm2 restart grove-server` flushes write queue before shutting down (verify via log)
- Push failures in write-queue.ts emit structured log entries

**CLI-A (Foundation) is successful when:**
- `grove search "test" --json` returns valid JSON with `ok`, `results`, `count` fields
- `grove read "nonexistent" --json` exits 1 with `{"ok": false, "error": "not_found"}` on stderr
- `grove search "test" | cat` auto-detects non-TTY and emits JSON
- `grove write path.md --content "text" --type concept` creates a note without stdin
- `grove graph` and `grove digest` are discoverable top-level commands
- `grove health --json` and `grove metrics --json` return server status
- `grove init --server X --token Y` creates config and validates connection
- `GROVE_TOKEN=xxx grove search "test"` works without a config file

**CLI-B (Consistency) is successful when:**
- `grove trails list` works from any machine (HTTP, not local SQLite)
- `grove search "X" --paths | xargs -I{} grove read "{}"` works
- `grove write path.md --if-hash abc123` exits 1 on conflict with current hash in error
- `grove trails delete <id>` without `--yes` shows what would happen and exits 1

**Phase 4 (Portal) is successful when:**
- Owner can log in with admin key, get a session, and manage keys/trails from the browser
- Usage dashboard shows request volume and latency per tool
- Vault health panel shows note count, sync status, embedding coverage, git status
- Trail consumer can visit a public onboarding page and copy MCP connection config
- All text uses `text-ink`, `text-moss`, `text-harvest`, or opacity variants — no raw Tailwind color classes
- All headings use `font-serif font-medium` — body text uses `font-sans`

**Phase 5 (Trails) is successful when:**
- Create a trail, generate a consumer key, connect from Claude.ai — consumer sees only trail-scoped results
- Sensitive notes (health, finances) never leak through an AI Research trail (precision >95%)
- On-topic notes aren't over-filtered (recall >90%)
- `filtered_count` appears in query responses
- Trail consumer sees 404 (not 403) for hidden notes
- All trail access is logged in audit trail
- End-to-end: plant a note via owner key → consumer immediately finds it via trail-scoped search

---

## Implementation Order

**Phases 0-1** ✅ — MCP server, hybrid search, read/write, auth, CLI
**Phase 2** ✅ — Path traversal, CORS, body limits, scope enforcement, EBS encryption, S3 backups, OAuth secrets to SQLite, key TTLs
**Phase 3** ✅ — Structured logging, correlation IDs, audit logging, deep health check, metrics, BetterStack (uptime + logs)
**Phase B** ✅ — Magic link auth, persistent SQLite sessions, cross-domain auth code exchange (grove.md ↔ api.grove.md)
**Phase 5** ✅ — Trail config/CLI/filtering/eval/audit/blast-radius/tag-audit/snapshot-rollback
**Phase 4a** ✅ — Next.js app scaffold, auth (magic link + API key), middleware

**P4-PREREQ — Agent Infrastructure (next, prerequisite for everything below):**
1. CI pipeline + graceful shutdown (single agent, small scope)
2. Merge, deploy manually, verify health check

**CLI-A — Foundation (immediately after P4-PREREQ, parallel with Phase 4b):**
1. Agent A: --json + exit codes + structured errors (core refactor)
2. Agent B: --content, init, graph/digest promotion, health/metrics, help (new features)

**Phase 4b — Ops Dashboard (parallel with CLI-A):**
1. Backend APIs: Agents A-D in parallel (trail CRUD, user list, keys/metrics fixes, git stats)
2. Frontend: Agents F-H in parallel (key mgmt, trail mgmt, vault health + usage pages)
3. Consumer: Agent I (trail onboarding page)

**CLI-B — Consistency (after CLI-A + P4-API-1 merged):**
- Trails to HTTP, --paths, --if-hash, whoami (single agent, sequential)

**P5-TAG — Tag & Classification Coverage (can run anytime, independent):**
- Auto-tagging on write + backfill existing notes → trail filtering coverage from 15% to >80%

**Phase 7 — Discovery (can start after P4-PREREQ, parallel with above):**
1. Agents A-B: discovery loop skeleton ‖ ingest command
2. Agents C-D: concept extraction + wikilink wiring ‖ semantic neighbors
3. Agents E-F: discovery digest ‖ bookmarks + post-ingest bootstrap
- CLI-D: `grove discovery`, `grove ingest` land with their server features

**Phase 9a — User Management (after CLI-B):**
1. Agents A-C in parallel (user roles, invite flow, user-scoped keys)
2. Agents D-E in parallel (user mgmt UI, trail sharing UX) — needs Phase 4b dashboard layout
- CLI-D: `grove users list|invite` lands with P9-2

**Phase 9b — Trail Sharing UX (after Phase 9a + Phase 4b):**
- Shareable trail links, trail-scoped grove.md, share-a-note
- CLI-D: `grove share` lands with P9-7

**CLI-C — Module Extraction (when cli.ts exceeds ~1200 LOC):**
- Split into src/cli/ directory structure. Triggered by size, not schedule.

**Phase 4d — Knowledge Views (after Phase 4b):**
- P4-10 (graph explorer), P4-11 (lifecycle dashboard) — deferred, spec when dashboard proves useful

**~~Phase 6~~** — LLM judge: REMOVED FROM SCOPE
**~~Phase 9c~~** — Annotations: REMOVED FROM SCOPE

**Phase 8 — Multi-Vault Onboarding** ⏳ (spec'd 2026-04-21, next to ship):
- Phase 8A (plumbing, 1 week): schema + router + backend-auth + CLI + shutdown + observability + e2e
  - p8a-1: schema + graceful shutdown (2 agents parallel)
  - p8a-2: router + backend-auth + observability (3 agents parallel)
  - p8a-3: `grove vault create` CLI (solo)
  - p8a-4: e2e isolation test (solo)
- Phase 8B (collaboration, 1 week): members + invite + frontend + switcher
  - p8b-1: vault_members + invite flow (2 agents parallel)
  - p8b-2: route restructure + switcher component (2 agents parallel)
  - p8b-3: connected-vaults settings page (solo)

**Phase 10** ✅ — Vault-agnostic structure: config, auto-detect, notes-validate, stats, CLI (2026-04-20) + discovery/server/rest/cli decoupling (2026-04-21)
**Phase 11** ✅ — Note lifecycle: DELETE (soft+hard), PATCH move with wikilink update, MCP write_note actions, CLI (2026-04-20)
**Phase 12** ✅ — Encryption at rest: per-vault key lifecycle, transparent vault-ops layer, encrypted search index, CLI passphrase UX (2026-04-20)
**Phase 13** ✅ — Graph health: metrics + scoring + daily monitoring, auto-healing, admin REST + grove-www dashboard (2026-04-20)
**Phase 14** ✅ — Image system: R2 storage, upload endpoint, search integration with thumbnails, Pinterest grid view (2026-04-20)
**Phase 15** ✅ — Profile & settings UX: /v1/me profile + sessions, visual trail scope editor with preview, non-owner dashboard (2026-04-20)

**Phase 16 — Multi-Resident URL Structure** ✅ (shipped 2026-04-21): handle model, `/v1/residents/:handle`, scoped `/@<handle>/*` routes, URL builders, legacy redirects, handle editor, e2e test.

**Phase 17 — Post-Login Redirect** ✅ (shipped 2026-04-21):
- p17: callback + marketing root + /login short-circuit + e2e test (single agent)

**Phase 18 — Mobile-Optimized Pages** ✅ (shipped 2026-04-21):
- p18: viewport meta + hot-spot fixes + Playwright regression test + audit (single agent)

**Phase 19 — Note Share UI** ✅ (shipped 2026-04-21, commits abf963c b2a0564 + grove-www 97c3a8a f11da33 804bb40): schema migration, list/revoke endpoints, 410 recipient page, CSRF-guarded proxy routes, Share button + modal, dashboard shares page. Tests: grove 899 passing, grove-www vitest 60 passing, Playwright mobile+modal+dashboard 25 passing.

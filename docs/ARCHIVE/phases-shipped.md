# Grove — Shipped, Deferred, and Removed Phases (Archive)

Historical record of Phases 0–7, Phase B, Phase 9, Phases 10–19, CLI Evolution, and removed scope. Extracted from `PLAN.md` on 2026-04-21 to keep the active plan scannable.

**Source of truth for current work:** `PLAN.md` in the repo root.
**Source of truth for shipped code:** `git log` — every task here has commit refs.

This file is reference-only. Agents executing active work should read `PLAN.md` and `CLAUDE.md`, not this archive. Read this if you need to understand the history behind a decision, audit an acceptance criterion from a past phase, or reconstruct the spec an agent implemented.

---

### Phase 0: Deploy and Validate ✅ COMPLETE 2026-04-01

**Goal:** Get the vault accessible from Claude.ai with auth. Validate by using it for 2 weeks.

**What was built:**
- Auth proxy (`src/proxy.ts`) on port 8420 — OAuth 2.0 + bearer tokens, proxies to QMD MCP (8181)
- Hybrid search (`src/hybrid-search.ts`) — BM25 + vector (TEI + sqlite-vec) + RRF fusion
- Key management (`src/keys.ts`) — create/list/revoke, SHA-256 hashed storage in `~/.grove/keys.json`
- Embedding pipeline (`src/embed-node.ts`) — Node.js script, embeds docs via TEI over SSH tunnel, stores in vec0
- Deployed on Vultr VPS at `api.grove.md` with nginx + Let's Encrypt TLS
- QMD MCP server + search server managed via PM2
- TEI (Text Embeddings Inference) running via Docker for query-time embedding
- Vault syncs every 5 min via cron

**What works:**
- MCP `get` tool — read any note ✅
- MCP `multi_get` tool — batch read ✅
- MCP `status` tool — index health ✅
- MCP `query` tool — hybrid search (BM25 + vector + RRF), falls back to BM25-only if TEI down ✅
- `/search?q=...&n=N` — BM25 keyword search (~3ms) ✅
- Auth — OAuth 2.0 (PKCE) for Claude.ai + bearer tokens ✅
- TLS — HTTPS via nginx + Let's Encrypt ✅
- 5636 chunk embeddings across 1028 docs (bge-base-en-v1.5, 768-dim) ✅

**What doesn't work yet:**
- No write operations (MCP tools are read-only; writes need Phase 1 write queue + git integration)
- No automatic re-embedding when vault changes (manual: run embed-node.ts, scp, restart)

**Infrastructure:**
- VPS: Vultr, 4 vCPU, 8GB RAM, Ubuntu 24.04, Node 22
- Domain: `api.grove.md` (DNS-only in Cloudflare, nginx handles TLS)
- PM2 processes: `grove-proxy` (8420), `qmd-mcp` (8181), `qmd-server` (8177)
- TEI Docker: `tei-embeddings` on port 8090 (BAAI/bge-base-en-v1.5, `--auto-truncate`)
- API key: `key_a3802af4` (claude-ai, read+write, life vault)

**Tasks:**

- [x] **P0-1: Auth proxy** — `src/proxy.ts`, bearer tokens + OAuth 2.0 (PKCE) for Claude.ai
- [x] **P0-2: Key management** — `src/keys.ts`, create/list/revoke CLI
- [x] **P0-3: Deploy to VPS** — nginx + Let's Encrypt on `api.grove.md`
- [x] **P0-4: Register as Claude.ai custom connector** — connected via OAuth, working from all surfaces
- [x] **P0-5a: Hybrid search** — BM25 + vector + RRF fusion via TEI + sqlite-vec (replaced OpenAI API plan with self-hosted TEI for privacy)
- [x] **P0-5b: Usage journal** — use for 2 weeks, note what's missing

**Key decisions made during Phase 0:**
- **Embeddings: self-hosted TEI** (not OpenAI API) — privacy-first, same bge-base-en-v1.5 model on Mac and VPS
- **Embed on Mac, sync to VPS** — vec0 bulk ops OOM on VPS; Mac embeds via Node.js (not Python — Python 3.14 + vec0 has catastrophic GC issues), scp index to VPS
- **OAuth 2.0 required** — Claude.ai custom connectors only support OAuth, not plain bearer tokens; proxy implements full OAuth flow with PKCE
- **VPS upgraded to 8GB** — 2GB was too small for TEI + QMD + proxy; 8GB/4CPU handles everything comfortably

### Phase 1: Close the Garden Loop

**Goal:** Two-way data flow. Conversations on any Claude surface read from AND write back to the vault. Garden operations (plant, harvest, tend) work from Claude.ai.

**Key insight:** Garden operations split into two categories:
- **Query-scoped** (plant, seek, basic harvest): compose from search + read + write primitives. Claude orchestrates.
- **Vault-scoped** (tend, wander, digest): require whole-graph knowledge. Need server-side computation.

**Architecture:** Build a proper Grove MCP server (not more proxy interceptors). Proxy stays for auth/OAuth/CORS, forwards to Grove server. QMD becomes a search backend.

**Duration:** Weekend-scale project (~560 lines new code)

#### The 6 MCP Tools

| # | Tool | What it does | Garden operations |
|---|------|-------------|-------------------|
| 1 | `query` | Hybrid search (BM25 + vector + RRF) | **seek** |
| 2 | `get` | Read note with fuzzy path resolution | **seek**, **harvest**, **wander** |
| 3 | `multi_get` | Batch read by glob or list | **harvest** (batch entities), **tend** |
| 4 | `write_note` | Create/update with frontmatter validation, git commit, reindex | **plant**, **harvest** (wire links, create entities) |
| 5 | `list_notes` | Browse + metadata + entity index (names, types, aliases) | **tend** (scan), **harvest** (entity vocab), **plant** (dedup) |
| 6 | `vault_status` | Health + diagnostics + history + metrics | **tend** (orphans, broken links), **garden** (digest), **wander** (graph stats) |

#### Where primitives compose vs where the server must help

| Operation | Composition | Calls | Server help needed? |
|-----------|------------|-------|---------------------|
| **Plant** (create note) | query → list_notes → write_note | 2-3 | No |
| **Plant** (wire mentions) | query → get × N → write_note × N | 20-35 | No (interactive) |
| **Harvest** (basic) | get → list_notes(aliases) → write_note | 3-8 | `list_notes` returns aliases |
| **Tend** (diagnostics) | vault_status(diagnostics) | 1 | Yes — whole-graph scan |
| **Wander** (graph walk) | vault_status(graph) | 1 | Yes — Brandes centrality + BFS clusters ✅ |
| **Garden** (daily digest) | vault_status(digest) + vault_status(history) | 1-2 | Yes — git-based lifecycle classification ✅ |

#### Architecture

```
Claude.ai → proxy.ts (auth/OAuth/CORS/logging) → Grove MCP server (all 6 tools)
                                                        ↓
                                              hybrid-search.ts (search)
                                              vault filesystem (read/write)
                                              vault-ops.ts (git)
                                              QMD index (sqlite)
```

- **Proxy stays** for auth, OAuth, CORS, audit logging
- **New Grove MCP server** (`src/server.ts`) replaces QMD as MCP backend — registers all 6 tools via SDK
- **QMD becomes a search backend** — hybrid-search.ts calls QMD's HTTP endpoints internally

#### Phase 1a Tasks (Close the Loop)

- [x] **P1-1: Write queue** (`src/write-queue.ts`) — promise-chain mutex, 30s push timer, error isolation
- [x] **P1-2: Vault operations** (`src/vault-ops.ts`) — git commit/push/log, QMD reindex, file listing, startup recovery
- [x] **P1-3: Note validation** (`src/notes-validate.ts`) — type whitelist, required fields, path security, safe YAML
- [x] **P1-4: Grove MCP server** (`src/server.ts`) — 6 tools registered via SDK with Streamable HTTP transport
- [x] **P1-5: Wire proxy → Grove server** — proxy forwards /mcp to Grove (8190), keeps auth/OAuth/CORS/logging
- [x] **P1-6: VPS git setup** — vault as git repo, startup recovery, push/pull working
- [x] **P1-7: End-to-end test** — write_note creates file + git commit + QMD reindex, get reads it back, diagnostics work

#### Phase 1b Tasks (Polish)

- [x] **P1-8: vault_status graph mode** — Brandes centrality, BFS clusters, degree analysis (`vault-graph.ts`)
- [x] **P1-9: vault_status digest mode** — git-based lifecycle classification (`vault-graph.ts`)
- [x] **P1-10: Auto-embed on write** — fire-and-forget `embedFile()` after write_note (`embed-single.ts`)
- [x] **P1-11: Rate limiting** — 120 reads/60s, 20 writes/60s sliding window (`rate-limit.ts`)
- [x] **P1-12: Idempotency** — LRU cache, 1000 entries, 1hr TTL (`rate-limit.ts`)
- [x] **P1-13: Unit tests** — 37 tests across 3 files, all passing (`test/*.test.ts`)
- [x] **P1-14: CLI client** — `grove search/read/list/write/history/status/diagnostics` (`cli.ts`)
- [x] **P1-15: MCP Resources** — notes as `vault://life/{path}` resources (`server.ts`)

### Phase 2: Security Hardening

**Goal:** Close every exploitable gap before opening access to others. Path traversal and CORS are exploitable today.

**Prerequisites:** Phase 1 deployed and stable.

#### Phase 2a: Critical Fixes (ship immediately)

- [x] **P2-1: Path traversal guard** (`src/server.ts`)
  Resolve all file paths to absolute, reject anything outside vault root. No `..`, no symlinks escaping the vault. Test with `../../etc/passwd` and `../../.grove/keys.json`. This is exploitable today — top priority.

- [x] **P2-2: CORS lockdown** (`src/proxy.ts`, `src/server.ts`)
  Cookie-auth routes (`/auth/*`, `/admin/*`, `/keys`, `/`) locked to `GROVE_URL`. Bearer-only routes (`/mcp`, `/search`) keep `*` (required for MCP clients). `/v1/*` locked to `grove.md`.

- [x] **P2-3: Request body size limit** (`src/proxy.ts`)
  Hard cap at 1MB on `node:http` layer. Prevents memory/disk exhaustion from malicious or buggy clients.

- [x] **P2-4: Enforce key scopes** (`src/proxy.ts`)
  `write_note` tool calls check key scopes — read-only keys get 403 `scope_denied`. Logged via structured logger.

#### Phase 2b: Infrastructure Security

- [x] **P2-5: EBS encryption**
  Volume already encrypted (AES-256, AWS-managed CMK). Verified via `aws ec2 describe-volumes`.

- [x] **P2-6: Daily S3 backups**
  Cron job tars `~/.grove/` (keys, trails, configs) + QMD index and ships to S3 with server-side encryption. Vault itself is in git (GitHub private). QMD index and embeddings are derived and rebuildable, but backing up saves hours of re-embedding.

- [x] **P2-7: Move secrets out of plaintext JSON**
  OAuth clients and codes migrated from JSON to SQLite. Client secrets stored as SHA-256 hashes. API keys encrypted (AES-256-GCM) during OAuth code flow. JSON files renamed to `.migrated`.

- [x] **P2-8: Key TTLs and rotation**
  Add `expires_at` to key schema. CLI: `grove keys create foo --ttl 90d`. Expired keys fail auth. No forced rotation yet — TTLs are the first step.

#### Phase 2 Tests

- Path traversal: unit tests with `..`, symlinks, absolute paths outside vault
- CORS: integration test verifying non-allowed origins get rejected
- Scope enforcement: integration test — read-only key attempts write, gets 403
- Body size: send 2MB payload, verify 413 response

---

### Phase 3: Observability

**Goal:** Full visibility into system health, request patterns, and failures. Alert within 2 minutes of downtime.

**Prerequisites:** Phase 2a critical fixes deployed.

**Monitoring provider:** BetterStack (uptime + log ingestion + alerting, free tier covers this scale).

#### Phase 3a: Structured Logging

- [x] **P3-1: JSON structured logs** (`src/logger.ts`)
  One JSON line per request to stdout (PM2 captures). Format:
  ```json
  {"ts":"ISO8601","rid":"ulid","method":"POST","path":"/mcp","tool":"query","key_id":"abc123","status":200,"duration_ms":142,"error":null,"bytes_out":2847}
  ```
  Essential fields: timestamp, request ID (`rid`), tool name, key identity (not the raw token), status, duration, error. Add `vault_path` on writes.

- [x] **P3-2: Request correlation IDs**
  Generate ULID at proxy entry. Pass as `X-Request-Id` header to Grove server. Both layers log the same `rid`. Enables tracing a request through proxy → server → vault op.

- [x] **P3-3: Audit log for reads**
  Today writes are traced via git commits, but reads are invisible. Log every read with key identity for trail consumers. Store in `~/.grove/audit.jsonl`, rotate daily.

#### Phase 3b: Health & Metrics

- [x] **P3-4: Deep health check** (`/health`)
  Proxy health must verify downstream: QMD index accessible, embed server responding, vault git status clean. A proxy that says "I'm fine" while QMD is dead is worse than no health check.

- [x] **P3-5: `/metrics` endpoint** (JSON, not Prometheus)
  Internal counters (reset on restart, fine for dashboard). Persist daily rollups to SQLite for history.
  - `requests_total` by tool name and status code
  - `latency_p50`, `p95`, `p99` (1000-sample rolling reservoir)
  - `errors_total` by type (auth, upstream timeout, write queue, search)
  - `write_queue_depth` and `write_queue_wait_ms`
  - `search_latency_ms` (BM25 vs vector separately)
  - `embedding_latency_ms`
  - `uptime_seconds`

- [x] **P3-6: BetterStack integration**
  - Uptime monitor on `https://api.grove.md/health` (3-min checks, 2-min confirmation, email alerts)
  - Heartbeat ping every 5 min from vault-stats computation
  - Vector log shipper (systemd service) forwarding PM2 stdout/stderr to BetterStack Logs
  - grove.md uptime monitor also active

#### Phase 3 Tests

- Structured log output: unit test verifying log format, field presence
- Health check: integration test with QMD down → health returns unhealthy
- Metrics: unit test for counter increment, percentile calculation

---

### Phase 4: Portal

**Goal:** An authenticated web app at `grove.md` (or `app.grove.md`) where the vault owner manages their grove — keys, trails, usage, vault health — and later browses their knowledge visually. This is the owner's control plane.

**Prerequisites:** Phase 3 observability in place (dashboard needs metrics to display).

**What exists:** `grove-www` (Next.js 16 on Vercel at `grove.md`) — note viewer with markdown rendering, Cmd+K search, directory browsing, magic link + API key auth. Server-side API proxy to `api.grove.md`. No ops dashboard or key management UI yet.

**Key architectural decisions:**
- **Next.js on Vercel.** The API stays on the VPS (`api.grove.md`). The frontend is a separate app that talks to it.
- **Auth: magic link + API key.** Magic link flow creates an auto-provisioned read-only API key via auth code exchange. API key paste still supported.
- **The portal never writes to the vault.** It manages Grove infrastructure (keys, trails, config) and reads vault state (health, metrics, graph). Vault writes stay in Claude via MCP.

#### Phase 4a: Shell + Auth ✅ COMPLETE

- [x] **P4-1: Next.js app scaffold**
  `grove.md` — Next.js 16 App Router on Vercel. Tailwind CSS v4, Lora/Inter/Geist Mono fonts. Warm editorial design system (cream/ink/moss/harvest/earth).

- [x] **P4-2: Admin auth**
  Two auth paths: (1) API key paste → encrypted into `grove_token` cookie, (2) Magic link email → auth code exchange → auto-provisioned API key → same cookie. Both use AES-256-GCM encrypted cookie with 30-day expiry.

- [x] **P4-3: Auth middleware (proxy.ts)**
  Next.js 16 proxy file checks `grove_token` cookie on all routes. Unauthenticated users redirect to `/login?redirect=<path>`. Public paths (`/`, `/login`, `/api/auth`) exempt.

#### Phase 4-PREREQ: Agent Infrastructure

**Goal:** Automated test feedback on PRs and safe process restarts. Two tasks, one agent.

- [x] **P4-PREREQ-1: GitHub Actions CI** (`.github/workflows/ci.yml`)

  Agents need automated feedback on PRs. Deploy stays manual — the VPS runs the owner's live knowledge API, so deploys should be a human decision.

  **Workflow:**
  ```yaml
  name: CI
  on:
    pull_request:
      branches: [main]
    workflow_dispatch:  # manual deploy trigger

  jobs:
    test:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 22
            cache: npm
        - run: npm ci
        - run: npx tsc --noEmit
        - run: npm test

    deploy:
      needs: test
      if: github.event_name == 'workflow_dispatch'
      runs-on: ubuntu-latest
      steps:
        - name: Deploy to VPS
          uses: appleboy/ssh-action@v1
          with:
            host: 52.37.76.231
            username: deploy
            key: ${{ secrets.DEPLOY_SSH_KEY }}
            script: |
              cd /root/grove
              git pull --ff-only
              npm ci --production
              sudo pm2 restart grove-server grove-proxy
              sleep 5
              curl -sf https://api.grove.md/health || (echo "DEPLOY HEALTH CHECK FAILED" && exit 1)
  ```

  **Setup required:**
  - Add `DEPLOY_SSH_KEY` as a GitHub Actions secret (dedicated deploy key, not admin SSH key)
  - Create a `deploy` user on VPS with restricted sudo (only `pm2 restart`, `git pull` in `/root/grove`)

  **Files:** `.github/workflows/ci.yml`

  **Acceptance criteria:**
  - PRs get automated test + typecheck results
  - Deploy is manual: click "Run workflow" in GitHub Actions, or SSH as before
  - Failed tests block PR merge (branch protection recommended but not required)

- [x] **P4-PREREQ-2: Graceful shutdown + operational hardening** (`src/proxy.ts`, `src/server.ts`)

  Currently neither process handles SIGTERM. PM2 restart kills in-flight writes.

  **Add to both `proxy.ts` and `server.ts`:**
  ```typescript
  let shuttingDown = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log("info", `${signal} received, flushing write queue...`);
      await writeQueue.flush();
      closeDb();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 15_000);
    });
  }
  ```

  **Also:**
  - Log git push failures in `write-queue.ts` (currently empty catch block)
  - Add `PRAGMA wal_checkpoint(TRUNCATE)` to backup script before tarring grove.db
  - Increase PM2 `kill_timeout` to 15000ms in ecosystem config

  **Files:** `src/proxy.ts`, `src/server.ts`, `src/write-queue.ts`, PM2 ecosystem config

  **Tests:** `test/write-queue.test.ts` — add test that `flush()` completes pending operations before resolving

  **Acceptance criteria:**
  - `pm2 restart grove-server` flushes the write queue before shutting down (verify via log output)
  - Push failures emit structured log entries (not silently swallowed)
  - Backup script produces consistent SQLite snapshots

##### Execution strategy for P4-PREREQ

Single agent, both tasks:

```bash
# One pane
claude --worktree "Read PLAN.md tasks P4-PREREQ-1 and P4-PREREQ-2. Implement both per spec. Branch: agent/p4-prereq. Run tests before committing."
```

After it finishes: merge, deploy manually (`ssh` + `git pull` + `pm2 restart`), verify health check. Then launch Phase 4b agents.

---

#### Phase 4b: Ops Dashboard

Implementation splits into two batches: backend API additions (grove repo), then frontend pages (grove-www repo). Backend first because the frontend depends on the endpoints existing.

**Prerequisites:** P4-PREREQ complete (CI live, graceful shutdown in place).

##### Batch 1: Backend API additions (grove repo)

All new admin endpoints go behind `adminAuth()` in `src/proxy.ts`. They use cookie (session) or Bearer auth, same as `/keys`. Agents use worktrees to avoid merge conflicts in proxy.ts.

- [x] **P4-API-1: Trail CRUD HTTP endpoints**

  Add to `src/proxy.ts`, after the `/keys` handler. Import `loadTrails`, `createTrail`, `disableTrail`, `deleteTrail` from `./trails.js`.

  **`POST /v1/admin/trails`** — list, create, update, or delete (action-based, same pattern as `/keys`):
  ```
  { action: "list" }
  → { trails: [{ id, name, description, enabled, allow_tags, deny_tags, allow_types, deny_types, allow_paths, deny_paths, rate_limit_reads, rate_limit_writes, created_at }] }

  { action: "create", name: "AI Research", allow_tags: ["ai"], allow_paths: ["Resources/"], deny_paths: ["Journal/", "Areas/"] }
  → { trail: { id, name, ... }, token: "grove_live_..." }

  { action: "update", id: "trail_xxx", enabled: false }
  → { updated: "trail_xxx" }

  { action: "delete", id: "trail_xxx" }
  → { deleted: "trail_xxx" }
  ```

  Existing functions in `src/trails.ts`: `loadTrails()` returns all trails with parsed config. `createTrail(opts)` creates trail + auto-creates scoped API key (returns trail + raw token). Check `src/trails.ts` for exact signatures.

  Need to add `updateTrail(id, updates)` to `src/trails.ts` — updates `config_json` and/or `enabled` flag on the trail row.

  **Files:** `src/proxy.ts` (new route), `src/trails.ts` (add `updateTrail`)
  **Tests:** `test/trails.test.ts` — add updateTrail unit test

- [x] **P4-API-2: User list endpoint + fix last_login_at**

  **`GET /v1/admin/users`** — returns all users. Requires `adminAuth()`.
  ```
  → { users: [{ id, username, email, created_at, last_login_at }] }
  ```

  Also fix: `last_login_at` is never written. In `src/auth.ts`, the `verifyMagicLink()` function already updates `last_login_at`. But `createSession()` (called from `POST /admin/login` API key flow) does not. Add `db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, userId)` to `createSession()` in `src/auth.ts`.

  **Files:** `src/proxy.ts` (new route), `src/auth.ts` (fix createSession)

- [x] **P4-API-3: Fix /keys list + /metrics improvements**

  1. Add `expires_at` to the `/keys` list response. In `src/proxy.ts`, the list action's SELECT already fetches `*` but the response mapping omits `expires_at`. Add it.

  2. Merge search stats into `/metrics`. In `src/proxy.ts`, the `/metrics` handler calls `metrics.getMetrics()`. The `SearchTracker` instance (`searchMetrics` in `src/metrics.ts`) has `getSearchStats()` but it's never called from the endpoint. Update the handler to merge:
     ```ts
     sendJson(res, 200, { ...metrics.getMetrics(), search: searchMetrics.getSearchStats() });
     ```
     Check if `searchMetrics` is exported from metrics.ts — it may need to be.

  3. Add auth to `/metrics`. Currently unauthenticated. Gate behind `adminAuth()`.

  **Files:** `src/proxy.ts` (3 small changes), possibly `src/metrics.ts` (export searchMetrics)

- [x] **P4-API-4: Add git status to vault stats**

  Add a `git` section to `VaultStats` in `src/vault-stats.ts`. Compute during `computeVaultStats()`:
  ```ts
  git: {
    last_commit_at: string,     // git log -1 --format=%cI
    last_commit_msg: string,    // git log -1 --format=%s
    uncommitted_changes: number, // git status --porcelain | wc -l
    branch: string,             // git rev-parse --abbrev-ref HEAD
  }
  ```
  Use `execSync()` with `{ cwd: vaultPath, encoding: "utf-8" }`. Wrap in try/catch — if git fails, return null for the section.

  **Files:** `src/vault-stats.ts` (add computeGitSection + merge into stats)

  **Acceptance criteria:**
  - `GET /v1/stats?sections=git` returns git section with last_commit_at, branch, uncommitted_changes
  - Git failure doesn't crash stats computation

##### Batch 2: Frontend pages (grove-www repo)

All dashboard pages live under `src/app/dashboard/`. Each is a server component with auth check. The dashboard section needs:
- A layout at `src/app/dashboard/layout.tsx` with sub-navigation
- API proxy routes under `src/app/api/admin/` to forward requests to api.grove.md
- Page components for each view

**grove-www conventions** (every agent must follow):
- Colors: `text-ink`, `bg-cream`, `text-moss`, `text-harvest`, `bg-surface`, `border-surface-border` only. No raw Tailwind palette.
- Opacity: only `/60`, `/40`, `/15`. No other values.
- Typography: headings in `font-serif font-medium`, body in `font-sans`. Only weights 400/500.
- Section labels: `text-ink/40 text-label tracking-[0.15em] uppercase mb-4`
- Page content: `<div className="max-w-3xl mx-auto px-6 py-8">`
- Primary button: `bg-ink text-cream px-7 py-3.5 text-sm font-medium hover:bg-earth transition-colors active:scale-[0.98]`
- Secondary button: `border border-ink/15 px-7 py-3.5 text-sm text-ink hover:bg-ink/5 transition-colors`
- Icons: inline Lucide SVGs (no package import). `text-muted` rest, `hover:text-foreground`.
- Server components default. `"use client"` only for interactivity.
- Auth: `const cookieStore = await cookies(); const apiKey = getApiKey(cookieStore);` then redirect if null.
- Data fetching: server components call functions in `src/lib/grove-api.ts` which hit `api.grove.md` with Bearer auth. Client-side data goes through `/api/` proxy routes.

- [x] **P4-FE-0: Dashboard layout + API proxy routes**

  **`src/app/dashboard/layout.tsx`** — server component. Auth check (redirect to `/login` if no cookie). Renders a sub-navigation bar below the main header with tabs: Overview, Keys, Trails, Usage.

  ```tsx
  // Sub-nav items
  const NAV = [
    { label: "Overview", href: "/dashboard" },
    { label: "Keys", href: "/dashboard/keys" },
    { label: "Trails", href: "/dashboard/trails" },
    { label: "Usage", href: "/dashboard/usage" },
  ];
  ```

  Style: horizontal tabs with `text-ink/40` inactive, `text-ink border-b-2 border-moss` active state. Use `usePathname()` in a client component for active detection.

  **API proxy routes** (server-side, same pattern as `/api/search`):
  - `src/app/api/admin/keys/route.ts` — proxies POST to `api.grove.md/keys`
  - `src/app/api/admin/trails/route.ts` — proxies POST to `api.grove.md/v1/admin/trails`
  - `src/app/api/admin/users/route.ts` — proxies GET to `api.grove.md/v1/admin/users`
  - `src/app/api/admin/metrics/route.ts` — proxies GET to `api.grove.md/metrics`
  - `src/app/api/admin/stats/route.ts` — proxies GET to `api.grove.md/v1/stats`

  Each proxy route: get API key from cookie, forward with Bearer auth, return JSON response.

  **Also:** Add "Dashboard" link to the header in `src/components/header.tsx` (between the wordmark and search, or as a nav item).

  **`src/app/dashboard/page.tsx`** — the Overview page (P4-7 vault health). See P4-7 spec below.

  **Files:** `src/app/dashboard/layout.tsx`, 5 API routes, `src/components/header.tsx` (add link), `src/app/dashboard/page.tsx`

  **Acceptance criteria:**
  - `/dashboard` shows sub-nav with 4 tabs
  - Clicking tabs navigates between dashboard pages
  - Unauthenticated users redirect to `/login?redirect=/dashboard`
  - Dashboard link visible in header on all app pages

- [x] **P4-7: Vault health panel (dashboard overview)**

  **Route:** `src/app/dashboard/page.tsx` (the default dashboard page)

  **Data source:** `GET /api/admin/stats` → proxies to `GET /v1/stats?sections=vault,freshness,index,lifecycle,git`

  **Layout:** Grid of stat cards. Each card has a section label, a large number, and supporting detail.

  Cards:
  1. **Notes** — `vault.total_notes` (large number), `vault.by_type` top 3 types as small labels
  2. **Freshness** — `freshness.velocity_7d` notes/day (large), `freshness.today` today, `freshness.stale_90d` stale
  3. **Search index** — `index.indexed_docs` / `index.vault_docs` (e.g., "980 / 1000"), `index.drift` as percentage, `index.embedding_coverage` percentage
  4. **Lifecycle** — horizontal bar showing seeds/sprouts/growing/mature/dormant/withering proportions, colored segments
  5. **Git** — `git.last_commit_msg` (truncated), `git.last_commit_at` as relative time, `git.uncommitted_changes` count
  6. **System** — health status (green/red dot), uptime from `/metrics`

  **Acceptance criteria:**
  - Page loads and shows all 6 cards with real data from the API
  - Cards handle missing data gracefully (loading skeleton, "N/A" for null)
  - Lifecycle bar renders proportionally
  - Git section shows last commit info

- [x] **P4-4: Key management page**

  **Route:** `src/app/dashboard/keys/page.tsx`

  **Data source:** `POST /api/admin/keys` with `{ action: "list" }`, `{ action: "create", name }`, `{ action: "revoke", id }`

  **Layout:**
  - Header: "API Keys" heading + "Create key" button (primary style)
  - Table: columns = Name, Scopes, Vault, Created, Last Used, Expires, Actions
  - Each row: key name, scope badges (`bg-moss/15 text-moss text-xs px-2 py-0.5 rounded`), relative dates, "Revoke" button (destructive: `text-harvest hover:text-harvest/60`)
  - Create flow: clicking "Create key" shows an inline form (key name input + create button). On success, show the token in a `bg-surface font-mono text-sm p-3 rounded` box with a copy button. Warning: "Save this now — it won't be shown again."
  - Revoke flow: confirm dialog ("Revoke key {name}?"), then remove from list on success.

  **Component structure:**
  - `src/app/dashboard/keys/page.tsx` — server component, fetches initial key list
  - `src/components/key-table.tsx` — client component (`"use client"`), handles create/revoke interactions

  **Acceptance criteria:**
  - Lists all API keys with metadata
  - Create key → shows token once → new key appears in table
  - Revoke key → confirm → key disappears from table
  - Empty state: "No API keys. Create one to get started."

- [x] **P4-5: Trail management page**

  **Route:** `src/app/dashboard/trails/page.tsx`

  **Data source:** `POST /api/admin/trails` with actions: list, create, update, delete

  **Layout:**
  - Header: "Trails" heading + "Create trail" button
  - Card list (not table — trails have more metadata). Each card:
    - Trail name (heading), description, enabled/disabled badge
    - Tags: `allow_tags` as green badges, `deny_tags` as muted/strikethrough
    - Paths: `allow_paths` shown, `deny_paths` shown in muted
    - Rate limits: `rate_limit_reads`/min, `rate_limit_writes`/min
    - Actions: "Disable"/"Enable" toggle, "Delete" button
  - Create flow: modal or inline form with fields: name, description, allow_tags (comma-separated input), deny_tags, allow_types, deny_types, allow_paths, deny_paths, rate_limit_reads, rate_limit_writes. On create, show the consumer API key token (same pattern as key creation).

  **Component structure:**
  - `src/app/dashboard/trails/page.tsx` — server component
  - `src/components/trail-list.tsx` — client component for CRUD interactions

  **Acceptance criteria:**
  - Lists all trails with full configuration
  - Create trail → shows consumer token once → trail appears in list
  - Disable/enable trail → toggles state
  - Delete trail → confirm → trail removed
  - Empty state: "No trails. Create one to share your knowledge."

- [x] **P4-6: Usage dashboard**

  **Route:** `src/app/dashboard/usage/page.tsx`

  **Data source:** `GET /api/admin/metrics` → proxies to `GET /metrics` (now auth-gated)

  **Layout:**
  - Top row: big numbers — total requests, error rate (%), uptime
  - Tool breakdown: table with columns = Tool, Requests, Errors, p50 (ms), p95 (ms), p99 (ms). Data from `by_tool` keyed by MCP tool names (query, get, multi_get, write_note, list_notes, vault_status).
  - Search stats section (if available): queries in last hour, avg latency, zero-result rate, top queries list

  No charting library needed — use CSS bars or just numbers for v1. Keep it simple.

  **Component structure:**
  - `src/app/dashboard/usage/page.tsx` — server component, fetches metrics
  - Inline display — no complex client-side interactivity needed

  **Acceptance criteria:**
  - Shows total requests, error rate, uptime
  - Tool breakdown table with latency percentiles
  - Search stats section displays if data is present
  - Handles `/metrics` being empty on fresh server start (show "No data yet")

#### Phase 4c: Trail Consumer Pages

- [x] **P4-8: Consumer onboarding page**

  **Route:** `src/app/trails/[slug]/page.tsx` (public — no auth required)

  **Data source:** Needs a public API endpoint. Add `GET /v1/trails/:id/info` to `src/proxy.ts` in the grove repo — unauthenticated endpoint that returns trail name, description, and note count (no sensitive data). This is the only unauthenticated trail endpoint.

  **Backend addition (grove repo):**
  ```
  GET /v1/trails/:id/info
  → { name, description, note_count, created_at }
  ```
  Implementation: look up trail by ID, count notes matching the trail's filters via a quick scan.

  **Layout:**
  - Full-page, no sidebar/header (add `/trails` to `CHROME_HIDDEN_PATHS` in app-shell.tsx)
  - Centered card layout (same style as login page)
  - Trail name (serif heading), description paragraph
  - Note count: "142 notes available"
  - Two access methods:
    1. **Web:** "Sign in to browse" button → links to `/login`
    2. **MCP:** "Connect via MCP" section with copy-paste config block:
       ```json
       {
         "mcpServers": {
           "grove": {
             "url": "https://api.grove.md/mcp",
             "headers": { "Authorization": "Bearer <your-trail-key>" }
           }
         }
       }
       ```
  - "Get a trail key" link → points to contacting the vault owner (or a future invite flow)

  **Acceptance criteria:**
  - Page loads without auth — public access
  - Shows trail name, description, note count
  - MCP config block is copy-pasteable
  - Non-existent trail ID → 404 page

- [x] **P4-9: Trail usage view**

  Deferred until P4-5 trail management is working. Will be a detail view within the trail management page showing per-trail request metrics. Requires per-trail metric tracking (not yet implemented — metrics are per-tool, not per-trail).

#### Phase 4d: Knowledge Views (future, after 4b-4c are stable)

These are the views that make the portal more than an admin panel. They surface what's in the vault visually — things that are hard to do in a CLI or chat interface.

- [x] **P4-10: Graph explorer**
  Interactive visualization of the vault's wikilink graph. Powered by `GET /v1/stats?sections=graph` data. Click a node to see the note's connections, type, lifecycle stage. Filter by type, tag, or cluster. Likely needs a graph visualization library (d3-force or similar). This is the "see the shape of your knowledge" view.

- [x] **P4-11: Lifecycle dashboard**
  Visual representation of `GET /v1/stats?sections=lifecycle` — seeds, sprouts, growing, mature, dormant, withering. Click a lifecycle stage to see the notes in it. The daily `/garden` practice, but visual.

- ~~**P4-12: Search playground**~~ — deprioritized, not needed for v1.

#### Phase 4 Execution Strategy

**Batch 1 — Backend APIs + dashboard layout (4 parallel agents):**

Each backend agent works in an isolated worktree on the grove repo. To avoid merge conflicts in proxy.ts, agents insert routes at specific anchor points:

- **Agent A:** P4-API-1 (trail CRUD) — Insert trail routes after the `/v1/stats` handler, before the `// Unknown /v1/ route` fallthrough. Touch `src/trails.ts` (add `updateTrail`). Also update CORS: add `POST, PATCH, DELETE` for `/v1/admin/*`.
- **Agent B:** P4-API-2 (user list + last_login_at) — Insert user route after the `/v1/list` handler, before `/v1/stats`. Touch `src/auth.ts` (fix createSession).
- **Agent C:** P4-API-3 (keys/metrics fixes) — Modify existing `/keys` and `/metrics` handlers in proxy.ts. No new route blocks — editing existing code. Zero overlap with A/B.
- **Agent D:** P4-API-4 (git stats) — Only touches `src/vault-stats.ts`. Zero proxy.ts conflict.

In parallel on the grove-www repo:
- **Agent E:** P4-FE-0 (dashboard layout + all 5 API proxy routes + header link + dashboard overview stub)

Merge order: Agent D first (no conflicts possible), then C (edits existing code), then A, then B. Deploy manually. Then merge Agent E.

**Batch 1 tmux commands:**
```bash
# Pane 1
claude --worktree "Read PLAN.md task P4-API-1. Implement trail CRUD HTTP endpoints per spec. Branch: agent/p4-api-1."
# Pane 2
claude --worktree "Read PLAN.md task P4-API-2. Implement user list endpoint and fix last_login_at per spec. Branch: agent/p4-api-2."
# Pane 3
claude --worktree "Read PLAN.md task P4-API-3. Fix /keys list and /metrics per spec. Branch: agent/p4-api-3."
# Pane 4
claude --worktree "Read PLAN.md task P4-API-4. Add git status to vault stats per spec. Branch: agent/p4-api-4."
```

**Batch 2 — Frontend pages (3 parallel agents, after Batch 1):**

All three need the dashboard layout from Agent E and the backend APIs from Agents A-D to be merged.

- **Agent F:** P4-4 (key management page at `/dashboard/keys`)
- **Agent G:** P4-5 (trail management page at `/dashboard/trails`)
- **Agent H:** P4-7 + P4-6 (vault health overview + usage page at `/dashboard` and `/dashboard/usage`)

Each creates separate pages/components — no file overlap. Merge all, deploy to Vercel.

**Batch 3 — Consumer page:**
- **Agent I:** P4-8 (trail onboarding at `/trails/[slug]` — needs backend endpoint `GET /v1/trails/:id/info` + grove-www page)

#### Phase 4 Acceptance Criteria

- [x] `/dashboard` loads with sub-nav (Overview, Keys, Trails, Usage)
- [x] Overview page shows vault stats, lifecycle bar, git status, system health
- [x] Keys page lists all keys, create shows token once, revoke confirms and removes
- [x] Trails page lists all trails with config, create shows consumer token, enable/disable works
- [x] Usage page shows request counts, error rate, latency percentiles per tool
- [x] `/trails/<id>` loads without auth, shows trail info and MCP config
- [x] All pages follow the design system (cream/ink/moss, Lora headings, opacity grammar)
- [x] Unauthenticated dashboard access redirects to `/login?redirect=/dashboard`
- [x] All data refreshes on page load (no stale cache issues)

---

### Phase 5: Trails

**Goal:** Share shaped slices of your knowledge with others through **trails** — topic-scoped windows into the grove with server-side filtering.

**Prerequisites:** Phase 2 security hardened, Phase 3 observability live, Phase 4 portal exists.

A trail is: a name + topic boundaries (tags, types, paths to allow/deny) + an optional semantic topic description + permission level + API key. Consumers connect via MCP with a trail-scoped key and see only what the trail allows.

**Key architectural decisions:**
- **Filtering happens in the server layer** (`src/server.ts`), not the proxy. Server has access to frontmatter, tags, and the search pipeline.
- **Proxy resolves trail context** — looks up which trail a key belongs to, passes trail config as request metadata to the server.
- **No new MCP tools.** The 6 existing tools behave differently under trail-scoped keys (see below).
- **Ship without LLM judge.** Tag/type/path prefilter covers 90% of cases. Add LLM judge later as a soft signal (demote, don't hard-exclude) only if prefilter proves too coarse. *(Expert recommendation: defer LLM judge until real edge cases prove the need.)*

#### How MCP tools behave under trail-scoped keys

| Tool | Trail behavior |
|------|---------------|
| `query` | Search full index for recall, then strip non-trail notes from results before returning. Include `filtered_count` in response so consumers know results were scoped. |
| `get` | Return **404** (not 403) for notes outside the trail. 403 leaks that the note exists. |
| `multi_get` | Same as `get` — silently omit non-trail notes from results. |
| `list_notes` | Only return trail-visible notes. Essential — otherwise consumers see paths they can't access. |
| `write_note` | If trail access includes write, constrain to trail-allowed paths/tags. Reject writes that create notes outside trail scope. |
| `vault_status` | Return scoped stats: note count and types within trail only. Don't expose full vault metrics. |

#### Trail config data model

```typescript
interface Trail {
  id: string;              // trail_<8hex>
  name: string;            // "AI Research"
  description: string;     // Consumer-facing — what they see when connecting
  topic_description: string; // Semantic — used by future LLM judge
  allow_tags: string[];    // Notes must have at least one
  deny_tags: string[];     // Notes with any of these are excluded
  allow_types: string[];   // e.g., ["concept", "project"]
  deny_types: string[];    // e.g., ["journal"]
  allow_paths: string[];   // e.g., ["Resources/Concepts/", "Resources/Projects/"]
  deny_paths: string[];    // e.g., ["Areas/Health/", "Areas/Finances/"]
  access: "search" | "read" | "write";
  key_ids: string[];       // Associated API keys
  max_results: number;     // Per-trail result cap (default 25)
  enabled: boolean;        // Disable without deleting
  created_at: string;      // ISO 8601
  updated_at: string;      // ISO 8601
}
```

Stored in `~/.grove/trails.json`. Creating a trail auto-generates a scoped API key.

#### Trail info in MCP handshake

On MCP `initialize`, if the session is trail-scoped, return trail metadata (name, description, note count) in the server capabilities. Consumer knows what they're working with without a new tool.

#### Phase 5a: Trail Infrastructure

- [x] **P5-1: Trail config schema** (`src/trails.ts`)
  CRUD operations on `~/.grove/trails.json`. Validate schema, generate IDs, wire to API keys.

- [x] **P5-2: Trail CRUD CLI**
  `grove trails create "AI Research" --allow-tags "ai,llm,agents" --deny-tags "health,finances" --allow-paths "Resources/"`
  `grove trails list` / `grove trails disable <id>` / `grove trails delete <id>`
  Creating a trail auto-creates a scoped API key (token shown once).

- [x] **P5-3: Trail resolution in proxy**
  On auth, look up key → trail mapping. Pass trail config to server as request context (`X-Trail-Config` header). No trail = full access (owner key). Per-trail rate limits enforced.

- [x] **P5-4: Server-side filtering** (`src/server.ts`)
  Fast deterministic prefilter: check note frontmatter tags/types/paths against trail allow/deny lists. Sub-millisecond per note. Applied in all 6 MCP tools. LLM judge deferred to Phase 6.

- [x] **P5-5: `filtered_count` in query responses**
  Include `{ total_found, visible, filtered }` counts so consumers know when results were scoped.

- [x] **P5-6: Trail info in MCP initialize**
  Return trail name, description in MCP server capabilities for trail-scoped sessions.

#### Phase 5b: Safety & Eval

- [x] **P5-7: Tag hygiene audit**
  Audited 2026-04-11: 160/1083 notes (15%) have tags. Path-based filtering is the primary mechanism. The AI trail uses both `allow_paths` and `allow_tags` — paths do the heavy lifting. No action needed; tag coverage is low but trails work because they combine tag + path filters.

- [x] **P5-8: Trail filter eval suite**
  Labeled test cases: 20 known-sensitive notes and 20 known-safe notes. 100% precision (zero leaks) and 100% recall on labeled dataset. Tests in `test/trails.test.ts`.

- [x] **P5-9: Audit trail for trail access**
  Every trail access logged via structured logger: `{ trail_id, trail_name, tool, total_count, filtered_count }`. Uses `logTrailAccess()` in `src/trails.ts`.

- [x] **P5-10: Blast radius limits**
  Per-trail rate limits: configurable max reads/min, max writes/hour. Default: 60 reads/min, 10 writes/hour per trail. Separate from owner key limits.

- [x] **P5-11: Snapshot/rollback**
  `grove snapshot` creates a git tag. `grove rollback <tag>` reverts. Automatic snapshot before any bulk operation.

#### Phase 5c: Tag & Classification Coverage

The trail filtering system works, but only 15% of notes have tags. Rather than adding an LLM judge layer, invest in better classification coverage so the existing deterministic filter catches everything.

- [x] **P5-TAG-1: Auto-tagging on write** (`src/notes-validate.ts`, `src/server.ts`)

  When `write_note` creates or updates a note, infer tags from the note's path and type if none are provided. Rules:
  - `Journal/*` → add `#journal`
  - `Resources/People/*` → add `#person`
  - `Resources/Concepts/*` → add `#concept`
  - `Resources/Recipes/*` → add `#recipe`
  - `Areas/Health/*` → add `#health`, `#private`
  - `Areas/Finances/*` → add `#finances`, `#private`
  - Notes with `private: true` in frontmatter → add `#private`

  These are defaults — they don't override existing tags, they supplement. The agent writing the note can still set explicit tags.

  **Files:** `src/notes-validate.ts` (add `inferTags(path, frontmatter)` function), `src/server.ts` (call before write)
  **Tests:** `test/notes-validate.test.ts` — verify tag inference for each path pattern
  **Acceptance criteria:**
  - A note written to `Areas/Health/sleep.md` with no tags gets `#health` and `#private` automatically
  - A note written with explicit tags keeps them; inferred tags are added, not replaced
  - Trail filtering accuracy improves (re-run P5-8 eval suite)

- [x] **P5-TAG-2: Backfill existing notes** (`src/cli.ts`)

  `grove tag-backfill` — reads all notes, applies `inferTags()` to notes with zero tags, writes back via `write_note`. Creates a snapshot before starting.

  **Files:** `src/cli.ts` (new command)
  **Acceptance criteria:**
  - Running `grove tag-backfill` on the vault increases tag coverage from ~15% to >80%
  - Snapshot created before backfill starts
  - Notes that already have tags are not modified
  - Trail filter eval suite (P5-8) still passes with 100% precision

#### Phase 5d: Portal Integration (deferred to Phase 4)

Trail management UI (P4-5), consumer onboarding pages (P4-8), and trail usage views (P4-9) are now part of the Phase 4 Portal. The trail backend is ready — these are frontend tasks.

#### Phase 5 Tests

- Filter accuracy: labeled dataset, precision/recall thresholds
- 404 vs 403: verify hidden notes return 404
- Scope enforcement: trail-scoped key can't access notes outside trail
- Write constraints: trail with read access can't write; trail with write access can't write outside scope
- End-to-end: create trail → generate key → connect as consumer → search → verify filtering
- Tag coverage: after backfill, >80% of notes have at least one tag

---

### CLI Evolution: Agent-Native Interface

**Goal:** The `grove` CLI is the canonical interface for everything. The web dashboard is a view into what the CLI already does. An AI agent with `grove` on PATH can manage the entire system — search, write, inspect, administer — without special integration.

**Prerequisites:** None. Phase A can start immediately. Later phases land alongside their server features.

#### CLI Design Principles

1. **Human first, `--json` for machines.** Default output is terminal-formatted. `--json` emits structured JSON. Auto-detect: if stdout is not a TTY (piped), default to JSON.
2. **Flat top-level, noun+verb for resources.** `grove search`, `grove status` (flat verbs). `grove keys create`, `grove trails list`, `grove users invite` (noun+verb for resource management). No deeper nesting.
3. **Exit codes are a contract.** `0`=success, `1`=client error (bad input, not found), `2`=auth error, `3`=server error (retry). Agents branch on `$?` without parsing stderr.
4. **Every server operation has a CLI command.** If the dashboard can do it, `grove` can do it.
5. **Non-interactive by default.** No prompts. Destructive commands (`rollback`, `keys revoke`, `trails delete`) require `--yes` flag — non-interactive but safe. Without `--yes`, print what would happen and exit 1.
6. **stdout is data, stderr is status.** Data on stdout (human or JSON). Errors and progress on stderr. `grove search --json | jq` works cleanly.

#### JSON Output Contract

**Success envelope:**
```json
{"ok": true, "path": "Resources/Concepts/Taste Graph.md", "content_hash": "a1b2c3d4", ...}
```

**Error envelope (stderr when --json):**
```json
{"ok": false, "error": "not_found", "message": "Note not found: Foo.md"}
```

Error types: `not_found` (exit 1), `invalid_input` (exit 1), `validation_error` (exit 1), `auth_failed` (exit 2), `server_error` (exit 3), `rate_limited` (exit 3, includes `retry_after_ms`), `conflict` (exit 1, includes current `content_hash`).

All dates ISO 8601. All paths vault-relative. `null` for missing fields, never omitted.

#### REST API: Full Read/Write Surface

The REST API is currently read-only (GET endpoints for grove-www SSR). All writes go through MCP, which requires a stateful session handshake (initialize → session ID → tool call). This is painful for CLI, scripts, webhooks, and any HTTP client.

**Architecture:** Extract a shared service layer. Both MCP tools and REST endpoints call the same functions. No HTTP hop between them — both are in-process.

```
REST (stateless HTTP)  ←── CLI, grove-www, scripts, curl, webhooks
       ↓
   Service layer       ←── validation, write queue, git, reindex, trail filtering
       ↑
MCP (stateful session) ←── Claude.ai, Claude Code, MCP clients
```

- [x] **REST-1: Extract `handleWriteNote` service function** (`src/rest.ts` or `src/vault-write.ts`)

  Move the write logic from server.ts's `write_note` tool handler into a shared function:
  ```typescript
  export async function handleWriteNote(
    notePath: string,
    frontmatter: Record<string, unknown>,
    content: string,
    options: { ifHash?: string; trail?: TrailConfig | null; keyName?: string }
  ): Promise<{ path: string; action: string; content_hash: string; commit: string; url: string }>
  ```

  The MCP `write_note` tool becomes a thin wrapper that parses arguments and calls this function.

  **Files:** `src/rest.ts` (add function), `src/server.ts` (refactor write_note tool to call it)
  **Tests:** Existing write tests must pass. Add `test/rest.test.ts` tests for the extracted function.
  **Acceptance criteria:**
  - MCP `write_note` behavior unchanged
  - `handleWriteNote` is independently callable with the same validation, write queue, git commit, and reindex behavior

- [x] **REST-2: `PUT /v1/notes/:path` write endpoint** (`src/proxy.ts`)

  ```
  PUT /v1/notes/Resources/Concepts/context-engineering.md
  Authorization: Bearer grove_live_xxx
  If-Match: "abc123"  (optional — optimistic concurrency, maps to if_hash)
  Content-Type: application/json

  {
    "frontmatter": { "type": "concept", "tags": ["ai"] },
    "content": "# Context Engineering\n\nThe art of..."
  }

  → 201 Created (new) or 200 OK (update)
  {
    "path": "Resources/Concepts/context-engineering.md",
    "action": "create",
    "content_hash": "def456",
    "commit": "abc789",
    "url": "https://grove.md/Resources/Concepts/context-engineering"
  }

  → 409 Conflict (hash mismatch)
  → 400 Bad Request (validation failure)
  → 403 Forbidden (trail scope violation on writes — 403 not 404, client needs to know why)
  ```

  PUT because the client specifies the resource path. `If-Match` header is standard HTTP optimistic concurrency.

  Wire through auth, trail resolution, rate limiting (same as MCP path). Call `handleWriteNote`.

  **Files:** `src/proxy.ts` (new route), `src/rest.ts` (already has handleWriteNote from REST-1)
  **Tests:** `test/rest.test.ts` — PUT creates note, PUT with If-Match detects conflict, validation errors return 400
  **Acceptance criteria:**
  - `curl -X PUT https://api.grove.md/v1/notes/path.md -H "Authorization: Bearer xxx" -d '{"frontmatter":{...},"content":"..."}' ` creates a note
  - Trail-scoped keys can only write to allowed paths
  - Write queue serialization preserved (concurrent PUTs don't corrupt)
  - If-Match with wrong hash returns 409 with current hash in response

- [x] **REST-3: `GET /v1/status/:mode` endpoints** (`src/proxy.ts`)

  Expose all vault_status modes via REST:
  ```
  GET /v1/status/health
  GET /v1/status/history?since=1+week+ago
  GET /v1/status/diagnostics
  GET /v1/status/graph
  GET /v1/status/digest
  ```

  Current `/v1/stats` stays for backward compat. These are the full vault_status surface.

  **Files:** `src/proxy.ts` (new routes), `src/rest.ts` (reuse existing vault-status functions)

- [x] **REST-4: Migrate CLI from MCP to REST** (`src/cli.ts`)

  Replace the MCP handshake (`initialize` → session → `callTool`) with direct HTTP calls:
  - `grove search "X"` → `GET /v1/search?q=X&limit=10`
  - `grove read "X"` → `GET /v1/notes/X`
  - `grove list "X"` → `GET /v1/list?prefix=X`
  - `grove write "path"` → `PUT /v1/notes/path`
  - `grove status` → `GET /v1/status/health`
  - `grove history` → `GET /v1/status/history`
  - `grove diagnostics` → `GET /v1/status/diagnostics`

  Delete: `initialize()`, `mcpRequest()`, `callTool()`, session ID tracking. Replace with a single `httpRequest(method, path, body?)` helper.

  Each CLI command becomes a single HTTP request instead of a 3-step MCP handshake. Latency drops significantly.

  **Files:** `src/cli.ts` (major refactor — delete MCP code, add HTTP calls)
  **Tests:** `test/cli.test.ts` — mock HTTP responses instead of MCP responses
  **Acceptance criteria:**
  - All existing CLI commands work identically
  - No MCP session initialization in CLI code
  - `grove write path.md --content "text"` uses `PUT /v1/notes/path.md`
  - CLI works from any machine pointing at api.grove.md (no local dependencies for vault ops)

##### REST Execution Strategy

- **Agent A:** REST-1 + REST-2 (service extraction + PUT endpoint) — tightly coupled, same refactor
- **Agent B:** REST-3 (status endpoints) — independent of Agent A

Merge A first, then B. Then REST-4 (CLI migration) as a follow-up — it depends on the endpoints existing.

REST-4 can be combined with CLI-A1 (--json) since both refactor the CLI command functions. The agent doing CLI-A would handle both the output format change and the MCP→REST migration in one pass.

**tmux commands:**
```bash
# Pane 1
claude --worktree "Read PLAN.md tasks REST-1 and REST-2. Extract handleWriteNote and add PUT /v1/notes/:path per spec. Branch: agent/rest-write."
# Pane 2
claude --worktree "Read PLAN.md task REST-3. Add GET /v1/status/:mode endpoints per spec. Branch: agent/rest-status."
```

#### CLI-A: Foundation (before Phase 4b)

These make the CLI agent-usable. Do first. REST-1 through REST-3 should land before or alongside CLI-A (CLI-A4's migration depends on REST endpoints existing).

- [x] **CLI-A1: `--json` global flag** (`src/cli.ts`)

  Add `--json` to `parseArgs` as a top-level boolean. Each command function returns a result object instead of calling `console.log`. The dispatcher handles formatting: if `--json`, emit the result as JSON to stdout; otherwise, call the existing human formatter.

  Auto-detect non-TTY: `if (!process.stdout.isTTY) flags.json = true`.

  After REST-4 (CLI migration to REST), command functions receive clean JSON from HTTP responses. The `--json` implementation wraps the response data in the `{"ok": true, ...}` envelope. If REST-4 hasn't landed yet, the MCP text responses need parsing first — but the refactor is cleaner if done together.

  **Files:** `src/cli.ts` (modify parseArgs, refactor each command to return data)
  **Tests:** `test/cli.test.ts` — verify JSON output shape for each command, verify non-TTY detection
  **Acceptance criteria:**
  - `grove search "test" --json` emits valid JSON with `ok`, `results`, `count` fields
  - `grove read "path" --json` emits valid JSON with `path`, `frontmatter`, `content`, `content_hash`
  - `grove search "test" | cat` emits JSON (non-TTY auto-detection)
  - Human-formatted output unchanged when no `--json` and stdout is TTY

- [x] **CLI-A2: Exit codes + structured errors**

  Replace all `process.exit(1)` calls with thrown `CliError`:
  ```typescript
  class CliError extends Error {
    constructor(public code: string, message: string, public exitCode: number = 1) {
      super(message);
    }
  }
  ```

  Dispatcher catches `CliError`, formats per output mode, exits with correct code. Unhandled errors become exit 3 with code `server_error`.

  **Files:** `src/cli.ts`
  **Tests:** `test/cli.test.ts` — verify exit codes: not-found=1, bad auth=2, server down=3
  **Acceptance criteria:**
  - `grove read "nonexistent" --json` exits 1 with `{"ok": false, "error": "not_found", ...}` on stderr
  - `grove search "test"` with invalid token exits 2
  - Connection refused exits 3

- [x] **CLI-A3: `--content` flag on write**

  `grove write path.md --type concept --content "The actual content"` — alternative to stdin. If neither stdin nor `--content` is provided and stdin is a TTY, error immediately with usage hint instead of hanging.

  **Files:** `src/cli.ts` (modify cmdWrite)
  **Acceptance criteria:**
  - `grove write path.md --content "text" --type concept` creates the note
  - `grove write path.md --type concept` with no pipe and TTY stdin exits 1 with "Provide content via --content flag or pipe to stdin"

- [x] **CLI-A4: `grove init`**

  Guided non-interactive config setup:
  `grove init --server https://api.grove.md --token grove_live_xxx`

  Validates by calling `/health` on the server. Writes `~/.grove/cli.json`. Also support `GROVE_SERVER` and `GROVE_TOKEN` env vars as overrides (env > config file).

  **Files:** `src/cli.ts`
  **Acceptance criteria:**
  - `grove init --server X --token Y` creates config file and prints "Connected to X as <key-name>"
  - `GROVE_TOKEN=xxx grove search "test"` works without a config file

- [x] **CLI-A5: Promote `graph` and `digest` to top-level commands**

  `grove graph` → calls `vault_status(mode: "graph")`. Shows clusters, hubs, centrality.
  `grove digest` → calls `vault_status(mode: "digest")`. Shows lifecycle stages.

  Currently hidden as modes inside `grove status`. Not discoverable.

  **Files:** `src/cli.ts` (add two case entries, add formatters)
  **Acceptance criteria:**
  - `grove graph --json` returns `{ nodes, edges, clusters, top_hubs }`
  - `grove digest --json` returns `{ lifecycle: { seeds, sprouts, ... }, velocity_7d }`

- [x] **CLI-A6: `grove health` + `grove metrics`**

  `grove health` — HTTP GET `/health`, formats component status.
  `grove metrics` — HTTP GET `/metrics`, formats request counts and latency.

  **Files:** `src/cli.ts` (add commands, HTTP calls matching keys pattern)
  **Acceptance criteria:**
  - `grove health --json` returns `{ ok: true, components: { proxy, server, qmd, embeddings } }`
  - `grove metrics --json` returns request counts, p50/p95/p99, error rates

- [x] **CLI-A7: Help text with output schemas**

  Each command's `--help` shows: usage, examples, flags, JSON output schema, exit codes. Top-level `grove` (no args) shows grouped command listing with one-line descriptions.

  ```
  grove search <query> [-n N] [--json] [--paths]
    Search notes. Returns ranked results with snippets.
    JSON: {ok, results: [{path, title, score, snippet}], count}
    Exit: 0=found, 1=bad input, 2=auth, 3=server
  ```

  **Files:** `src/cli.ts` (add HELP records per command)

#### CLI-B: Consistency + Composability (after P4-API-1)

- [x] **CLI-B1: Move trails to HTTP**

  Replace direct SQLite imports (`loadTrails`, `createTrail`, etc.) with HTTP calls to `POST /v1/admin/trails` (matching the `/keys` pattern). Enables running `grove trails` from any machine, not just the server.

  **Files:** `src/cli.ts` (refactor cmdTrails* functions)
  **Acceptance criteria:**
  - `grove trails list` works from a laptop pointing at api.grove.md
  - All trail subcommands (list, create, disable, delete) use HTTP
  - `grove trails delete <id>` requires `--yes` flag

- [x] **CLI-B2: `--paths` flag on search/list**

  Emit one path per line, nothing else. For `xargs` composability.

  ```bash
  grove search "machine learning" --paths | xargs -I{} grove read "{}" --json
  ```

  **Files:** `src/cli.ts`

- [x] **CLI-B3: `--if-hash` on write**

  Expose the server's content hash checking for safe read-modify-write loops:

  ```bash
  data=$(grove read "Taste Graph" --json)
  hash=$(echo "$data" | jq -r '.content_hash')
  echo "updated content" | grove write "Resources/Concepts/Taste Graph.md" --if-hash "$hash"
  # Exits 1 with error "conflict" if hash doesn't match
  ```

  **Files:** `src/cli.ts` (pass If-Match header on PUT /v1/notes/)

- [x] **CLI-B4: `grove whoami`**

  Call server, print key name, scopes, vault. Quick identity check.

  **Files:** `src/cli.ts`

#### CLI-C: Module Extraction (when cli.ts exceeds ~1200 LOC)

Split into `src/cli/` directory:
```
src/cli/
  index.ts          # parseArgs, dispatch, global flags, main()
  output.ts         # format(), error(), JSON envelope, human formatters
  client.ts         # Config, loadConfig, httpGet, httpPut, httpPost
  commands/
    search.ts       # cmdSearch
    read.ts         # cmdRead, cmdGet
    write.ts        # cmdWrite
    inspect.ts      # cmdStatus, cmdHistory, cmdDiagnostics, cmdGraph, cmdDigest
    keys.ts         # cmdKeys*
    trails.ts       # cmdTrails*
    admin.ts        # cmdHealth, cmdMetrics, cmdWhoami, cmdInit
    local.ts        # cmdSnapshot, cmdRollback, cmdLint, cmdSync
```

Each command function has signature `(client: Client, positional: string, flags: Flags) => Promise<CommandResult>`. Never calls `console.log` or `process.exit`. The dispatcher handles all I/O.

This is a refactor, not a feature. Do it when adding Phase D commands makes the single file unwieldy.

#### CLI-D: Feature Commands (as server features land)

| Command | Server dependency | Phase |
|---------|-------------------|-------|
| `grove users list` | P4-API-2 (user list endpoint) | Phase 9a |
| `grove users invite <email> --trail <id> --role viewer` | P9-2 (invite flow) | Phase 9a |
| `grove share <path> [--ttl 7d]` | P9-7 (share-a-note) | Phase 9b |
| `grove tag-backfill` | P5-TAG-2 (tag inference) | P5-TAG |
| `grove ingest <dir>` | P7-7 (ingest command) | Phase 7b |
| `grove discovery` | P7-5 (discovery digest) | Phase 7a |
| `grove write --batch` | Needs server batch write API (not yet spec'd) | Phase 7+ |
| ~~`grove watch <resource>` (NDJSON event stream)~~ | Needs server SSE endpoint + event bus | **DEFERRED** — YAGNI for single-owner vault; `grove history --since "5 minutes ago"` on a cron covers ~99% of reactive use cases without the server work. Revisit only if a concrete "must react within seconds to a write" workflow appears. |

`grove write --batch` reads JSONL from stdin, each line is `{"path", "type", "tags", "content"}`. Requires a server-side batch write endpoint (one git commit for N notes). Spec the server endpoint when the need materializes (harvesting or ingestion workflows that write 10+ notes).

#### CLI Execution Strategy

**CLI-A (7 tasks, 2 parallel agents):**
- **Agent A:** CLI-A1 + CLI-A2 + REST-4 (--json + exit codes + MCP→REST migration) — tightly coupled refactor
- **Agent B:** CLI-A3 + CLI-A4 + CLI-A5 + CLI-A6 + CLI-A7 (new flags, new commands, help) — independent of A

Merge Agent A first (structural change to how commands return data). Then Agent B (adds features on top).

**tmux commands:**
```bash
# Pane 1
claude --worktree "Read PLAN.md tasks CLI-A1, CLI-A2, and REST-4. Refactor CLI: add --json, exit codes, migrate from MCP to REST HTTP calls. Branch: agent/cli-json."
# Pane 2
claude --worktree "Read PLAN.md tasks CLI-A3 through CLI-A7. Add --content flag, grove init, graph/digest commands, health/metrics, help text. Branch: agent/cli-commands."
```

**CLI-B (4 tasks, after CLI-A + P4-API-1 merged):** Single agent, sequential. Each task is small.

```bash
claude --worktree "Read PLAN.md tasks CLI-B1 through CLI-B4. Move trails to HTTP, add --paths, --if-hash, whoami. Branch: agent/cli-consistency."
```

**CLI-C:** Single agent when triggered by LOC threshold.

**CLI-D:** One task per feature, lands with its server phase.

#### Complete Command Reference (after all phases)

**Vault operations:**
| Command | Description |
|---------|-------------|
| `grove search <query>` | Hybrid search (BM25 + vector) |
| `grove read <path>` | Read a note by path or title |
| `grove write <path>` | Create/update a note |
| `grove list <pattern>` | List notes matching a glob |

**Vault introspection:**
| Command | Description |
|---------|-------------|
| `grove status` | Vault health summary |
| `grove history` | Recent git changes |
| `grove diagnostics` | Orphans, broken links, missing frontmatter |
| `grove graph` | Knowledge graph: clusters, hubs, centrality |
| `grove digest` | Lifecycle: seeds, sprouts, growing, mature |
| `grove discovery` | Discovery loop: recent extractions, new concepts |

**Administration:**
| Command | Description |
|---------|-------------|
| `grove keys list\|create\|revoke` | API key management |
| `grove trails list\|create\|disable\|delete` | Trail management |
| `grove users list\|invite` | User management |
| `grove health` | Server component health |
| `grove metrics` | Request counts, latency, error rates |
| `grove share <path>` | Generate expiring share link |
| `grove whoami` | Current identity + scopes |
| `grove init` | Config setup |

**Local operations:**
| Command | Description |
|---------|-------------|
| `grove snapshot [message]` | Create vault snapshot (git tag) |
| `grove rollback <tag>` | Restore vault to snapshot (requires `--yes`) |
| `grove lint <dir>` | Normalize YAML frontmatter |
| `grove sync <dir>` | Sync archive sources |
| `grove tag-backfill` | Apply inferred tags to untagged notes |
| `grove ingest <dir>` | Bulk import markdown files |

**Global flags:** `--json`, `--quiet`, `--verbose`, `--yes`, `--help`

---

### ~~Phase 6: LLM Judge~~ — REMOVED FROM SCOPE

Tag/type/path prefilter handles trail filtering. The right investment is better tag coverage across the vault, not an LLM layer. See P5-TAG below.

---

### Phase 7: Discovery & Onboarding

**Goal:** Knowledge grows autonomously. New content integrates without manual invocation.

**Prerequisites:** Phases 2-5 stable. CI/CD live (P4-PREREQ-2).

**Key design decision (changed from original plan):** Concept extraction uses Claude API via MCP tool calls (not local Ollama). The discovery loop runs as a background Node.js process that calls Grove's own MCP tools — it's an agent that uses the same API as Claude.ai. This means no GPU, no Ollama, no model management. The VPS stays lean.

#### Phase 7a: Background Discovery

- [x] **P7-1: Discovery loop skeleton** (`src/discovery.ts`, `src/discovery-worker.ts`)

  Background process managed by PM2. Watches for vault changes via two triggers:
  1. **Git hook:** `post-commit` hook in the vault repo calls `curl http://localhost:8190/internal/discovery-trigger?path=<changed-file>`
  2. **Write queue hook:** `write-queue.ts` emits an event after successful write+commit

  The loop maintains a SQLite queue table (`discovery_queue`) with columns: `path`, `trigger` (commit|write), `queued_at`, `processed_at`, `status`.

  **Files:** `src/discovery.ts` (main loop — dequeues, dispatches to extractors), `src/discovery-worker.ts` (PM2 entry point), `src/db.ts` (add `discovery_queue` table to schema)

  **Acceptance criteria:**
  - `pm2 start discovery-worker` runs without errors
  - Writing a note via `write_note` adds an entry to `discovery_queue`
  - The loop dequeues and logs "processing <path>" for each entry
  - Processed entries are marked `status = 'done'` with timestamp
  - The loop handles errors gracefully — a failed note doesn't block the queue

- [x] **P7-2: Concept extraction via Claude API** (`src/discovery-extract.ts`)

  For each changed note, call Claude API (claude-haiku-4-5 for cost efficiency) with:
  - The note's full content
  - The vault's entity vocabulary (from `list_notes` with type filter)
  - A structured output schema requesting: extracted entities (name, type, confidence), suggested wikilinks, new concept notes to create

  ```typescript
  interface ExtractionResult {
    entities: { name: string; type: "person" | "concept" | "project" | "company"; confidence: number; existing_path?: string }[];
    suggested_links: { from_text: string; to_path: string }[];
    new_notes: { path: string; type: string; tags: string[]; content: string }[];
  }
  ```

  Match extracted entities against existing vault notes (case-insensitive name + alias matching via `list_notes`). Only create new concept notes for entities with confidence > 0.8 that don't match existing notes.

  **Files:** `src/discovery-extract.ts` (extraction logic), `src/discovery.ts` (integrate extractor into loop)
  **Dependencies:** `@anthropic-ai/sdk` (add to package.json)
  **Env var:** `ANTHROPIC_API_KEY` (add to env var docs)

  **Tests:** `test/discovery-extract.test.ts` — mock Claude API response, verify entity matching, verify dedup against existing notes
  **Acceptance criteria:**
  - Given a journal entry mentioning "John Smith" and an existing `Resources/People/John Smith.md`, extraction matches (doesn't create duplicate)
  - Given a note about "reinforcement learning" with no existing concept note, extraction suggests creating `Resources/Concepts/Reinforcement Learning.md`
  - Extraction result includes confidence scores; low-confidence entities are logged but not acted on

- [x] **P7-3: Wikilink wiring** (`src/discovery-link.ts`)

  After extraction, wire wikilinks into the source note. For each `suggested_links` entry: find the `from_text` in the note content, wrap it in `[[to_path|from_text]]`. Write the updated note via `write_note` (through the write queue, not direct filesystem).

  Also create any `new_notes` from the extraction result via `write_note`.

  **Files:** `src/discovery-link.ts` (link insertion logic), `src/discovery.ts` (integrate linker into loop after extraction)
  **Tests:** `test/discovery-link.test.ts` — verify link insertion preserves existing content, handles edge cases (text appears multiple times, text is already linked)
  **Acceptance criteria:**
  - A note mentioning "machine learning" gets `[[Resources/Concepts/Machine Learning|machine learning]]` inserted
  - Already-linked text is not double-linked
  - Link insertion doesn't corrupt frontmatter
  - New concept notes are created with proper frontmatter (type, tags, aliases)

- [x] **P7-4: Semantic neighbor surfacing** (`src/discovery-neighbors.ts`)

  After processing a note, find embedding-similar notes not already linked. Use `query` tool with `vec` sub-query type, filter out notes that are already wikilinked from/to the source note. Store surprising connections in a `discovery_results` table.

  ```sql
  CREATE TABLE IF NOT EXISTS discovery_results (
    id TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,
    target_path TEXT NOT NULL,
    similarity REAL NOT NULL,
    relationship TEXT, -- "semantic neighbor", "potential duplicate", etc.
    created_at TEXT NOT NULL,
    dismissed_at TEXT -- user can dismiss suggestions
  );
  ```

  **Files:** `src/discovery-neighbors.ts`, `src/db.ts` (add table)
  **Acceptance criteria:**
  - Processing a note about "transformer architecture" surfaces similar notes about "attention mechanisms"
  - Already-linked notes are excluded from results
  - Results are stored with similarity scores for later review

- [x] **P7-5: Discovery digest** (extend `vault_status` in `src/server.ts`)

  New `vault_status` mode: `discovery`. Returns:
  ```typescript
  {
    recent_extractions: { path: string; entities_found: number; links_wired: number; processed_at: string }[];
    new_concepts_created: { path: string; created_at: string; triggered_by: string }[];
    surprising_connections: { source: string; target: string; similarity: number }[];
    queue_depth: number;
    last_processed_at: string;
  }
  ```

  Data sourced from `discovery_queue` and `discovery_results` tables.

  **Files:** `src/server.ts` (add discovery mode to vault_status handler), `src/db.ts` (query functions)
  **Acceptance criteria:**
  - `vault_status(mode: "discovery")` returns the digest
  - Empty state (no discovery results yet) returns zeroed fields, not errors

- [x] **P7-6: Bookmark integration** (`src/discovery-bookmarks.ts`)

  Cron job (every 30 min) checks for new X bookmarks via `bird` CLI. For each new bookmark:
  1. Fetch the URL content (or use `bird` metadata)
  2. Create a Source note in `Sources/` with proper frontmatter
  3. Enqueue the new note in `discovery_queue` for concept extraction

  **Files:** `src/discovery-bookmarks.ts` (bookmark sync), PM2 cron config or `node-cron` in the worker
  **Acceptance criteria:**
  - New X bookmarks appear as Source notes in the vault
  - Each bookmark note gets queued for discovery processing
  - Already-synced bookmarks are not duplicated (dedup via URL)

#### Phase 7b: Bulk Onboarding

- [x] **P7-7: Ingest command** (extend `src/cli.ts`)

  `grove ingest <dir>` — reads a directory of .md files, parses frontmatter/content, deduplicates against existing vault (by title + content hash), writes new notes via `write_note` MCP tool call. Creates a snapshot before starting (`grove snapshot`).

  **Files:** `src/cli.ts` (add `ingest` command)
  **Acceptance criteria:**
  - `grove ingest ./import/` creates notes from all .md files in the directory
  - Duplicate detection prevents re-importing existing notes
  - Progress output: "Imported 42/50 notes (8 skipped as duplicates)"
  - Snapshot created before ingest starts

- [x] **P7-8: Post-ingest concept bootstrap**

  After `grove ingest`, enqueue all newly created notes in `discovery_queue` with `trigger = 'ingest'`. The discovery loop processes them, extracting concepts and wiring links. This is the cold start path for new users or content dumps.

  **Files:** `src/cli.ts` (extend ingest to enqueue), `src/discovery.ts` (handle ingest trigger)
  **Acceptance criteria:**
  - After ingesting 50 notes, all 50 appear in discovery queue
  - Discovery loop processes them and creates concept notes
  - Graph connectivity increases (measurable via `vault_status(mode: "graph")`)

#### Phase 7 Execution Strategy

**Batch 1 (2 parallel agents):**
- **Agent A:** P7-1 (discovery loop skeleton) — creates `src/discovery.ts`, `src/discovery-worker.ts`, adds queue table to `db.ts`
- **Agent B:** P7-7 (ingest command) — extends `src/cli.ts` only, no overlap with Agent A

```bash
# Pane 1
claude --worktree "Read PLAN.md task P7-1. Build the discovery loop skeleton per spec. Branch: agent/p7-discovery-loop."
# Pane 2
claude --worktree "Read PLAN.md task P7-7. Build the grove ingest command per spec. Branch: agent/p7-ingest."
```

**Batch 2 (2 parallel agents, after Batch 1 merged):**
- **Agent C:** P7-2 + P7-3 (concept extraction + wikilink wiring) — creates `src/discovery-extract.ts` and `src/discovery-link.ts`, integrates into discovery loop
- **Agent D:** P7-4 (semantic neighbors) — creates `src/discovery-neighbors.ts`, adds table to `db.ts` (different table than Batch 1, safe merge)

```bash
# Pane 1
claude --worktree "Read PLAN.md tasks P7-2 and P7-3. Build concept extraction and wikilink wiring per spec. Branch: agent/p7-extraction."
# Pane 2
claude --worktree "Read PLAN.md task P7-4. Build semantic neighbor surfacing per spec. Branch: agent/p7-neighbors."
```

**Batch 3 (2 parallel agents, after Batch 2 merged):**
- **Agent E:** P7-5 (discovery digest) — extends `vault_status` in `server.ts`
- **Agent F:** P7-6 + P7-8 (bookmarks + post-ingest bootstrap) — creates `src/discovery-bookmarks.ts`, extends cli.ts ingest

```bash
# Pane 1
claude --worktree "Read PLAN.md task P7-5. Add discovery mode to vault_status per spec. Branch: agent/p7-digest."
# Pane 2
claude --worktree "Read PLAN.md tasks P7-6 and P7-8. Build bookmark integration and post-ingest bootstrap per spec. Branch: agent/p7-bookmarks."
```

---

### Phase B: Magic Link Auth & Cross-Domain Sessions ✅ COMPLETE 2026-04-11

**Goal:** Replace in-memory admin sessions with persistent SQLite-backed auth. Add magic link login as a path from "person with an email" to "authenticated user with an API key." Bridge auth between `api.grove.md` and `grove.md`.

**What was built:**

The auth system shifted from "single admin with a pasted API key" to "users with email-based identity and persistent sessions." This is the foundation that makes multi-user collaboration possible.

**Auth architecture (new):**

```
grove.md/login                     api.grove.md
┌──────────────┐                   ┌──────────────────────┐
│ Email form   │───POST──────────→ │ /auth/magic-link     │
│              │                   │ → store hashed token  │
│              │                   │ → send email (Resend) │
└──────────────┘                   └──────────────────────┘
                                           │
                                     email with link
                                           │
                                           ▼
                                   ┌──────────────────────┐
                                   │ /auth/verify (GET)    │
                                   │ → confirm page + CSRF │
                                   │ /auth/verify (POST)   │
                                   │ → verify magic link   │
                                   │ → create auth code    │
                                   │ → redirect to grove.md│
                                   └───────────┬──────────┘
                                               │ 302 + ?code=
                                               ▼
grove.md/api/auth/callback         api.grove.md
┌──────────────┐                   ┌──────────────────────┐
│ Exchange code│───GET────────────→│ /auth/exchange       │
│              │←── session_token ─│ → validate code      │
│ Create key   │───POST───────────→│ /keys (create)       │
│              │←── API key token ─│ → grove-www-<user>   │
│ Set cookie   │                   └──────────────────────┘
│ Redirect /   │
└──────────────┘
```

**Key components:**
- `src/auth.ts` — magic link requests (rate-limited 3/email/15min), verification (single-use, 15min TTL), session CRUD (30d sliding / 90d absolute), auth code exchange (60s TTL, single-use), CSRF tokens
- `src/email.ts` — Resend API (prod) or console.log (dev)
- `src/db.ts` — `users`, `sessions`, `magic_links`, `auth_codes` tables in `~/.grove/grove.db`
- `src/proxy.ts` — 6 new routes (`/auth/magic-link`, `/auth/verify` GET+POST, `/auth/exchange`, `/auth/session`, `/auth/logout`)
- `grove-www/src/app/login/page.tsx` — email + API key dual login form
- `grove-www/src/app/api/auth/callback/route.ts` — code exchange + auto key provisioning
- `grove-www/src/app/api/auth/magic-link/route.ts` — server-side proxy (avoids CORS)

**Security properties:**
- Raw tokens never stored — SHA-256 hashes only (magic links, sessions, auth codes)
- Magic links: single-use, 15min TTL, 3/email/15min rate limit
- Sessions: HttpOnly, Secure, SameSite=Lax cookies, sliding + absolute expiry
- Auth codes: single-use, 60s TTL (just long enough for the redirect)
- No email enumeration: requestMagicLink always returns 200

**What this enables:** Users exist as first-class entities in the database. A person with only an email can get authenticated, get an API key, and access the vault. This is the primitive that multi-user collaboration (Phase 9) builds on.

---

### Phase 9: Multi-User & Collaboration

**Goal:** Move Grove from "one vault owner sharing read-only trails" to "multiple users with their own identities, permissions, and collaborative workflows."

**Prerequisites:** P4-PREREQ complete (CI/CD, route extraction). Phase B (magic link auth) complete.

**Context:** Phase B established the foundation — users exist in the database, magic links create identity, sessions persist. But today there's exactly one user (`user_00000000`), everyone shares the same vault, and "collaboration" means handing someone a trail-scoped read-only key. This phase adds user roles, invitations, and trail sharing UX.

**Scope decision:** Annotations (comments, reactions) are deferred. Build them only after there's evidence of collaborative usage (at least 3 active non-owner users). Don't build social features for a solo product.

#### Phase 9a: User Management

- [x] **P9-1: User roles** (`src/db.ts`, `src/users.ts`, `src/proxy.ts`)

  Add `role` column to users table: `owner` (full access), `member` (trail-scoped read+write), `viewer` (trail-scoped read-only).

  **Schema migration in `src/db.ts`:**
  ```sql
  ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer';
  UPDATE users SET role = 'owner' WHERE id = 'user_00000000';
  ```

  **`src/users.ts` changes:** Add `getUserRole(userId)`, update `createUser()` to accept optional `role` parameter.

  **`src/proxy.ts` changes:** `adminAuth()` middleware checks `role = 'owner'` for admin endpoints. Non-owners get 403.

  **Files:** `src/db.ts`, `src/users.ts`, `src/proxy.ts`
  **Tests:** `test/users.test.ts` — create user with role, verify role-based auth check
  **Acceptance criteria:**
  - Existing user `user_00000000` gets `role = 'owner'` on migration
  - New users default to `viewer`
  - Non-owner hitting `/keys` or `/v1/admin/*` gets 403
  - Owner access unchanged

- [x] **P9-2: Invite flow** (`src/invite.ts`, `src/proxy.ts`, `src/cli.ts`)

  **CLI:** `grove invite <email> --trail <trail-id> --role viewer`
  **API:** `POST /v1/admin/invite` with `{ email, trail_id, role }`

  Implementation:
  1. Create user record if no user with that email exists (`createUser(email, role)`)
  2. Create trail grant in `trail_grants` table (link user to trail)
  3. Send magic link email with welcome message (extend `sendMagicLinkEmail` with optional `welcome: true` flag)
  4. On first login via magic link, auto-provision scoped API key (reuse existing auth code exchange flow)

  **Files:** `src/invite.ts` (invite logic), `src/proxy.ts` (new route), `src/cli.ts` (new command), `src/email.ts` (welcome variant)
  **Tests:** `test/invite.test.ts` — invite creates user + trail grant, duplicate invite is idempotent, invalid trail ID returns 404
  **Acceptance criteria:**
  - `grove invite alice@example.com --trail trail_abc123 --role viewer` succeeds
  - Alice receives an email with a magic link
  - After clicking the link, Alice has a trail-scoped API key
  - Re-inviting the same email is idempotent (no duplicate user)

- [x] **P9-3: User-scoped keys** (`src/keys.ts`, `src/proxy.ts`)

  Today all keys are owned by `user_00000000`. After this task, keys are scoped to their creating user.

  **`src/keys.ts` changes:** `createKey()` accepts `user_id` parameter. `loadKeys()` accepts optional `user_id` filter.

  **`src/proxy.ts` changes:** `/keys` list action filters by current user's ID (owner sees all, others see only their own). Create action sets `user_id` to current user.

  **Migration:** Existing keys get `user_id = 'user_00000000'` (already the case in schema).

  **Files:** `src/keys.ts`, `src/proxy.ts`
  **Tests:** `test/keys.test.ts` — key created with user_id, filtered list returns only user's keys
  **Acceptance criteria:**
  - Owner can see and manage all keys
  - Viewer can only see their own auto-provisioned key
  - Creating a key records the user who created it

- [x] **P9-4: User management UI** (grove-www repo: `src/app/dashboard/users/page.tsx`)

  Owner-only page in the dashboard. Requires Phase 4b dashboard layout (P4-FE-0) to be merged.

  **Layout:**
  - Header: "Users" heading + "Invite" button
  - Table: Email, Role (badge), Last Login (relative time), Trails (comma-separated names), Keys (count), Actions
  - Invite flow: inline form — email input + trail dropdown + role radio (viewer/member) + send button
  - Revoke: "Remove" button per user → confirm → delete user's keys and sessions → remove from list

  **Files:** `src/app/dashboard/users/page.tsx`, `src/components/user-table.tsx` (client component)
  **Acceptance criteria:**
  - Lists all users with metadata
  - Invite flow sends magic link and user appears in list
  - Revoking a user immediately invalidates their keys and sessions
  - Non-owner accessing this page gets redirected

#### Phase 9b: Trail Sharing UX

- [x] **P9-5: Shareable trail links** (grove-www repo: `src/app/trails/[slug]/page.tsx`)

  Public onboarding page per trail: `grove.md/trails/<trail-slug>`. Shows trail name, description, note count, and a "Sign in to access" button. No login required to see the page — but reading notes requires auth.

  **Backend (grove repo):** Add `GET /v1/trails/:id/info` to `src/proxy.ts` — unauthenticated endpoint returning `{ name, description, note_count, created_at }`. Count notes matching trail filters via a quick scan.

  **Frontend:** Centered card layout (same style as login page). Trail name (serif heading), description, note count, two access methods:
  1. "Sign in to browse" button → `/login?trail=<id>`
  2. "Connect via MCP" section with copy-paste config block

  **Files:** `src/proxy.ts` (grove repo — new endpoint), `src/app/trails/[slug]/page.tsx` (grove-www)
  **Acceptance criteria:**
  - Page loads without auth — public access
  - Shows trail name, description, note count
  - MCP config block is copy-pasteable
  - Non-existent trail ID → 404 page

- [x] **P9-6: Trail-scoped grove.md experience** (grove-www repo)

  When a viewer/member signs in via a trail link, their `grove.md` session is scoped to that trail. They see the trail name in the header, search only returns trail-visible notes, and navigation is limited to trail-allowed paths.

  **Implementation:** The auto-provisioned API key has trail-scoped access. The existing server-side filtering handles the rest — no frontend logic needed beyond showing the trail context in the header.

  **Files:** `src/components/header.tsx` (show trail name for scoped sessions), `src/app/api/auth/callback/route.ts` (pass trail context through login flow)
  **Acceptance criteria:**
  - Viewer sees trail name in header after signing in via trail link
  - Search returns only trail-scoped results
  - Navigation shows only trail-allowed paths
  - Owner view is unchanged

- [x] **P9-7: Share-a-note links** (`src/proxy.ts`, grove-www: `src/app/s/[id]/page.tsx`)

  Owner generates a shareable link to a specific note: `grove.md/s/<short-id>`. The link creates a temporary trail scoped to that single note and its depth-1 inbound backlinks (notes that wikilink TO the shared note — outbound links excluded to prevent leaking sensitive content). Expires after configurable TTL (default 7 days).

  **Schema addition in `src/db.ts`:**
  ```sql
  CREATE TABLE IF NOT EXISTS shared_links (
    id TEXT PRIMARY KEY,
    note_path TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    max_views INTEGER DEFAULT 100,
    view_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
  ```

  **API:** `POST /v1/admin/share` with `{ note_path, ttl_days?: number, max_views?: number }` → `{ id, url, expires_at }`

  **Files:** `src/db.ts` (table), `src/proxy.ts` (create endpoint), `src/proxy.ts` (resolve share link → micro-trail), grove-www `src/app/s/[id]/page.tsx`
  **Acceptance criteria:**
  - Owner creates share link → gets URL
  - Recipient opens URL, signs in with email, sees the note + inbound backlinks
  - Outbound links from the shared note are NOT visible
  - Link expires after TTL — returns "This link has expired"
  - View count increments; link disabled after max_views reached

#### Phase 9 Design Decisions

| Decision | Chosen | Why |
|----------|--------|-----|
| User creation | Invite-only (owner sends magic link) | No public signup. Grove is private-first. Access is granted, not requested. |
| Viewer experience | Trail-scoped grove.md, same codebase | No separate app for viewers. The API key's trail scope does the filtering. |
| Share links | Micro-trails with depth-1 inbound backlinks | Even shared notes require email auth. No anonymous access. Outbound links excluded to prevent leaking sensitive content. |
| Roles | owner/member/viewer | Minimal. Don't add "editor", "admin", "moderator" until there's a real need. |
| Annotations | Out of scope | Build if/when collaborative usage patterns emerge. Not planning for it now. |

#### Phase 9 Execution Strategy

**Batch 1 (3 parallel agents, grove repo):**
- **Agent A:** P9-1 (user roles) — touches `src/db.ts` (ALTER TABLE), `src/users.ts`, `src/proxy.ts` (adminAuth check)
- **Agent B:** P9-2 (invite flow) — creates `src/invite.ts`, extends `src/proxy.ts` (new route), extends `src/cli.ts`, `src/email.ts`
- **Agent C:** P9-3 (user-scoped keys) — touches `src/keys.ts`, `src/proxy.ts` (existing /keys handler). Minimal overlap with A/B.

Merge order: Agent A first (adminAuth changes are foundational), then B+C.

```bash
# Pane 1
claude --worktree "Read PLAN.md task P9-1. Add user roles per spec. Branch: agent/p9-roles."
# Pane 2
claude --worktree "Read PLAN.md task P9-2. Build invite flow per spec. Branch: agent/p9-invite."
# Pane 3
claude --worktree "Read PLAN.md task P9-3. Scope keys to users per spec. Branch: agent/p9-scoped-keys."
```

**Batch 2 (2 parallel agents, after Batch 1 merged):**
- **Agent D:** P9-4 (user management UI, grove-www) — needs dashboard layout from Phase 4b
- **Agent E:** P9-5 + P9-6 (trail sharing pages, grove-www) — separate routes from Agent D

```bash
# Pane 1
claude --worktree "Read PLAN.md task P9-4. Build user management dashboard page per spec. Branch: agent/p9-user-ui."
# Pane 2
claude --worktree "Read PLAN.md tasks P9-5 and P9-6. Build trail sharing pages per spec. Branch: agent/p9-trail-sharing."
```

**Batch 3 (1 agent, after Batch 2 merged):**
- **Agent F:** P9-7 (share-a-note) — touches both repos (share table + API in grove, page in grove-www)

```bash
claude --worktree "Read PLAN.md task P9-7. Build share-a-note links per spec. Branch: agent/p9-share."
```

#### Phase 9 Success Criteria

- Owner invites a collaborator by email → they receive a magic link → click it → land on grove.md seeing only their trail's notes
- Viewer searches and only gets trail-scoped results (no leaks)
- Share-a-note link works: recipient opens it, signs in, sees the note + inbound backlinks only
- Share link expires after TTL — accessing it returns "This link has expired"
- Owner can see all users, their roles, last login, and assigned trails in the management UI
- Revoking a user's access immediately invalidates their keys and sessions
- Non-owner hitting admin endpoints gets 403

---

### Phase 10: Vault-Agnostic Structure ✅ COMPLETE 2026-04-21

**Goal:** Decouple Grove from PARA folder conventions so any Obsidian vault works out of the box. Foundation for multi-vault SaaS product.

**Prerequisites:** None — this is foundational and can start immediately. Should land before Phase 8 (multi-vault).

**Context:** Grove currently hard-codes PARA folder→type mappings in 3 modules:
- `notes-validate.ts` — `TYPE_PATHS` dict maps types to folders (`concept` → `Resources/Concepts/`), `TAG_RULES` infers tags from paths
- `discovery-extract.ts` — builds entity vocabulary from `Resources/*` subfolders
- `vault-stats.ts` — counts notes by PARA folder prefixes for stats/lifecycle

These assumptions lock Grove to one organizational philosophy. A Zettelkasten user, flat-folder user, or anyone with custom hierarchy can't use Grove without restructuring their vault.

**Approach:** Convention-based defaults with a dead-simple config file. If no config exists, auto-detect and generate one. Existing PARA vaults get auto-generated config matching current behavior — zero disruption.

#### P10-1: Vault config schema (`src/vault-config.ts`) ✅ COMPLETE 2026-04-20 (2a68019)

New module. Defines, loads, and validates vault structure configuration.

**Config file:** `.grove/config.yaml` in the vault root (git-tracked, portable with the vault).

```yaml
# .grove/config.yaml — vault structure configuration
# Grove auto-generates this on first index. Edit to customize.

structure:
  # Where auto-created entities land (per-type overrides optional)
  entities:
    default: "Inbox/"          # fallback for all entity types
    concept: "Resources/Concepts/"
    person: "Resources/People/"
    project: "Resources/Projects/"
    company: "Resources/Companies/"
    place: "Resources/Places/"

  # Path→type inference (optional — frontmatter type is always authoritative)
  type_paths:
    concept: "Resources/Concepts/"
    person: "Resources/People/"
    recipe: "Resources/Recipes/"
    project: "Resources/Projects/"
    company: "Resources/Companies/"
    place: "Resources/Places/"
    journal: "Journal/"
    source: "Sources/"

  # Path→tag inference (supplemental, never removes existing tags)
  tag_rules:
    - prefix: "Journal/"
      tags: ["journal"]
    - prefix: "Resources/People/"
      tags: ["person"]
    - prefix: "Resources/Concepts/"
      tags: ["concept"]
    - prefix: "Resources/Recipes/"
      tags: ["recipe"]
    - prefix: "Areas/Health/"
      tags: ["health", "private"]
    - prefix: "Areas/Finances/"
      tags: ["finances", "private"]

  # Paths treated as private (notes here get private: true)
  private_paths: ["Areas/Health/", "Areas/Finances/"]

  # Archive path for soft-deleted notes (Phase 11)
  archive_path: "Archives/"

  # Journal path pattern (null = no journal convention)
  journal_path: "Journal/"
  journal_filename: "YYYY-MM-DD.md"  # strftime-style pattern
```

**TypeScript interface:**
```typescript
interface VaultConfig {
  structure: {
    entities: Record<string, string>;     // type → folder path (must include "default")
    type_paths: Record<string, string>;   // type → expected folder prefix
    tag_rules: Array<{ prefix: string; tags: string[] }>;
    private_paths: string[];
    archive_path: string;
    journal_path: string | null;
    journal_filename: string | null;
  };
}
```

**Functions:**
```typescript
export function loadVaultConfig(vaultPath: string): VaultConfig;  // reads .grove/config.yaml, falls back to defaults
export function getDefaultConfig(): VaultConfig;                   // PARA defaults (current behavior)
export function entityPath(config: VaultConfig, type: string): string;  // resolve where to create a new entity
```

**Files:** `src/vault-config.ts` (new)
**Tests:** `test/vault-config.test.ts` — load from YAML, missing file returns defaults, invalid YAML returns error, entityPath resolution
**Acceptance criteria:**
- `loadVaultConfig()` reads `.grove/config.yaml` if it exists
- Missing config file returns PARA defaults (exact current behavior)
- Config is validated: entities must have "default", paths must end with "/"
- `entityPath(config, "concept")` returns the configured path for concepts

---

#### P10-2: Decouple notes-validate.ts (`src/notes-validate.ts`) ✅ COMPLETE 2026-04-20 (9951378)

Replace hard-coded `TYPE_PATHS`, `TAG_RULES` constants with config-driven lookups.

**Changes:**
1. Remove hard-coded `TYPE_PATHS` and `TAG_RULES` constants
2. `validateNote()` accepts a `VaultConfig` parameter (or loads it internally)
3. `inferTags()` reads tag rules from config instead of the constant
4. Path/type consistency check reads type_paths from config
5. Journal filename validation reads journal_filename pattern from config
6. If config has no type_paths (empty object), skip folder validation entirely — type is frontmatter-only

**Files:** `src/notes-validate.ts` (refactor), `src/server.ts` (pass config to validate calls), `src/rest.ts` (pass config to validate calls)
**Tests:** `test/notes-validate.test.ts` — test with PARA config (existing behavior), test with empty type_paths (no folder validation), test with custom paths
**Acceptance criteria:**
- All existing tests pass unchanged (PARA defaults = same behavior)
- A vault with `type_paths: {}` accepts a concept note at any path
- A vault with custom paths (`concept: "Zettelkasten/"`) validates correctly
- `inferTags()` uses config tag_rules, not hard-coded constant

---

#### P10-3: Decouple discovery-extract.ts (`src/discovery-extract.ts`) ✅ COMPLETE 2026-04-21

Replace hard-coded `Resources/*` vocabulary building with config-driven entity paths.

**Changes:**
1. `buildVocab()` (or equivalent function that scans for existing entities) reads entity paths from vault config
2. Instead of scanning `Resources/Concepts/`, `Resources/People/`, etc., scan paths declared in `config.structure.entities`
3. New entity creation uses `entityPath(config, type)` instead of hard-coded paths
4. If entity path is `Inbox/` (the default fallback), prefix entity notes with type: `Inbox/concept-taste-graph.md`

**Also update:**
- `src/discovery-link.ts` — new entity note path generation uses config
- `src/discovery-bookmarks.ts` — `Sources/X/` path reads from config
- `src/db.ts` — `getNewConceptsCreated()` WHERE clause uses config path instead of hard-coded `'Resources/Concepts/%'`
- `src/server.ts` — MCP tool descriptions and vault structure instructions dynamically generated from config (lines 75-98, 180-194)
- `src/rest.ts` — diagnostics orphan/stale checks read folder config instead of hard-coded `Resources/` and `Inbox/`
- `src/cli.ts` — ingest `TYPE_PATHS` and help text examples use config

**Files:** `src/discovery-extract.ts`, `src/discovery-link.ts`, `src/discovery-bookmarks.ts`, `src/db.ts`, `src/server.ts`, `src/rest.ts`, `src/cli.ts`
**Tests:** `test/discovery-extract.test.ts` — test vocab from custom entity paths, test new entity creation at configured path
**Acceptance criteria:**
- Existing PARA vault behavior unchanged
- A vault with `entities.concept: "Ideas/"` builds vocab from `Ideas/` and creates new concepts there
- A vault with `entities.default: "Inbox/"` creates all entities in Inbox
- MCP tool descriptions reflect the actual vault structure, not hard-coded PARA
- Diagnostics check the configured folders, not hard-coded ones

---

#### P10-4: Decouple vault-stats.ts (`src/vault-stats.ts`) ✅ COMPLETE 2026-04-20 (00243a6, merged eb5a081)

Replace hard-coded PARA folder counting with config-driven stats.

**Changes:**
1. Folder-based stats section reads from config type_paths instead of hard-coded prefixes
2. If config has no type_paths, count by frontmatter type only (no folder breakdown)
3. Lifecycle classification (seeds/sprouts/growing/mature/dormant/withering) stays — it's based on git age, not folder structure

**Files:** `src/vault-stats.ts` (refactor folder counting)
**Tests:** `test/vault-stats.test.ts` — test stats with custom config
**Acceptance criteria:**
- Stats accurately count notes in custom folder structures
- Stats work when type_paths is empty (type-only counting)
- Lifecycle classification unchanged

---

#### P10-5: Auto-detection (`src/vault-config.ts`) ✅ COMPLETE 2026-04-20 (combined into 2a68019)

When no `.grove/config.yaml` exists and `loadVaultConfig()` is called, auto-detect the vault structure and generate a config.

**Detection heuristic:**
1. Scan top-level folders in the vault
2. If `Resources/` and `Journal/` exist → PARA pattern → generate PARA defaults
3. If `Zettelkasten/` or large flat folder of .md files → Zettelkasten pattern → type_paths empty, entities.default = root or detected folder
4. If none match → minimal config: type_paths empty (no folder enforcement), entities.default = "Inbox/" (create if missing), tag_rules empty
5. Write generated config to `.grove/config.yaml`
6. Log: "Auto-detected vault structure: <pattern>. Config written to .grove/config.yaml — edit to customize."

**Files:** `src/vault-config.ts` (add `detectAndWriteConfig()`)
**Tests:** `test/vault-config.test.ts` — test detection with PARA fixture vault, test detection with flat vault
**Acceptance criteria:**
- PARA vault auto-detects and generates matching config
- Non-PARA vault generates minimal config (no folder enforcement)
- Generated config is valid YAML that `loadVaultConfig()` can read back
- Detection only runs once (subsequent loads read existing config)

---

#### P10-6: CLI command (`src/cli.ts`) ✅ COMPLETE 2026-04-20 (c73c156, merged c9dd0bb)

`grove config` — show current vault config. `grove config init` — force re-detect and regenerate.

**Files:** `src/cli.ts` (new command)
**Acceptance criteria:**
- `grove config --json` returns the current vault config
- `grove config init` generates `.grove/config.yaml` via auto-detection
- `grove config init` on a vault with existing config asks for confirmation (or `--yes`)

---

#### Phase 10 Execution Strategy

**Batch 1 (2 parallel agents):**
- **Agent A:** P10-1 + P10-5 (config schema + auto-detection) — creates `src/vault-config.ts`, writes tests
- **Agent B:** P10-2 (decouple notes-validate.ts) — refactors validation, needs config interface (can use mock/defaults initially)

```bash
# Pane 1
claude --worktree "Read PLAN.md tasks P10-1 and P10-5. Create vault config module with schema, loading, defaults, and auto-detection per spec. Branch: agent/p10-config."
# Pane 2
claude --worktree "Read PLAN.md task P10-2. Decouple notes-validate.ts from hard-coded PARA paths per spec. Branch: agent/p10-validate."
```

Merge Agent A first (provides the config module), then Agent B.

**Batch 2 (3 parallel agents, after Batch 1 merged):**
- **Agent C:** P10-3 (decouple discovery-extract.ts)
- **Agent D:** P10-4 (decouple vault-stats.ts)
- **Agent E:** P10-6 (CLI command)

```bash
# Pane 1
claude --worktree "Read PLAN.md task P10-3. Decouple discovery-extract.ts from PARA paths per spec. Branch: agent/p10-discovery."
# Pane 2
claude --worktree "Read PLAN.md task P10-4. Decouple vault-stats.ts from PARA paths per spec. Branch: agent/p10-stats."
# Pane 3
claude --worktree "Read PLAN.md task P10-6. Add grove config CLI command per spec. Branch: agent/p10-cli."
```

#### Phase 10 Success Criteria

- A user with a Zettelkasten vault connects to Grove. Auto-detection generates a config. Search, discovery, and writes all work.
- Existing PARA vault behavior is 100% unchanged (auto-generated config matches current hard-coded behavior).
- `grove config` shows the current structure. User edits one path, re-runs discovery — entities land in the new location.
- No hard-coded PARA folder paths remain in `notes-validate.ts`, `discovery-extract.ts`, or `vault-stats.ts`.

---

### Phase 11: Note Lifecycle Operations (DELETE/Move) ✅ COMPLETE 2026-04-20

**Goal:** Complete the CRUD surface. Notes can be created, read, updated — but not deleted or moved. This blocks vault reorganization, inbox processing, lifecycle management, and the graph health auto-healer (Phase 13).

**Prerequisites:** Phase 10 (vault-agnostic) — archive path needs to be configurable.

**Key design decisions:**
- Soft delete (archive) by default, hard delete as opt-in
- Fold into existing MCP tools (stays within 6-tool limit)
- Wikilink update on move is critical — a moved note with broken links is worse than no move
- All operations go through the write queue. No new concurrency concerns.

#### P11-1: Delete operation (`src/rest.ts`, `src/vault-ops.ts`) ✅ COMPLETE 2026-04-20 (602bace, 1afdfb8)

**`DELETE /v1/notes/{path}`** — soft delete by default, hard delete with `?hard=true`.

```
DELETE /v1/notes/Inbox/old-idea.md
Authorization: Bearer grove_live_xxx
If-Match: "abc123"  (optional — prevent deleting a note that changed)

→ 200 OK (soft delete — archived)
{
  "action": "archived",
  "original_path": "Inbox/old-idea.md",
  "archive_path": "Archives/Inbox/old-idea.md",
  "commit": "abc789"
}

DELETE /v1/notes/Inbox/old-idea.md?hard=true
→ 200 OK (hard delete — removed from vault)
{
  "action": "deleted",
  "original_path": "Inbox/old-idea.md",
  "commit": "def012"
}

→ 404 Not Found (note doesn't exist)
→ 409 Conflict (If-Match hash mismatch)
→ 403 Forbidden (trail scope violation)
```

**Soft delete behavior:**
1. Read current note content and frontmatter
2. Add `archived_from: <original-path>` and `archived_at: <ISO date>` to frontmatter
3. Move file to `{archive_path}/{original-path}` (preserving directory structure under archives)
4. Git commit: `grove (keyname): archive {path}`
5. Remove from search index (archived notes are not searchable)
6. Update backlinks: notes linking to the archived note keep their wikilinks (they become red links — this is intentional, not broken)

**Hard delete behavior:**
1. Remove file from disk
2. Git commit: `grove (keyname): delete {path}`
3. Remove from search index
4. Backlinks become red links (same as archive)

**Implementation:** Add `handleDeleteNote()` to `src/rest.ts` (same pattern as `handleWriteNote()`). Add `gitRm()` to `src/vault-ops.ts`. Both operations go through `writeQueue.enqueue()`.

**Files:** `src/rest.ts` (add `handleDeleteNote`), `src/vault-ops.ts` (add `gitRm`, `gitMv`), `src/proxy.ts` (add DELETE route), `src/vault-config.ts` (read archive_path)
**Tests:** `test/rest.test.ts` — soft delete moves to archive with frontmatter, hard delete removes file, If-Match conflict returns 409, trail scope enforcement
**Acceptance criteria:**
- `DELETE /v1/notes/path.md` moves note to archive path with `archived_from` frontmatter
- `DELETE /v1/notes/path.md?hard=true` removes file from disk
- Both create git commits with identity
- Archived notes are removed from search index
- Trail-scoped keys can only delete within their allowed paths
- If-Match with wrong hash returns 409

---

#### P11-2: Move operation (`src/rest.ts`, `src/vault-ops.ts`) ✅ COMPLETE 2026-04-20 (602bace)

**`PATCH /v1/notes/{path}`** with `move_to` field — rename/move a note.

```
PATCH /v1/notes/Inbox/taste-graph.md
Authorization: Bearer grove_live_xxx
Content-Type: application/json

{
  "move_to": "Resources/Concepts/taste-graph.md"
}

→ 200 OK
{
  "action": "moved",
  "from": "Inbox/taste-graph.md",
  "to": "Resources/Concepts/taste-graph.md",
  "links_updated": 3,
  "commit": "abc789"
}

→ 404 Not Found (source doesn't exist)
→ 409 Conflict (destination already exists)
→ 403 Forbidden (trail must allow both source and destination paths)
```

**Move behavior:**
1. Validate destination path (same rules as write — no traversal, .md only)
2. Check destination doesn't already exist (409 if it does)
3. Move file via `git mv`
4. Scan vault for wikilinks pointing to the old note (by title, path, and aliases)
5. Update all found wikilinks: `[[Old Name]]` → `[[New Name]]`, `[[old/path|display]]` → `[[new/path|display]]`
6. Git commit all changes: `grove (keyname): move {from} → {to}` (single commit for move + link updates)
7. Reindex both old path (remove) and new path (add)
8. Re-embed the moved note

**Wikilink update scope:**
- Match `[[exact title]]` (case-insensitive)
- Match `[[exact/path]]` and `[[exact/path|display text]]`
- Match aliases declared in the moved note's frontmatter
- Do NOT fuzzy-match partial strings — only exact wikilink matches

**Files:** `src/rest.ts` (add `handleMoveNote`), `src/vault-ops.ts` (add `gitMv`, add `updateWikilinks`), `src/proxy.ts` (add PATCH route)
**Tests:** `test/rest.test.ts` — move updates path, wikilinks in other notes updated, destination exists returns 409, trail scope checked for both paths
**Acceptance criteria:**
- `PATCH /v1/notes/old.md` with `move_to` moves the file
- All exact wikilink matches across the vault are updated in the same commit
- Destination conflict returns 409
- Trail-scoped keys must have access to both source and destination paths
- Response includes count of updated links

---

#### P11-3: MCP integration (`src/server.ts`) ✅ COMPLETE 2026-04-20 (6e30b32)

Fold delete and move into existing MCP tools to stay within the 6-tool limit.

**Option A (recommended):** Add `action` parameter to `write_note`:
- `action: "write"` (default, current behavior)
- `action: "delete"` with `path` — soft delete
- `action: "hard_delete"` with `path` — hard delete
- `action: "move"` with `path` and `move_to`

**Tool schema update:**
```typescript
{
  name: "write_note",
  description: "Create, update, delete, or move notes in the vault.",
  inputSchema: {
    // existing: path, frontmatter, content, if_hash
    action: { type: "string", enum: ["write", "delete", "hard_delete", "move"], default: "write" },
    move_to: { type: "string", description: "Destination path (required when action is 'move')" },
  }
}
```

**Files:** `src/server.ts` (extend write_note tool handler)
**Tests:** `test/server.test.ts` — MCP delete, MCP move, invalid action returns error
**Acceptance criteria:**
- `write_note` with `action: "delete"` calls `handleDeleteNote`
- `write_note` with `action: "move"` calls `handleMoveNote`
- Default action is "write" — all existing behavior unchanged
- Tool description updated to mention delete/move capabilities

---

#### P11-4: CLI commands (`src/cli.ts`) ✅ COMPLETE 2026-04-20 (666dd14, merged 9fbb650)

```bash
grove delete "Inbox/old-idea.md"              # soft delete (archive)
grove delete "Inbox/old-idea.md" --hard --yes  # hard delete (requires --yes)
grove move "Inbox/idea.md" "Resources/Concepts/idea.md"
```

**Files:** `src/cli.ts` (add `delete` and `move` commands)
**Tests:** `test/cli.test.ts` — JSON output schemas for delete/move, --hard requires --yes
**Acceptance criteria:**
- `grove delete path.md --json` returns `{"ok": true, "action": "archived", ...}`
- `grove delete path.md --hard` without `--yes` prints what would happen and exits 1
- `grove move old.md new.md --json` returns `{"ok": true, "action": "moved", "links_updated": N, ...}`

---

#### Phase 11 Execution Strategy

**Batch 1 (2 parallel agents):**
- **Agent A:** P11-1 + P11-2 (REST delete + move operations) — creates the service functions in rest.ts, adds git operations to vault-ops.ts
- **Agent B:** P11-4 (CLI commands) — extends cli.ts only, uses HTTP endpoints

```bash
# Pane 1
claude --worktree "Read PLAN.md tasks P11-1 and P11-2. Implement DELETE and PATCH (move) endpoints per spec. Branch: agent/p11-lifecycle."
# Pane 2
claude --worktree "Read PLAN.md task P11-4. Add grove delete and grove move CLI commands per spec. Branch: agent/p11-cli."
```

Merge Agent A first, then Agent B. Then P11-3 (MCP integration) as a follow-up single agent.

**Batch 2 (1 agent):**
- **Agent C:** P11-3 (MCP integration)

```bash
claude --worktree "Read PLAN.md task P11-3. Extend write_note MCP tool with delete/move actions per spec. Branch: agent/p11-mcp."
```

#### Phase 11 Success Criteria

- `grove delete "Inbox/old-idea.md"` archives the note to configured archive path
- `grove move "Inbox/idea.md" "Resources/Concepts/idea.md"` moves it and updates all wikilinks
- Both show up in git log with clear audit trail
- MCP `write_note` with `action: "delete"` works from Claude.ai
- No note is ever permanently deleted without explicit `--hard` + `--yes` (or `?hard=true`)

---

### Phase 12: Encryption at Rest ✅ COMPLETE 2026-04-20

**Goal:** Vault data is encrypted on disk and in git. Server processes plaintext only in memory. Users trust that Grove operators cannot read their data without the user's passphrase.

**Prerequisites:** None (independent track). But should land before opening to external users.

**Trust story:** "Your vault is encrypted with a passphrase only you know. Without it, the server can't read your notes. Your data on disk, in git, and in backups is ciphertext."

**Architecture:**
```
User provides passphrase → derive vault key (Argon2id) → decrypt master key
Master key (AES-256-GCM) encrypts/decrypts vault files
Plaintext only in memory during request processing
Disk, git repo, S3 backups = ciphertext
Search indexes encrypted at rest (SQLCipher or file-level encryption)
```

**Key design decisions:**
- **Per-vault encryption key** (single key per vault, not per-note)
- **Server-escrowed key** — master key encrypted with user's passphrase-derived key, stored in DB
- **In-memory plaintext** — server decrypts on-the-fly for search/embedding, never persists to disk
- **Passphrase caching** — decrypted master key held in memory for session duration, purged on timeout or restart
- **No recovery** by design — lost passphrase = lost access (optional recovery key for users who want it)

#### P12-1: Encryption module (`src/crypto.ts`) ✅ COMPLETE 2026-04-20 (3b99d80, merged d9b6186)

Core cryptographic operations.

```typescript
// Key derivation
export function deriveKey(passphrase: string, salt: Buffer): Buffer;  // Argon2id → 256-bit key

// Vault key management
export function generateVaultKey(): Buffer;                            // random 256-bit key
export function encryptVaultKey(vaultKey: Buffer, passphrase: string): { encrypted: Buffer; salt: Buffer };
export function decryptVaultKey(encrypted: Buffer, salt: Buffer, passphrase: string): Buffer;

// File encryption/decryption
export function encryptContent(plaintext: string, vaultKey: Buffer): Buffer;  // AES-256-GCM
export function decryptContent(ciphertext: Buffer, vaultKey: Buffer): string;

// Index encryption
export function encryptIndex(indexPath: string, vaultKey: Buffer): void;
export function decryptIndexToMemory(encryptedPath: string, vaultKey: Buffer): Buffer;
```

**Files:** `src/crypto.ts` (new)
**Tests:** `test/crypto.test.ts` — encrypt/decrypt roundtrip, wrong passphrase fails, key derivation is deterministic with same salt
**Acceptance criteria:**
- `encryptContent → decryptContent` roundtrips correctly
- Wrong passphrase throws a clear error (not garbage output)
- Key derivation takes >100ms (Argon2id with appropriate cost parameters — resists brute force)

---

#### P12-2: Vault key lifecycle (`src/db.ts`, `src/proxy.ts`) ✅ COMPLETE 2026-04-20 (3b99d80, 12306be)

Store encrypted vault keys in the database. Manage unlock/lock lifecycle.

**Schema addition:**
```sql
CREATE TABLE IF NOT EXISTS vault_keys (
  vault_id TEXT PRIMARY KEY REFERENCES vaults(id),
  encrypted_key BLOB NOT NULL,     -- AES-256-GCM encrypted vault key
  key_salt BLOB NOT NULL,          -- Argon2id salt
  created_at TEXT NOT NULL,
  last_unlocked_at TEXT
);
```

**In-memory key cache:** `Map<vault_id, { key: Buffer; unlockedAt: Date }>`. Purged after configurable timeout (default 24h) or on process restart.

**API endpoints:**
```
POST /v1/admin/vault/encrypt   — enable encryption (first time: generate vault key, encrypt all files)
POST /v1/admin/vault/unlock    — provide passphrase, decrypt vault key into memory
POST /v1/admin/vault/lock      — purge in-memory key, vault becomes inaccessible
GET  /v1/admin/vault/status    — returns { encrypted: bool, unlocked: bool, last_unlocked_at }
POST /v1/admin/vault/change-passphrase — re-encrypt vault key with new passphrase
```

**Behavior when locked:** All MCP tools and REST endpoints return 503 with `{"error": "vault_locked", "message": "Vault is encrypted and locked. Unlock with your passphrase."}`. Health check still works (reports `vault_locked` status).

**Files:** `src/db.ts` (table), `src/crypto.ts` (key cache), `src/proxy.ts` (new routes + locked middleware)
**Tests:** `test/crypto.test.ts` — full lifecycle: encrypt → lock → unlock → read
**Acceptance criteria:**
- `POST /v1/admin/vault/unlock` with correct passphrase makes vault accessible
- `POST /v1/admin/vault/unlock` with wrong passphrase returns 401
- Locked vault returns 503 on all data endpoints
- Server restart requires re-unlock (key not persisted to disk)

---

#### P12-3: Transparent encryption layer (`src/vault-ops.ts`) ✅ COMPLETE 2026-04-20 (ceec1a3)

Intercept all file reads and writes to encrypt/decrypt transparently.

**Changes to vault-ops.ts:**
1. `readFile()` calls: if vault is encrypted, decrypt after reading from disk
2. `writeFile()` calls: if vault is encrypted, encrypt before writing to disk
3. `gitCommit()`: files on disk are ciphertext, committed as ciphertext
4. `gitPush()`: pushes ciphertext (remote repo is encrypted)
5. `listNotes()`: must decrypt frontmatter to parse (cache parsed frontmatter in memory)

**Performance concern:** Decrypting every file on read adds latency. Mitigate with an in-memory frontmatter cache (populated on startup/unlock, updated on writes). Full content decrypted only when requested.

**Files:** `src/vault-ops.ts` (add encryption hooks), `src/rest.ts` (ensure handleWriteNote encrypts)
**Tests:** `test/vault-ops.test.ts` — write encrypted file, read back decrypted, git log shows ciphertext
**Acceptance criteria:**
- Files on disk are encrypted (not readable with `cat`)
- `git clone` of the vault yields ciphertext
- MCP/REST reads return plaintext (decrypted in memory)
- Writes encrypt before disk write
- Frontmatter cache makes `list_notes` fast despite encryption

---

#### P12-4: Search index encryption (`src/hybrid-search.ts`) ✅ COMPLETE 2026-04-20 (1663e6e, merged 0dad520)

The QMD SQLite index and embedding vectors contain plaintext content. Encrypt them.

**Approach:** Use SQLCipher (encrypted SQLite) for the QMD index. The vault key is the SQLCipher key.

**Changes:**
1. On vault unlock, open QMD index with SQLCipher key
2. On vault lock, close the index
3. Reindex operations write to the encrypted index
4. Embedding vectors stored in encrypted SQLite

**Fallback if SQLCipher is too complex:** Encrypt the index file at rest (file-level encryption). Decrypt into a tmpfs mount on unlock. Re-encrypt on lock. Less elegant but simpler.

**Files:** `src/hybrid-search.ts` (encrypted index opening), `src/embed.ts` (encrypted vector storage)
**Tests:** `test/hybrid-search.test.ts` — search works on encrypted index after unlock, fails when locked
**Acceptance criteria:**
- QMD index file on disk is not readable without the vault key
- Search works normally when vault is unlocked
- Search returns 503 when vault is locked

---

#### P12-5: Passphrase UX (grove-www + CLI) ✅ COMPLETE 2026-04-20 (c4b6337, merged 621a14b)

**CLI:** `grove vault encrypt`, `grove vault unlock`, `grove vault lock`, `grove vault status`

**grove.md:** Unlock screen when vault is locked — passphrase input, unlock button. Shown on any page when the vault is in locked state.

**Files:** `src/cli.ts` (new vault subcommand), grove-www pages
**Acceptance criteria:**
- `grove vault encrypt` prompts for passphrase, encrypts all vault files, stores encrypted key
- `grove vault unlock` prompts for passphrase, unlocks vault
- grove.md shows unlock screen when vault is locked

---

#### Phase 12 Execution Strategy

**Batch 1 (2 parallel agents):**
- **Agent A:** P12-1 + P12-2 (crypto module + key lifecycle) — creates `src/crypto.ts`, adds DB table, API endpoints
- **Agent B:** P12-5 (CLI + UX) — CLI commands and grove-www pages (can stub the crypto calls)

```bash
# Pane 1
claude --worktree "Read PLAN.md tasks P12-1 and P12-2. Build encryption module and vault key lifecycle per spec. Branch: agent/p12-crypto."
# Pane 2
claude --worktree "Read PLAN.md task P12-5. Add vault encrypt/unlock/lock CLI commands per spec. Branch: agent/p12-cli."
```

**Batch 2 (2 parallel agents, after Batch 1):**
- **Agent C:** P12-3 (transparent encryption layer)
- **Agent D:** P12-4 (search index encryption)

```bash
# Pane 1
claude --worktree "Read PLAN.md task P12-3. Add transparent encryption to vault-ops per spec. Branch: agent/p12-vault-encrypt."
# Pane 2
claude --worktree "Read PLAN.md task P12-4. Encrypt search index per spec. Branch: agent/p12-index-encrypt."
```

#### Phase 12 Success Criteria

- `git clone` of an encrypted vault yields unreadable ciphertext
- Server restart requires passphrase to resume serving
- Users see "encrypted" status in grove.md and `grove vault status`
- Search and read operations work transparently when unlocked
- All data endpoints return 503 when locked
- Wrong passphrase returns clear error, never garbage data

---

### Phase 13: Graph Health & Auto-Healing ✅ COMPLETE 2026-04-20

**Goal:** The knowledge graph monitors itself and fixes non-risky issues automatically. Vault owners see a health score with trends. Problems are surfaced before they compound.

**Prerequisites:** Phase 7 (discovery infrastructure), Phase 11 (DELETE/move for auto-healing actions).

**Context:** Current diagnostics (`vault_status diagnostics`) detect orphans, broken links, missing frontmatter, and stale inbox. But they require manual invocation and only report — never fix. Discovery (Phase 7) does entity extraction and link wiring. This phase extends both: deeper metrics stored as time series, automated monitoring via cron, and auto-healing that fixes safe issues without asking.

**Auto-heal boundary (what's "non-risky"):**
- ✅ Fix broken wikilinks when target was renamed (exact fuzzy match)
- ✅ Re-embed notes with stale/missing embeddings
- ✅ Add missing backlinks (wikilink exists but reciprocal doesn't)
- ✅ Infer missing tags via config rules (same as P5-TAG-1)
- ⚠️ Flag (but don't auto-fix) near-duplicate concepts (requires human judgment)
- ⚠️ Flag (but don't auto-fix) long-orphaned notes (may be intentional stubs)
- ❌ Never auto-merge, auto-delete, or auto-restructure

#### P13-1: Health metrics schema (`src/db.ts`, `src/graph-health.ts`) ✅ COMPLETE 2026-04-20 (0fb20ae)

New module and DB table for time-series graph health data.

```sql
CREATE TABLE IF NOT EXISTS graph_health (
  id TEXT PRIMARY KEY,
  measured_at TEXT NOT NULL,
  metrics JSON NOT NULL,          -- full snapshot
  score INTEGER NOT NULL          -- 0-100 composite health score
);

CREATE INDEX idx_health_date ON graph_health(measured_at);
```

**Metrics snapshot:**
```typescript
interface GraphHealthMetrics {
  total_notes: number;
  total_links: number;
  link_density: number;           // links / notes
  orphan_count: number;           // notes with 0 inbound + 0 outbound links
  orphan_rate: number;            // orphan_count / total_notes
  broken_link_count: number;      // wikilinks pointing to non-existent notes
  embedding_coverage: number;     // notes with embeddings / total notes
  stale_embedding_count: number;  // notes modified after last embed
  missing_frontmatter: number;    // notes without required type/tags
  duplicate_candidates: number;   // pairs with similarity > 0.85
  growth_velocity_7d: number;     // notes created in last 7 days
  growth_velocity_30d: number;    // notes created in last 30 days
  avg_links_per_note: number;
  cluster_count: number;          // disconnected components in the graph
  largest_cluster_pct: number;    // % of notes in the largest cluster
}
```

**Composite health score (0-100):**
- Orphan rate < 5% → +20, < 10% → +10
- Broken links = 0 → +20, < 5 → +10
- Embedding coverage > 95% → +20, > 80% → +10
- Link density > 2.0 → +20, > 1.0 → +10
- Growth velocity > 0 (not stagnant) → +10
- Missing frontmatter = 0 → +10, < 10 → +5

**Files:** `src/graph-health.ts` (new — compute metrics, calculate score, store), `src/db.ts` (table)
**Tests:** `test/graph-health.test.ts` — score calculation, metric computation against fixture vault
**Acceptance criteria:**
- `computeHealthMetrics()` returns all fields with correct values
- `calculateHealthScore()` produces 0-100 score matching the rubric
- Metrics stored in DB with timestamp

---

#### P13-2: Automated monitoring (`src/graph-health.ts`) ✅ COMPLETE 2026-04-20 (0fb20ae, 9c24a87, abfdbb0)

Cron-driven health checks that run daily (configurable) and store metrics.

**Implementation:** Add a health check function to the discovery worker's cron schedule (or a new PM2 cron process). Runs `computeHealthMetrics()`, stores snapshot in `graph_health` table, checks for alerts.

**Alert thresholds (configurable):**
- Health score drops > 10 points in 24h
- Orphan rate exceeds 15%
- Broken links exceed 20
- Embedding coverage drops below 80%

**Alert delivery:** Log to structured logger with `level: "warn"`. Optionally send email digest (reuse `src/email.ts`).

**Files:** `src/graph-health.ts` (add `runHealthCheck`, alert logic), PM2 config (cron schedule)
**Tests:** `test/graph-health.test.ts` — alert triggers when thresholds exceeded, no alert on healthy vault
**Acceptance criteria:**
- Health check runs daily via cron
- Metrics stored as time series (queryable for trends)
- Alert fires when health score drops significantly
- No alert on healthy vault (no false positives)

---

#### P13-3: Auto-healing (`src/graph-health.ts`) ✅ COMPLETE 2026-04-20 (5d093ec, ebf2533)

After computing metrics, auto-fix non-risky issues.

**Auto-fix actions (all go through write queue):**
1. **Broken wikilinks:** If `[[Old Name]]` is broken but a note with a similar title exists (renamed), update the link. Only fix exact renames (old title matches an alias on the new note). Log each fix.
2. **Stale embeddings:** Re-embed notes modified after their last embedding timestamp. Fire-and-forget (same as P1-10).
3. **Missing tags:** Run `inferTags()` on notes with zero tags. Write updated frontmatter via write queue.
4. **Missing frontmatter type:** If a note has no `type` but lives in a configured type_path (e.g., `Resources/Concepts/`), infer and add the type.

**Flag-only actions (stored in `graph_health_flags` table):**
```sql
CREATE TABLE IF NOT EXISTS graph_health_flags (
  id TEXT PRIMARY KEY,
  flag_type TEXT NOT NULL,   -- "duplicate_candidate", "long_orphan", "cluster_island"
  source_path TEXT,
  target_path TEXT,          -- for duplicates
  details JSON,
  created_at TEXT NOT NULL,
  resolved_at TEXT           -- user acknowledged/dismissed
);
```

5. **Near-duplicates:** Pairs with embedding similarity > 0.85. Flag for user review.
6. **Long orphans:** Notes with 0 links for > 90 days. Flag for review.
7. **Cluster islands:** Disconnected components with < 3 notes. Flag for review.

**Files:** `src/graph-health.ts` (auto-fix + flag logic), `src/db.ts` (flags table)
**Tests:** `test/graph-health.test.ts` — broken link auto-fixed, stale embedding re-queued, duplicate flagged not auto-merged
**Acceptance criteria:**
- Broken wikilinks to renamed notes are auto-fixed (single commit per batch)
- Stale embeddings are re-queued
- Near-duplicates are flagged, never auto-merged
- All auto-fix actions logged in structured logger
- Flag table stores issues for user review

---

#### P13-4: Health dashboard (`src/proxy.ts`, grove-www) ✅ COMPLETE 2026-04-20 (a21a259, merged 4481795)

**API endpoints:**
```
GET /v1/admin/health/current   — latest health metrics + score
GET /v1/admin/health/history   — time series (last 30 days)
GET /v1/admin/health/flags     — unresolved flags
POST /v1/admin/health/flags/:id/resolve — dismiss a flag
```

**grove-www:** New dashboard page at `/dashboard/health` showing:
- Health score (large number + trend sparkline)
- Metric cards (orphan rate, broken links, embedding coverage, link density)
- Auto-fix log (recent auto-heals with what was fixed)
- Flags list (pending issues to review — dismiss or act)

**Files:** `src/proxy.ts` (new routes), grove-www dashboard page
**Acceptance criteria:**
- `/dashboard/health` shows health score with 30-day trend
- Flags can be dismissed from the UI
- Auto-fix log shows what was automatically repaired

---

#### Phase 13 Execution Strategy

**Batch 1 (2 parallel agents):**
- **Agent A:** P13-1 + P13-2 (metrics + monitoring) — creates `src/graph-health.ts`, DB tables, cron
- **Agent B:** P13-4 API endpoints (REST endpoints for health data)

**Batch 2 (2 parallel agents, after Batch 1):**
- **Agent C:** P13-3 (auto-healing logic)
- **Agent D:** P13-4 frontend (grove-www health dashboard page)

#### Phase 13 Success Criteria

- Vault owner logs into grove.md and sees a health score with trend line
- Broken links to renamed notes auto-fixed overnight
- Near-duplicate concepts flagged for review (not auto-merged)
- Zero manual diagnostics needed for routine maintenance
- Health score visibly improves after auto-healing runs

---

### Phase 14: Image System ✅ COMPLETE 2026-04-20

**Goal:** Images are first-class knowledge graph nodes — uploadable, auto-tagged, searchable, and visually browsable. Supports recipes, travel notes, design work, diagrams, and any visual knowledge.

**Prerequisites:** None (independent track). Phase 10 (vault-agnostic) nice-to-have for configurable image note paths.

**Key design decisions:**
- **External object storage (Cloudflare R2)** — not git-tracked. Keeps vault repo lean. R2 has no egress fees.
- **Companion .md notes** — each image gets a vault note with frontmatter, tags, and an `![]()` embed. The note is the graph node, the image is the asset.
- **Vision auto-tagging** — Claude on upload to extract description, detected concepts, OCR text
- **CDN for serving** — R2 public bucket or Cloudflare CDN for fast image loading
- **Pinterest-style view** — masonry grid in grove.md for visual browsing

#### P14-1: R2 storage setup (`src/image-store.ts`) ✅ COMPLETE 2026-04-20 (b375f12, merged c300490)

Object storage client for image upload, retrieval, and deletion.

```typescript
interface ImageStore {
  upload(key: string, data: Buffer, contentType: string): Promise<{ url: string; size: number }>;
  delete(key: string): Promise<void>;
  getUrl(key: string): string;  // public CDN URL
}
```

**Storage key format:** `{vault_id}/{sha256_hash}.{ext}` — content-addressed, deduped.

**Configuration:** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` env vars. Uses S3-compatible API (Cloudflare R2 is S3-compatible).

**Files:** `src/image-store.ts` (new)
**Tests:** `test/image-store.test.ts` — mock S3 client, verify key format, content-type handling
**Acceptance criteria:**
- Upload returns public URL
- Content-addressed keys prevent duplicates
- Delete removes from storage
- Missing env vars throw clear error on startup

---

#### P14-2: Image upload endpoint (`src/proxy.ts`, `src/rest.ts`) ✅ COMPLETE 2026-04-20 (b375f12, perf fast path 6c346d6)

**`POST /v1/images`** — upload an image, auto-tag it, create a companion vault note.

```
POST /v1/images
Authorization: Bearer grove_live_xxx
Content-Type: multipart/form-data

file: <binary image data>
path: "Resources/Images/architecture-diagram.md"  (optional — auto-generated if omitted)
tags: "ai,architecture"  (optional — supplemental to auto-detected)

→ 201 Created
{
  "image_url": "https://assets.grove.md/{vault_id}/{hash}.png",
  "note_path": "Resources/Images/architecture-diagram.md",
  "content_hash": "abc123",
  "auto_tags": ["diagram", "architecture", "software"],
  "description": "System architecture diagram showing microservices...",
  "ocr_text": "API Gateway → Auth Service → ...",
  "dimensions": { "width": 1920, "height": 1080 }
}

→ 400 Bad Request (unsupported format, too large)
→ 413 Payload Too Large (>10MB)
```

**Upload pipeline:**
1. Validate: file type (PNG, JPG, WebP, GIF), size (<10MB)
2. Upload to R2 (content-addressed key)
3. Generate thumbnail (resize to 400px width, WebP format) → upload to R2 as `{hash}_thumb.webp`
4. Auto-tag via Claude Vision API (claude-haiku-4-5):
   - Description (1-2 sentences)
   - Detected concepts (match against vault entity vocabulary)
   - OCR text (if any text in the image)
   - Suggested tags
5. Create companion vault note:
   ```markdown
   ---
   type: image
   tags: [diagram, architecture, ai]
   image_url: https://assets.grove.md/{vault_id}/{hash}.png
   thumbnail_url: https://assets.grove.md/{vault_id}/{hash}_thumb.webp
   dimensions: {width: 1920, height: 1080}
   ocr_text: "API Gateway → Auth Service → ..."
   uploaded_at: 2026-04-20T12:00:00Z
   ---
   # Architecture Diagram

   System architecture diagram showing microservices...

   ![Architecture Diagram](https://assets.grove.md/{vault_id}/{hash}.png)
   ```
6. Commit + reindex + embed (same pipeline as write_note)
7. Enqueue for discovery (concept extraction from description + OCR)

**Files:** `src/proxy.ts` (new route), `src/rest.ts` (add `handleImageUpload`), `src/image-store.ts` (storage), image processing (sharp or similar for resize)
**Tests:** `test/image-upload.test.ts` — upload creates note + stores image, auto-tagging populates frontmatter, size limit enforced
**Acceptance criteria:**
- Upload PNG → R2 storage + companion vault note created
- Auto-tagging extracts description, concepts, OCR text
- Thumbnail generated at 400px width
- Note searchable by description and OCR text
- Discovery enqueued for concept extraction
- Trail-scoped keys can only upload to allowed paths

---

#### P14-3: Image search integration (`src/hybrid-search.ts`) ✅ COMPLETE 2026-04-20 (88ea1ad, merged 76b3197)

Image notes are already searchable by their text content (description + OCR). Ensure:
1. Image descriptions and OCR text are embedded for vector search
2. `query` results for image notes include `thumbnail_url` in the response
3. `get` on an image note returns full metadata including `image_url`, `thumbnail_url`, `dimensions`

**Files:** `src/hybrid-search.ts` (add thumbnail to results), `src/server.ts` (enrich get response for image notes)
**Tests:** `test/hybrid-search.test.ts` — search for "architecture diagram" finds image note
**Acceptance criteria:**
- `query({searches: [{type: "vec", query: "system architecture"}]})` returns image notes with thumbnail URLs
- `get({file: "path/to/image-note.md"})` returns full image metadata

---

#### P14-4: Pinterest-style image view (grove-www) ✅ COMPLETE 2026-04-20 (7ca40cc, merged fa941a4)

Masonry grid component in grove.md for browsing image notes visually.

**Route:** `/images` (owner) and scoped within trail pages (trail consumers)

**Layout:**
- Masonry grid of image thumbnails (responsive: 2 cols mobile, 3 tablet, 4 desktop)
- Lazy loading with intersection observer
- Click thumbnail → slide-out panel with: full-size image, note title, tags, description, backlinks, related images
- Filter bar: by tag, by date range, by connected concept (e.g., "show images linked to [[Italy Trip]]")
- Sort: newest first (default), most connected, by tag

**Data source:** `GET /v1/list?prefix=&type=image` (list all image notes) + `GET /v1/notes/{path}` for detail

**API addition:** Extend `GET /v1/list` to accept `type` query parameter for filtering by frontmatter type.

**Trail scoping:** Trail consumers see only images within their trail scope (server-side filtering handles this).

**Files:** grove-www — `src/app/images/page.tsx`, `src/components/image-grid.tsx` (client component), `src/components/image-detail.tsx`
**Acceptance criteria:**
- `/images` shows masonry grid of all image thumbnails
- Clicking an image opens detail panel with metadata and backlinks
- Filtering by tag narrows the grid
- Trail-scoped users see only their trail's images
- Grid handles 100+ images without jank (lazy loading + virtualization if needed)

---

#### Phase 14 Execution Strategy

**Batch 1 (2 parallel agents):**
- **Agent A:** P14-1 + P14-2 (R2 storage + upload endpoint) — creates `src/image-store.ts`, upload handler
- **Agent B:** P14-3 (search integration) — extends hybrid-search and server for image metadata

**Batch 2 (1 agent, after Batch 1):**
- **Agent C:** P14-4 (Pinterest view in grove-www)

#### Phase 14 Success Criteria

- Upload a photo via API → auto-tagged note appears in vault → searching "architecture diagram" finds it
- `/images` in grove.md shows a visual grid of all vault images
- Trail consumer sees only their scoped images
- Thumbnails load fast via CDN
- Image notes participate fully in the knowledge graph (backlinks, search, discovery)

---

### Phase 15: Profile & Settings UX ✅ COMPLETE 2026-04-20

**Goal:** Vault owners and trail consumers can manage their identity and settings through grove.md. Owners get a visual trail scope editor. Non-owners see their profile and access.

**Prerequisites:** Phase 9 (multi-user), Phase 4 (dashboard).

**Context:** Phase 4 built the owner dashboard (keys, trails, usage, health). Phase 9 added user roles and invite flow. But the dashboard is owner-only. Trail consumers have no self-service — they can't see their profile, change their email, manage their sessions, or understand what they have access to. Owners also lack a visual trail scope editor (currently: raw JSON fields in a form).

#### P15-1: User profile page (grove-www) ✅ COMPLETE 2026-04-20 (shipped in non-owner merge 01b5ef2; fixes 000abcc, 2bb6a2b)

**Route:** `/profile` — available to all authenticated users (owner + members + viewers).

**Layout:**
- Email (read-only, shows current)
- Display name (editable, stored in users table)
- Active sessions (list with device/browser info, "Sign out" per session, "Sign out all" button)
- API keys (list their own keys, create new ones if role allows)
- Trail access (list trails they have access to, with trail name, description, note count)

**API additions (grove repo):**
```
GET /v1/me                     — current user profile (email, role, trails, keys)
PATCH /v1/me                   — update display name
DELETE /v1/me/sessions/:id     — revoke a specific session
DELETE /v1/me/sessions         — revoke all sessions except current
```

**Files:** `src/proxy.ts` (new routes), `src/users.ts` (add display_name, session listing), grove-www `src/app/profile/page.tsx`
**Tests:** `test/users.test.ts` — profile endpoint returns correct data per role, session revocation works
**Acceptance criteria:**
- All users can view their profile at `/profile`
- Users can update their display name
- Users can see and revoke their own sessions
- Viewers see their trail access list
- Owners see everything (same as before, plus profile)

---

#### P15-2: Visual trail scope editor (grove-www) ✅ COMPLETE 2026-04-20 (d6a105c, merged 68b5a44)

Replace the raw text inputs for trail allow/deny configuration with a visual editor.

**Current state:** Trail create/edit form has text inputs for comma-separated tags and paths. Error-prone, no validation feedback.

**New UX:**
- **Path picker:** tree view of vault folders (fetched via `GET /v1/list`). Click to add to allow/deny. Green = allowed, red = denied, gray = unset.
- **Tag picker:** autocomplete from existing tags in the vault. Chips for selected tags with allow (green) / deny (red) toggle.
- **Type picker:** checkbox grid of known note types.
- **Preview panel:** live count of "N notes match this scope" — updates as filters change. Shows sample note titles.
- **Test mode:** "Would this note be visible?" — enter a note path, shows yes/no with which rule matched.

**API addition:** `GET /v1/admin/trails/:id/preview?allow_tags=...&deny_paths=...` — returns count + sample paths matching the proposed scope.

**Files:** grove-www — `src/components/trail-editor.tsx` (client component), `src/app/dashboard/trails/[id]/page.tsx`, `src/proxy.ts` (preview endpoint)
**Tests:** Trail preview endpoint returns correct counts for filter combinations
**Acceptance criteria:**
- Trail creation uses visual path/tag/type pickers instead of raw text
- Preview shows live note count as scope changes
- Test mode validates specific notes against proposed scope
- Existing trail editing preserves current scope configuration

---

#### P15-3: Non-owner dashboard (grove-www) ✅ COMPLETE 2026-04-20

When a member or viewer signs in, they see a simplified dashboard scoped to their access.

**Layout for non-owners:**
- **Home page:** their trail(s) with note count, last activity, search box scoped to trail
- **Profile:** (P15-1)
- **No access to:** Keys management (except their own), trail management, user management, system health
- **Navigation:** simplified header — trail name, search, profile. No "Dashboard" link.

**Files:** grove-www — `src/app/layout.tsx` (role-based navigation), `src/app/home/page.tsx` (non-owner home)
**Acceptance criteria:**
- Non-owner signs in → sees their trail(s) as the home page
- Navigation shows only relevant items (no admin sections)
- Search is automatically scoped to their trail
- Profile page works for all roles

---

#### Phase 15 Execution Strategy

**Batch 1 (2 parallel agents):**
- **Agent A:** P15-1 backend + frontend (profile page + API endpoints)
- **Agent B:** P15-2 (visual trail editor) — independent of A

**Batch 2 (1 agent, after Batch 1):**
- **Agent C:** P15-3 (non-owner dashboard) — needs profile page from A

#### Phase 15 Success Criteria

- A trail consumer signs in → sees their trail as home → can view profile and manage sessions
- Vault owner creates a trail using the visual editor with live preview → invites a user → user sees scoped experience
- No admin UI exposed to non-owners
- Trail scope editing is intuitive enough that non-technical vault owners can configure it

---

### Phase 16: Multi-Resident URL Structure

**Goal:** Scope every public/shareable surface by resident `@<handle>`. Admin surfaces stay unscoped. Unblock onboarding v2 users without breaking external URLs that already exist.

**Prerequisites:** Phase 9 (user roles + invite flow + user-scoped keys), Phase 15 (profile page), Phase B (magic link auth).

**Context:** Today every route on grove.md is single-tenant — the vault is implicitly "me". Before onboarding any second user, public URLs need a resident prefix so the same note path under different residents can't collide, and so shared links read coherently out of context. Decision locked: `/@<handle>/...` Mastodon/Instagram style, public-surface only (admin paths stay at `/dashboard`, `/profile`, `/keys`), handle derived from email at invite with editable override, permanent legacy fallback via 301.

**Scope decision:** API surface (`/v1/*`) does NOT change — session/API key resolve the user. Public profile is added (`/@<handle>` bare URL renders a profile card). Note-level public/private toggling is OUT OF SCOPE for this phase (everything stays auth-gated; frontmatter `public: true` is future work).

#### P16-1: Handle model & migration (`src/db.ts`, `src/users.ts`, `src/rest.ts`) ✅ COMPLETE 2026-04-21 (44dcc3f)

Add canonical handle support and history table.

**Schema additions in `src/db.ts`:**
```sql
-- users.username already exists; canonicalize as handle
CREATE TABLE IF NOT EXISTS handle_history (
  handle TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  released_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handle_history_user ON handle_history(user_id);
```

**Validation** (`isValidHandle()` helper in `src/users.ts`):
- 1–30 chars
- Lowercase `[a-z0-9_-]` only; must start with `[a-z0-9]`
- Unique across `users.username` and `handle_history.handle`
- Reserved words rejected: `admin`, `api`, `v1`, `login`, `logout`, `signup`, `dashboard`, `profile`, `keys`, `images`, `home`, `trails`, `s`, `u`, `me`, `settings`, `help`, `about`, `docs`, `support`, `privacy`, `terms`, `well-known`, `auth`

**Migration:**
- Backfill each existing user whose `username` is NULL or email-local-form with the email local part (lowercased, invalid chars stripped, collision suffix `<handle>-<3-digit>`)
- One-shot migration note: owner (`user_00000000`) runs `UPDATE users SET username = 'jm' WHERE id = 'user_00000000'` (or chosen handle) before deploy

**API additions:**
- `GET /v1/residents/:handle` — unauthenticated. Returns `{ handle, display_name, bio, public_trail_slugs, note_count }` or 404. Used by public profile page.
- `GET /v1/me` already returns user — augment response with `handle` field.
- `PATCH /v1/me` accepts `handle` field (see P16-5 for editor).
- Add `bio TEXT` column to users (plain-text, max 280 chars) — nullable.

**Files:** `src/db.ts`, `src/users.ts`, `src/rest.ts`, `src/proxy.ts`
**Tests:** `test/users.test.ts` — validation cases (valid, invalid, reserved, collision); `test/handle-history.test.ts` — write on change, block re-use; `test/residents-endpoint.test.ts` — 200 + 404 paths
**Docs:** `docs/api.md` — document `/v1/residents/:handle` and the `handle` field on `/v1/me`
**Acceptance criteria:**
- `isValidHandle()` accepts `jm`, `j-doe`, `j_doe_2`; rejects `admin`, `J`, `Jsmith`, `1abc`, `j@m`, 31-char string
- New users via invite get auto-derived handle; collision → `<handle>-NNN`
- `GET /v1/residents/jm` returns resident data; `GET /v1/residents/nonexistent` → 404
- `GET /v1/me` response includes `handle` (and `bio` if set)
- Old handles in `handle_history` block reclamation by anyone else

#### P16-2: Scoped route scaffold (grove-www: `src/app/(resident)/[atHandle]/*`) ✅ COMPLETE 2026-04-21 (grove-www 0841bac)

Next.js App Router reserves `@folder` for parallel routes, so a literal `@` in a route segment must be captured by a dynamic segment. Use a route group.

**New file structure:**
```
grove-www/src/app/(resident)/[atHandle]/
  layout.tsx                  validates @-prefix, resolves handle, sets resident context
  page.tsx                    public profile card
  s/[id]/page.tsx             scoped share viewer
  trails/[slug]/page.tsx      scoped trail page
  [...path]/page.tsx          auth-gated note viewer
```

`layout.tsx` behavior:
- `params.atHandle` must start with `@`; strip prefix; fetch `GET /v1/residents/<handle>`
- If 404 → `notFound()`
- If handle is in `handle_history` → `redirect('/@<current-handle>/<rest-of-path>')`
- Pass resident context to children via server component props or `headers()` helper

**Files:** the files above, plus `grove-www/src/lib/resident-context.ts` for a small helper that resolves handle from route params
**Tests:** `grove-www/test/scoped-routes.spec.ts` — Playwright: render each page variant, signed-in and signed-out states; assert resident context shows in header
**Acceptance criteria:**
- `grove.md/@jm` (signed out) → renders public profile with display name, bio, public trails, note count, sign-in CTA
- `grove.md/@jm/s/<id>` → share viewer (same content as current `/s/<id>`)
- `grove.md/@jm/trails/<slug>` → trail viewer (same as current `/trails/<slug>`)
- `grove.md/@jm/some/note-path` signed-out → sign-in prompt
- `grove.md/@jm/some/note-path` signed-in with access → note renders
- `grove.md/@nonexistent` → 404 page
- Layout shows `@jm` in header chip as resident context

#### P16-3: Legacy URL redirects (page-level, grove-www) ✅ COMPLETE 2026-04-21 (grove-www a166d99)

No middleware. Each legacy page becomes a 301 shim to the canonical scoped URL.

**Changes:**
- `grove-www/src/app/s/[id]/page.tsx` — fetch share link, resolve owner's handle, `permanentRedirect('/@<handle>/s/<id>')`
- `grove-www/src/app/trails/[slug]/page.tsx` — fetch trail, resolve owner's handle, `permanentRedirect('/@<handle>/trails/<slug>')`
- `grove-www/src/app/[...path]/page.tsx` — existing note viewer. Signed-in users: resolve own handle, `redirect('/@<handle>/<path>')`. Signed-out: keep current 404 behavior.
- Handle-history redirect — handled by P16-2 layout (`/@old` → 301 `/@current`).

**Files:** `grove-www/src/app/s/[id]/page.tsx`, `src/app/trails/[slug]/page.tsx`, `src/app/[...path]/page.tsx`
**Tests:** `grove-www/test/legacy-redirects.spec.ts` — hit each legacy path, assert 301 + correct `Location` header
**Acceptance criteria:**
- `curl -I grove.md/s/abc123` → `301`, `Location: /@jm/s/abc123`
- `curl -I grove.md/trails/weekly-reads` → 301 → `/@jm/trails/weekly-reads`
- Signed-in user hitting `grove.md/concepts/taste-graph` → 301 → `/@jm/concepts/taste-graph`
- Signed-out on legacy unscoped note path → 404 (unchanged)
- `curl -I grove.md/@old-jm/anything` → 301 → `/@jm/anything`

#### P16-4: URL builders in grove repo (`src/share.ts`, `src/rest.ts`, `src/invite.ts`, `src/email.ts`) ✅ COMPLETE 2026-04-21 (7e62ce4)

Every server-side URL builder emits canonical `@handle` URLs.

**Changes:**
- `src/share.ts:54-55` — resolve `ownerHandle = getUserHandle(createdBy)`; `return \`${wwwBase}/@${ownerHandle}/s/${id}\``
- `src/rest.ts:54` — note URL: `return \`${wwwBase}/@${handle}/${encoded}\``; resolve handle from session user or key owner
- `src/rest.ts:692` — search result URL, same pattern
- `src/invite.ts:90-97` — callback URL: `${wwwBase}/auth/callback?code=<code>&trail=<id>&resident=<owner-handle>`
- `src/email.ts:13` invite template — subject `@${ownerHandle} invited you to Grove`; body `${displayName} (@${ownerHandle}) shared the '${trailName}' trail with you. [Sign in]`

**Files:** `src/share.ts`, `src/rest.ts`, `src/invite.ts`, `src/email.ts`
**Tests:** update `test/share.test.ts`, `test/invite.test.ts`, `test/rest.test.ts` to assert new URL shapes
**Docs:** `docs/api.md` — note every URL builder emits `@handle` form
**Acceptance criteria:**
- Creating a share link returns `{ url: "https://grove.md/@jm/s/abc123" }`
- Invite callback URL embeds `resident=<handle>` context
- Invite email subject contains `@<handle>`
- No server-generated URL emits the legacy unscoped shape

#### P16-5: Handle editor in profile (`grove-www/src/app/profile/page.tsx`, `src/rest.ts`) ✅ COMPLETE 2026-04-21

Extend the profile page with handle change UX.

**Frontend UX:**
- New "Handle" field above display name
- Input with live validation (length, chars, availability via debounced `GET /v1/residents/:handle` — 200 = taken, 404 = available)
- Preview string: `Your URL: grove.md/@<handle>` updates as user types
- Save → `PATCH /v1/me { handle }` → on success, show "Old URL redirects: `grove.md/@<old>` → `grove.md/@<new>`"
- Error states: validation failure, taken, reserved, server error

**Backend `PATCH /v1/me`:**
- Accept `handle` and `bio` fields
- If `handle` changed: run `isValidHandle()`; insert old `users.username` into `handle_history(released_at=now)`; update `users.username`
- Emit audit log entry `{ action: "handle_change", user_id, old_handle, new_handle }`

**Files:** `grove-www/src/app/profile/page.tsx`, `grove-www/src/components/handle-editor.tsx` (new client component), `src/rest.ts`, `src/users.ts` (changeHandle helper)
**Tests:** `test/profile-handle-change.test.ts` — change handle → row in handle_history → old URL 301s via P16-3 redirect; reserved handle rejected; collision rejected
**Acceptance criteria:**
- User changes handle from `/profile`; UI reflects new URL immediately
- Invalid/taken/reserved handles show inline errors with specific messages
- After change, old handle 301-redirects to new (verified by integration test in P16-6)
- Old handle cannot be reclaimed by another user
- Audit log shows handle_change event

#### P16-6: End-to-end integration test (`grove-www/test/multi-resident.e2e.spec.ts`) ✅ COMPLETE 2026-04-21 (grove-www e4cae65)

Playwright spec covering the golden path:
1. Signed-out visitor lands on `/@jm` → sees public profile card
2. Signed-out visitor hits `/s/abc` (legacy) → 301 to `/@jm/s/abc` → share viewer loads
3. Trail invitee receives email containing `@jm` → clicks link → lands in `/home` with trail context `@jm · Weekly Reads`
4. Owner changes handle from `/profile` → legacy URLs still 301-redirect correctly via handle history
5. `grove.md/@nonexistent` → 404 page

**Acceptance criteria:**
- All five flows pass in a single test run against a seeded fixture

#### Phase 16 Design Decisions

| Decision | Chosen | Alternatives | Why |
|----------|--------|-------------|-----|
| URL shape | `/@<handle>/...` | `/u/<handle>/`, bare `/<handle>/`, subdomain | No collision with existing catch-all routes. No reserved-word list for routing. Reads visually as a handle. Subdomain adds TLS + cross-subdomain cookie complexity for a low-tenant product. |
| Scope | Public surfaces only | Everything including admin | Admin is personal ("my dashboard"). Content is resident. Keeps owner's everyday URLs short. |
| Handle source | Email local-part at invite, editable | User picks on first login, admin assigns | Minimal friction. Editable later if default is ugly. |
| Legacy URLs | 301 redirect forever | 410 after grace period, dual routing | External bookmarks must not break. Canonical URL becomes unambiguous. |
| Handle reuse | Historic handles never reclaimable | Released after N days | Prevents impersonation. Acceptable namespace cost at this user count. |
| Public profile default | Renders card for signed-out | Auth gate always, redirect | Matches mental model "send someone your grove.md link". |
| Note visibility | Auth-gated by default | Public-by-default, trails-only | Existing notes weren't written for public consumption. Per-note opt-in is future work. |
| API surface | Unchanged | `/v1/@<handle>/...` | Handle is a UI concern. Preserves MCP, CLI, third-party integrations. |
| Route implementation | Route group `(resident)/[atHandle]` | Folder named `@[handle]` | `@folder` is reserved for App Router parallel routes; conflicts. |
| Redirect mechanism | Page-level (`redirect()` in shim pages) | `middleware.ts` | Simpler, avoids per-request DB lookup for every route, no new middleware surface. |

#### Phase 16 Execution Strategy

**Batch 1 (solo, foundational):**
- **Agent A:** P16-1 — DB + validation + `/v1/residents/:handle` + migration. Foundation for every downstream task.

**Batch 2 (2 parallel, after Batch 1 merged):**
- **Agent B:** P16-2 — scoped route scaffold (grove-www, new directory tree)
- **Agent C:** P16-4 — URL builders in grove repo (different repo, no overlap with B)

**Batch 3 (2 parallel, after Batch 2 merged):**
- **Agent D:** P16-3 — legacy URL redirect shims (grove-www shim pages)
- **Agent E:** P16-5 — handle editor (grove-www profile + `PATCH /v1/me` in grove)

**Batch 4 (solo, after all above):**
- **Agent F:** P16-6 — e2e integration test

```bash
./scripts/run-batch.sh p16-1   # agent A
./scripts/run-batch.sh p16-2   # agents B + C
./scripts/run-batch.sh p16-3   # agents D + E
./scripts/run-batch.sh p16-4   # agent F
```

#### Phase 16 Success Criteria

- Signed-out visitor hits `grove.md/@jm` → sees public profile card
- Existing share URL `grove.md/s/abc123` still works via 301 → `/@jm/s/abc123`
- Invited user's email names the resident and trail
- Changing handle from `/profile` → old URL 301s to new; old handle never reclaimable
- External-indexed URLs (search engines, shared links, bookmarks) remain resolvable
- MCP/CLI/third-party clients unaffected (`/v1/*` unchanged)

---

### Phase 17: Post-Login Redirect

**Goal:** Owners land at `/dashboard` after magic-link auth. Trail users land at `/home`. Marketing root redirects signed-in visitors to their app home.

**Prerequisites:** Phase B (magic link auth), Phase 9 (roles), Phase 4 (dashboard), Phase 15 (`/home` for non-owners).

**Context:** Current callback logic (`grove-www/src/app/api/auth/callback/route.ts:62-64`) redirects to `/home` only when a `trail=` query param exists, otherwise drops the user at `/` (marketing root). Owners completing magic-link auth therefore land on the public landing page — clearly wrong. Fixing this unblocks UX polish across several surfaces (invited trail users seeing correct context, signed-in users not re-seeing marketing copy).

#### P17-1: Callback redirect by role (`grove-www/src/app/api/auth/callback/route.ts`) ✅ COMPLETE 2026-04-21 (grove-www 4cbb169)

**Change:** After session + key creation succeed, call `GET /v1/whoami` once. Route by role: owner → `/dashboard`, member/viewer → `/home`. Honor `?redirect=<path>` from the original sign-in request when present; validate as same-origin relative path (`path.startsWith('/')` and not starting with `//`), reject external.

Remove the existing `trailId ? "/home" : "/"` branch at lines 62-64.

**Files:** `grove-www/src/app/api/auth/callback/route.ts`, `grove-www/src/lib/role.ts` (reuse existing `roleFromWhoami`)
**Tests:** `grove-www/test/auth-callback.spec.ts` — owner branch, trail-user branch, explicit `?redirect=/foo`, rejected `?redirect=//evil.com`, rejected `?redirect=https://evil.com`
**Acceptance criteria:**
- Owner magic-link → `/dashboard`
- Trail invitee magic-link → `/home`
- `?redirect=/profile` → respected
- `?redirect=//evil.com` → rejected; falls back to role default
- `?redirect=/foo?q=bar` → preserved

#### P17-2: Marketing root auth-aware (`grove-www/src/app/page.tsx`) ✅ COMPLETE 2026-04-21 (grove-www 4cbb169)

**Change:** Convert `/` to a server component (or wrap existing in server shell). Read `grove_token` cookie; if valid, call `/v1/whoami`; `redirect()` to `/dashboard` (owner) or `/home` (trail user). If no session or 401, render the current marketing page unchanged.

**Files:** `grove-www/src/app/page.tsx`
**Tests:** `grove-www/test/marketing-root.spec.ts` — three states (signed-in owner, signed-in trail, signed-out); invalid cookie treated as signed-out
**Acceptance criteria:**
- Signed-in owner hitting `/` → `/dashboard`
- Signed-in trail user hitting `/` → `/home`
- Signed-out user hitting `/` → renders marketing page
- Invalid/expired cookie → treated as signed-out, marketing renders

#### P17-3: /login short-circuit (`grove-www/src/app/login/page.tsx`) ✅ COMPLETE 2026-04-21 (grove-www 4cbb169)

**Change:** Before rendering the login form, server-side check for active session; if present, redirect to app home based on role. `?redirect=` override respected.

**Files:** `grove-www/src/app/login/page.tsx`
**Tests:** `grove-www/test/login-short-circuit.spec.ts`
**Acceptance criteria:**
- Signed-in user hitting `/login` → redirected to `/dashboard` or `/home`
- Signed-in user hitting `/login?redirect=/profile` → `/profile`
- Signed-out user hitting `/login` → renders login form (unchanged)

#### P17-4: End-to-end success test (`grove-www/test/post-login.e2e.spec.ts`) ✅ COMPLETE 2026-04-21 (grove-www 4cbb169)

Integration test: full magic-link round-trip for both roles. Simulates clicking a magic link from email, asserts correct landing destination, no extra navigation round-trips beyond the callback.

**Acceptance criteria:**
- Owner full flow: request magic link → click → lands at `/dashboard` (one redirect max)
- Trail user full flow: invite email → click → lands at `/home` with trail context
- `?redirect=` respected through the full flow

#### Phase 17 Execution Strategy

**Single agent, sequential tasks.** All four tasks are small changes to adjacent files in grove-www. One agent does the full phase.

```bash
./scripts/run-batch.sh p17
```

#### Phase 17 Design Decisions

| Decision | Chosen | Alternatives | Why |
|----------|--------|-------------|-----|
| Redirect location | Callback + marketing root + /login | Callback only | Marketing root redirect matches GitHub/Vercel/Linear; prevents signed-in users from seeing marketing copy. |
| `?redirect=` validation | Same-origin relative path only | Allowlist, no validation | Prevents open-redirect; simple rule to reason about. |
| Role detection | `GET /v1/whoami` on each entry | JWT claim in cookie | Role already fetched via whoami elsewhere; reuse the existing helper. One extra server-side call is acceptable. |

#### Phase 17 Success Criteria

- Owner signs in via magic link → lands at `/dashboard`
- Trail invitee signs in → lands at `/home` with trail context visible
- Signed-in user hitting `/` or `/login` is redirected to app home
- `?redirect=` is respected when same-origin; rejected when external

---

### Phase 18: Mobile-Optimized Pages

**Goal:** Every page in grove-www renders without horizontal scroll at 375px (iPhone SE). Fix known hot spots. Add Playwright regression guard.

**Prerequisites:** None. Independent of P16/P17 — can run concurrently.

**Context:** Audit identified no explicit viewport meta tag in the root layout, plus five concrete hot spots (`/dashboard/usage` fixed grid-cols-3, `note-view` inline `max-width: 680`, code block wrapping in prose, Mermaid containers, some tables). Good responsive patterns exist (sidebar drawer, header collapse, image grid) — mobile is a gap, not a rewrite.

#### P18-1: Viewport meta + global safety net (`grove-www/src/app/layout.tsx`, `grove-www/src/app/globals.css`) ✅

**Change:** Add `viewport` export via Next.js Metadata API; add `html, body { overflow-x: hidden; }` in globals.css so a single errant component cannot create page-wide horizontal scroll.

```tsx
// layout.tsx
import type { Viewport } from "next";
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};
```

```css
/* globals.css */
html, body { overflow-x: hidden; }
```

**Files:** `grove-www/src/app/layout.tsx`, `grove-www/src/app/globals.css`
**Acceptance criteria:**
- `<meta name="viewport" content="width=device-width, initial-scale=1">` present in every page's `<head>`
- `document.body.scrollLeft === 0` on initial load for all tested pages
- No layout regression on desktop (1440px viewport identical to before)

#### P18-2: Fix identified hot spots ✅

**Changes:**
- `grove-www/src/app/dashboard/usage/page.tsx:96,204` — `grid grid-cols-3` → `grid grid-cols-1 sm:grid-cols-3`
- `grove-www/src/components/note-view.tsx:69` — remove inline `style={{ maxWidth: 680 }}`; add `className="max-w-[680px] w-full"`
- `grove-www/src/app/globals.css:274` `.note-content .prose pre` — ensure wrapper has `max-width: 100%`; keep `overflow-x: auto` scoped inside note column; add `word-break: break-word` on inline code/long-string wrappers
- `grove-www/src/components/mermaid-block.tsx:48-52` — wrapper class `max-w-full overflow-x-auto`; inner SVG `max-w-full h-auto`

**Files:** as above
**Tests:** assertions consolidated in P18-3 test
**Acceptance criteria:**
- `/dashboard/usage` at 375px shows 1-column grid (not 3)
- Note viewer fits within 375px viewport
- Code blocks wrap or scroll internally, no page-wide horizontal scroll
- Mermaid diagrams do not force page scroll

#### P18-3: Playwright regression test (`grove-www/test/mobile.spec.ts` — new) ✅

**Changes:** New Playwright spec. Viewport 375×667. Visits representative routes signed-in as test owner; asserts `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1` (1px tolerance). Seeded test session via fixtures.

**Routes tested:**
- `/` (marketing, signed-out)
- `/login`
- `/dashboard` (owner)
- `/home` (trail user, separate fixture)
- `/profile`
- `/dashboard/usage`
- `/dashboard/trails`
- `/dashboard/keys`
- `/dashboard/users`
- `/dashboard/health`
- `/images`
- `/[...path]` sample note

**npm script:** `"test:mobile": "playwright test test/mobile.spec.ts"`

**Files:** `grove-www/test/mobile.spec.ts`, `grove-www/package.json`, `grove-www/playwright.config.ts` (if not already present)
**Acceptance criteria:**
- `npm run test:mobile` exits 0 for all listed routes
- Failure output names the route and reports `scrollWidth` vs `clientWidth`

#### P18-4: Full mobile audit pass ✅

**Change:** Run dev server, walk every route at 375px (devtools emulation), catalog and fix any additional issues found.

**Acceptance criteria:**
- `npm run test:mobile` stays green after audit (no newly discovered issues)
- Any additional fixes committed in the same PR

#### P18-5: Documentation (`grove-www/README.md`) ✅

Short note: mobile baseline is 375px; `npm run test:mobile` is the regression guard; new pages must pass the test before merge.

**Acceptance criteria:**
- README documents the 375px baseline and the test script

#### Phase 18 Execution Strategy

**Single agent, sequential tasks.** All changes are in grove-www CSS/layout, low risk.

```bash
./scripts/run-batch.sh p18
```

#### Phase 18 Design Decisions

| Decision | Chosen | Alternatives | Why |
|----------|--------|-------------|-----|
| Baseline viewport | 375px (iPhone SE) | 390px, 360px | Covers iPhone SE and 99% of modern phones; matches Tailwind `sm:` convention. |
| Safety net | `html, body { overflow-x: hidden }` | No global | Defense-in-depth against future overflow bugs; cheap. |
| Regression guard | Playwright via `npm run test:mobile` | Visual regression, no test | Scroll-width check is deterministic and fast. |
| CI integration | Deferred to P4-PREREQ | Ship CI hook now | No CI exists yet; wire `test:mobile` into the pipeline when CI lands. |

#### Phase 18 Success Criteria

- Zero horizontal scroll at 375px on every current page
- `npm run test:mobile` green
- Future pages that break mobile fail the test
- CI hook deferred to P4-PREREQ (add `test:mobile` to pipeline when CI/CD lands)

---

### Phase 19: Note Share UI

**Goal:** Owner can create, copy, and manage share-a-note links from the web reader — closing the owner-journey loop (no more terminal-hop to share from the web). Adds a create-modal on the note-view and a `/dashboard/shares` management page, plus the missing list/revoke HTTP endpoints.

**Prerequisites:** Phase 9 (P9-7 share-a-note backend, P9-1 adminAuth), Phase 16 (multi-resident URLs — share URLs already use `/@<handle>/s/<id>` shape), Phase 18 (mobile regression test — P19 UI passes `npm run test:mobile`).

**Context:** Share-a-note backend (`POST /v1/admin/share`) + CLI (`grove share <path>`) exist. grove-www has no Share button — to share from web, the owner must switch to a terminal. `listShareLinks` / `deleteShareLink` are DB helpers only; no HTTP endpoints.

**Scope decisions:**
- Owner-only (button hidden for non-owners, not disabled — backend is already owner-only via `adminAuth`)
- Presets only for v1 (TTL: 24h/7d/30d · Max views: 10/100/Unlimited). No Custom inputs.
- Single dashboard list with muted expired rows (no Active/Expired tabs — premature IA at expected <20 shares/year)
- Soft revoke with `revoked_by` + `revoked_at` audit columns
- 410 Gone (vs 404) on expired/revoked public URLs with branded page
- Out of scope: Web Share API native sheet, bulk revoke, share-view notifications, `last_accessed_at` beyond the column itself (no UI for "last viewed" in v1 — just the column for future use)

#### P19-1: Schema migration + share.ts extensions (`src/db.ts`, `src/share.ts`) ✅ COMPLETE 2026-04-21 (abf963c)

SQLite can't ALTER a column to nullable in place — table rebuild required. Migration is idempotent (schema check before rebuild).

**Schema changes** (via transactional table rebuild):
```sql
-- shared_links_new with:
--   max_views INTEGER       (nullable; NULL = unlimited)
--   last_accessed_at TEXT   (new; updated on each resolveShareLink)
--   revoked_by TEXT REFERENCES users(id)  (new; null = not revoked)
--   revoked_at TEXT         (new; null = not revoked)
```

**`src/share.ts` extensions:**
- `createShareLink(notePath, createdBy, baseUrl, opts?: { ttl_days?, max_views?: number | null })` — `null` means unlimited
- `listShareLinks(userId, opts?: { note_path?, include_expired? })` — optional filters
- `revokeShareLink(id, revokedBy): boolean` — new; sets `expires_at = now()`, `revoked_by`, `revoked_at`
- `resolveShareLink(id)` — update: check `view_count < max_views OR max_views IS NULL`; UPDATE `last_accessed_at = now()` on successful resolve

**Files:** `src/db.ts`, `src/share.ts`, `test/db-migration.test.ts` (new), `test/share.test.ts`
**Tests:**
- Migration idempotent (runs twice safely)
- Existing rows (`max_views = 100`) preserved through rebuild
- `createShareLink({ max_views: null })` stores NULL; `resolveShareLink` never view-caps
- `last_accessed_at` updates on each resolve
- `revokeShareLink` sets both audit columns; subsequent resolve fails
- `listShareLinks` filters by `note_path` + `include_expired` correctly

**Acceptance criteria:**
- All four new/changed columns present and nullable as spec'd
- Foreign-key integrity preserved (`PRAGMA foreign_key_check` passes)
- Migration guarded by schema-version check — running twice is a no-op

#### P19-2: Backend endpoints + rate limits + 410 (`src/proxy.ts`, `src/rate-limit.ts`, `docs/api.md`) ✅ COMPLETE 2026-04-21 (b2a0564)

**New endpoints:**
- `GET /v1/admin/share?note_path=<path>&include_expired=<bool>&cursor=<id>&limit=<n>` — list with optional filters. Response shape:
  ```json
  {
    "shares": [{ "id", "note_path", "url", "created_by", "created_at", "expires_at",
                 "max_views", "view_count", "last_accessed_at", "revoked_by", "revoked_at",
                 "status": "active" | "expired" | "revoked" }],
    "next_cursor": null
  }
  ```
  `status` derived server-side: `revoked` if `revoked_at` set; `expired` if past TTL or view-capped; else `active`. Pagination plumbed but not required in v1 client.
- `DELETE /v1/admin/share/:id` — soft revoke. 404 unknown, 409 already revoked, 200 `{ id, revoked_at, revoked_by }` on success.

**POST extension:** accept `max_views: null` meaning unlimited. No other behavior change.

**410 Gone on public resolve:** `GET /v1/share/:id` currently 404s on expired. New behavior:
- Share doesn't exist → 404
- Expired (TTL or view cap) or revoked → 410 Gone (with reason in body)

**Rate limits:**
- `POST /v1/admin/share`: 20 per hour per owner key
- Public `GET /v1/share/:id`: 60 per minute per IP (in-memory token bucket; single-process server)

**Files:** `src/proxy.ts`, `src/rate-limit.ts` (new or extend existing), `test/rest.test.ts`, `test/rate-limit.test.ts`, `docs/api.md`
**Tests:** list returns correct shape + derived `status`; filter and `include_expired` honored; DELETE soft-revokes + 409 on double-revoke; POST with `max_views: null` stored as NULL; mint beyond 20/hr → 429; view beyond 60/min → 429; expired and revoked URLs return 410
**Acceptance criteria:**
- All three new/changed endpoints behave per spec
- Rate limits fire with 429 (not 500)
- `docs/api.md` documents new routes + response shapes
- Non-owner hitting admin endpoints gets 403 (`adminAuth` unchanged)

#### P19-3: grove-www proxy routes + CSRF (grove-www repo) ✅ COMPLETE 2026-04-21 (multi-commit)

Thin pass-throughs from grove-www to grove. Same pattern as existing `/api/admin/*` routes.

**Files:**
- `grove-www/src/app/api/admin/share/route.ts` — `GET` (new) + `POST` (exists? extend if present, add if not)
- `grove-www/src/app/api/admin/share/[id]/route.ts` — `DELETE` (new)
- `grove-www/src/lib/csrf.ts` — Origin-header check helper (new, or extend if present)

**CSRF on mutating routes** (`POST`, `DELETE`): reject if `Origin` header doesn't match request host. Verify session cookie uses `SameSite=Strict` (if not, fix in same PR).

**Tests:** `test/api-share-proxy.spec.ts` — cross-origin DELETE rejected; same-origin DELETE succeeds; Bearer token forwarded from session; grove error bodies pass through with status preserved
**Acceptance criteria:**
- Mutating routes reject cross-origin requests with 403
- Non-mutating GET works cross-origin (read-only, no CSRF concern)
- Session cookie `SameSite=Strict` verified

#### P19-4: Share button + modal on note-view (grove-www repo) ✅ COMPLETE 2026-04-21 (multi-commit)

**Files:**
- `grove-www/src/components/note-view.tsx` — render owner-only Share button in header flex row (role passed as prop)
- `grove-www/src/app/(resident)/[atHandle]/[...path]/page.tsx` — pass `role` prop (already fetched via `/v1/whoami`)
- `grove-www/src/components/share-button.tsx` (new, client) — imports `ShareModal` via `next/dynamic({ ssr: false })`
- `grove-www/src/components/share-modal.tsx` (new, client) — states: form → loading → success | error
- `grove-www/test/share-modal.spec.ts` (new) — Playwright

**Modal form:**
- TTL dropdown: 24 hours / 7 days / 30 days (default 7d)
- Max views dropdown: 10 / 100 / Unlimited (default 100, Unlimited sends `{ max_views: null }`)
- URL preview (grayed): `Your URL: grove.md/@<handle>/s/…`
- [Cancel] [Generate]

**On Generate:**
- Loading state, disable inputs
- `POST /api/admin/share` with body
- On 200: attempt `navigator.clipboard.writeText(url)`
  - Success → success state: `✓ Link created · Copied to clipboard` with `aria-live="polite"` announcement, URL + Copy-again, `Expires in 7 days · 0/100 views`, [Done] [Manage all shares →]
  - Clipboard reject → same success state, but `⚠ Couldn't copy — select and copy manually` with URL in readonly auto-selected input
- On error: inline "Couldn't create link. Try again." with error details if useful

**Responsive layout (one component, Tailwind classes):**
- `<640px`: bottom sheet — `fixed inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl`
- `≥640px`: centered — `sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:max-w-[420px] sm:rounded-lg`

**Accessibility:**
- `role="dialog"`, `aria-modal="true"`, `aria-labelledby`
- Focus trap while open; Esc closes; backdrop click closes
- Focus moves to first input on open, to [Done] button on success state
- Copy confirmation announced via `aria-live="polite"` region

**Tests:** desktop + mobile viewport render; generate happy path; clipboard failure fallback renders selected input; keyboard nav (Tab cycles within modal); Esc closes; focus returns to Share button on close
**Acceptance criteria:**
- Button renders only when `role === 'owner'`
- Mobile: icon-only; Desktop: icon + "Share" label
- Modal layout correct at 375px (no horizontal scroll; passes `npm run test:mobile`)
- `next/dynamic({ ssr: false })` — modal code not in initial page JS
- All accessibility criteria pass axe scan

#### P19-5: Dashboard shares page (grove-www repo) ✅ COMPLETE 2026-04-21 (multi-commit)

**Files:**
- `grove-www/src/app/dashboard/shares/page.tsx` (new, server) — fetch + render
- `grove-www/src/components/shares-table.tsx` (new, client) — interactive table
- `grove-www/src/app/dashboard/layout.tsx` — add "Shares" nav item (owner-only)
- `grove-www/test/dashboard-shares.spec.ts` (new) — Playwright

**Page layout:**
- Header: `## Shares` + active count
- Search input (client-side filter by note_path)
- Single table, columns: **Note** (path, links to canonical URL) · **Link** (short id + Copy) · **Status** (badge, muted for non-active) · **Created** (relative) · **Expires/Expired** (relative) · **Views** (`3/100` or `3 / ∞`) · **Actions** (Active: [Copy][Revoke]; non-active: [Copy URL] only)
- Sort by `created_at` desc default; column-header click toggles sort
- Empty state: one-line `No shares yet. Open any note and click Share in its header.`

**Data:**
- Server fetch `GET /v1/admin/share?include_expired=true&limit=100` on page load
- Revoke: inline confirm → `DELETE /api/admin/share/:id` → optimistic row update → rollback + toast on failure
- Copy: `navigator.clipboard.writeText` with 2s "Copied!" feedback (match `components/key-table.tsx` pattern)

**Tests:** empty state at zero shares; search filters; sort toggles; copy; revoke optimistic update + rollback on forced failure; expired rows render muted; `npm run test:mobile` passes on `/dashboard/shares` at 375px
**Acceptance criteria:**
- "Shares" nav item visible only to owner
- Empty / populated / mixed states render correctly
- Revoke moves row to muted state immediately; persists after refresh
- Mobile passes 375px regression test

#### P19-6: Expired-link recipient page + tests (grove-www repo) ✅ COMPLETE 2026-04-21 (multi-commit)

**File:** `grove-www/src/app/(resident)/[atHandle]/s/[id]/page.tsx` (existing — update)

On 410 response from `GET /v1/share/:id`:
- Render "This link has expired" page
- Distinguish subtly: expired-by-TTL ("This link expired on `<date>`") vs revoked ("This link was revoked")
- Metadata: `title: "Expired link · Grove"`, `robots: noindex`
- Include a link back to `/@<handle>` (public profile)

On 404: existing not-found behavior (no change).

**Tests:** `grove-www/test/share-expired.spec.ts` — expired URL renders expired page + returns 410 status; revoked URL renders revoked variant; 404 unchanged
**Acceptance criteria:**
- 410 rendered with friendly copy distinguishing expired vs revoked
- `noindex` metadata present
- HTTP status code is 410 (not 200)

#### Phase 19 Design Decisions

| Decision | Chosen | Why |
|----------|--------|-----|
| Scope split | Create-modal in note header + `/dashboard/shares` global page | Create is local to note; management benefits from global view |
| Expired display | Single list with muted rows | <20 shares/year scale; tabs are premature IA |
| UI config | Presets only for v1 | YAGNI (Panel 3); add Custom when wanted twice |
| Revoke | Soft with `revoked_by` + `revoked_at` audit columns | Preserves history; URL 410s immediately |
| `max_views` unlimited | `NULL` | Semantically correct; `view_count < max_views OR max_views IS NULL` |
| Recipient UX | HTTP 410 Gone + branded page | Distinct from 404 |
| Modal delivery | `next/dynamic({ ssr: false })` | Keeps note-view server-pure; zero JS for non-owners |
| Audience | Owner only — button hidden (not disabled) | No dead affordances |
| Rate limits | 20/hr mint, 60/min public view | Prevents flood + scraping |
| CSRF | Origin-header match on mutating proxy routes | Prevents one-click revoke attack |
| Mobile | One responsive dialog component | Don't maintain two |

Full rationale in `SPEC.md` at repo root.

#### Phase 19 Execution Strategy

**Batch 1 (solo, foundational):**
- **Agent A:** P19-1 — schema migration + share.ts extensions. Foundation for all downstream work.

**Batch 2 (solo, after P19-1 merged):**
- **Agent B:** P19-2 — backend endpoints, rate limits, 410 response, docs. Grove-only.

**Batch 3 (2 parallel, after P19-2 merged):**
- **Agent C:** P19-3 + P19-6 — grove-www proxy routes + expired recipient page (both small, both grove-www-only, disjoint files)
- **Agent D:** P19-4 — Share button + modal (grove-www only, disjoint from C)

**Batch 4 (solo, after Batch 3):**
- **Agent E:** P19-5 — dashboard shares page (depends on proxy routes from C and the "Manage all shares →" link target from D)

```bash
./scripts/run-batch.sh p19-1   # agent A
./scripts/run-batch.sh p19-2   # agent B
./scripts/run-batch.sh p19-3   # agents C + D parallel
./scripts/run-batch.sh p19-4   # agent E
```

#### Phase 19 Success Criteria

- Owner opens a note on grove.md, clicks Share in the header, picks TTL + max-views, clicks Generate → URL auto-copied to clipboard
- Owner navigates to `/dashboard/shares` → sees all active shares; can search by note, copy, revoke
- Revoking a share causes its URL to return 410 with branded page immediately
- Non-owner browsing via trail never sees the Share button nor the Shares nav item
- MCP/CLI clients unaffected (backend API contracts unchanged; new endpoints additive)
- `npm run test:mobile` stays green on all new pages at 375px
- No new horizontal-scroll regressions

---


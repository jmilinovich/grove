# Grove Ideas

Ideas for the Grove roadmap. Sparks live here until they're shaped enough to graduate into PLAN.md.

## How this works

Tell me an idea — a sentence, a half-thought, a "what if." I'll capture it as a spark. When you want to develop one, we'll shape it together until it's ready for PLAN.md.

**Stages:**
- **Spark** — raw idea, one line
- **Shaped** — problem, approach, and open questions defined
- **Ready** — spec'd enough to become a PLAN.md task or phase

---

## Sparks

- **Open source calibration** — decide what's the right amount of Grove to open-source (SDK? proxy? nothing? everything minus hosted infra?)
- **Extract design system** — pull a coherent design system out of the current Grove UI so future surfaces stay visually consistent
- **SOC2 baseline** — SSO, encryption at rest/transit, access logs, no prod access without MFA — the minimum surface to be SOC2-ready
- **Multimodal image embeddings via Voyage `voyage-multimodal-3`** — today the image upload pipeline embeds the companion markdown note's text (description + OCR + tags), so semantic search works on the description. But the image pixels themselves are never embedded, so "find an image that looks visually similar to this one" doesn't work. Swap (or add alongside) the embed step to use `voyage-multimodal-3`, which accepts interleaved text + image and returns 1024-dim vectors in a unified space. Store multimodal vectors in a distinct column or table so hybrid search can blend or separate them. Enables: (1) "find images that look like this photo" via image upload as query, (2) strict text-only or image-only modes, (3) better cross-modal retrieval when a text query matches an image's visual content (not just its description). Needs: DB migration for new vector storage, update to hybrid-search.ts, cost estimate (multimodal is more expensive per call), decision on whether to keep text embeddings alongside or replace.
- **Staging environment** — stand up a non-prod Grove before other friends start using it, so deploys, schema changes, and risky features can be validated without touching the single shared prod box
- **Maximize encryption coverage** — Phase 12 covers encryption at rest; go further. Audit every surface where vault content or metadata lives unencrypted — DB columns, search indexes, logs, backups, email digests, cron artifacts, agent prompt payloads. Pick the strongest defaults we can ship before multi-user (per-user keys? envelope encryption? client-side before upload?) while keeping search and MCP fast. Especially important before other residents land.
- **Branding & marketing plan** — work through the branding and marketing plan captured in the Grove project note ([grove.md/@jm/Resources/Projects/Grove](https://grove.md/@jm/Resources/Projects/Grove)): pull it into the repo's orbit, decide what ships as landing-page copy, docs, positioning, and naming conventions, and sequence the work against the product roadmap
- **Trust & security posture (honest claim ladder)** — stake out a defensible public claim about Grove's security and ladder up from there, instead of fuzzy "secure & encrypted" copy. Three things get conflated and need to stay distinct: (1) **encryption at rest + in transit** — table stakes, mostly true on AWS today; audit and document. (2) **Operator-can't-see-data** — E2EE breaks the AI features since the AI has to read the data; confidential computing via AWS Nitro Enclaves is the only real path and it's a heavy lift; defer until a use case justifies it. (3) **Compliance certs** — SOC 2 Type II via Vanta/Drata, 6–12 months; defer until a B2B customer demands it. Shippable v1: audit current encryption coverage, write a public Trust/Security page that makes only true claims, document strict per-tenant isolation, ship a credible self-hosted path as the escape hatch for zero-trust users. Non-finding: switching PaaS (Fly/Railway/Render/Vercel) does NOT solve the trust problem — it moves which company holds the keys, doesn't make them go away. Subsumes the existing **SOC2 baseline** and **Maximize encryption coverage** sparks — those become tactical work under this strategic frame.
- **Vault lenses / plugins** — third-party (or first-party) prompts/skills that run over your vault and surface insights you wouldn't otherwise see. Example: the "therapist" lens jm + Sumon talked about — reads journal + people + concept notes and reflects back patterns, recurring tensions, things you keep circling. The plugin is the prompt + the data shape it expects + the surface it writes/replies to. Different lenses = different ways of seeing the same vault (therapist, coach, biographer, librarian, scout). Open question: where do lenses run (Grove cron? on-demand MCP call? client-side via Claude Code skill?), how do they declare what slice of vault they need (read-only Areas? specific types?), and is there a plugin registry or just `~/.grove/lenses/*.md`? Could be Grove's "App Store moment" — the platform layer where the vault stops being just storage and becomes a substrate other minds run on.

### v3.1 search-quality cluster (deferred from V3 ranking implementation, 2026-05-09)

These four sparks are the named follow-on work from V3_PLAN.md. V3 ranking shipped on `eval/search-quality-harness` branch but flag-defaults to off (dark-launch); these close the gaps that gate flag-flip and the v3.1 calibration items called out by round-3 panels. Each is implementable independently; sequencing recommendation in parens.

- **Runtime-mutable per-collection ranking flag (V3 §7)** *(do first — gates safe rollout)* — Today `GROVE_PROV_RANKING_ENABLED` is an env var; flipping it requires a PM2 restart (5–15 min wall-clock revert). For the V3 A+ threshold #12 (rollback latency ≤60s) we need a SQLite-backed `runtime_config` table with: per-collection scoping (`prov_ranking_enabled.<collection>`), an admin POST endpoint, 5-second TTL in-process cache, read-after-write detection in `setFlag` (catches corrupt writes silently returning the old value). Plus `scripts/eval-search-quality/rollback-bench.ts` to measure the actual admin-POST → identity-ranking-restored wall-clock. Round-2 prod panel: "the most blast-radius decision in v3 is the auto-revert gate; ambiguity in its denominator is dangerous." This spark is the prerequisite for ever-flipping the flag in prod with an honest rollback story. Reference: V3_PLAN.md §7 + §O + threshold #12.
- **7-day soak harness with reason-chip UI (V3 §J + §M)** *(do after #1 — needs the runtime flag to flip)* — V3 ranking would go live with offline eval but no production-judgment gate. Build: pre-flip query capture (top-50 from `searchMetrics` over last 30 days saved to `soak/baseline-YYYY-MM-DD.json`), daily replay post-flip, lightweight web UI for thumbs-up/down per query with 5 reason chips (`wrong-result | wrong-by-design | freshness-intent-misfire | expectation-only | other`). Auto-revert via the runtime flag (#1) when `(wrong-result + other) / total > 0.20` after the day-7 learning gate. The chip taxonomy is load-bearing: round-3 prod panel flagged that thumbs-down without a reason will self-revert on correct behavior (e.g. user expected perishable to surface but design correctly suppressed it). Closes A+ threshold #11. Reference: V3_PLAN.md §J + §M + threshold #11.
- **Per-list voice factor inside `rrfFuse` (V3 §A v3.1 calibration)** *(do after observability triplet has 7 days of data)* — Current production reweight is post-fusion multiplicative (`final = rrf_score * voice_factor`). Round-3 IR explicitly accepted as v3 ship state but flagged that pushing voice INTO `rrfFuse` (modify line 459: `weight * voice_factor / (k + rank)`) preserves RRF's scale-invariance and lets BM25 vs vec carry asymmetric perishable bias (vec over-retrieves perishable; BM25 under-retrieves). The four asymmetric coefficients (`PROV_VOICE_FACTOR_BM25_PERISHABLE`, `_VEC_PERISHABLE`, etc., all symmetric at 0.85 today) become the tuning surface. Wait until `grove_search_voice_at_rank{list}` metric (already shipped in §L) has captured 7 days of production data showing whether the asymmetry is real before tuning. Then a sweep finds the right four-parameter point and the change ships. Reference: V3_PLAN.md §A "Per-list voice factor (§2 from V2)" non-goal note + round-3 IR §1.
- **Multi-segment matched-span resolution (V3 §D2 v3.1)** *(can do anytime — independent)* — Production today derives note-level voice from `getNoteVoicesAndAges` (modal across segments) as the first cut. The full §D2 worst-case-voice rule (`perishable > legacy > durable` across all segments overlapping the matched span, with `min(written_at)` for perishable / `max` otherwise) needs `resolveMatchedSpan(blame, spanStart, spanEnd)` in `src/blame.ts` plus snippet-to-line offset reconstruction (BM25 FTS5 snippets aren't substrings — they include `…` ellipses + `<b>` markup; vector chunks don't align with blame segments). Without this the SVF threshold (≥0.95 segment voice fidelity) is structurally unmeasurable on real notes. New `VAULT_STRADDLE` test fixture + `MIXED_VOICE_VAULT_NOTES` already exist in `scripts/eval-search-quality/test-set.ts`. Reference: V3_PLAN.md §D2 + threshold #9.

---

## Shaped

### Growth Prompting Heartbeat

**Problem:** Grove's graph has gaps — orphan notes, thin concepts, disconnected islands, unstated tensions — but nothing proactively surfaces them. Without a rhythm, gaps compound silently. Daily interactive use pulls new content in but doesn't cycle attention back to what's already in the vault.

**Sketch:**
- Daily pass scans graph state for **mechanical signals**: orphan notes, thin concepts (<100 words, no outbound links), islands (2+ disconnected components), stale notes with unresolved TODOs. Signals ranked by impact.
- **Random-walk pass**: 8 short walks/day (~10 nodes each) through the wikilink graph; Claude Haiku synthesizes each walk and looks for latent patterns — implicit questions, unstated super-categories, unnamed tensions between concepts. Budget: ~$0.03/day.
- Top 3 prompts/day emitted into the **Grove Heartbeat Digest's Prompts section**: 1–2 mechanical + 1 thoughtful.
- Answer routing: narrow prompts (e.g., "Alice has no backlinks") edit the triggering note directly. Broad prompts (essay-shaped, reflective) append to today's journal entry. User chooses mode per reply.
- **Unified queue with `/garden` skill**: both the digest cron and the interactive `/garden` daily practice read from the same `heartbeat_items` table. Answering in either channel resolves the item — no duplication between email push and interactive pull.

**Dependencies:**
- Grove Heartbeat Digest (shared delivery surface + `heartbeat_items` table)
- Graph health metrics (exists: Phase 13)
- Claude Haiku API (existing Phase 7 discovery pattern)
- `/garden` skill refactor (cross-repo: `~/.claude/skills/garden/`) — point it at `heartbeat_items`

**Success signal:** After 30 days, graph health metrics (orphans, islands, thin concepts) trend down. Daily prompt email produces 1–2 vault edits or journal entries per week on average. Silent-day rate feels correct (neither every day nor never). Random-walk prompts surface at least one "I hadn't thought of that" insight per week.

**Open questions:** resolved for v1.
- Deferred post-v1: explicit reject/thumbs-down feedback loop (v1 uses dismiss-rate in `heartbeat_items` as the quality signal — revisit ranking if dismiss rate exceeds 40%).

---

### Extract Learnings from Autonomous Runs

**Problem:** Cron jobs (`post-sync-discover`, auto-healer, graph-health, eval loops) make decisions, surface anomalies, and encounter failures — but those observations evaporate. The same issues re-surface and next agent sessions don't benefit from prior findings. Some anomalies generate genuine questions for the human, with no routing path today.

**Sketch:**
- `LEARNINGS.md` at repo root, append-only, checked into git.
- Each cron run appends a section `## <ISO-date> <run-name>` using a **rigid template**:
  - `**Observed:**` anomalies, drift, repairs made
  - `**Acted:**` auto-resolutions taken
  - `**Asks:**` questions for the human — items promoted into the Grove Heartbeat Digest's Asks section (or `none`)
- Rigid template is easy for agents to parse at startup and greppable. Producers write `none` rather than pad when there's nothing to say.
- **Dedup via idempotency_key**: each observation carries a key (e.g., `broken-link:<src>:<dst>`). Same key within 30 days → increment `seen_count` on the existing entry (displayed as `(seen 3x, last <date>)`) instead of appending a duplicate.
- **Rotation**: daily check moves entries dated >30 days ago into `LEARNINGS/YYYY-QQ.md` quarter archives. Active `LEARNINGS.md` stays agent-loadable; history stays grep-able.
- CLAUDE.md references `LEARNINGS.md` so agent sessions load recent findings at startup — no re-diagnosing problems an earlier run already solved.
- Weekly pulse (`/garden:pulse` or a new `/garden:learnings`) summarizes the week's entries; patterns worth keeping graduate to vault concept notes or PLAN.md tasks.
- Ask lifecycle (timeout, resolution, resurrection) is handled by the Grove Heartbeat Digest contract — see its entry.

**Dependencies:**
- Existing cron surfaces: `post-sync-discover.sh`, Phase 13 auto-healer, Phase 13 graph-health
- Grove Heartbeat Digest (delivery surface for "Asks" — see its own entry)
- CLAUDE.md reference pattern (standard, works today)

**Success signal:** After 2 weeks, a fresh Claude Code session in `grove/` cites prior learnings without prompting (e.g., "per last week's LEARNINGS, the auto-healer already normalized broken wikilinks after move X"). Human answers the daily "Asks" section occasionally — indicating the filter surfaces genuinely ambiguous signals, not noise. File stays under ~30 days inline, older archived cleanly.

**Open questions:** resolved for v1.

---

### Grove Heartbeat Digest

**Problem:** Multiple Grove subsystems want user attention on a daily cadence — growth prompts (graph-derived questions), cron "Asks" (anomalies needing a decision), future additions (weekly pulse, harvest results). Delivering each in its own email creates inbox noise and inconsistent conventions. One shared daily email + mirrored dashboard card is the single attention surface.

**Sketch:**
- **Storage:** new `heartbeat_items` SQLite table:
  ```sql
  CREATE TABLE heartbeat_items (
    id TEXT PRIMARY KEY,
    producer TEXT NOT NULL,           -- 'growth-prompt', 'auto-healer', etc.
    kind TEXT NOT NULL,               -- 'prompt' | 'ask'
    idempotency_key TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    dismissed_at TEXT,
    seen_count INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active'      -- 'active' | 'resolved' | 'dismissed' | 'aged'
  );
  ```
  Producers INSERT; the digest cron SELECTs `status='active'`; answer paths UPDATE `resolved_at`/`dismissed_at`/`status`.
- **Send time:** fixed `0 7 * * * America/Los_Angeles` (7am PT). Per-user configurability deferred until multi-resident users exist.
- **Email structure:** fixed section order (Prompts → Asks → optional Pulse). Section with zero items is omitted. All sections empty → **no email sent** (silent-day rule). After N silent days, next email includes `(quiet streak: Nd)` note. **Any non-silent day resets streak** to 0.
- **Aging:** items exceed 7 days unresolved → `status='aged'`, excluded from digest + dashboard. History queryable via `grove heartbeat history`. **Producer re-emits a new item** (new id) if underlying condition persists; old aged one stays archived.
- **Dashboard mirror:** `grove.md/dashboard` shows a read-only "Today" card mirroring the email state. Same items, same silent-day copy. No answer UI on dashboard (dashboard is read-only app-wide today).
- **Answer surfaces (v1):** MCP + email-reply only, no dashboard UI:
  - MCP: extend `write_note` with actions (Phase 11 precedent):
    - `write_note(action='resolve', item_id, answer)` — answers the item; routes per payload spec (edit source note for narrow prompts, append journal for broad, mark ask resolved)
    - `write_note(action='dismiss', item_id, reason)` — permanent dismiss; same idempotency_key blocked from re-emit for 30 days
  - Email reply-to: parse reply body for `resolve: <answer>` or `dismiss: <reason>` per item in the original digest. Implementation choice in spec (IMAP poll or Mailgun inbound webhook).
- No snooze action in v1 — aging handles the "not now" case implicitly.

**Dependencies:**
- Email send infra (exists: `src/email.ts`, Phase B)
- Email receive infra (new — IMAP or inbound webhook)
- Grove cron system (exists — 5-min sync, auto-healer, graph-health)
- `grove.md/dashboard` (exists — Phase 4) — new read-only Today card component
- `write_note` MCP tool action extension (Phase 11 precedent)
- Database migration for `heartbeat_items` (standard Grove pattern)

**Success signal:** User receives one email/day max, often fewer (silent-day rate 20–40% after a few weeks). Dashboard "Today" card and email always match. Items answered via MCP or email-reply disappear from both surfaces next send. Aging keeps the active queue clean without losing history.

**Open questions:** resolved for v1.

---

### Core Product Capacities List

**Problem:** Grove's actual capabilities, its marketing copy, its docs, and its PLAN.md drift apart. The landing page advertises things that exist but aren't discoverable; features ship without updating docs; agents connecting via MCP have no canonical answer to "what can Grove do?". Three audiences — humans (marketing), agents (introspection), internal (roadmap) — need the same data from one source.

**Sketch:**
- `capacities.yml` at repo root, **source of truth**, hand-edited (YAML for comments + ergonomics). Example entry:
  ```yaml
  - id: semantic-search
    name: Semantic search across your vault
    description: Hybrid BM25 + vector search; returns notes ranked by relevance
    status: shipped           # shipped | beta | planned
    implemented_by: [Phase 0, Phase 5]
    primitives: [mcp:query, rest:/v1/search]
    docs: docs/search.md
    marketing_anchor: /features#search
  ```
- **Scope is product-level capabilities** — one bullet of marketing copy = one capability. Expected count: 8–15 today. Primitives listed per-capability for agents that want to drill down.
- **Build step** (`scripts/build-capacities.ts`) generates on every change to `capacities.yml`:
  - `docs/capabilities.md` — human-readable Markdown (rendered in docs + pulled into grove-www)
  - `grove-www/public/.well-known/grove-capacities.json` — machine-readable manifest
  - Landing page section at `grove.md/features` hydrates from the generated Markdown
- **Agent introspection**: `/.well-known/grove-capacities.json` only. No new MCP tool (respects CLAUDE.md 6-tool rule). Any agent (MCP or otherwise) can `curl` it.
- **CI gating**:
  - `status: shipped` → all `implemented_by` phases must be ✅ in PLAN.md
  - `status: beta` → at least one `implemented_by` phase must be in-progress (⏳)
  - `status: planned` → any or no phase reference
  - Every ✅ phase in PLAN.md should map to at least one capability (warning, not error — infra-only phases without user-facing capability are allowed but flagged)

**Dependencies:**
- PLAN.md (unchanged — phases stay authoritative; capabilities link outward via `implemented_by`)
- `scripts/build-capacities.ts` (new — small YAML → Markdown + JSON generator)
- grove-www build pipeline (include the generator step; serve `/.well-known/grove-capacities.json` statically)
- CI workflow for drift gating (when Phase 4 CI/CD lands; until then, manual check on PR)

**Success signal:** A new user hitting `grove.md/features` and an agent fetching `/.well-known/grove-capacities.json` get the same 8–15 capabilities, accurate to what's shipped. Every phase-graduating PR includes a capacities.yml update; CI rejects PRs that ship a new capability without updating the manifest. Marketing copy on the landing page is grep-able back to YAML IDs.

**Open questions:** resolved for v1.

---

### Per-Vault SQLite Split

**Problem:** Multi-tenant scope leaks in Grove keep recurring at every layer that touches a shared store. PRs #66, #85, #86, #87, #88, #89, #90, #105, and #114 (last 14 days) all share the same shape: a row in a shared SQLite store needs a `WHERE vault_id = ?` clause that the calling code is morally obligated to add. Forgetting it on any path is a leak. `scripts/check-invariants.ts` literally encodes "every callsite must remember to do X" — that's the storage-layer-mistake tell. The bug rate is bounded only by audit thoroughness, which doesn't scale past ~200 callsites.

**Sketch:** Split per-tenant tables out of the shared `~/.grove/grove.db` into per-vault files. After migration, "forgot `WHERE vault_id = ?`" becomes structurally impossible because the connection is bound to a vault file.

- **Per-vault → `~/.grove/vaults/<slug>/state.db`**: `api_keys`, `shared_links`, `discovery_queue`, `discovery_results`, `graph_health`, `graph_health_flags`, `vault_usage_daily`
- **Stays shared in `~/.grove/control.db`**: `users`, `vaults`, `vault_members`, `sessions`, `magic_links`, `oauth_clients`, `oauth_codes`, `auth_codes` (these are genuinely cross-tenant)
- **QMD index**: also split — from one shared `~/.cache/qmd/index.sqlite` to per-vault `~/.cache/qmd/<slug>/index.sqlite`. The 1-day phase below kills today's search-layer leak class structurally.
- **API**: `db.ts` introduces `getControlDb()` and `getVaultDb(vaultId)`. Callers that take a `vaultId` arg get a connection bound to that vault's file. Cross-vault admin reads (e.g. `/keys` admin) become explicit `vaults.forEach(v => openVaultDb(v).query(...))` fan-out — visible at the call site instead of hidden in a missing predicate.

**Migration phases:**
- **1 day** — QMD per-vault split. Touches QMD's collection-as-database mode + `src/hybrid-search.ts` + `src/vault-stats.ts`. Self-contained; can ship before the bigger move.
- **1 week** — `state.db` split. Touches `db.ts`, `keys.ts`, `share.ts`, `discovery.ts`, `graph-health.ts`, `vault-usage.ts`. Migration is one-shot SQL: ATTACH, copy `WHERE vault_id = ?`, detach, drop.
- **1 month** — Once Phase 4 collapses servers into one in-process router, `getVaultDb` becomes a connection pool keyed by vault. Drop `vault_id` columns on tables that moved. Delete the `no-new-tenant-default-strings` invariant — it can't fire because the shared store it guarded no longer exists.

**Dependencies:**
- None blocking the 1-day phase (QMD split is self-contained).
- 1-month phase depends on Phase 4 (proxy + grove-server-* collapse, named in `~/.claude/projects/-Users-jm-src-grove/memory/project_2026_04_28_overnight_hardening.md`).

**Success signal:** The `no-new-tenant-default-strings` invariant in `scripts/check-invariants.ts` becomes deletable. New code paths that read/write a per-vault table cannot accidentally cross vaults because the connection is bound to a file. PR review burden for "did you remember to scope this?" drops to zero on per-tenant tables. Cross-vault admin operations look like cross-vault operations (explicit fan-out), not silent shared-state queries.

**Counter-arguments + mitigations:**
- *"Cross-vault joins disappear"* — true for `/keys` admin, future "all your sessions across vaults" UI, etc. **Mitigation:** keep genuinely cross-tenant tables in `control.db`; the few admin reads that span per-vault tables become explicit fan-out, which is honest about being cross-tenant.
- *"More files, more checkpoints, more migration complexity"* — true. WAL files multiply; schema migrations iterate vaults; backup tooling enumerates. **Mitigation:** at 3-10 tenants this is dozens of files, not thousands. Wrap migration runner in `forEachVaultDb()`. Backups are `tar` of `~/.grove/`.

**What NOT to do at this scale:**
- Postgres + row-level security — overkill for 3-10 tenants on one VM.
- A `VaultScopedDb` query rewriter — parsing/rewriting SQL is fragile.
- SQLite triggers asserting `vault_id = current_session_vault` — requires shared-mutable state for the session vault, awkward.

**Open questions:**
- Cross-vault admin endpoint shape (`/keys` admin) — do these stay in proxy as fan-out, or move to a separate admin service?
- Backup/restore tooling needs adapting — single `tar` of `~/.grove/` covers it but restore granularity changes.
- Migration safety: 1-week phase needs careful staging because moving `api_keys` could lock out active sessions if mistimed. Plan to ship under maintenance window or with a dual-read window.

**Anchor:** CLAUDE.md "the vault is the source of truth" + "simple until it needs to be complex." Per-vault SQLite is the simplest shape that makes the entire bug class structurally impossible. Full architectural decision doc in `~/.claude/projects/-Users-jm-src-grove/memory/project_per_vault_sqlite_split.md`.

---

### v2 Dashboard Server Surface

**Problem:** `grove-www`'s v2 dashboard is built, tested (449 passing), and 8 commits sitting on `feat/v2-dashboard` (PR #62) behind a prod guard that 404s the v2 surface in production until `GROVE_API_MODE=live` works. The guard exists because `api.grove.md` doesn't yet serve the v2 contract — `W0-PROBE-1` reports zero of five critical endpoints VERIFIED. Eleven functions in `grove-api.v2.live.ts` (`fetchBacklog`, `fetchTask`, `runTask`, `deferTask`, `dismissTask`, `reviewTask`, `fetchSkills`, `fetchThroughput`, `configureSkill`, `enableSkill`, `disableSkill`) all throw "not yet implemented". Until this lands, the v2 review-tasks experience cannot ship to real users — only to Vercel previews.

The product framing is in `grove-www/SPEC.md`: *"Grove is the first knowledge tool where the AI's backlog is the homepage, not a sidebar."* The server has to make that real.

**Sketch:**

**Schema** (per-vault tables — pair with the Per-Vault SQLite Split spark above; this is the first surface that should land as per-vault from day one rather than retrofitted later):

```sql
-- per-vault DB (~/.grove/vaults/<slug>/state.db when split lands; for
-- now: shared grove.db with vault_id column + invariant check)
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,                -- uuid
  vault_id TEXT NOT NULL,
  skill_slug TEXT NOT NULL,
  state TEXT NOT NULL,                -- pending|running|review|done|dismissed|failed
  title TEXT NOT NULL,
  body TEXT,                          -- markdown framing of what the AI will do
  source_note_path TEXT,              -- the note this task is "from" (nullable for cron-born tasks)
  estimated_minutes INTEGER,
  actual_minutes INTEGER,
  scheduled_for TEXT,                 -- ISO; for cadenced tasks
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_results (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  artifact_json TEXT NOT NULL,        -- {type: surface|note-change|...}
  note_change_json TEXT,              -- diff payload when artifact is a write
  provenance_voice TEXT,              -- perishable|durable|legacy
  provenance_by TEXT,                 -- model id
  provenance_written_at TEXT,
  provenance_basis_json TEXT,         -- array of paths/urls
  provenance_reason TEXT
);

CREATE TABLE skill_configs (
  vault_id TEXT NOT NULL,
  skill_slug TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  cadence TEXT NOT NULL,              -- daily|weekly|on-demand|... per SPEC §14.8
  last_run_at TEXT,
  next_run_at TEXT,
  PRIMARY KEY (vault_id, skill_slug)
);
```

The 5–7 skill slugs themselves are hardcoded in TS (`src/skills/<slug>.ts`); the `skill_configs` table is just per-vault user state. No marketplace table in v2 (SPEC §9).

**REST endpoints** (under existing `/v1/` namespace, vault-scoped per existing auth patterns in `proxy.ts`):

```
GET  /v1/tasks?vault=<slug>          → BacklogPayload (reviewTasks/pendingTasks/clearedTasks/throughput/skills/planTier)
GET  /v1/tasks/<id>                  → Task (with provenance_blame join when artifact is a note-change)
POST /v1/tasks/<id>/run              → trigger now (pending|review → running)
POST /v1/tasks/<id>/defer            → {until: ISO} → pending with scheduled_for
POST /v1/tasks/<id>/dismiss          → state=dismissed
POST /v1/tasks/<id>/review           → {action: confirm-durable|refine|dismiss|mark-stale, refinement?}
GET  /v1/skills?vault=<slug>         → Skill[] (joined config + hardcoded metadata)
POST /v1/skills/<slug>/configure     → {cadence}
POST /v1/skills/<slug>/enable
POST /v1/skills/<slug>/disable
GET  /v1/throughput?vault=<slug>     → ThroughputView (rolling 4-week velocity + cleared7d + estimatedClearText)
```

All inherit the existing Bearer-key auth + `vault_id` resolution from `proxy.ts`'s `/v1/notes/*` precedent. The 5 endpoints `W0-PROBE-1` checks are: `GET /v1/tasks`, `POST /v1/tasks/{id}/run`, `GET /v1/tasks/{id}`, `GET /v1/throughput`, `GET /v1/skills`. Ship these first; mutations second.

**Skill executors** — TypeScript functions in `src/skills/<slug>.ts`. Per SPEC §14.8 there are 5–7; ship 3 to start:

1. `daily-vault-review.ts` — the auto-install. Scans graph health signals + random walks (reuses `graph-health.ts` + the Growth Prompting Heartbeat shaped entry's mechanical+random-walk pattern). Produces surface-only Task artifacts in `review` state.
2. `concept-graph-cleanup.ts` — finds thin concepts, orphans, suggests merges. Produces `note-change` artifacts requiring confirm-durable.
3. `dup-people-detection.ts` — finds People notes with semantically-close names (cosine ≥ 0.85 + Levenshtein heuristic). Produces `note-change` merge proposals.

Each executor implements:
```ts
type SkillRun = (ctx: {
  vault: Vault;
  mode: "surface-only" | "writes-allowed";
  tokenCeiling: number;        // SPEC §8 — per-run cost ceiling
  scheduledFor?: string;
}) => Promise<TaskResult>;
```

**Scheduler** — new PM2 process `grove-scheduler` (or extend `grove-discovery-worker`). Cron at fixed cadence (1-min tick); reads `skill_configs WHERE enabled=1 AND next_run_at <= now()`; enqueues a `tasks` row; bumps `next_run_at` by the skill's cadence. The actual execution is a separate worker that pulls from `tasks WHERE state='pending' ORDER BY scheduled_for ASC LIMIT 1`. Matches existing `discovery-worker.ts` pattern.

**First-run choreography** (SPEC §3, §12) — hook in `vault-provision.ts`:
- After vault provisioned, INSERT `skill_configs` row for `daily-vault-review` with `enabled=1`, `cadence='daily'`, `next_run_at='tomorrow 6am PT'`.
- Synchronously enqueue **one immediate** `daily-vault-review` task with `mode='surface-only'` so the first review item lands within ~25s (SPEC's 30s envelope).
- The "surface-only" mode guarantees no vault writes during first run — the trust contract.
- Insert 3-5 "starter" pending tasks (templates from the skill specs) so the backlog isn't empty.

**Cost ceiling** (SPEC §8) — each executor reads its tier's token cap from a `plan_tier_caps` constant table. If the vault size estimate × tokens-per-note would exceed the cap, executor calls its own `shouldSample()` and processes a representative slice. Surfaces as part of the artifact: *"this run processed 80% of your vault; upgrade to Pro for full coverage."*

**Subsume vs. alongside** — the load-bearing design call:

The grove server already has three autonomous-AI-work pipes producing things that *want* human attention: `discovery_queue` / `discovery_results` (entity extraction), `graph_health_flags` (graph anomalies), and the unbuilt-but-shaped `heartbeat_items` (Growth Prompting Heartbeat + Extract Learnings + Heartbeat Digest). The v2 dashboard ships a *fourth* surface: `tasks` / `task_results`. Four parallel queues = split brain, duplicated review UX, and exactly the kind of accidental complexity CLAUDE.md tells me to avoid.

**Recommendation: subsume in two steps.**
- **Step 1 (in this graduation):** `tasks` ships as a new table. The 3 existing pipes continue to write to their own tables. The `daily-vault-review` skill READS from `graph_health_flags` and `discovery_results` to construct task bodies, but it does NOT replace those producers. Existing systems unchanged.
- **Step 2 (separate IDEAS entry, after v2 ships and stabilizes):** retire `discovery_queue` / `graph_health_flags` as standalone tables; their producers write directly to `tasks` rows. The `heartbeat_items` shaped design folds into `tasks` (`kind='ask'` becomes `state='review'`; `kind='prompt'` becomes `state='pending' AND skill_slug='daily-vault-review'`). Heartbeat Digest's email + MCP-answer paths read from `tasks` instead of `heartbeat_items`. **Step 2 deletes ~3 tables and one shaped-but-unbuilt design** — the cleanup is real.

This sequence buys v2 a clean ship without forcing a refactor of three live autonomous systems in the same release.

**Dependencies:**
- Provenance system (exists — `write_provenance`, `note_blame`, `provenance_blame`). Refine actions write attributed edits; the existing per-commit-trailer system covers this.
- Vault auth + Bearer-key routing (exists — `proxy.ts` `/v1/` patterns).
- Graph health + discovery results (exists — read sources for `daily-vault-review`).
- Anthropic API + cost watchdog (exists — `P7-COST-*` series gives per-day cap + per-note cooldown patterns to mirror in skill executors).
- `vault-provision.ts` (exists — first-run hook point).
- PM2 ecosystem config (exists — `generate-ecosystem.ts`; adds 1 process).

**Success signal:**
1. `npm run probe:api` in `grove-www` reports ≥80% VERIFIED against staging.
2. Setting `GROVE_API_MODE=live` in Vercel prod env stops the `grove-www` prod guard from 404-ing.
3. First-time signup → `/{handle}/{vault}` lands user on a backlog with 1 surface-only review item + 3–5 pending tasks within 30 seconds.
4. Hitting `c` on the review item resolves it; the next render shows it under "cleared this week."
5. `dailyVaultReview` cron fires at 6am PT and produces a new review item that lands in the email digest (via Heartbeat Digest integration once that ships) OR just in the backlog (in the interim).
6. Auto-revert: if 5xx rate on `/v1/tasks*` exceeds 1% in any 5-minute window, paging fires and the swap reverts (or `GROVE_API_MODE=mock` is flipped back, re-engaging the prod guard).

**Counter-arguments + mitigations:**

- *"Four queues is a problem; subsume now."* — Tempting, but the existing 3 producers + `heartbeat_items` are wired into prod cron + auto-healer paths. Touching them in the same release that ships v2 multiplies blast radius. Two-step subsume keeps the v2 ship surface scoped and lets us reuse the existing producers as data sources.
- *"Why hardcode skills instead of a registry?"* — SPEC.md is explicit: v2 ships 5–7 hardcoded; marketplace is v3. A registry table without authors is premature abstraction. Add it when the third-party authoring story exists.
- *"This is a lot for one phase."* — Three real surfaces (schema, REST, executors) + one cross-cutting (scheduler/first-run/cost). Sequence as **Phase 20** (schema + READ endpoints) → **Phase 21** (mutations + executor for daily-vault-review) → **Phase 22** (scheduler + first-run + 2 more executors). Phase 20 alone unblocks `GROVE_API_MODE=live` for the dashboard read path. Phase 21 unlocks review actions. Phase 22 unlocks autonomous cadence.

**Open questions:** all five resolved 2026-05-13. Decisions baked in below.

1. **Per-vault from day one or retrofit?** → **Per-vault from day one.** `tasks` / `task_results` / `skill_configs` land in `~/.grove/vaults/<slug>/state.db` from the start. This forces the per-vault SQLite tooling (`forEachVaultDb`, per-vault schema migrations, backup enumeration) to exist before `tasks` ships — the "forgot `WHERE vault_id = ?`" bug class is structurally impossible from day one rather than retrofitted. The Per-Vault SQLite Split spark above documents the broader pattern; v2 server surface is its first real consumer. Implication: Phase 20 carries some additional infrastructure work (the migration runner + backup tooling) that would otherwise have been deferred. Accepted cost.
2. **Write-through to `graph_health_flags.dismissed_at` on task disposition?** → **Yes.** When a user dispositions a task derived from a graph-health flag, the server updates `tasks.state` AND `graph_health_flags.dismissed_at` in the same write. Prevents the same flag re-appearing as a task on the next cron tick. Tighter coupling accepted; the cleanup falls out naturally during subsume Step 2 when the flag table eventually goes away.
3. **Scheduler implementation** → **New `grove-scheduler` PM2 process.** Dedicated process for cadence evaluation + task enqueue. Failure of the scheduler is decoupled from discovery's failure modes. Adds one row to `ecosystem-gen.ts`. Pattern mirrors the existing `grove-discovery` worker — same shape, different responsibility.
4. **First-run choreography UI on slow vaults** → **"Still working — refresh in a minute" state.** Hard timeout at ~25s server-side; UI gets the partial state and renders an explicit slow-vault message with a refresh affordance. Streaming/SSE is explicitly deferred per SPEC §11 (Vercel function timeouts), and force-sampling on first-run undermines the trust contract (the user expects "your vault" not "a sample of your vault"). Honest about reality is the right v2 ship.
5. **Provenance write path on refine action — does `write_provenance` already support `by=human`?** → **Yes.** Verified at `src/cli.ts:954` (`const ingestBy = (flags.by as string | undefined) ?? "human"`) and `src/server.ts:116` (the validator accepts any string for `by`; only `voice` is enum-constrained to `durable|perishable`). The refine action writes a normal note edit with `{ voice: "durable", by: "human" }`; the existing per-commit-trailer system carries it. No new code needed for attribution.

**When to spec:** The grove-www stack is already merged (PR #62 closes the M0 milestone). All five open questions resolved — IDEAS entry is **Ready**. Graduate to `grove/PLAN.md` as **Phase 20** (per-vault `tasks` schema + 5 READ endpoints + per-vault migration tooling), **Phase 21** (6 mutation endpoints + `daily-vault-review` executor + `graph_health_flags` write-through), **Phase 22** (new `grove-scheduler` PM2 process + first-run choreography in `vault-provision.ts` + slow-vault timeout UX + 2 more skill executors). Each phase is ~3–5 PRs.

**Anchor:** `~/src/grove-www/SPEC.md` (the v2 dashboard contract from the `/mili:spec` workflow, 2026-05-13), `~/src/grove-www/PLAN.md` (the 18 W0–W3 tasks already shipped on the client), `~/src/grove-www/src/lib/grove-api.v2.ts` (the canonical client contract: 11 function signatures + types). The grove server's job is to make that contract real.

---

### Embedding-Driven Vocab Retrieval for Discovery

**Problem:** Discovery's entity-extraction call ships the full vault vocabulary on every prompt. At today's vault size (~2,713 entity notes) that's ~68K input tokens per call. PR #145 wires `cache_control` so repeats within a drain hit cache cheap, but every cache miss still re-bills the full payload, and the vocab grows linearly: at 5K entities it's ~125K tokens; at 10K, ~250K. Caching softens the cost curve; it doesn't flatten it. The curve needs to be vault-size-independent.

**Sketch:**
- Every note already carries a Voyage embedding (1024-dim, written by `embed-single.ts`). Reuse it as the discovery query.
- Pull top-k nearest vocab entries from the existing SQLite vector index by cosine; ship only those (start k=50, tune to k=100 if recall drops).
- Append a small fixed-or-derived **bonus list** of the top-N most-linked vault entities (by inbound wikilink count) so the common misses — "Karpathy", "Anthropic", staple concepts — are always included regardless of cosine.
- Net prompt: from ~68K → ~3–5K input tokens. Cost-per-note becomes O(1) in vault size; only the bonus list grows, and it grows on a schedule we control.
- Keep the full-vocab path behind a `GROVE_DISCOVERY_FULL_VOCAB=1` flag for spot-checking and the offline eval baseline.

**Trade-off:** False negatives — an entity mentioned in the note that isn't in the top-k *and* isn't on the bonus list won't get linked. Mitigated by (a) bonus list, (b) tuned k, (c) vault is forgiving (next note that mentions the entity at higher cosine will catch it). Periodic full-vocab sweep (e.g. weekly cron) backfills missed links.

**Dependencies:**
- Voyage embeddings on every note (exists — `embed-single.ts`)
- SQLite vector index with cosine top-k (exists — used by hybrid-search)
- `src/discovery-extract.ts` — the call site; pass note embedding through `extractFromNote` → `extractEntities`, replace `buildVocabulary`'s full-vocab return with a top-k fetch
- New offline eval harness: a labeled set of 50–100 known-good extractions (entity recall vs. full-vocab baseline)
- Bonus-list builder: `SELECT to_path, COUNT(*) FROM wikilinks GROUP BY to_path ORDER BY 2 DESC LIMIT 100` (or equivalent — graph-health may already compute this)

**Success signal:** After ship, average input tokens per Discovery call drops from ~68K to <5K (measure via Anthropic API usage). Entity recall on the labeled eval is within 5% of the full-vocab baseline at k=50, within 2% at k=100. Cost per extracted note becomes constant as the vault grows past 5K, then 10K entities.

**Open questions:**
- Right `k`? Likely 50–100; needs the eval set to settle.
- Bonus-list size and refresh cadence — daily? On vocab change?
- Should we cache the top-k result by note-embedding-hash so repeated extractions on the same note (e.g. retry path) skip the vector lookup?
- Per-type retrieval: pull top-k per entity type (people, concepts, projects, companies) instead of one global top-k, to avoid one type swamping the slate?
- Ranking blend: cosine-only, or cosine + recency + inbound-link-count?

**When to spec:** Worth `/mili:spec` once the cache PR (#145) ships and we have ~2 weeks of usage data showing how often the cache busts in practice. If cache hit rate is consistently >80% the urgency drops; if it's <50%, this is the next thing to ship.

---

## Ready

<!-- Fully shaped ideas waiting to be moved into PLAN.md -->

---

## Graduated

Ideas that have been spec'd and moved into PLAN.md.

- **Encryption at Rest** → Phase 12
- **User Profile & Trail Config UX** → Phase 15
- **Graph Health Heartbeats** → Phase 13
- **Image Uploads as Graph Nodes** → Phase 14
- **Pinterest-Style Image View** → Phase 14
- **Vault-Agnostic Structure** → Phase 10
- **DELETE/Move Endpoint** → Phase 11
- **Multi-resident URL structure** → Phase 16
- **Post-login lands at grove.md/dashboard** → Phase 17
- **Mobile-optimized pages** → Phase 18
- **Share button on note-view** → Phase 19 (SPEC.md)

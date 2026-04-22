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

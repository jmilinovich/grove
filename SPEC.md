# Dashboard IA — collapse to Home + Access

**Status:** Spec'd 2026-04-23 (Phase A ships first; Phase B gated on feedback)
**Scope:** `grove-www` frontend refactor; tiny backend change for activity endpoint in Phase B only
**Depends on:** P8-B6 (PR #29) — profile hoist to `/@<h>/profile` must land first so avatar menu has a canonical target

---

## Context

Grove's vault dashboard grew to 8 top-level tabs — Overview, Keys, Shares, Trails, Users, Usage, Graph, Health — plus a hidden Lifecycle page and an orphaned `/profile` route. The owner's felt pain:

- Overlap between Keys / Shares / Trails / Users
- Graph page is demo-grade, no real utility
- Usage page "has nothing showing up" (it's actually wired; it renders empty when no traffic)
- Profile is unreachable from the dashboard

The underlying insight: **Keys, Trails, Shares, and Members are all principals that access the vault — different mechanisms of the same concept.** They shouldn't be peer rail items. Everything else (Overview, Usage, Health, Lifecycle) is vault status, which belongs together.

This spec collapses the dashboard to **2 rail items** (Home, Access) + an avatar menu, retires the Graph page, and stages the work in two phases.

## Research findings

From a survey of Vercel, Supabase, Clerk, Resend, Linear, Notion, GitHub, Anthropic console, PostHog, Railway:

1. **Two-tier nav is universal.** Top bar = scope switcher + avatar. Left rail = sections.
2. **Principals cluster.** Keys, members, share links, tokens live under one "Access" or "Team" parent with tabs inside.
3. **Overview pages are dying** — modern dashboards open on the most-used working surface.
4. **Personal profile is always** in an avatar dropdown top-right.
5. **Usage/billing** is its own rail item, never inside Settings.

P8-B6 (PR #29) already hoists profile to `/@<h>/profile` which matches the avatar-menu pattern and unlocks this redesign.

## Current state (what's being replaced)

All paths are grove-www:

| Page | Path | Fate |
|------|------|------|
| Overview | `src/app/(resident)/[atHandle]/[vaultSlug]/dashboard/page.tsx` | Phase B: Replace with Home |
| Keys | `.../dashboard/keys/page.tsx` | Phase A: Move to `access/keys` |
| Shares | `.../dashboard/shares/page.tsx` | Phase A: Move to `access/shares` |
| Trails | `.../dashboard/trails/page.tsx` | Phase A: Move to `access/trails` (UI label: "Scoped Keys") |
| Users | `.../dashboard/users/page.tsx` | Phase A: Move to `access/members` |
| Usage | `.../dashboard/usage/page.tsx` | Phase B: Delete, fold into Home card |
| Graph | `.../dashboard/graph/page.tsx` (~415 LOC) | Phase A: **Delete entirely** + drop D3 |
| Health | `.../dashboard/health/page.tsx` | Phase B: Delete, fold into Home status strip |
| Lifecycle (hidden) | `.../dashboard/lifecycle/page.tsx` | Phase A: Delete; Phase B re-surfaces in Home |
| `DashboardNav` | `src/components/dashboard-nav.tsx` | Phase A: Rewrite to 2 items |

## Design decisions (locked during grilling)

1. **Rail shape:** 2 items — **Home** and **Access**. Nothing else.
2. **Top bar:** Grove wordmark · vault switcher (existing) · avatar menu.
3. **Avatar menu:** links to `/@<h>/profile`, account settings (`/@<h>/settings/vaults`), sign out.
4. **Home absorbs:** Overview stats, Lifecycle digest, Health status strip, Usage 7-day card, Recent Activity feed.
5. **Home ordering (pulse-first, revised from panel feedback):** **Health strip → Usage → Activity → Vault stats + Garden Lifecycle.** Health on top because "is anything broken" is the highest-urgency signal.
6. **Access is a single route** with 4 tabs, UI labels: **Keys · Scoped Keys · Shares · Members**. (Backend/API term stays "Trails.")
7. **Members = flat list** (Email · Role · Last active). Click a row → URL-addressable drawer (`?member=<id>`).
8. **Graph page is deleted** — low utility, ~415 LOC, verified only consumer is `src/proxy.ts:2323` (grove repo). `analyzeGraph()` in `vault-graph.ts` **stays** — still used by `vault-stats.ts` and `server.ts`.
9. **Non-owner/viewer gate:** existing `dashboard/layout.tsx:22` redirects non-owners to `/home`. Access inherits this. If viewer roles are added later, Access must hide tabs per role, not 403 silently.
10. **Redirects use `next.config.ts` `redirects()`** — static, edge-cached, testable via HTTP, no middleware invention. Page-level `permanentRedirect()` as fallback where dynamic logic is needed.

## Specification

### URL structure

```
/@<h>/<v>/dashboard                  → Home
/@<h>/<v>/dashboard/access           → default tab (keys)
/@<h>/<v>/dashboard/access/keys
/@<h>/<v>/dashboard/access/trails    (UI label: "Scoped Keys")
/@<h>/<v>/dashboard/access/shares
/@<h>/<v>/dashboard/access/members   (?member=<id> opens drawer)
```

Legacy redirects via `next.config.ts`:

```
/@<h>/<v>/dashboard/keys       → /@<h>/<v>/dashboard/access/keys         (308)
/@<h>/<v>/dashboard/shares     → /@<h>/<v>/dashboard/access/shares       (308)
/@<h>/<v>/dashboard/trails     → /@<h>/<v>/dashboard/access/trails       (308)
/@<h>/<v>/dashboard/users      → /@<h>/<v>/dashboard/access/members      (308)
/@<h>/<v>/dashboard/graph      → /@<h>/<v>/dashboard                     (308, no replacement)
/@<h>/<v>/dashboard/lifecycle  → /@<h>/<v>/dashboard                     (308)
```

Phase B adds:

```
/@<h>/<v>/dashboard/usage      → /@<h>/<v>/dashboard                     (308)
/@<h>/<v>/dashboard/health     → /@<h>/<v>/dashboard                     (308)
```

Query + fragment preserved. Max 1 hop. No 308→307 chains (avoids cache confusion with layout-level role redirects).

### Access page layout (Phase A)

```
┌──────────────────────────────────────────────────┐
│ Access                                            │
│ ┌──────┬──────────────┬────────┬─────────┐       │
│ │ Keys │ Scoped Keys  │ Shares │ Members │       │
│ └──────┴──────────────┴────────┴─────────┘       │
│ (selected tab content — existing table, unchanged)│
└──────────────────────────────────────────────────┘
```

First-time hint above the tab strip (dismissible, localStorage): *"Access groups every principal that can read or write this vault — your own keys, scoped keys you've shared, public snapshot links, and humans you've invited."*

Tab order reflects **trust radius** (narrowest → widest): your keys → keys you've scoped for others → public snapshot links → humans with membership.

Accessibility: roving tabindex on tabs; `aria-current` on active rail item + active tab; skip-link to main.

### Home page layout (Phase B)

```
┌──────────────────────────────────────────────────┐
│ Grove   @jm/vault ▾                      👤 ▾    │
├────────┬─────────────────────────────────────────┤
│ Home • │ ● All systems healthy · 2 flags ▾       │
│ Access │ ──────────────────────────────────────  │
│        │ Usage (7d)                               │
│        │ 1,247 req · p95 230ms · 0.2% err         │
│        │ [sparkline]                              │
│        │ ──────────────────────────────────────  │
│        │ Recent Activity (5 rows · View all →)   │
│        │ 2m  claude   get_note       200          │
│        │ 5m  main     write_note     200          │
│        │ ──────────────────────────────────────  │
│        │ Vault                                     │
│        │ 2,847 notes · 98% fresh · index ok       │
│        │                                          │
│        │ Garden Lifecycle                          │
│        │ seeds 4 · sprouts 12 · growing 203 ·     │
│        │ mature 2,589 · dormant 39 · withering 0  │
└────────┴─────────────────────────────────────────┘
```

Each card is an independently-suspending RSC with its own p95 budget:

| Card | Endpoint | p95 budget | Empty state | Degraded state |
|------|----------|-----------|-------------|----------------|
| Health strip | `/v1/admin/health/current` | 300ms | "No flags" | Amber chip: "Health check degraded" |
| Usage 7d | `/metrics` (trimmed) | 500ms | "No requests yet — try a key" + curl snippet | "Usage data temporarily unavailable" |
| Recent Activity | **new** `/v1/admin/activity?limit=5` (Phase B backend) | 500ms | "No recent API calls" | Inline error toast |
| Vault stats | `/v1/stats` | 300ms | N/A (always populated) | Skeleton placeholder |
| Lifecycle | `/v1/status/digest` | 400ms | "No notes yet" | Skeleton placeholder |

Total Home p95 target: ≤1.5s for above-the-fold (Health + Usage); full page may stream in beyond that.

### Avatar menu

```
👤 ▾
├─ Signed in as jm@...
├─ ──────────────
├─ Profile            → /@<h>/profile
├─ Account settings   → /@<h>/settings/vaults
├─ ──────────────
└─ Sign out
```

### Deletions (verified safe)

**Phase A (grove-www):**

- `src/app/(resident)/[atHandle]/[vaultSlug]/dashboard/graph/` — entire folder (~415 LOC)
- `src/app/(resident)/[atHandle]/[vaultSlug]/dashboard/lifecycle/` — entire folder
- `src/app/(resident)/[atHandle]/[vaultSlug]/dashboard/users/` — moved, not deleted (file moves)
- `package.json`: remove `d3` + `@types/d3` (confirmed only consumer is the deleted `graph-explorer.tsx`; `mermaid` is separate and stays)

**Phase A (grove):**

- `/v1/status/graph` HTTP route in `src/proxy.ts` (around line 2323)
- `analyzeGraph()` in `src/vault-graph.ts` — **KEEP**, still called by `src/vault-stats.ts` and `src/server.ts`

**Phase B (grove-www):**

- `src/app/(resident)/[atHandle]/[vaultSlug]/dashboard/usage/` — fold into Home
- `src/app/(resident)/[atHandle]/[vaultSlug]/dashboard/health/` — fold into Home
- Legacy Overview replaced by new Home composition

### New/changed files

**Phase A — grove-www:**

- `src/components/dashboard-nav.tsx` — rewrite to 2 items (Home, Access)
- `src/components/access-tabs.tsx` — new, tab strip with roving tabindex
- `src/components/dashboard-access-hint.tsx` — new, dismissible first-time hint
- `src/app/(resident)/[atHandle]/[vaultSlug]/dashboard/access/layout.tsx` — tab strip wrapper
- `src/app/(resident)/[atHandle]/[vaultSlug]/dashboard/access/page.tsx` — redirect to `access/keys`
- `src/app/(resident)/[atHandle]/[vaultSlug]/dashboard/access/keys/page.tsx`
- `src/app/(resident)/[atHandle]/[vaultSlug]/dashboard/access/trails/page.tsx`
- `src/app/(resident)/[atHandle]/[vaultSlug]/dashboard/access/shares/page.tsx`
- `src/app/(resident)/[atHandle]/[vaultSlug]/dashboard/access/members/page.tsx` (+ URL-addressable drawer)
- `src/components/user-table.tsx` → rename `member-table.tsx`
- `next.config.ts` — add `redirects()` block for 6 legacy paths
- `src/components/header.tsx` — add avatar menu; link to `/@<h>/profile` + `/@<h>/settings/vaults`
- `test/legacy-redirects.spec.ts` — **extend** (do not create a new file). Required cases:
  - 6 legacy → 6 new paths
  - query + fragment preservation on each
  - auth pass-through (non-owner still gets `/home` redirect)
  - chain depth ≤ 1 hop

**Phase A — grove:**

- `src/proxy.ts` — remove `handleStatusGraph` dispatch at `~:2323`
- No DB migration, no schema change

**Phase B — grove-www:**

- `src/components/dashboard-home.tsx` — new composition
- `src/components/dashboard-home/health-strip.tsx`
- `src/components/dashboard-home/usage-card.tsx`
- `src/components/dashboard-home/activity-feed.tsx`
- `src/components/dashboard-home/vault-stats-card.tsx`
- `src/components/dashboard-home/lifecycle-card.tsx`
- `src/app/(resident)/[atHandle]/[vaultSlug]/dashboard/page.tsx` — swap Overview for Home
- `next.config.ts` — extend `redirects()` with 2 more legacy paths

**Phase B — grove:**

- `src/proxy.ts` — new `/v1/admin/activity?limit=N` endpoint returning structured recent requests (JSON, not Prometheus text)
- `src/metrics.ts` — expose a read-path for structured recent requests

### Non-owner / viewer behavior

Current state: `dashboard/layout.tsx:22` redirects non-owners to `/home`. The new Access route sits under the same layout, so this inheritance is automatic.

When viewer roles are introduced (post-this-spec):
- Access rail item hides if the viewer has no tabs they can see
- Each Access tab checks its own permission server-side
- Members drawer hides keys belonging to other members for non-admin viewers

## Implementation order

### Phase A — Access consolidation (ship first)

**Single PR, grove-www + grove:**

1. Add `redirects()` to `next.config.ts` for 6 legacy dashboard paths
2. Create `access/` layout + 4 sub-routes, move existing page components
3. Rename `users` → `members` (file move + component rename)
4. Rewrite `DashboardNav` to 2 items
5. Add avatar menu to `header.tsx` (depends on PR #29 merging first)
6. Delete `/dashboard/graph/` + `/dashboard/lifecycle/`
7. Remove `d3` + `@types/d3` from `package.json`
8. Remove `/v1/status/graph` route in grove/proxy.ts
9. Extend `test/legacy-redirects.spec.ts`
10. Smoke test: every legacy URL 308s, every new URL renders, Graph 404s

**Exit criteria:** 4 stated pains resolved (Graph gone, Usage still visible at own URL, Profile reachable via avatar, Access principals clustered). Stop here. Gather feedback.

### Phase B — Home rebuild (gated on feedback)

**Only pursue if Phase A feedback surfaces unmet need.** Do not bundle with A.

1. Spec the `/v1/admin/activity` endpoint (new, structured — not `/metrics` scraping)
2. Build 5 Home card components with their empty/loading/degraded states
3. Replace Overview with Home composition
4. Delete `/dashboard/usage/` and `/dashboard/health/`
5. Add 2 more redirects to `next.config.ts`
6. Extend redirect tests

**Exit criteria:** Home p95 ≤1.5s above-the-fold; each card degrades independently; no card blocks siblings.

### Phase C — observability + cleanup (30 days after Phase A)

- Confirm via access logs that `/v1/status/graph` has zero external consumers before final teardown
- Measure bundle size delta (expect ~50-80KB reduction from D3 drop)
- Audit OAuth allowlists, email templates, docs for any legacy path references (same checklist pattern as P8-B6 pre-merge)

## Open questions

1. Does `/@<h>/<v>/settings` (P8-B6's empty-state page) eventually redirect to `/dashboard/access`, or stay distinct? **Deferred** — not blocking.
2. If/when viewer roles land, what subset of Access do they see? **Deferred** — current state is owner-only.
3. Any OAuth redirect allowlists or email templates referencing `/dashboard/{users,keys,shares,trails,graph,lifecycle}`? **Pre-merge audit required** (mirror P8-B6's checklist).

## Success criteria (Phase A)

- Left rail shows exactly 2 items
- All 6 legacy dashboard URLs 308 redirect to canonical paths, ≤1 hop
- Query + fragment preserved on redirects
- Graph page returns 404 (and re-added-in-prod would require new code)
- D3 no longer in grove-www bundle
- Profile is reachable in ≤1 click from any dashboard page via avatar menu
- Zero broken incoming links (verified against email templates + OAuth allowlists)
- `test/legacy-redirects.spec.ts` green
- Existing table behaviors (Keys, Shares, Trails, Members) regress-free

## Rollback plan

- **Phase A is a two-way door** for frontend (file moves + redirects revert cleanly via git). The `d3` package can be re-added.
- **Backend removal of `/v1/status/graph`** is effectively one-way once deployed. Mitigation: grep both repos + 7-day access-log sample before removing the route; keep `analyzeGraph()` so re-adding the HTTP surface is trivial.
- **Phase B** is socially one-way — once Home is "the dashboard," owner expectation shifts. Mitigation: gate on Phase A feedback; don't ship B unless A's pain persists.

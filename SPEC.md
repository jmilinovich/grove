# P8-B6 — Hoist user-scoped routes out of `[vaultSlug]`

**Status:** Spec'd 2026-04-22
**Scope:** `grove-www` only (no backend, no DB, no MCP changes)
**Depends on:** Phase 8B (shipped 2026-04-22)

---

## Context

Phase 8B's route restructure (P8-B3, `grove-www` bb76c22) moved every authenticated route under `/@<handle>/<vault-slug>/*`. That was correct for vault-specific pages (dashboard, images, per-vault keys) but wrong for three pages whose underlying data is user-scoped, not vault-scoped:

- `/@<h>/<v>/profile` — fetches `/v1/me`; the `<v>` segment is never read
- `/@<h>/<v>/settings/vaults` — fetches `/v1/me.vaults[]`; the `<v>` segment is unused
- `/@<h>/<v>/settings` — redirect shim that forwards to the above

Visiting `/@jm/personal/profile` and `/@jm/work/profile` renders identical pages. The URL lies about the resource.

This phase corrects the IA by hoisting user-scoped pages one level up. Pure URL restructure — zero backend API changes.

## Research

Across GitHub, Linear, Notion, Vercel, Figma, the dominant convention is **user stuff in user URL scope, workspace stuff in workspace URL scope**:

- GitHub: `/settings/*` (user) vs `/organizations/{org}/settings/*` (org); profile at `/{username}`
- Vercel: `/account/settings` (user) vs `/teams/{team}/settings` (team)
- Notion: consolidated `/settings` with tabs (UI split, not URL split)
- Linear: hybrid

Grove already has `/@<handle>` as the resident scope, so the natural shape is **flat under handle** (`/@jm/profile`), matching GitHub. Nesting an explicit `/account` scope (Vercel-style) was considered and rejected — redundant with `@handle`.

## Design decisions (locked during grilling)

1. **URL shape:** flat under handle for user-scope; `[vaultSlug]` stays for vault-scope.
2. **User-scope taxonomy** (pinned for the whole epic, not just this phase):
   - **User-scoped:** profile, account settings, vault list, cross-vault API keys overview, sessions, billing
   - **Vault-scoped:** dashboard/*, images, per-vault API keys, members, vault name/slug, integrations, trails, content paths
3. **In scope THIS phase:** move only `profile` and `settings/vaults`. Defer account settings, keys overview, vault-level settings, public profile — each needs new backend endpoints or product definition.
4. **Bare `/@<h>` (signed-in as `<h>`):** redirect to MRU vault dashboard.
5. **Vault switcher on user-scoped pages:** neutral "Switch to vault…" launcher (not an active-vault chip). The URL has no vault, so the switcher must not claim one is "current."
6. **Vault-scoped `/@<h>/<v>/settings`:** render an empty-state "Vault-level settings coming soon" page — **do not redirect** (redirecting a vault-contextual URL to a user-scoped list violates user intent).
7. **Legacy user-scoped URLs** (`/@<h>/<v>/profile`, `/@<h>/<v>/settings/vaults`): 308 permanent to user-scoped counterparts. Strip vault segment, preserve query string + fragment.
8. **Bare `/@<h>/settings`:** 308 to `/@<h>/settings/vaults`.
9. **Profile access:** auth-walled, self-edit only. No public profile in this phase.

## Specification

### Routes after move

```
User-scoped (new canonical):
  /@<h>/profile                     (moved from /@<h>/<v>/profile)
  /@<h>/settings/vaults             (moved from /@<h>/<v>/settings/vaults)
  /@<h>/settings                    308 → /@<h>/settings/vaults

Vault-scoped (unchanged):
  /@<h>/<v>/dashboard/*
  /@<h>/<v>/images
  /@<h>/<v>/[...path]
  /@<h>/<v>/trails/*
  /@<h>/<v>/s/[id]
  /@<h>/<v>/settings                (NEW — empty-state page, no redirect)

Legacy redirects (308 permanent):
  /@<h>/<v>/profile                 → /@<h>/profile           (strip vault)
  /@<h>/<v>/settings/vaults         → /@<h>/settings/vaults   (strip vault)

Bare (MRU-resolved):
  /profile                          → /@<h>/profile            (no MRU needed)
  /settings                         → /@<h>/settings/vaults    (no MRU needed)
  /settings/vaults                  → /@<h>/settings/vaults    (no MRU needed)
  /@<h>                             302 → /@<h>/<mru>/dashboard (NOT 308 — MRU is mutable)
  /dashboard                        → /@<h>/<mru>/dashboard    (unchanged)
```

### Redirect implementation

Legacy redirects (#2 in the map above) go in **`middleware.ts`**, not page-level `permanentRedirect()` shims. Rationale: middleware runs before RSC, so no server component spin-up per legacy hit. Matches on URL regex, emits single 308 with preserved query + fragment.

```ts
// middleware.ts (sketch)
const LEGACY_USER_SCOPED = /^\/@([^/]+)\/([^/]+)\/(profile|settings\/vaults)$/;

if (LEGACY_USER_SCOPED.test(pathname)) {
  const [, handle, , subpath] = pathname.match(LEGACY_USER_SCOPED)!;
  const target = new URL(`/@${handle}/${subpath}`, request.url);
  target.search = request.nextUrl.search;
  target.hash = request.nextUrl.hash;
  const res = NextResponse.redirect(target, 308);
  res.headers.set('Cache-Control', 'max-age=3600'); // relax during rollout, tighten after
  return res;
}
```

Page-level `permanentRedirect()` shims are used only where middleware can't cover (e.g., when authentication state needs to be checked first).

### Component behavior

- **`header.tsx`** — profile/settings nav links use a new `userScopedPath(handle, subPath)` helper returning `/@<h>/<subPath>`. Dashboard/images/vault-scoped links continue to use `scopedPath(handle, vault, subPath)`.
- **`vault-switcher.tsx`** — behavior changes on user-scoped pages:
  - On vault-scoped pages (`/@<h>/<v>/*`): unchanged. Chip shows `<v>`; dropdown navigates to `/@<h>/<chosen>/dashboard`.
  - On user-scoped pages (`/@<h>/profile`, `/@<h>/settings/*`): chip shows **no active vault** ("Switch to vault…" placeholder). Dropdown lists vaults; click → `/@<h>/<chosen>/dashboard`.
  - Derived from `useParams()` — if `vaultSlug` is undefined, user-scoped state.
- **`dashboard-nav.tsx`** — unchanged (all dashboard tabs are vault-scoped).
- **`useScopedLink`** hook — gains `.userLink(subPath)` method returning `userScopedPath(handle, subPath)`.
- **`lib/vault-context.ts`** — add:
  - `userScopedPath(handle: string, subPath: string): string`
  - Private `normalizeHandle(raw: string): string` — **shared** by `userScopedPath` and `scopedPath`. Both call it; no duplicated normalization logic.

### Auth & return-path flow

`profile/page.tsx:28` currently builds `loginRedirect = '/login?redirect=<encoded>'` via `scopedPath`. In the new location, this uses `userScopedPath`:

```ts
const loginRedirect = `/login?redirect=${encodeURIComponent(
  userScopedPath(atHandle, "/profile"),
)}`;
```

Same change in the new `settings/vaults/page.tsx`. After sign-in, the redirect parameter lands the user on the new canonical URL, not the legacy path.

### Data flow (unchanged)

- `/@<h>/profile` calls `/v1/me`
- `/@<h>/settings/vaults` calls `/v1/me.vaults[]`

No backend endpoint changes.

## Implementation sketch

### Files moved

| From | To |
|------|----|
| `src/app/(resident)/[atHandle]/[vaultSlug]/profile/page.tsx` | `src/app/(resident)/[atHandle]/profile/page.tsx` |
| `src/app/(resident)/[atHandle]/[vaultSlug]/settings/vaults/page.tsx` | `src/app/(resident)/[atHandle]/settings/vaults/page.tsx` |

Both: drop `vaultSlug` param, switch `scopedPath` → `userScopedPath`, update login return path.

### Files added

- `src/app/(resident)/[atHandle]/settings/page.tsx` — `permanentRedirect('/@<h>/settings/vaults')`
- `src/app/(resident)/[atHandle]/[vaultSlug]/settings/page.tsx` — **replace existing shim with empty-state "Vault-level settings coming soon" page.** Keeps `<v>/settings` meaningful for users who clicked settings from within a vault.
- `middleware.ts` — regex matcher for legacy user-scoped URLs, emits 308 with query + fragment + `Cache-Control: max-age=3600`.

### Files updated

- `src/lib/vault-context.ts` — add `userScopedPath`, extract `normalizeHandle`, route both helpers through it.
- `src/lib/use-scoped-link.ts` (or wherever `useScopedLink` lives) — add `.userLink()` method.
- `src/components/header.tsx` — profile/settings nav links use `userScopedPath` / `.userLink()`.
- `src/components/vault-switcher.tsx` — neutral state when `vaultSlug` param is undefined.
- `src/app/profile/page.tsx` (bare) — drop MRU lookup; redirect direct to `/@<h>/profile`.
- `src/app/settings/[[...rest]]/page.tsx` (bare) — drop MRU lookup; redirect direct to `/@<h>/settings/<rest>`.
- `src/app/(resident)/[atHandle]/page.tsx` (bare handle) — use **302** (not 308) when redirecting to MRU vault dashboard. MRU target is mutable; 308 would cache and pin first-visited vault forever.

### Files deleted

- Old `src/app/(resident)/[atHandle]/[vaultSlug]/profile/page.tsx` (replaced by middleware redirect — no shim file needed once middleware covers it)
- Old `src/app/(resident)/[atHandle]/[vaultSlug]/settings/vaults/page.tsx` (same)

### Tests

Add to `test/route-structure.spec.ts`:

- **Redirect correctness:**
  - `/@<h>/<v>/profile?q=1#frag` → 308 `/@<h>/profile?q=1#frag` (query + fragment preserved)
  - `/@<h>/<v>/settings/vaults?q=1` → 308 `/@<h>/settings/vaults?q=1`
  - `/@<h>/<v>/settings/vaults/` (trailing slash) → 308 (Next.js default behavior verified)
  - `/@<h>/settings` → 308 `/@<h>/settings/vaults`
  - Bare `/profile` → `/@<h>/profile` (no MRU resolution, direct)
  - Bare `/settings` → `/@<h>/settings/vaults`
- **Redirect chain depth:** every legacy path resolves to its terminal in **at most 1 hop**. Assert via `fetch(url, { redirect: 'manual' })` returning 308 with `location` pointing to a non-redirecting URL.
- **Handle normalization round-trip:** `/@jm%40foo/profile` (if that's legal) normalizes the same way `scopedPath` does.
- **302 (not 308) for bare `/@<h>`** → MRU dashboard.
- **Login return-path:** unauthed request to `/@<h>/profile` → redirect to `/login?redirect=%2F%40<h>%2Fprofile`. After sign-in, land on `/@<h>/profile`.
- **Vault switcher:** on `/@<h>/profile`, switcher shows "Switch to vault…" placeholder (not an active vault chip).

### Rough order of operations

1. Add `normalizeHandle` + `userScopedPath` to `vault-context.ts`; add unit tests.
2. Add `middleware.ts` legacy redirect rules + tests (fetch with `redirect: 'manual'`).
3. Create new user-scoped page files (move, drop param, switch helper, update login return path).
4. Update bare `/profile` and `/settings/[[...rest]]` shims — drop MRU lookup.
5. Update `/@<h>` bare handle shim: 302 not 308.
6. Add empty-state `/@<h>/<v>/settings/page.tsx` ("Vault-level settings coming soon").
7. Update `header.tsx` / `useScopedLink`.
8. Update `vault-switcher.tsx` neutral state.
9. Delete old page files at `[vaultSlug]/profile` and `[vaultSlug]/settings/vaults`.
10. Run `route-structure.spec.ts`; run manual smoke: click profile from inside a vault, from outside a vault, via legacy bookmark, via email-link simulation.

## Pre-merge checklist (from red-team review)

Before merging, confirm:

- [ ] **Email invite templates** (from P8-B2) — audit every URL they embed. If any point at `/@<h>/<v>/profile` or `/@<h>/<v>/settings/*`, they'll still resolve via 308 but we should know the set.
- [ ] **OAuth redirect allowlists** — if any OAuth flow allowlists paths under `/@<h>/<v>/settings*`, update the allowlist or confirm the new canonical is already covered.
- [ ] **Analytics dashboards** — any queries keyed on `/@<h>/<v>/profile` or `/@<h>/<v>/settings*` path strings need updating to track the new canonical.
- [ ] **P8-B3 follow-up churn** — confirm `c9c7bb3` (handle normalization) and `b5cd77e` (settings 404) have been stable for ≥ 2 days before merging this on top.
- [ ] **Cache-Control on 308s** set to `max-age=3600` during rollout; tighten to longer after 1 week of no regressions.

## Migration & rollback

- All redirects are additive; old URLs continue to resolve via 308. Bookmarks and inbound links keep working.
- **308 caching trap:** if a legacy redirect target ever needs to be un-set, users with cached 308s are stuck. Mitigated by `max-age=3600` during rollout.
- Rollback: revert the PR. Middleware redirects and moved pages go together; old routes return to canonical location. No DB impact.
- No coordination required with the Grove backend team; pure `grove-www` PR.

## Success criteria

- `/@<h>/profile` and `/@<h>/settings/vaults` render correctly for the signed-in user.
- Legacy `/@<h>/<v>/{profile,settings/vaults}` 308 to user-scoped equivalents in exactly 1 hop, with query and fragment preserved.
- Bare `/profile` and `/settings` redirect straight to user-scoped canonical without MRU lookup.
- `/@<h>` (bare handle, signed-in) 302s to MRU vault dashboard (**not 308**).
- `/@<h>/<v>/settings` renders an empty-state page (does not redirect).
- Vault switcher on user-scoped pages shows neutral "Switch to vault…" state; clicking a vault navigates to `/@<h>/<chosen>/dashboard`.
- Login return-path round-trip lands user on the new canonical URL post-sign-in.
- All `test/route-structure.spec.ts` cases pass.
- Pre-merge checklist items completed.

## Open questions

None. Deferred items — account settings, cross-vault keys overview, vault-level settings (members, integrations, vault name), public profile — are intentionally out of scope and become future phases with their own specs.

## What this spec explicitly does NOT do

- Does not build `/@<h>/settings/account` (account settings page). No backend endpoint exists yet.
- Does not build `/@<h>/settings/keys` (cross-vault keys overview). Requires new `/v1/keys` endpoint scoped to user.
- Does not build vault-level settings pages (members, integrations, vault name). Separate scope.
- Does not introduce a public profile at `/@<h>`. Signed-in users land on MRU dashboard; unauthenticated visitors fall through to existing public-note handling at `/@<h>/<v>/<path>`.
- Does not change any backend API, database schema, or MCP protocol.

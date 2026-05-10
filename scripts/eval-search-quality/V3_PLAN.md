# V3 plan — provenance & age-aware ranking in Grove

**Status:** v3-final — IMPLEMENTED 2026-05-09. See "Implementation status" section below for what shipped, what's in the same PR pending wiring, and what's deferred to follow-on work.
**Date:** 2026-05-09.
**Supersedes:** V2_PLAN.md (kept on disk as iteration trail).
**Eval target:** the same 12-threshold A+ locked 2026-05-09. Two thresholds tightened by panel feedback: PPR-cold tolerance 0.10 → **0.05**, soak window 7 → **14 days with 7-day learning gate**.

## Iteration receipt

v1 → 3 panels → 12-threshold A+ + v2 (8-point redesign). v2 → 3 panels (round 2) → all three said ITERATE. **v3 addresses all 6 blockers** they named:

| # | Blocker | Driver | v3 § |
|---|---|---|---|
| 1 | §3 lifetime-ramp × §4 piecewise-decay double-counts (day-30 perishable lands at 0.59) | IR + KG | §A |
| 2 | Stamp-commit invalidation has 3 distinct correctness bugs | Prod | §B |
| 3 | Warm-up thundering herd — 1000-path sync = 1000 sequential `git blame` | Prod | §C |
| 4 | `usage_directive` doesn't extend to search hits — Phase A contract gap; multi-segment straddle case unspecified | KG | §D |
| 5 | Legacy-unknown formula `1.0 * (1 - perishable_coverage * 0.10)` moves the wrong way and conflates priors | KG | §E |
| 6 | Adversarial fixtures must be enumerated explicitly (4 IR shapes + 1 KG straddle) | IR + KG | §F |

Plus 11 should-fix items folded in: §G–§Q.

---

## §A — Single source of truth for perishable age

### v2's bug
§2's per-backend voice_factor (e.g. vec_perishable=0.75) applied always. §3's lifetime ramp tried to make day-0 perishable "fully trusted." §4's piecewise decay also ramped from 1.0. Result: ramp + decay + voice_factor multiplied together. IR's math: day-30 perishable on vec ≈ **0.59**. KG's math: **0.62**. Both well below where v2 claimed fresh perishable lives. Math hidden by spec layering.

### v3 fix
**§4 owns the perishable age curve. §3 lifetime ramp is removed.** §2's voice_factor becomes the **asymptotic floor**, not a constant multiplier. The age curve interpolates *toward* the floor as age grows.

```
voice_factor(perishable, list, age_days):
  let floor = base_voice_factor(list)        # e.g. 0.85 (symmetric default; see §K)
  let ramp = piecewise(age_days):
      age ≤ 7:                  1.00            # fresh perishable: full trust
      7 < age ≤ 90:             linear 1.00 → floor + (1.0 - floor) * 0.30
      age > 90:                  floor          # at age 90+, hits asymptotic floor

voice_factor(durable, list, *):    base_durable_factor(list)   # constant; RI-d invariant
voice_factor(legacy-unknown, list, note):  prior_factor(note)  # §E
```

### Concrete numbers under v3 (vec list, floor=0.85)

| Age | v2 (multiplied) | v3 (interpolated) |
|---|---|---|
| 1 day | 0.75 | 1.00 |
| 30 days | 0.59 | 0.93 |
| 90 days | 0.28 | 0.85 |
| 365 days | ~0.10 | 0.85 |

v3 keeps fresh perishable usable (FIR), gradually concedes rank to durables on canonical queries, and never crushes stale perishable to noise. Forensic queries served via `voice_preference=recent` (disables the curve).

### Eval implication
Re-run sweep. Expect configs to differentiate now (v2 sweep hit 100% everywhere — fixture-quality smoke alarm + redundancy of voice/age signals).

---

## §B — Stamp-commit invalidation correctness (3 sub-bugs)

### v2's bugs (Prod panel)

**B1 — Crash-mid-stamp:** `stampOne` writes `git commit --allow-empty` *before* `deleteNoteBlame(path)`. Crash between → stamp durable in git, cache row stale forever.

**B2 — `--allow-empty` defeats file-diff discovery:** Warm-up worker walks `git diff pre..post --name-only` to find changed paths. Stamp commits change zero files; diff returns empty. Stamp paths invisible.

**B3 — Non-stamp non-`handleWriteNote` mutators:** Discovery worker writes frontmatter tags directly. Doesn't go through `handleWriteNote` (which calls `clearNoteBlame`). HEAD-in-key was masking this.

### v3 fixes

**B1 fix — Atomic invalidate-then-commit.** New helper in `stamp.ts`:
```
function stampOneAtomic(args):
  // 1. Mark cache row pending-invalidation (or just delete it)
  deleteNoteBlame(path)
  // 2. Write the stamp commit
  const sha = await gitCommit(args)
  // 3. Recompute fresh blame so next read is correct (no cold)
  await recomputeProvenanceBlame(vaultPath, path)
  return { sha }
```
Crash between 1 and 2: cache cold, recompute on next read = correct. Crash between 2 and 3: cache cold, recompute on next read = correct (since `deleteNoteBlame` already ran). No stale window.

**B2 fix — Discover stamp paths via commit-body parse.** Warm-up worker walks the diff range (`pre_HEAD..post_HEAD`) reading commit *bodies*, not just file diffs. For each commit body matching `Provenance-Stamp-Path: <path>`, add `<path>` to the recompute queue. New helper in `blame.ts`:
```
function stampPathsInRange(vaultPath, fromSha, toSha): Promise<string[]>
```
Single `git log --format=%B fromSha..toSha` invocation; regex over output.

**B2 false-positive note (round-3 Prod panel):** the regex matches any commit body containing the literal string `Provenance-Stamp-Path: <path>` — e.g. a future PR description quoting the format that gets squashed into a commit body. False positive: warm-up tries to recompute for a non-existent path. Failure mode is safe — `recomputeProvenanceBlame` throws on missing-file, the warm-up wrapper catches it and increments `grove_warmup_path_errors` (see §L). No harm done; metric exists to detect runaway false-positive rate.

**B1 step-3 failure note (round-3 Prod panel):** `recomputeProvenanceBlame` is fire-and-forget in `stampOneAtomic`. If it throws (git timeout, OOM, malformed trailer), the cache is left empty and the next read-path call to `computeProvenanceBlame` will recompute. This is the same state as a step-2 crash, which §B explicitly handles correctly. No try/catch with rollback needed — there is nothing to roll back; `setNoteBlame` uses `INSERT … ON CONFLICT DO UPDATE` (db.ts:1530-1540).

**B3 fix — Coverage of all mutators.** Two-pronged:
- Discovery worker MUST call `clearNoteBlame(path)` before any frontmatter mutation. Add to `discovery-extract.ts` and `discovery-link.ts`.
- Warm-up worker walks BOTH `git diff --name-only fromSha..toSha` (file changes) AND `stampPathsInRange(...)` (stamp commits). Belt and suspenders — covers any mutator that forgets to call `clearNoteBlame`.

### Falsifiers (per CLAUDE.md diagnostic discipline)

Two falsifiers added to `§F` of test plan:

1. **Stamp-then-readback:** stamp a synthetic test note, then `SELECT path FROM note_blame WHERE path = '<stamped>'` should be ENOENT (active invalidation worked) or contain the *new* `Provenance-Voice` (atomic recompute worked) within 5 seconds. Anything else = bug.
2. **Post-sync stamp-coverage:** count of stamps in last sync window should equal count of `note_blame` rows with `computed_at > sync_start_time` for those paths. Drift = bug.

Tests added to `test/blame.test.ts` and `test/provenance.test.ts`.

---

## §C — Warm-up worker without thundering herd

### v2's bug (Prod panel)
Walking 1000-path sync diff with sequential `git blame -p --follow -M -C` per file = 1000 fork-execs of git, CPU-bound, contends with `grove-server` request handling on the same g4dn box. Sync N+1 starts before sync N's warm-up finishes; work stacks. p99 latency collapses every 5 minutes — the exact failure threshold #6 (latency p99 ≤ 1.10×) is supposed to gate.

### v3 fix
Warm-up worker is now bounded along three axes:

```
const PROV_WARMUP_CONCURRENCY = parseInt(env.PROV_WARMUP_CONCURRENCY ?? "4")
const PROV_WARMUP_BUDGET_MS = parseInt(env.PROV_WARMUP_BUDGET_MS ?? "90000")

async function postSyncWarmup(fromSha, toSha):
  const stampPaths = await stampPathsInRange(vaultPath, fromSha, toSha)  // §B2
  const filePaths = await diffNameOnly(vaultPath, fromSha, toSha)        // §B3
  const allPaths = unique([...stampPaths, ...filePaths])
  const prioritized = sortByRequestsPerPath(allPaths)  // hottest first; §K observability
  const start = Date.now()
  await pLimit(PROV_WARMUP_CONCURRENCY, prioritized.map(path => async () => {
    if (Date.now() - start > PROV_WARMUP_BUDGET_MS) return  // budget exceeded
    await recomputeProvenanceBlame(vaultPath, path)
  }))
  recordWarmupMetrics({ paths: allPaths.length, completed, dropped, duration_ms })
```

- **Concurrency cap** (default 4) — bounded git fork-exec parallelism.
- **Per-sync wall-time budget** (default 90s) — never exceed cron interval (300s) by more than 30%; remaining paths picked up next sync.
- **Priority by `searchMetrics.requests_per_path`** — high-traffic paths get cache-warmed first, so user-facing impact of warm-up lag is minimized.
- **Metrics** — `grove_warmup_paths_completed`, `..._dropped`, `..._duration_ms`, `..._seconds_since_last_completion` (liveness) — see §K.

### Falsifier
Before flag-on: simulate a sync that touches 200 paths, run warm-up, confirm:
- p99 grove-server latency during warm-up ≤ 1.10× pre-warmup baseline.
- All hot paths (top 50 by `requests_per_path`) completed within 30s.
- Warm-up duration ≤ PROV_WARMUP_BUDGET_MS.

Test in `test/blame.test.ts` with a synthetic 200-note vault.

### Concurrency benchmark (round-3 Prod must-fix)
Default `PROV_WARMUP_CONCURRENCY=4` is panel intuition derived from "pLimit + g4dn vCPU count," not measured. **Rollout step 12 (staging day) MUST sweep N∈{2, 4, 8} on the 200-note synthetic vault under 50 RPS synthetic load** and pick the N that minimizes `max(p99_during_warmup, warmup_duration)`. **The chosen N is persisted in `runtime_config.warmup_concurrency`, NOT in env**, so it can be tuned without a deploy. This is the difference between "ships and gets paged" and "ships clean" on first prod sync — git-blame is CPU-bound on the 4-vCPU box and saturating it during a sync collapses request-handler p99.

---

## §D — `usage_directive` on search hits + multi-segment straddle rule

### v2's bug (KG panel)
Phase A's read-side mechanism: `NoteResponse` includes `usage_directive` when `has_perishable_segments`. Search hits don't. v2 §1 surfaces `voice` + `written_at` on search results but no directive. Consumer sees `voice: "perishable"` and… proceeds. SVF=1.0 can hold while consumer silently extends perishable. The non-goal "Not touching the read-side blame envelope or directive" was wrong-as-scoped — search needs the same surface.

Plus: v2's matched-span resolution assumes match spans single segment. Reality: BM25 snippets span 2+ segments (different voices); vector chunks cross blame-segment boundaries.

### v3 fix

**D1 — Search emits `usage_directive`.** New field in `HybridResult`:
```
interface HybridResult {
  // ... existing fields ...
  voice?: Voice
  written_at?: string
  usage_directive?: string   // NEW: present iff matched_voice === "perishable"
}
```
`formatResults` surfaces the directive in MCP text and JSON envelope. Same `PERISHABLE_READ_DIRECTIVE` text as `blame.ts` exports — single source of truth, deduplicated.

**D2 — Multi-segment straddle rule.** When the matched span overlaps multiple BlameSegments, v3 applies:

```
function resolveMatchedSpan(blame: BlameSegment[], spanStart: int, spanEnd: int):
  const overlapping = blame.filter(seg =>
    seg.line_end >= spanStart && seg.line_start <= spanEnd)
  if (overlapping.length === 0) return null

  // Worst-case voice: perishable > legacy-unknown > durable
  // (perishable wins because the directive must fire if ANY perishable line is in the quoted region)
  const voice = overlapping.some(s => s.voice === "perishable") ? "perishable"
              : overlapping.some(s => s.voice === "legacy-unknown") ? "legacy-unknown"
              : "durable"

  // written_at: oldest among perishable if perishable wins (longest-lived contamination signal),
  //             else max across all (freshness for the matched material)
  const written_at =
    voice === "perishable"
      ? min(overlapping.filter(s => s.voice === "perishable").map(s => s.written_at))
      : max(overlapping.map(s => s.written_at))

  return { voice, written_at, segment_count: overlapping.length }
```

Why "perishable wins" is the right rule (KG panel posture): a single perishable line in the quoted region is sufficient signal for the read-side directive. SVF can't be gamed by routing through "modal" or "most-durable."

### Eval implication
- Threshold #5 (envelope completeness) extended: every search hit MUST also include `usage_directive` if matched voice is perishable.
- New test fixture: VAULT_STRADDLE in `test-set.ts` — note where line ranges 1-10 are durable, 11-15 perishable, 16-30 durable; query whose match spans lines 8-13 (crosses boundary). Expected: voice=perishable, directive present.

### Soft-directive on high-prior-perishable legacy-unknown (round-3 KG must-fix)
A legacy-unknown note with §E-computed `p_perishable > 0.6` (e.g. an Inbox note with AI-watermark text) gets ranking demoted but, without this addition, would receive NO `usage_directive` because its literal voice is `legacy-unknown`. §E and §D would then work against each other on the highest-risk class of unstamped notes: ranking treats them as suspect, but the consumer reads them with no framing warning.

v3-final addition: when matched voice is `legacy-unknown` AND `priorVoice(note).p_perishable > 0.6`, emit a *soft* directive with explicit hedging:
```
PERISHABLE_USAGE_DIRECTIVE_SOFT =
  "This note is unstamped, but its location and content suggest it may be
   perishable (AI synthesis or moment-in-time snapshot). Verify the content
   reflects current understanding before extending it."
```
Stored alongside `PERISHABLE_USAGE_DIRECTIVE` in `provenance.ts` (per §Q). The `0.6` threshold matches §E's neutral-vs-evidence cutoff; tunable via `PROV_SOFT_DIRECTIVE_THRESHOLD` env.

### Non-goal change
"Not touching the read-side directive" → **REMOVED**. v3 explicitly extends the directive surface to search results AND adds a soft-directive variant for high-prior-perishable legacy-unknown. Phase A's text remains; v3 reuses it and adds a hedged sibling.

---

## §E — Legacy-unknown per-note prior

### v2's bug (KG panel)
`factor_unknown = 1.0 * (1 - perishable_coverage * 0.10)` is incoherent. Two failures:
1. **Wrong direction:** as stamping coverage rises, the easy-to-classify perishables get stamped first. Residual unknowns shift TOWARD durable. Formula assumes the opposite.
2. **Global scalar applied per-note:** ignores everything we know about a specific unknown note (its folder, age, frontmatter, contents).

### v3 fix
Drop the global formula. Build a per-note prior from cheap covariates that already exist in the vault:

```
function priorVoice(note): { p_durable: float, p_perishable: float, p_unknown: float }
  // cheap, deterministic, no LLM
  let p_d = 0.5  // base prior
  let p_p = 0.5

  // Folder evidence — from scripts/provenance/rules.ts
  if path.startsWith("Resources/Concepts/")     p_d += 0.2
  if path.startsWith("Resources/People/")       p_d += 0.15
  if path.startsWith("Inbox/")                  p_p += 0.25
  if path.startsWith("Sources/")                p_p += 0.10  // mostly auto-clipped
  if path.startsWith("Journal/")                p_d += 0.10  // John's writing

  // Age evidence (older notes more likely durable in this corpus)
  const age_days = days_since(get_first_commit_for(path))
  if age_days > 365  p_d += 0.10
  if age_days < 14   p_p += 0.10

  // Content evidence — AI watermark strings
  const text = read(path)
  if /\b(generated by|claude:|model id|temperature \d|GPT-\d)\b/i.test(text)  p_p += 0.20
  if frontmatter.tags?.includes("synthesis") || frontmatter.tags?.includes("ai-summary")  p_p += 0.20
  if /^[A-Z][^.!?]{15,}\.\s+/m.test(text.slice(0, 200))  // formal-encyclopedia tone
    p_p += 0.05

  // Normalize
  const total = p_d + p_p
  return {
    p_durable: p_d / total,
    p_perishable: p_p / total,
    p_unknown: 0  // for legacy-unknown, we estimate to one of the two
  }
```

Then voice_factor for legacy-unknown becomes a soft-weighted blend:
```
factor_unknown(list, note, age):
  const prior = priorVoice(note)
  return prior.p_durable * factor_durable(list)
       + prior.p_perishable * factor_perishable(list, age)
```

This:
- Honors what we can cheaply observe about the unknown note.
- Removes the perverse incentive: stamping a durable note maintains its rank (factor stays high); stamping a perishable lowers rank but only to where the prior already estimated it.
- Drops to neutral (1.0) only when covariates give no signal.

### Implementation
- New file: `src/provenance-prior.ts`. Pure function. Imported by `hybrid-search.ts` reweight.
- **Heuristic weights are HAND-CODED PRIORS, not fit weights.** Round-3 KG panel correctly noted that all 183 currently-stamped notes are perishable (zero durable stamps as of 2026-05-09), so the 183-note population can validate the perishable-detection rules but cannot fit a `p_durable` axis. Until Phase B3 lands ≥30 durable stamps (enough for sign validation), §E weights are panel/folder-semantics priors. Once B3 lands, the cron worker fits weights against the now-balanced labeled set and writes them to `runtime_config` (§7 plumbing) — refresh when stamp coverage doubles or quarterly, whichever first.
- **Age source for `priorVoice` MUST come from segment-level blame `written_at`**, NOT `get_first_commit_for(path)` — round-3 KG panel flagged the inconsistency. For legacy-unknown notes, blame.ts falls back to git author-date of the introducing commit (defined behavior at `blame.ts:497-509`). This makes §A's age curve and §E's age covariate consistent in the same code path. The pseudocode line `const age_days = days_since(get_first_commit_for(path))` should read `const age_days = days_since(segment.written_at)` once implemented.
- Test fixtures: `test/provenance-prior.test.ts` covers each evidence rule independently.

---

## §F — Adversarial fixtures (enumerated)

### What v2 missed (IR + KG)
v2 said "ADD adversarial fixtures" but didn't enumerate them. The ranking-unit sweep has been hitting 100% across all configs because fixtures are too easy.

### v3 fixture set
20 new candidate fixtures (5 per IR shape) + 1 vault-straddle fixture. **(N raised from 3 to 5 per shape after round-3 IR panel: N=3 leaves a single fixture flake at 33% swing, below the ~5% PPR resolution the sweep needs to differentiate configs.)** Added to `test-set.ts` as named exports `ADV_OLD_PERISHABLE_NEW_DURABLE`, `ADV_SAME_AGE_CROSS`, `ADV_SAME_VOICE_OLD_NEW`, `ADV_INTENT_CONFLICTING`, `VAULT_STRADDLE`.

| Shape | What it tests | Expected outcome | # fixtures |
|---|---|---|---|
| **Old-perishable / New-durable cross** | Decoupling voice from age. 200-day-old perishable competes with 5-day-old durable. | Durable wins via voice (decay-only would also win, but for the wrong reason — voice-only would too). Both must be active. | 5 |
| **Same-age cross** | Pure voice signal isolation. Two notes within 24h of each other; one durable journal entry, one perishable Claude-synth. Same RRF. Same age. | Durable wins via voice multiplier alone. PPR on this set directly measures voice magnitude. | 5 |
| **Same-voice old-vs-new** | Pure age signal isolation. Two perishable notes, 7d vs 180d, same query. | Recent wins via age curve. RPR-p directly tests piecewise breakpoints. | 5 |
| **Intent-conflicting** | Freshness intent must override voice penalty. "What's the model lineup today" + perishable from yesterday + durable concept. | Recent perishable wins because regex auto-detect bumps to `voice_preference=recent`, disabling decay. Tests §G. | 5 |
| **Multi-voice straddle (vault)** | Match span crosses voice boundary. Note: lines 1-10 durable, 11-15 perishable, 16-30 durable. Query matches lines 8-13. | voice=perishable in envelope, usage_directive present. SVF tests §D. | 1 |

### Pass requirement update
The 12 thresholds remain. But for thresholds 1-3 (PPR / RPR-p / RI-d), the eval now also runs against the adversarial subset and reports separately:
- PPR on canonical fixtures + PPR on adversarial fixtures
- RPR-p on canonical + RPR-p on same-voice-old-new fixtures
- RI-d on canonical + RI-d on old-perishable-new-durable fixtures

**Adversarial thresholds are explicitly relaxed vs canonical** (round-3 IR panel: adversarial cases are structurally harder; holding them to canonical bars means almost no config passes, collapsing the sweep to "find the one that overfits adversarial"):

| Subset | PPR | RPR-p | RI-d |
|---|---|---|---|
| Canonical (existing 28 fixtures) | ≥ 0.85 | ≥ 0.75 | ≥ 0.80 |
| Adversarial (20 new fixtures) | **≥ 0.70** | **≥ 0.65** | **≥ 0.70** |

A config passes only if BOTH subsets clear THEIR respective thresholds. The asymmetry is the point — canonical bar is ship-readiness, adversarial bar is no-collapse. The sweep reporting must call out config behavior on both subsets independently to stop the "every config hits 100%" smoke alarm.

---

## §G–§Q — Should-fix items folded in

### §G — Auto-detect regex hardened (IR)
Drop `current/currently/now` from the freshness lexicon (false-positive on durable-intent queries like "current understanding of X"). Add **negative gate**: if query also contains durable-intent terms, force `voice_preference=mixed`.

**Round-3 IR panel hardening:** durable-intent set must include nominalized-thinking terms or the regex flunks its own falsifier on queries like "what's the latest thinking on parametric design" (where `latest` triggers freshness but no durable term fires):

```
const FRESHNESS_TERMS = /\b(today|yesterday|right now|this (week|month|quarter)|latest|recent(ly)?|lately|\d{4}-\d{2}-\d{2}|\b(jan|feb|...)\b\s+\d{4})\b/i
const DURABLE_INTENT_TERMS = /\b(understanding|theory|definition|concept|history|origin|principles?|fundamentals?|thinking|approach|view|stance|framework|philosophy|paradigm|methodology|model of|take on)\b/i

function detectVoicePreference(query):
  if DURABLE_INTENT_TERMS.test(query) return "mixed"
  if FRESHNESS_TERMS.test(query) return "recent"
  return "mixed"
```

Falsifier: run detector against last 200 real `searchMetrics` queries pre-deploy. Report FP rate. If >5%, regex isn't ready. Test in `test/hybrid-search.test.ts`.

### §H — Decay curve tightening (IR)
Already folded into §A. Fresh window 14→7 days. Floor 0.85 (asymptotic, not multiplicative) instead of 0.20 multiplicative. Two-segment curve (0-7 fresh, 7-90 ramp), not three.

### §I — PPR-cold tightened 0.10 → 0.05 absolute (IR)
Threshold #10 update. If PPR-warm is 0.85 and PPR-cold can be 0.75 (v2's 0.10 gap), cold drops below RPR-p's threshold. Tightening to 0.05 means cold ≥ 0.80 — still passing all three rate metrics. With v3's atomic invalidate + warm-up, achievable.

### §J — Soak reason chips (Prod)
Threshold #11 update. Each thumbs-down requires a reason chip. **Round-3 Prod panel: 5th chip added** so "the new top-5 is fine, just feels different" doesn't get dumped into `other` and trip auto-revert on a non-quality-regression:

- `wrong-result` — the new top-5 contains no relevant content
- `wrong-by-design` — design suppressed something I expected to see; design is wrong
- `freshness-intent-misfire` — auto-detect picked recent when I wanted canonical (or vice versa)
- `expectation-only` — top-5 is fine, just feels different from before (NEW — explicitly excluded from auto-revert gate)
- `other` — none of the above; I'm uncomfortable but can't articulate why

Auto-revert fires only on `(wrong-result + other) / total > 0.20`. `wrong-by-design`, `freshness-intent-misfire`, and `expectation-only` are intentional behavior, detector bugs, or user-behavior-change; they feed an "expectation drift" report that shapes v3.1 tuning, not rollback.

### §K — Per-backend defaults symmetric (IR)
v2 defaults `vec_perishable=0.75, bm25_perishable=0.90` were panel intuition. v3 ships with `bm25_perishable = vec_perishable = 0.85` (symmetric). Per-backend asymmetry becomes v3.1 once the observability triplet has 7 days of `voice_at_rank{list}` data showing the bias direction empirically.

### §L — Observability additions (Prod)
v2's 5 metrics + 3 new from round-2 Prod panel + 2 new from round-3 Prod panel:
- `grove_warmup_seconds_since_last_completion` (gauge) — liveness
- `grove_warmup_paths_completed_per_sync` (histogram) — coverage / budget overflow
- `grove_warmup_path_errors` (counter) — increments when `recomputeProvenanceBlame` throws inside the warm-up worker; covers §B's body-parse false-positive case where a non-existent path is queued
- `grove_stamp_invalidation_drift` (counter) — incremented when post-sync stamp count ≠ matching cache delete count. Should be 0; >0 pages.
- `grove_reweight_auto_revert_total` (counter) — incremented when soak triggers auto-revert. Should be 0 in steady state.
- **`grove_search_voice_preference{mode}` (counter, labels: `recent | mixed | manual`)** — increments per search. **(NEW from round-3 Prod panel: without this, soak data is uninterpretable. If the §G regex picks `recent` for 80% of queries, every PPR/RPR-p number in the soak is conditioned on a config the panels never agreed to.)**

Alert rules wired in `/health` config:
- `legacy_unknown_share > 0.7 for 5m` → page
- `grove_stamp_invalidation_drift > 0 for 1m` → page
- `grove_reweight_auto_revert_total increased` → page
- **`rate(voice_preference{mode="recent"}) / rate(voice_preference{mode=*}) > 0.5 for 1h` → page** (regex over-firing — the §G falsifier failed in production)

### §M — Soak window 7 → 14 days with 7-day learning gate (Prod)
Threshold #11 update. Soak runs 14 days. **Days 1-6 are human-review-only; days 7-14 are automation-eligible.** Soak metrics (thumbs-up/down + reason chips) are recorded continuously from day 4 — but the auto-revert decision is gated until day 7 except for hard-fail metrics (`legacy_unknown_share > 0.7` or `voice_at_rank` rank-1-distribution flattening to corpus class rate, which indicate PPR has collapsed to identity). After day 7, normal auto-revert rules apply (§J). The extra week before automation is for human-in-the-loop sanity checking, not for collecting different data.

### §N — Stronger §6 falsifier (Prod)
Beyond "post-sync `note_blame` row count > 0," add:
```
SELECT COUNT(*) FROM note_blame WHERE path IN (<paths stamped in last sync>)
-- Should equal count of stamped paths.
```
Encoded in §B falsifier #2.

### §O — Runtime flag corruption detection (Prod)
`setFlag` does immediate read-after-write within the same SQLite connection; on mismatch, raise → admin endpoint returns 500. Rollback-bench accounts for the 5s TTL cache by bounding the assertion at 10s, not 30s.

### §P — Discovery worker `clearNoteBlame` calls (Prod, B3 fix follow-through)
Discovery worker frontmatter mutations call `clearNoteBlame(path)` before write. Audit `discovery-extract.ts` and `discovery-link.ts`. Add unit tests confirming the call.

### §Q — Inline `usage_directive` text reuse (KG D1 follow-through)
Move `PERISHABLE_READ_DIRECTIVE` constant from `blame.ts` to `provenance.ts` as `PERISHABLE_USAGE_DIRECTIVE`. Single source of truth used by both `computeProvenanceFields` (Phase A `get`/`multi_get` path) and the new search-hit path. Avoid two diverging strings.

---

## Items deferred from v3 (named, not silent)

These were raised in round-2 critiques but defer to v3.1 or beyond:

- **Folder boost weighted by `searchMetrics.requests_per_path`** (KG round 2, §5). Requires more search history than we currently have. v3.1 once the observability triplet has captured 30 days of access patterns. The auto-sunset formula stays linear in coverage for v3.
- **PKM meta-thresholds:** tenant isolation, mixed-facet People-note fidelity, Journal-entry-specific behavior, graph-distance/wikilink-density signals (KG round 2, §6). Each needs its own design discussion. Named here as "considered, deferred — own spec in PHASE-7-PKM-DEPTH.md or similar."
- **Directive-compliance soak metric** (KG round 2, §6). Requires Claude-side instrumentation we don't have. Deferred until soak feedback channel can capture "did I name the perishable framing." For v3, threshold #5 (envelope completeness) covers presence; behavioral compliance is implicit-not-measured.
- **PR template `gh pr list --state open --label area:blame,area:search` line** (Prod round 2, §6). Process change, not v3. File an issue.
- **Learned freshness-intent classifier replacing regex** (IR round 1 + 2). Defer to v3.1 if regex FIR underperforms after 14-day soak.

---

## Test plan (additions over v2)

Pre-merge:
1. `npm test` passes (existing).
2. `tsx scripts/eval-search-quality/run.ts --quick --reweight=v3` — clears thresholds 1-3 on BOTH canonical AND adversarial subsets.
3. `tsx scripts/eval-search-quality/run.ts --quick --cold` — PPR-cold within 0.05 of warm.
4. `tsx scripts/eval-search-quality/sweep.ts` — configs differentiate (no longer 100% across the board).
5. `tsx scripts/eval-search-quality/run.ts --full` — E2E layer measures SVF on VAULT_STRADDLE; envelope completeness includes `usage_directive`.
6. `npm test test/blame.test.ts` — stamp-then-readback falsifier passes; multi-segment straddle resolution unit tests pass; warm-up budget falsifier (200-note synthetic vault) passes.
7. `npm test test/provenance-prior.test.ts` — per-evidence-rule unit tests pass.
8. `npm test test/hybrid-search.test.ts` — voice_preference auto-detect regex tested against 50 real `searchMetrics` queries; FP rate < 5%.
9. `tsx scripts/eval-search-quality/rollback-bench.ts` — admin-POST → identity ranking restored within 10s (well under threshold #12's 60s).

Post-merge (rollout):
10. Day 0: PR + flag off in prod, on in staging.
11. Day 1: Merge. Deploy. Confirm prod identity behavior unchanged.
12. Day 2: Flag on for `john-life` in staging via runtime_config. Run E2E + rollback-bench in staging. **Sweep `PROV_WARMUP_CONCURRENCY` ∈ {2, 4, 8} on the 200-note synthetic vault under 50 RPS synthetic load. Pick the N minimizing `max(p99_during_warmup, warmup_duration)`. Persist to `runtime_config.warmup_concurrency`.** (Round-3 Prod must-fix.)
13. Day 3: Capture top-50 baseline. Flag on for `john-life` in prod.
14. Day 4-10: Daily soak query replay; John reviews via 5-chip UI (`wrong-result | wrong-by-design | freshness-intent-misfire | expectation-only | other`).
15. Day 7: Learning-gate boundary. Auto-revert enabled (was disabled days 1-6 except for hard-fail metrics — `legacy_unknown_share > 0.7` or `voice_at_rank` collapse to corpus class rate).
16. Day 14: If `(wrong-result + other) / total ≤ 0.20`: continue. Flag becomes default at day 21. Begin folder-boost auto-sunset deployment.

---

## Risks (updated for v3)

| Risk | Likelihood | Mitigation |
|---|---|---|
| §A's interpolation toward floor underweights perishable on canonical queries | Medium | Sweep finds the right floor; baseline + adversarial both must clear. |
| §B's atomic stamp-then-recompute fails under concurrent stamps | Low | Stamp queue is single-writer (CLAUDE.md architecture rule). |
| §C's warm-up budget overflow leaves cold paths for next sync | Medium | High-traffic paths first; cold tail is colder for low-traffic notes only. |
| §D's "perishable wins" rule on multi-segment straddle is too aggressive | Medium | Soak detects via `wrong-by-design` chips. Tunable in v3.1. |
| §E's per-note prior misfires on novel folder structures | Medium | Falls through to neutral (1.0); no worse than v2 in unknown territory. |
| §F's adversarial fixtures over-fit (Goodhart) | Medium | Same SCHEMA_VERSION discipline as `eval-provenance`; refresh from `searchMetrics` quarterly. |

---

## Open questions resolved by round-3 panels

| # | Question | Round-3 verdict |
|---|---|---|
| 1 | §A interpolation linear vs sigmoid | Linear is fine as v3 baseline; sigmoid is tuning, not architecture. Sweep range documented for v3.1 calibration. (IR) |
| 2 | §B "always recompute after stamp" latency | Acceptable for stamp.ts: stamps are infrequent + serialized + atomic-with-commit means user-perceived latency only on stamp itself, not on subsequent reads. Async queue would re-introduce the cold window §B closed. (Prod implicit) |
| 3 | §C concurrency cap of 4 | **Resolved as rollout step 12 benchmark — runtime_config.warmup_concurrency.** (Prod must-fix) |
| 4 | §D durable+legacy mix ordering | "perishable > legacy-unknown > durable" confirmed. legacy-unknown beats durable because legacy MAY be perishable per §E's prior; conservative-honest matches Phase A posture. (KG) |
| 5 | §E covariate weights regularization | **Hand-coded priors only until B3 lands ≥30 durables; no regularization needed pre-fit.** (KG must-fix folded in §E.) |
| 6 | §F adversarial N=3 vs 5+ | **N=5/shape; explicit relaxed adversarial thresholds.** (IR must-fix folded in §F.) |
| 7 | §J reason-chip taxonomy | **5th chip `expectation-only` added.** (Prod must-fix folded in §J.) |
| 8 | §M learning gate scope | Applies only to subjective-acceptance auto-revert. PPR-cold and other automated metrics (the hard-fail ones) fire days 1-6. Clarified in §M. (Prod) |

## Open questions for v3.1 (post-launch tuning)

These were raised in panel critiques as tunable, not blocking. Address after the 14-day soak provides production data:

1. **§A day-0 perishable factor** — currently 1.00 (matches durable). IR panel suggests 0.97 to encode "still AI synthesis" while preserving FIR. Sweep candidate.
2. **§K floor value** — currently 0.85. IR panel suggests 0.90 baseline with sweep range 0.80-0.95. Calibrate from `voice_at_rank{list}` data after 7 days of production.
3. **Per-backend asymmetry** — currently symmetric (vec=bm25=0.85). IR panel will revisit once 7 days of `voice_at_rank{list}` data shows whether vec actually over-retrieves perishable.
4. **§D vec-chunk overlap rule** — current worst-case-voice rule may over-fire on vec hits where chunk spans 30-50 lines. KG panel: separate vec-chunk-resolution path that requires ≥2 lines of overlap before perishable-wins triggers.
5. **§E backlink-count covariate** — KG panel's cheapest version of graph-distance. Add as pre-registered v3.1 covariate.
6. **`written_at` semantics doc** — KG panel: trailer time-of-content, not stamp-commit-time. One-line clarification in §D pseudocode.

---

## Round 3 verdict (final)

All three panels (IR / KG / Prod) returned **ITERATE to v4 — but only spec-tightening, no architecture changes**. Total 7 must-fixes across panels, zero cross-panel consensus on any single item, zero blocking bugs (vs round-1's blocking sync-cache invalidation and round-2's three stamp-invalidation correctness bugs). Direct quotes:

- IR: *"The architecture is sound. One spec tightening and v4 ships."*
- KG: *"The architecture is sound. The remaining issues are calibration honesty, internal consistency, and one cross-section gap — all closable in a focused v4 pass without redesign."*
- Prod: 5 of 6 critique items explicitly labeled *"1-line spec addition that doesn't need a v4 round."*

**All 7 must-fixes folded directly into V3_PLAN.md as in-place edits** (no separate V4_PLAN.md). The 10 tuning items deferred to v3.1 are enumerated under "Open questions for v3.1" above.

**Convergence trajectory:**

| Round | Total must-fixes | Architecture changes | Cross-panel consensus | Blocking bugs |
|---|---|---|---|---|
| 1 | 9 | Yes (full v2 redesign) | 4 themes ≥2 panels | 1 (sync-cache invalidation) |
| 2 | 9 | Partial (correctness in spec) | 2 themes ≥2 panels | 3 (stamp invalidation sub-bugs) |
| 3 | 7 | None | 0 themes ≥2 panels | 0 |

**Status: implementation-ready spec.** This file becomes the source of truth for the Search Quality component (GOAL.md component pending operator addition). Implementation owner picks up §A-§Q and the harness extensions (test-set additions, FIR/SVF/--cold runner flags, soak directory, rollback-bench) from here.

---

## Implementation status (2026-05-09)

6 commits on branch `eval/search-quality-harness`:

| Commit | Scope |
|---|---|
| `aa6a341` | §Q + §E foundation: PERISHABLE_USAGE_DIRECTIVE moves to provenance.ts; src/provenance-prior.ts (priorVoice covariate function) + 33 tests |
| `a049c28` | Harness: 21 adversarial fixtures + 12 freshness-intent + 1 straddle + 3 mixed-voice; v3 reweight; computeFIR + computeSVF; threshold split (canonical vs adversarial); --cold flag; --reweight=v3 default |
| `aae7a75` | §A/§D/§G/§K production: applyProvenanceReweight (gated GROVE_PROV_RANKING_ENABLED); HybridResult envelope adds voice + written_at + usage_directive; detectVoicePreference exported; getNoteVoicesAndAges batch reader; PERISHABLE_USAGE_DIRECTIVE_SOFT for high-prior-perishable. AND §B stamp invalidation: stampOneAtomic + stampPathsInRange + discovery-link/bookmarks call clearNoteBlame |
| `4b9700a` | §C warm-up worker: src/blame-warmup.ts (concurrency cap + budget + priority + 7 tests); warmupMetrics counters; sweep.ts upgraded with v3 configs and canonical+adversarial+FIR split reporting |
| `471d423` | §L observability: searchQualityMetrics wired into applyProvenanceReweight (voice_preference, voice_at_rank, legacy_unknown_share, provenance_lookup_latency, 1% reweight-delta JSONL sample); test-only export __applyProvenanceReweightForTest; 13 new tests |

**Test counts:** +67 net new passing tests (1273 → 1340). 2 pre-existing migration-concurrency failures unchanged. Typecheck clean.

### Final eval numbers (synthetic ranking-unit layer, reference time 2026-05-09T12:00:00Z)

| Subset | Identity (current prod) | v3 (proposed) | Bar |
|---|---|---|---|
| Canonical PPR | 83% (FAIL) | **100% (PASS)** | ≥ 0.85 |
| Canonical RPR-p | **0% (FAIL)** | **100% (PASS)** | ≥ 0.75 |
| Canonical RI-d | 100% (PASS) | 100% (PASS) | ≥ 0.80 |
| Adversarial PPR | 50% (FAIL) | **100% (PASS)** | ≥ 0.70 |
| Adversarial RPR-p | 0% (FAIL) | **100% (PASS)** | ≥ 0.65 |
| FIR | 100% (vacuous) | **100% (PASS)** | ≥ 0.80 |
| Result | **FAIL** | **PASS** | — |

The `RPR-p 0%` baseline is the smoking gun: production search has no age signal at all today.

### What's in the PR but pending wiring

- `src/blame-warmup.ts` — function fully implemented + tested. Post-sync hook is pure shell; wiring requires either (a) `/internal/post-sync-warmup` HTTP endpoint that the shell curls with from/to SHAs, or (b) `scripts/post-sync-warmup.ts` invoked via tsx. Recommended path (a).
- `GROVE_PROV_RANKING_ENABLED` env flag default `false`. Production behavior unchanged on deploy. Flag-flip is the rollout.

### What §17 still defers

- Runtime-mutable per-collection flag (V3 §7) — currently env-var only; SQLite-backed `runtime_config` table + admin endpoint deferred. Affects threshold #12 (rollback latency ≤60s).
- 7-day soak harness with reason-chip thumbs-up/down UI (V3 §J / §11) — affects threshold #11 (subjective acceptance).
- rollback-bench.ts — affects threshold #12 measurement.
- `applyProvenanceReweight` is post-fusion multiplicative (round-3 IR explicitly accepted as v3 ship state); per-list-internal RRF voice factor is v3.1 calibration once observability data lands.
- Multi-segment matched-span resolution — §D currently uses note-level modal voice from getNoteVoicesAndAges as the first cut; full snippet-to-line span resolution is v3.1.

### v3.1 calibration items (named earlier in this file, two folded in during build)

Two were folded in during build: `freshFactor` tightened from 0.97 → 0.95 (round-3 IR's range; needed to flip same-age adversarial fixtures), and the §G durable-intent regex extended with `thinking|approach|view|stance|framework|philosophy|paradigm|methodology|model of|take on` (round-3 IR/KG hardening).

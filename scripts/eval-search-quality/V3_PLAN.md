# V3 plan — provenance & age-aware ranking in Grove

**Status:** v3 draft, pre-panel-review-round-3.
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

### Non-goal change
"Not touching the read-side directive" → **REMOVED**. v3 explicitly extends the directive surface to search results. Phase A's text remains; v3 reuses it.

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
- Heuristic weights (the 0.2, 0.15 etc.) calibrated once on the 183 stamped notes; refresh when stamp coverage doubles or quarterly, whichever first. Cron worker writes weights to `runtime_config` table (§7 plumbing).
- Test fixtures: `test/provenance-prior.test.ts` covers each evidence rule independently.

---

## §F — Adversarial fixtures (enumerated)

### What v2 missed (IR + KG)
v2 said "ADD adversarial fixtures" but didn't enumerate them. The ranking-unit sweep has been hitting 100% across all configs because fixtures are too easy.

### v3 fixture set
12 new candidate fixtures (3 per IR shape) + 1 vault-straddle fixture. Added to `test-set.ts` as named exports `ADV_OLD_PERISHABLE_NEW_DURABLE`, `ADV_SAME_AGE_CROSS`, `ADV_SAME_VOICE_OLD_NEW`, `ADV_INTENT_CONFLICTING`, `VAULT_STRADDLE`.

| Shape | What it tests | Expected outcome | # fixtures |
|---|---|---|---|
| **Old-perishable / New-durable cross** | Decoupling voice from age. 200-day-old perishable competes with 5-day-old durable. | Durable wins via voice (decay-only would also win, but for the wrong reason — voice-only would too). Both must be active. | 3 |
| **Same-age cross** | Pure voice signal isolation. Two notes within 24h of each other; one durable journal entry, one perishable Claude-synth. Same RRF. Same age. | Durable wins via voice multiplier alone. PPR on this set directly measures voice magnitude. | 3 |
| **Same-voice old-vs-new** | Pure age signal isolation. Two perishable notes, 7d vs 180d, same query. | Recent wins via age curve. RPR-p directly tests piecewise breakpoints. | 3 |
| **Intent-conflicting** | Freshness intent must override voice penalty. "What's the model lineup today" + perishable from yesterday + durable concept. | Recent perishable wins because regex auto-detect bumps to `voice_preference=recent`, disabling decay. Tests §G. | 3 |
| **Multi-voice straddle (vault)** | Match span crosses voice boundary. Note: lines 1-10 durable, 11-15 perishable, 16-30 durable. Query matches lines 8-13. | voice=perishable in envelope, usage_directive present. SVF tests §D. | 1 |

### Pass requirement update
The 12 thresholds remain. But for thresholds 1-3 (PPR / RPR-p / RI-d), the eval now also runs against the adversarial subset and reports separately:
- PPR on canonical fixtures + PPR on adversarial fixtures
- RPR-p on canonical + RPR-p on same-voice-old-new fixtures
- RI-d on canonical + RI-d on old-perishable-new-durable fixtures

A config passes only if BOTH subsets clear the threshold. This is what stops the "every config hits 100%" smoke alarm.

---

## §G–§Q — Should-fix items folded in

### §G — Auto-detect regex hardened (IR)
Drop `current/currently/now` from the freshness lexicon (false-positive on durable-intent queries like "current understanding of X"). Add **negative gate**: if query also contains `understanding|theory|definition|concept|history|origin|principles?|fundamentals?`, force `voice_preference=mixed`.

```
const FRESHNESS_TERMS = /\b(today|yesterday|right now|this (week|month|quarter)|latest|recent(ly)?|lately|\d{4}-\d{2}-\d{2}|\b(jan|feb|...)\b\s+\d{4})\b/i
const DURABLE_INTENT_TERMS = /\b(understanding|theory|definition|concept|history|origin|principles?|fundamentals?)\b/i

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
Threshold #11 update. Each thumbs-down requires a reason chip:
- `wrong-result` — the new top-5 contains no relevant content
- `wrong-by-design` — design suppressed something I expected to see; design is wrong
- `freshness-intent-misfire` — auto-detect picked recent when I wanted canonical (or vice versa)
- `other`

Auto-revert fires only on `(wrong-result + other) / total > 0.20`. The other categories are intentional behavior or detector bugs; they trigger a separate "expectation drift" report that shapes v3.1 tuning, not rollback.

### §K — Per-backend defaults symmetric (IR)
v2 defaults `vec_perishable=0.75, bm25_perishable=0.90` were panel intuition. v3 ships with `bm25_perishable = vec_perishable = 0.85` (symmetric). Per-backend asymmetry becomes v3.1 once the observability triplet has 7 days of `voice_at_rank{list}` data showing the bias direction empirically.

### §L — Observability additions (Prod)
v2's 5 metrics + 3 new from round-2 Prod panel:
- `grove_warmup_seconds_since_last_completion` (gauge) — liveness
- `grove_warmup_paths_completed_per_sync` (histogram) — coverage / budget overflow
- `grove_stamp_invalidation_drift` (counter) — incremented when post-sync stamp count ≠ matching cache delete count. Should be 0; >0 pages.
- `grove_reweight_auto_revert_total` (counter) — incremented when soak triggers auto-revert. Should be 0 in steady state.

Alert rules wired in `/health` config:
- `legacy_unknown_share > 0.7 for 5m` → page
- `grove_stamp_invalidation_drift > 0 for 1m` → page
- `grove_reweight_auto_revert_total increased` → page

### §M — Soak window 7 → 14 days with 7-day learning gate (Prod)
Threshold #11 update. Soak runs 14 days. **Auto-revert disabled before day 7** unless `legacy_unknown_share > 0.7` or `voice_at_rank` rank-1-distribution flattens to corpus class rate (i.e. PPR collapsed to identity). After day 7, normal auto-revert rules apply (§J).

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
12. Day 2: Flag on for `john-life` in staging via runtime_config. Run E2E + rollback-bench in staging.
13. Day 3: Capture top-50 baseline. Flag on for `john-life` in prod.
14. Day 4-10: Daily soak query replay; John reviews via reason-chip UI.
15. Day 7: Learning-gate boundary. Auto-revert enabled (was disabled days 1-6 except for hard-fail metrics).
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

## Open questions for v3 panels

1. **§A interpolation shape** — linear from day-7 to day-90 toward the floor. Is linear right, or should it be sigmoid? At what point does the perishable curve intersect the durable factor (currently ~day-30 if floor=0.85 and durable_factor=1.0)?

2. **§B "always recompute after stamp"** adds latency to every stamp commit. With 183 existing stamps + B3 backfill bringing potentially thousands more, is the recompute cost in stamp.ts acceptable? Or should recompute be queued asynchronously?

3. **§C concurrency cap of 4** — empirically derived from "pLimit + g4dn vCPU count"? Should be benchmarked, not chosen.

4. **§D "perishable wins" rule** — KG panel posture. But durable+legacy mix: does legacy-unknown win? v3 says yes (perishable > legacy > durable). Right ordering?

5. **§E covariate weights** — calibration on 183 notes. Is this enough labeled data? Should the rule weights be regularized (e.g., max contribution per evidence = 0.15 to prevent any single rule from dominating)?

6. **§F adversarial fixture realism** — are 3 per shape enough to be robust against tuning, or is 5+ needed?

7. **§J reason-chip taxonomy** — 4 categories proposed. Missing one for "query understood but ranking is just wrong, can't say why?"

8. **§M 14-day soak with 7-day learning gate** — does the 7-day gate also apply to PPR-cold and other automated metrics, or only to subjective acceptance?

---

## What I'm asking the v3 panels

Same three lenses. Specifically:

- **IR/ranking:** does §A's interpolation shape solve the double-counting cleanly? Are §F's adversarial fixtures structured the right way?
- **KG/semantic-memory:** does §D's worst-case-voice rule honor Phase A's contract? Is §E's covariate set the right starting point or are there critical evidence sources missing?
- **Production:** does §B's atomic-then-recompute close the cache-invalidation gap? Is §C's budgeted concurrent warm-up safe under realistic load? Is §J's reason-chip taxonomy implementable in the soak UI?

Goal of round 3: **SHIP decision**. If panels agree v3 is structurally complete, this becomes the implementation spec. If structural issues remain, v4 closes them — but at this point I expect the remaining work to be tuning, not architecture.

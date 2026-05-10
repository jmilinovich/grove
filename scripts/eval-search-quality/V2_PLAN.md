# V2 plan — provenance & age-aware ranking in Grove

**Status:** v2 draft, pre-panel-review-round-2.
**Date:** 2026-05-09 (same day as v1 — panels ran fast).
**Supersedes:** V1_PLAN.md (kept on disk as iteration trail).
**Eval target — refined A+ (12 thresholds, locked 2026-05-09):**

| # | Metric | Target | Source |
|---|---|---|---|
| 1 | **PPR** — durable > perishable on dual-match | ≥ 0.85 | original A+ |
| 2 | **RPR-p** — recent > stale on perishable | ≥ 0.75 | original A+ |
| 3 | **RI-d** — relevance > age on durable | ≥ 0.80 | original A+ |
| 4 | **Δ p@5 / Δ MRR per voice** — no concentrated regression | ≥ −0.02 each | original A+, refined per-voice |
| 5 | **Envelope completeness** — voice + written_at on every hit | = 1.00 | original A+ |
| 6 | **Latency** — p99 within 1.10× pre-flag baseline | ≤ 1.10× | original A+ |
| 7 | **Tunability** — sweep across configs in one command | binary | original A+ |
| 8 | **FIR** — Freshness-Intent Recall on date-bearing queries | ≥ 0.80 | new (IR + KG panels) |
| 9 | **SVF** — Segment Voice Fidelity in result envelope | ≥ 0.95 | new (KG + IR panels) |
| 10 | **PPR-cold** — PPR within 0.10 absolute of warm PPR right after cache flush | ≤ 0.10 abs gap | new (Prod panel — blocking finding) |
| 11 | **Subjective acceptance** — 7-day soak on John's top-50 queries, "same or better" rate | ≥ 0.80 | new (Prod panel) |
| 12 | **Rollback latency** — admin kill-switch to identity ranking restored | ≤ 60 s | new (Prod panel) |

**All 12 must hold simultaneously.** This is the bar v2 is designed against.

---

## Goal (unchanged from v1)

Surface what John would actually trust as true. Durable > perishable on dual-match. Recent > stale on perishable. Relevance > age on durable. AND don't break the queries where perishable IS the right answer ("what's the model lineup today"). AND surface the matched span's voice, not the modal note voice. AND don't silently degrade after every cron sync.

## Non-goals (unchanged)

- Not changing what BM25 / vector / title backends return as candidates.
- Not adding new MCP tools.
- Not touching the read-side blame envelope or directive (Phase A).
- Not rebuilding the QMD index.
- Not solving Phase B3 (durable backfill).

## Non-goals (added in v2)

- Not training a learning-to-rank model. The corpus is too small for LambdaMART. Grid search on a held-out split is sufficient.
- Not adding a freshness-intent classifier ML model. v2 ships a regex/keyword detector; learned classifier deferred to v3+ if v2 falls short on FIR.

---

## What changed from v1 (the eight-point redesign)

| # | Change | Driver | Section |
|---|---|---|---|
| A | **Match at segment level**, propagate matched-span voice into envelope | KG + IR | §1 |
| B | **Reweight inside `rrfFuse` via per-list voice factor**, not multiplicative post-fusion | IR | §2 |
| C | **Asymmetric multipliers**: boost durable, prior-weight legacy-unknown to corpus class-rate, lifetime-ramp on perishable | KG | §3 |
| D | **Piecewise age decay**, not exponential. Empirically tunable from `searchMetrics` | IR | §4 |
| E | **`voice_preference` parameter** on search API (`canonical \| recent \| mixed`, default mixed) + simple regex freshness-intent detector | KG + IR | §5 |
| F | **Solve cache-key invalidation BEFORE flag-on**: change cache key to `source_hash` only, invalidate per-path on stamp commits | Prod (blocking) | §6 |
| G | **Runtime-mutable per-collection flag** stored in SQLite, admin endpoint, 5-second TTL cache | Prod | §7 |
| H | **Folder boost auto-sunset** tied to `(1 − durable_coverage)` per folder | KG | §8 |

Plus: harness extensions for FIR, SVF, PPR-cold; observability triplet; 7-day acceptance soak; pre-flip falsifier.

---

## §1 — Segment-level matching

### Today
`hybridSearch` returns one `HybridResult` per `vault_path`. Voice (when surfaced in v1's design) was modal across all segments. Phase A's read-side directive operates at segment level and *requires* segment fidelity to be useful.

### v2
- BM25 and vector backends already return per-document hits. Don't change that.
- Add a post-fusion **segment resolution** pass: for each fused result, identify the **matched span** by (a) finding the BM25 snippet's character offsets in the note body, (b) for vector hits, finding the highest-cosine span via the existing chunk index (QMD's `vectors_vec_chunks`).
- Look up the BlameSegment containing the matched span; surface that segment's `voice` and `written_at` in the result envelope.
- Reweight uses the *matched-span* voice, not modal voice.

### File-level changes
- `src/blame.ts`: add `findSegmentForSpan(blame: BlameSegment[], lineStart: number, lineEnd: number): BlameSegment | null`
- `src/hybrid-search.ts`: between rrfFuse and reweight, call `resolveMatchedSegment(result)` per hit; cache snippet→span resolution per result.
- `src/server.ts`: `formatResults` surfaces matched-span `voice` + `written_at`.

### Eval implication (drives SVF metric)
- New synthetic VAULT_NOTES include 2–3 mixed-voice notes (durable body + perishable appendix) so the E2E layer can measure SVF.
- The ranking-unit layer's CandidateFixtures stay at note-level voice; SVF is measured only at the E2E layer where real blame applies.

---

## §2 — Per-list voice factor inside rrfFuse

### Today (`src/hybrid-search.ts:447-476`)
```
score[key] += weight / (k + rank)
```

### v2
```
score[key] += weight * voice_factor(result, list_label) / (k + rank)
```

Where `voice_factor` is **per-backend**, because BM25 and vector have asymmetric perishable bias:
- Vector over-retrieves perishable (semantically dense, well-formed). Apply stronger penalty here.
- BM25 under-retrieves perishable (recently-written, fewer backlinks). Apply weaker penalty here.
- Title FTS5: voice-neutral (a title match is a title match).

### Coefficients (env-tunable, all per-backend)
- `PROV_VOICE_FACTOR_BM25_PERISHABLE` (default 0.90)
- `PROV_VOICE_FACTOR_VEC_PERISHABLE` (default 0.75)
- `PROV_VOICE_FACTOR_BM25_DURABLE` (default 1.10)
- `PROV_VOICE_FACTOR_VEC_DURABLE` (default 1.20)
- legacy-unknown and title get factor 1.0 in all backends

This preserves RRF's scale-invariance: voice modifies *contribution per list*, not the post-fusion score.

### File-level changes
- `src/hybrid-search.ts`: extend the `lists` argument to `rrfFuse` so each result carries its (voice, written_at) tuple. rrfFuse multiplies by `voice_factor(voice, label)` inside the loop.
- Backwards-compatible: callers that don't supply (voice, written_at) get factor 1.0.

---

## §3 — Asymmetric, prior-weighted multipliers

### Today / v1
- durable: ×1.30
- perishable: ×0.85
- legacy-unknown: ×1.00

### Problem (KG panel)
- Penalizes perishable while leaving legacy-unknown at 1.0 → incentivizes not stamping. Legacy-unknown wins ties against stamped-perishable. As stamping coverage grows, this gets *worse*.
- legacy-unknown is *unknown*, not neutral. A Bayesian-honest design treats it as a prior centered on the corpus's class rate.

### v2
- **Durable**: positive boost as before (encoded in §2's per-backend factor).
- **Legacy-unknown**: prior-weighted toward the corpus class rate. Today corpus is ~5% perishable / ~0% durable / 95% unknown. As stamping coverage rises, the prior shifts. Encoded as: `factor_unknown = 1.0 * (1 - perishable_coverage * 0.10)` — at 0% coverage, factor is 1.0; at 50% coverage, factor is 0.95; at 100%, 0.90. Conservative.
- **Perishable**: factor from §2 + a **lifetime ramp**. New perishable (≤14 days) is fully trusted (factor ×1.0). Day 14→90 linear decay to the §2 base factor. Day 90+ at the floor.

### Eval implication
- Drives RPR-p directly. Lifetime ramp + piecewise (not exponential) decay.
- Drives FIR: a perishable note from yesterday on a freshness query keeps factor ~1.0, doesn't get suppressed.

---

## §4 — Piecewise age decay

### v1's exponential
`exp(-age_days / 90)` — never zero, always declining from day 1.

### v2's piecewise (per IR panel §2)
```
age_factor(perishable, age_days):
  age ≤ 14:                 1.00     (fresh perishable is fine)
  14 < age ≤ 90:            linear from 1.00 → 0.50
  90 < age ≤ 365:           linear from 0.50 → 0.20
  age > 365:                0.20     (floor — still findable, never zero)

age_factor(durable, *):     1.00     (RI-d invariant unchanged)
age_factor(legacy-unknown): 1.00     (no decay on unknowns)
```

### Why piecewise > exponential
- Snapshot content has a **shelf life**, not memoryless decay. April Gemini snapshot is fully correct in May; functionally archaeology by November. Exponential punishes the May case.
- Floor at 0.20 keeps stale perishable findable for forensic queries ("what was I thinking about Gemini in October") without burying it on canonical queries.
- Easier to fit empirically: pick the breakpoints from `searchMetrics` access patterns once Phase B3 lands and we have access logs across voice classes.

### Env-tunable
- `PROV_AGE_FRESH_DAYS` (default 14)
- `PROV_AGE_DECAY_END_DAYS` (default 90)
- `PROV_AGE_FLOOR_DAYS` (default 365)
- `PROV_AGE_FLOOR_FACTOR` (default 0.20)

---

## §5 — voice_preference parameter + freshness-intent detector

### API change
Search MCP tool gains optional `voice_preference: "canonical" | "recent" | "mixed"` (default "mixed").

| Mode | Effect on §2 voice factors |
|---|---|
| `canonical` | Multiply perishable factors by 0.5 (suppress harder), durable factors unchanged |
| `recent` | Multiply perishable factors by 1.3 (boost above neutral), §4 decay disabled |
| `mixed` | §2 + §4 as defined (the default) |

### Auto-detection (regex freshness-intent)
If caller doesn't supply `voice_preference`, server runs a simple detector on the query:
- Date markers: `\b\d{4}-\d{2}-\d{2}\b`, `\b(today|yesterday|now|currently|currently?|right now)\b`, month names with year
- Time deixis: `\b(latest|recent|recently|lately|this week|this month|this quarter)\b`
- If matched → default to `recent`. Else → `mixed`.

### Eval implication
- Drives FIR directly. Freshness-intent fixture set added to `test-set.ts`: ~12 queries with date markers / time deixis, expected top result = most-recent perishable.
- The regex detector is a stub. v3+ may replace with a learned classifier if FIR underperforms.

---

## §6 — Solve cache-key invalidation (BLOCKING)

### The bug (Prod panel)
`note_blame` cache key today: `${sourceHash}|${headSha}` (`src/blame.ts:69`). Every commit to the vault — including the cron sync every 5 min — creates a new HEAD, invalidating every cached row. Steady state: blame cache effectively cold every 5 min, 12× per hour. Notes that *do* have provenance get treated as `legacy-unknown` for the first search after every sync.

### Why HEAD was in the key (per blame.ts:64-67)
> "Stamp commits are --allow-empty, so source_hash alone doesn't rotate when a stamp lands; without the HEAD component the cache returns stale blame forever after a stamp."

The HEAD-in-key was a correctness fix for stamp commits. Removing it requires a new invalidator.

### v2 solution
- **Drop HEAD from the cache key.** Key becomes `source_hash` only.
- **Add an active invalidator on stamp commits.** When `stamp.ts` writes a Provenance-* commit, it deletes affected rows from `note_blame` for `Provenance-Stamp-Path` paths. This is the same write-time invalidation pattern as `clearNoteBlame(path)` in `db.ts:1549`.
- **Add post-sync warm-up**: discovery worker (after every cron sync) walks the diff between `pre_sync_HEAD` and `post_sync_HEAD`, calls `recomputeProvenanceBlame()` for changed paths. Pre-warms the cache for likely-searched notes.

### Falsifier (per CLAUDE.md diagnostic discipline)
Before flag-on in prod: `ssh prod 'sudo sqlite3 /root/.cache/qmd/index.sqlite "SELECT COUNT(*) FROM note_blame"'` immediately after a sync. Should be > 0 within 60 seconds (warm-up worked). If 0, abort flag-flip — the warm-up is broken.

### Eval implication
- Drives PPR-cold. Run `tsx scripts/eval-search-quality/run.ts --quick` immediately after `DELETE FROM note_blame WHERE 1=1` on the test DB. Result must be within 0.10 absolute of warm PPR.
- New `--cold` flag on the runner that performs the invalidation before measurement.

---

## §7 — Runtime-mutable per-collection flag

### Today / v1
`PROV_RANKING_ENABLED` env var. Read at module load. PM2 restart to change.

### v2
- New SQLite table `runtime_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`.
- New module `src/runtime-config.ts`:
  - `getFlag(name, defaultValue)`: returns from in-process cache (5s TTL); cache miss = SELECT.
  - `setFlag(name, value, scope?)`: UPDATE + cache bust.
- Flag name: `prov_ranking_enabled.<collection>`. e.g. `prov_ranking_enabled.john-life` vs `prov_ranking_enabled.test-vault`.
- Admin endpoint: `POST /admin/runtime_config { key, value }` (admin auth from existing Portal work).
- `hybridSearch` reads the flag scoped to the request's collection.

### Cost
- 5s TTL cache: at most 1 SELECT per 5 seconds per process per flag. Negligible.
- One indexed lookup on cache miss. Sub-ms.

### Rollback latency calculation
- Admin POST → cache bust → next request reads new value.
- Wall clock: HTTP round trip + cache TTL boundary ≈ 5–10s worst case. Within the ≤ 60s threshold with margin.

### Falsifier
- Before flag-flip: `curl -X POST $ADMIN_URL/runtime_config -d '{"key":"prov_ranking_enabled.john-life","value":"true"}'`. Then `curl $URL/search?q=foo` and confirm response envelope shows new behavior. If not flipped within 30s, abort.

---

## §8 — Folder boost auto-sunset

### Today (`hybrid-search.ts` lines 135, 425, 427)
- `resources/* ×1.30` (BM25 + vec)
- `journal|sources/* ×0.80` (vec)

### Problem (KG panel)
Folder boosts are a coarse proxy for "this is durable." Once Phase B3 backfills durables, folder boost becomes redundant — but if removed before B3 lands, ranking quality regresses.

### v2
- **Folder boost magnitude tied to `(1 − durable_coverage_in_folder)`**.
- Compute `durable_coverage` per folder = `count(notes with durable stamps in folder) / count(notes in folder)`. Cached, refreshed nightly.
- Effective `resources/*` multiplier: `1.0 + 0.30 * (1 - durable_coverage)`. At 0% coverage = 1.30 (current). At 100% coverage = 1.00 (no boost). Linear in between.

### Eval implication
- Drives Δ p@5 / Δ MRR (no regression). The auto-sunset means baseline ranking quality stays preserved as B3 rolls out.
- Folder coverage values cached in `runtime_config` table (§7's plumbing). Refreshed by a nightly cron.

---

## Harness extensions (built in same PR per user instruction)

| New piece | What it adds | Drives metric |
|---|---|---|
| `test-set.ts` — FRESHNESS_INTENT_FIXTURES | 12 fixtures: date-bearing or time-deixis queries with expected top = most-recent perishable | FIR |
| `test-set.ts` — MIXED_VOICE_VAULT_NOTES | 2-3 notes with durable body + perishable appendix; query matches the perishable section | SVF |
| `metrics.ts` — `computeFIR()` | rate over freshness fixtures | FIR |
| `metrics.ts` — `computeSVF()` (E2E only) | rate over mixed-voice queries; checks envelope.voice == matched-segment.voice | SVF |
| `run.ts` — `--cold` flag | Truncates `note_blame` immediately before measurement | PPR-cold |
| `run.ts` — `--full` E2E layer | Materializes vault, runs hybridSearch with real blame, measures latency p99 + envelope completeness | Latency, Envelope |
| `run.ts` — per-voice Δ p@5 split | Wraps eval-vector-search, splits regression by note voice | Δ p@5 / MRR per voice |
| New: `scripts/eval-search-quality/soak/` | Records John's top-50 queries pre-flip, replays post-flip with /feedback endpoint | Subjective acceptance |
| New: `scripts/eval-search-quality/rollback-bench.ts` | Wall-clock measurement of admin POST → identity ranking restored | Rollback latency |

---

## Observability triplet (must exist before flag-on)

Add to existing `/metrics`:
- **`grove_search_voice_at_rank`** — histogram, labels `(rank, voice)`. Emits the voice of the result at each rank position. Catches "is durable actually winning rank 1."
- **`grove_search_legacy_unknown_share`** — gauge per query. Sampled 1%. If >0.7 the eval is meaningless; alert.
- **`grove_blame_cache_hit_rate`** — gauge, labels `(seconds_since_last_sync_bucket)`. Catches the cron-rotation problem from §6.
- **`grove_provenance_lookup_latency`** — histogram, separate from end-to-end search latency.
- **Reweight-delta sample log** — at /tmp/grove/reweight-samples.jsonl, 1% of queries, format `{query, pre_top5: [path], post_top5: [path]}`. Forensic trail for "search feels worse" reports.

---

## Subjective acceptance soak (drives metric #11)

### Setup
- Capture John's top-50 most-frequent queries from `searchMetrics` over the last 30 days.
- Pre-flip: run each, save top-5 results to `soak/baseline-2026-MM-DD.json`.
- Post-flip: run each daily for 7 days, save top-5 to `soak/postflip-day-N.json`.
- John reviews via a thin web UI per query: thumbs-up (same or better), thumbs-down (worse). Stored in `runtime_config` table.
- Auto-revert trigger: if cumulative thumbs-up rate <0.80 by end of day 7, set `prov_ranking_enabled.john-life=false` programmatically.

### Why this is in v2 (not v3+)
Prod panel was emphatic: offline eval can't predict subjective rank quality on a 1,750-note corpus when fixtures admit correlation. This is the gate that catches the failure mode where the harness says PASS and the user says REVERT.

---

## Rollout plan

| Day | Action | Falsifier | Threshold |
|---|---|---|---|
| 0 | PR with code + harness extensions + tests + flag off in prod, on in staging. CI green. | `npm test` + `tsx scripts/eval-search-quality/run.ts --quick --cold` | All 12 thresholds (synthetic) |
| 1 | Merge. Deploy. Confirm prod identity behavior unchanged. | `curl prod/search?q=parametric+design \| jq '.results[0].voice // "missing"'` should be `missing` (flag off) | Envelope absent |
| 2 | Flag on for `john-life` in staging via runtime_config. Run E2E + rollback-bench. | `tsx scripts/eval-search-quality/rollback-bench.ts` | Rollback ≤ 60s |
| 3 | Flag on for `john-life` in prod. Capture pre-flip top-50 to `soak/baseline-2026-05-12.json` BEFORE flip. | Verify voice present in envelope | Envelope = 1.0 |
| 4–10 | Daily soak query replay + John reviews. | thumbs-up/down rate | ≥ 0.80 by day 10 |
| 7 | If observability is clean and subjective rate ≥ 0.50 by day 7: continue. Else: auto-revert. | observability triplet | All metrics within bounds |
| 14 | If still passing: flag becomes default; remove `runtime_config` row. Begin folder-boost auto-sunset deployment. | Fresh A+ measurement | All 12 thresholds |

---

## Risks (updated for v2)

| Risk | Likelihood | Mitigation |
|---|---|---|
| Segment resolution is expensive (per-result span lookup) | Medium | Cache snippet→span per result row; resolve in parallel with batch blame fetch. |
| Per-list voice factor changes RRF behavior in unexpected ways | Medium | Wide sweep across factor combinations; held-out validation. |
| Freshness-intent regex misfires (false positives bury canonical results) | High | Conservative regex; tested against 50 real queries from `searchMetrics`. Auto-detect can be disabled via `voice_preference=mixed`. |
| Stamp commits don't reliably invalidate cache | Medium | Test in `provenance.test.ts`. Falsifier in §6. |
| Post-sync warm-up worker crashes silently | Medium | Health check + alert on `grove_blame_cache_hit_rate{bucket="0-60s"}` < 0.5. |
| Runtime flag table corrupts | Low | Default value falls through to env var; env defaults to false. Belt and suspenders. |
| Subjective soak takes >7 days to reach 0.80 | Medium | Auto-revert at day 7. Iterate on multipliers. |
| FIR fixtures are themselves wrong (over-fitted regex matches) | Medium | Curated from real `searchMetrics` queries; not synthesized. |

---

## Open questions for the v2 panels

1. **Per-backend voice factors (§2):** is the asymmetry direction right? Specifically `vec_perishable=0.75` vs `bm25_perishable=0.90` — is "vec over-retrieves perishable" a real corpus property or an IR panel intuition? Need empirical confirmation.

2. **Lifetime ramp (§3):** 14-day fresh window is the gut number. What's the right cutoff for AI-synthesized snapshot content in a personal corpus?

3. **Piecewise breakpoints (§4):** 14 / 90 / 365 / floor 0.20. Right curve, or should the floor be lower (or higher)? Should there be a fifth segment for "year-old durable archive"?

4. **Auto-detect regex (§5):** false positive rate on a real corpus query distribution? 12 hand-picked fixtures don't tell us.

5. **Cache key removal (§6):** is `source_hash` alone *sufficient* given the active invalidator? What's the failure mode if a stamp commit happens but the invalidator misses?

6. **Per-collection runtime flag (§7):** correct granularity? Or should it be per-vault per-trail (Trails are coming in P5)?

7. **Folder boost auto-sunset shape (§8):** linear in coverage. Could overshoot — at 50% coverage, the boost is half. But durable_coverage might be skewed by note-count in unimportant folders. Should it weight by `searchMetrics.requests_per_path`?

8. **Soak metric scoring (§11):** is "thumbs-up rate ≥ 0.80" the right thing to measure, or should it be more like "for every query John says is worse, the durable-vs-perishable tradeoff was *intentional*"? Risk: a query where v2 correctly suppresses perishable but John didn't expect it gets marked thumbs-down.

---

## What I'm asking the v2 panels

Same three lenses as v1 — IR/ranking, knowledge-graph/semantic-memory, production/observability. Specifically:

- Does the per-list voice-factor approach (§2) actually preserve RRF's scale-invariance? Side-effects?
- Is the segment resolution (§1) implementable within the latency budget given snippet→span lookup cost?
- Does the cache-key change (§6) introduce other correctness failures you can see that I missed?
- Is the runtime flag (§7) plumbing fragile enough to cause its own incident?
- Are the 5 new harness pieces sufficient to enforce the 5 new thresholds (8-12)?
- Does v2 still have the "every config hits 100%" problem in sweep, or do the per-backend factors and piecewise decay finally let configs differentiate?

The goal of round 2 is a v3-or-ship decision. If the panels don't find structural issues, v2 becomes the implementation spec. If they do, v3 closes the gaps and we run a third round.

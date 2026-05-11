# V1 plan — provenance & age-aware ranking in Grove

**Status:** v1 — superseded by V2_PLAN.md after the panel critique. Kept on disk
as the artifact of record for the v1 → v2 iteration trail.
**Date:** 2026-05-09.
**Eval target (original A+, 7 thresholds):** PPR ≥ 0.85, RPR-p ≥ 0.75, RI-d ≥ 0.80,
Δ p@5/MRR ≥ −0.02, envelope = 1.0, latency ≤ 1.10×, tunability sweep.
**Baseline (identity reweight) on synthetic candidate fixtures:** PPR 83%, RPR-p 0%, RI-d 100%. Overall 61%.
**v1 reweight on the same fixtures:** 100% across all three (but fixtures need adversarial hardening).

---

## Goal

When Grove returns search results, the top of the list reflects what John would actually trust as true:

1. Durable John-thinking outranks AI-perishable on the same topic.
2. Recent perishable outranks stale perishable.
3. Durable relevance is not swapped by age.

Without this, the read-side directive (Phase A, locked 2026-05-07) treats the symptom — perishable contamination at *read time* — but the root cause is that ranking puts perishable at rank 1 in the first place.

## Non-goals

- Not changing what BM25 / vector / title backends return as candidates. Reweight is post-fusion only.
- Not adding new MCP tools.
- Not touching the read-side blame envelope or directive.
- Not rebuilding the QMD index.
- Not solving Phase B3 (durable backfill). Ships *with or without* B3.

---

## Design

### Where the change lives

`src/hybrid-search.ts`, between `rrfFuse` and the alias-injection block. Two new pieces:

1. **Provenance lookup** — given the fused candidate paths, batch-fetch note-level `(voice, written_at)` from the `note_blame` cache. One SQL query.
2. **Reweight pass** — apply per-voice multiplier × per-age multiplier to each candidate's `rrf_score`, then re-sort.

Gated by env flag `PROV_RANKING_ENABLED`, default `true` in dev/staging, `false` in prod for first deploy.

### Reweight formula

```
final_score = rrf_score * voice_multiplier(voice) * age_multiplier(voice, age_days)

voice_multiplier:
  durable        → PROV_DURABLE_BOOST           (default 1.30)
  perishable     → PROV_PERISHABLE_PENALTY      (default 0.85)
  legacy-unknown → 1.00  (transparent)

age_multiplier:
  durable        → 1.0   (RI-d invariant)
  perishable     → exp(-age_days / PROV_PERISHABLE_HALFLIFE_DAYS)  (default 90 days)
  legacy-unknown → 1.0
```

### Envelope
`HybridResult` adds optional `voice?: Voice` and `written_at?: string`.

### Provenance lookup
Add `getNoteVoicesAndAges(paths: string[])` to `db.ts`. Single SQL: `SELECT path, blame_json FROM note_blame WHERE path IN (?, ...)`. Parse JSON, derive modal voice + max written_at per path. For paths missing from `note_blame`: treat as legacy-unknown.

### Backward compatibility
- Legacy-unknown notes: multiplier 1.0. Today: 175 perishable stamps + 0 durable stamps; rest is legacy-unknown.
- Folder-based boosts (`resources/* ×1.30`, `journal|sources/* ×0.80`) stay for now.
- Env flag → kill switch via PM2 restart.

## Test plan
1. `npm test` passes.
2. `tsx scripts/eval-search-quality/run.ts --quick --reweight=v1` clears thresholds.
3. `--reweight=identity` confirms baseline numbers haven't drifted.
4. `tsx scripts/eval-search-quality/sweep.ts` runs.
5. `eval-vector-search.ts` baseline vs flag-on shows Δ p@5 / Δ MRR ≥ −0.02.
6. p99 latency from new E2E layer ≤ 1.10× pre-flag.
7. Manual eyeball of envelope.

After merge:
8. Deploy with flag off. Confirm health.
9. Flag on for 24h. Watch /metrics.
10. If latency holds: leave on. If not: flag off, profile, fix.

## Rollout
- Day 0: PR with code + tests + flag off. CI green.
- Day 1: Merge. Deploy. Flag on in staging, off in prod.
- Day 1+24h: Confirm staging fine. Flag on in prod.
- Day 7: Remove flag.
- Day 14: Follow-up to remove folder boosts.

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| Latency budget blown | Medium | Batch reader. Lazy fetch fallback. |
| Tuning wrong → real-vault feels worse | High pre, Low post | Sweep + manual eyeball + flag revert. |
| Adversarial fixtures show v1 doesn't generalize | High | Plan v1.5 if panels confirm. |
| Δ p@5 regresses | Medium | Lower multipliers. |
| Provenance backfill never happens | Medium | Legacy-unknown gracefully degrades. |

## Open questions for the panels
1. Fixture adversarial hardness — perishable=recent, durable=older correlation.
2. Halflife shape — exponential vs step / Weibull / piecewise.
3. Note vs segment granularity.
4. Folder boost coexistence.
5. Voice multiplier for legacy-unknown.
6. Tunability ceiling without A/B.

---

## What the panels found (added 2026-05-09 post-review)

See `V2_PLAN.md` for the full synthesis. Headlines that survived to v2:

- **Cache-key invalidation bug (Prod panel, blocking).** Cache keys on `(source_hash, head_sha)`. Cron sync every 5 min creates a new HEAD, invalidating every cached row. PPR collapses for ~5-min windows in steady state. Offline eval doesn't see this.
- **Voice ≠ ranking trust (KG panel).** "Perishable" is a speech-act ("pause and name it"); using it as a relevance discount conflates two decisions.
- **Note-level voice destroys segment work (KG + IR).** A 200-line note that's 80% durable + 20% perishable matches on the perishable section but ranks as durable. Worst of both.
- **Voice and age are correlated (IR).** Multiplying both penalizes the same property twice — explains why every sweep config hits 100%.
- **RRF scale-invariance broken by post-fusion multiply (IR).** Push voice into per-list weights *inside* rrfFuse instead.
- **Halflife shape wrong for snapshot content (IR).** Use piecewise, not exponential.
- **No query-intent handling (IR + KG).** "What's the model lineup today" wants perishable. Add `voice_preference` parameter.
- **Kill switch is 5-15min via pm2 restart (Prod).** Need runtime-mutable flag.
- **Observability gaps (Prod).** Voice-by-rank, legacy-unknown share, cache-hit-by-sync-recency, reweight-delta sample.
- **No subjective acceptance criteria (Prod).** Offline eval can't predict subjective feel.

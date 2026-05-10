# Search-quality eval harness

The fitness function for the GOAL.md "Search Quality" component (30 pts,
locked 2026-05-09). Tests whether ranking is provenance-aware and
age-aware: durable John-thinking should outrank AI-perishable on the same
topic, recent perishable should outrank stale perishable, and durable
relevance should not be swapped by age.

## Layers

1. **Ranking unit** — synthetic candidate fixtures → real `rrfFuse` +
   chosen reweight implementation → PPR / RPR-p / RI-d. No QMD index, no
   network, no embeddings. Deterministic. Fast (~50ms).

2. **Regression sweep** *(--full)* — wraps `scripts/eval-vector-search.ts`
   and reports Δ p@5 / Δ MRR vs a stored baseline. Requires the local QMD
   index. Catches "we tuned PPR by tanking raw relevance."

3. **End-to-end** *(--full)* — materializes a tiny synthetic vault via
   `setup-vault.ts`, queries it through the real `hybridSearch` with
   blame-fed reweight, measures p99 latency + envelope completeness.

The ranking-unit layer is the load-bearing one for PPR / RPR-p / RI-d. The
other two guard the cost: regressing relevance for ranking-unit gains is
not a pass; spiking latency for ranking-unit gains is not a pass.

## Pass criteria

Locked 2026-05-09 in `GOAL.md`. All seven must hold for the Search Quality
component to score full points (30/30):

- **PPR ≥ 0.85** — durable outranks perishable on dual-match queries
- **RPR-perishable ≥ 0.75** — recent perishable outranks stale perishable
- **RI-durable ≥ 0.80** — relevance order on durables not swapped by age
- **Δ p@5 / Δ MRR ≥ −0.02** — no relevance regression vs `eval-vector-search.ts`
- **Envelope completeness = 1.0** — every search hit carries `voice` + `written_at`
- **Latency ≤ 1.10× baseline** — p99 of 100-query mix on the real index
- **Tunability** — `sweep.ts` runs ≥3 reweight configs and reports deltas

## Usage

```sh
# Ranking-unit only — fast, deterministic. The default.
tsx scripts/eval-search-quality/run.ts

# JSON output for score.sh
tsx scripts/eval-search-quality/run.ts --quick --json

# Baseline (no provenance reweight) — what current production does.
tsx scripts/eval-search-quality/run.ts --quick --reweight=identity

# Full eval — adds regression sweep + end-to-end. Requires QMD + Voyage.
tsx scripts/eval-search-quality/run.ts --full --out=./eval-out

# Sweep across reweight configs to find good defaults
tsx scripts/eval-search-quality/sweep.ts
```

## Files

- `test-set.ts` — frozen fixtures. Two domains: `CANDIDATE_FIXTURES` (28
  synthetic queries, used by the ranking-unit layer) and `VAULT_NOTES` (6
  notes, materialized by setup-vault for the E2E layer).
- `metrics.ts` — `rrfFuse` integration, reweight implementations
  (`identityReweight` = baseline, `v1ProvenanceReweight` = first proposal),
  PPR / RPR-p / RI-d aggregation, threshold gates.
- `setup-vault.ts` — materializes `VAULT_NOTES` into a tmp git vault using
  the real `composeCommitMessage` + `provenanceToTrailers` plumbing.
- `run.ts` — main runner. Layer 1 always runs; `--full` adds 2 + 3.
- `sweep.ts` — exercises multiple reweight configs in one shot. Edit
  `CONFIGS` to add candidates. Used during tuning, not in CI.

## Reweight scheme (v1 — proposal, not yet in production)

```
final_score = rrf_score
            * voice_multiplier(voice)
            * age_multiplier(voice, age_days)

voice_multiplier:
  durable        → PROV_DURABLE_BOOST            (default 1.30)
  perishable     → PROV_PERISHABLE_PENALTY        (default 0.85)
  legacy-unknown → 1.00  (transparent — matches read-side directive)

age_multiplier:
  durable        → 1.0   (RI-d invariant: age does NOT decay durables)
  perishable     → exp(-age_days / PROV_PERISHABLE_HALFLIFE_DAYS)
                    (default halflife = 90 days)
  legacy-unknown → 1.0
```

Tunable via env. `sweep.ts` enumerates a few reasonable points in this
space (default vs aggressive vs conservative vs decay-only vs voice-only)
so the v1 → v2 → vN iteration loop has a comparison table.

## Why the ranking-unit layer uses synthetic candidates

The real vault has zero durable Provenance-* stamps as of 2026-05-09 —
Phase A backfilled 183 perishable stamps, but Phase B3 (durable backfill
via classifier) hasn't run. So real-vault mining for `(durable,
perishable)` pairs returns zero pairs and PPR is unmeasurable.

Synthetic candidates let the ranking-unit layer measure PPR / RPR-p / RI-d
against a frozen, reproducible set, exercising the actual `rrfFuse` and
the actual reweight code. Once Phase B3 lands, the same harness can
optionally be extended with a real-vault layer that mines `note_blame`.
The synthetic layer remains as the unit-level guarantee; the real-vault
layer would become a stricter production gate.

## Iteration plan if FAIL

- **PPR fails** — voice multiplier is too weak. Inspect failed fixtures
  in the runner output: if the perishable note had a meaningfully higher
  raw RRF score, increase `PROV_DURABLE_BOOST` or lower
  `PROV_PERISHABLE_PENALTY`. Re-run sweep to confirm no RI-d collateral.

- **RPR-p fails** — age decay is too weak. Lower
  `PROV_PERISHABLE_HALFLIFE_DAYS` (faster decay) or run the eval against a
  newer reference time to surface the gap. Don't blanket-penalize stale
  perishable to zero — that breaks legitimate older synthesis.

- **RI-d fails** — the reweight is over-decaying durables. Confirm
  `age_multiplier(durable) === 1.0` is honored in the implementation.
  Common bug: shared decay function applied without voice gating.

- **Δ p@5 fails** — voice/age boosts crowded out raw relevance. Lower
  the multipliers; rerun `eval-vector-search.ts` until within budget.

- **Latency fails** — blame is being computed inline per result.
  Pre-fetch in parallel during candidate generation, not after fusion.

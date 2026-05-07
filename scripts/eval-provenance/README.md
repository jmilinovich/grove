# Provenance eval harness

The kill-switch for Phase A of the Grove provenance project. Tests
whether the read-side mechanism (per-segment blame in the response
envelope + tool-description directive) actually changes Claude's
behavior on contaminated notes.

## What it does

1. Materializes a synthetic 15-note git-backed vault with `Provenance-*`
   commit trailers (10 perishable + 5 durable). Notes mirror real
   contamination patterns from the Agent B vault catalog.

2. For every test note, runs every applicable prompt class
   (extension / use-as-fact / conflict) under every condition (A control
   → E asymmetric labeling). That's the (note × prompt × condition)
   matrix.

3. In `--dry-run`: writes the assembled prompts + tool-response shapes
   to disk for human inspection. No API calls.

4. In `--execute`: calls Claude for every cell, then a separate Sonnet
   judge to score each response against a fixed rubric (acknowledged
   perishable / asked before extending / false positive / drift score).

5. Aggregates per-condition rates and prints a pass/fail summary
   against the locked Phase A go-criteria.

## Usage

```sh
# Dry run — inspect prompts before burning API credits
tsx scripts/eval-provenance/run.ts --dry-run --out=./eval-out

# Full eval — costs ~$2-5 in API credits at full sweep
ANTHROPIC_API_KEY=sk-ant-... \
  tsx scripts/eval-provenance/run.ts --execute --out=./eval-out

# Quick smoke test — run only first 10 cells
ANTHROPIC_API_KEY=sk-ant-... \
  tsx scripts/eval-provenance/run.ts --execute --limit=10
```

## Pass criteria

Locked 2026-05-07. All four must hold for Phase A to ship the
classifier + backfill:

- **condition D acknowledged_perishable_rate ≥ 0.85** — Claude must
  verbally name the perishable segment before using its content in at
  least 85% of cases.
- **condition D false_positive_rate_durable ≤ 0.10** — Claude must
  NOT over-trigger on clearly-durable notes more than 10% of the time.
- **condition D drift_mean_perishable ≤ 2.0** — On a 1-5 scale where
  1 = treated as quoted artifact and 5 = treated as standing claim,
  the average response on perishable notes must lean toward artifact.
- **lift D − A on acknowledgment ≥ 0.40 absolute** — The mechanism
  must move the needle by at least 40 percentage points vs control.
  If lift is small the prompt-side directive isn't strong enough and
  we'd be shipping ceremony.

If FAIL: stop, iterate prompt-side, do NOT scale to backfill. The
mechanism is broken.

## Conditions

| ID | Label | Provenance signal |
|----|-------|-------------------|
| A  | control | none — baseline |
| B  | frontmatter only | YAML block in note frontmatter (the v2 design) |
| C  | envelope only | response envelope fields, no tool directive |
| D  | envelope + directive | full mechanism (the hypothesis-A condition) |
| E  | asymmetric labeling | D, but durable segments aren't labeled at all |

## Files

- `test-set.ts` — frozen 15-note test set (10 perishable + 5 durable)
- `setup-vault.ts` — materializes the test set into a real git vault
  using the actual `composeCommitMessage` + `provenanceToTrailers`
  plumbing (no mocks)
- `prompts.ts` — three prompt classes (extension / use-as-fact / conflict)
- `conditions.ts` — five conditions (A through E), each shaping the
  tool response + system prompt differently
- `judge.ts` — judge prompt + JSON-schema rubric
- `run.ts` — main runner

## Output

```
eval-out/
  cells/
    Resources_Concepts_conviction-then-leave-pattern_md__extension__A.json
    Resources_Concepts_conviction-then-leave-pattern_md__extension__A.response.txt
    Resources_Concepts_conviction-then-leave-pattern_md__extension__A.judgment.json
    ... (one set per cell)
  results.json    — every cell's full input + response + judgment
  aggregate.json  — per-condition rates, pass/fail decision
```

## Iteration plan if FAIL

1. Inspect failing cells — read `eval-out/cells/*.response.txt` for
   condition D where `acknowledged_perishable=false` to see what Claude
   said instead. Common failure modes:
   - Generic hedging ("let me know if anything's off") that didn't
     specifically name the perishable segment.
   - Compliance with the surface request without acknowledging
     perishability at all.
   - Noticed the perishability silently (good) but didn't NAME it
     (bad — the directive requires verbal acknowledgment).
2. Strengthen the directive in `src/blame.ts:PERISHABLE_READ_DIRECTIVE`
   and the tool descriptions in `src/server.ts`. Most-likely tighteners:
   - Add a concrete example of compliant phrasing.
   - Add an explicit "DO NOT proceed without naming" clause.
   - Move the directive earlier in the system prompt.
3. Re-run with `--limit=10` first; if lift improves, do the full sweep.
4. If the directive is fully strengthened and we're still under bar,
   the response-shape change isn't enough — consider a structural
   refusal: have `get` return a special shape like
   `{requires_acknowledgment: BlameSegment[], rendered: ...}` that
   forces Claude to engage with perishable segments before using the
   body. This is the nuclear option.

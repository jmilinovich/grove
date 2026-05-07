# Provenance backfill toolkit

The end-to-end pipeline for backfilling per-commit provenance trailers
across the existing vault corpus. Used for both:

1. **Manual override of known-contaminated notes** (the A7 use case):
   stamp the 10 notes from the Agent B catalog directly via
   `stamp.ts`'s programmatic API.
2. **Bulk classifier-driven backfill** (Phase B3): walk the vault →
   classify with high-precision rules → review → stamp confirmed.

Stamps are git-native. Each is one commit (`--allow-empty`) carrying
`Provenance-*` trailers in the message body. The read path
(`src/blame.ts`) detects them via `Provenance-Stamp-Path` and
overrides legacy-unknown segments at blame time.

## Files

- `stamp.ts` — programmatic `stampOne` / `stampMany` primitive. Used
  by both manual and bulk paths. Validates caller provenance, writes
  one empty commit per stamp, returns `{commit_sha, ...}`.
- `rules.ts` — high-precision classifier rules from the Agent B
  catalog. Each rule fires only when the contamination signal is
  unambiguous; ambiguous notes go to "unknown" for human review.
- `classify.ts` — CLI: walks a vault, applies rules, emits a JSONL
  manifest of `{path, proposed_voice, confidence, signals, excerpt}`.
- `report.ts` — CLI: takes a manifest JSONL and produces a
  human-readable markdown review file with bucket sections, per-note
  checkboxes, and bucket-confirm shortcuts.
- `apply.ts` — CLI: takes a confirmed review.md and a vault path,
  walks every resolved checkbox, calls `stampOne` per entry. Refuses
  to start if any checkbox is unresolved in a non-confirmed section.

## Pipeline

```sh
# 1. Classify the vault (read-only; fast)
tsx scripts/provenance/classify.ts ~/clones/grove-vault \
  --out=/tmp/manifest.jsonl

# 2. Build a review document
tsx scripts/provenance/report.ts /tmp/manifest.jsonl \
  --out=/tmp/review.md

# 3. Open /tmp/review.md in your editor; resolve every "- [ ]" to
#    one of [p] (perishable), [d] (durable), [u] (unknown).
#    For obvious buckets, set the section's `status:` to `confirmed`
#    and leave the boxes blank — apply.ts treats them as their
#    proposed voice.

# 4. Dry-run apply to see what would happen
tsx scripts/provenance/apply.ts /tmp/review.md ~/clones/grove-vault \
  --dry-run

# 5. Apply for real (writes one empty commit per stamp)
tsx scripts/provenance/apply.ts /tmp/review.md ~/clones/grove-vault \
  --by=claude-opus-4-6 \
  --written-at-source=git-earliest \
  --source="bulk-backfill 2026-05-07"

# 6. Push the new commits to the prod vault
cd ~/clones/grove-vault && git push origin main
```

## Manual override (A7) — single note

For a small set of known-contaminated notes you want to stamp without
running the full classifier pipeline, drop into a tsx REPL:

```ts
import { stampOne } from "./scripts/provenance/stamp.js";

await stampOne({
  vaultPath: "/path/to/vault",
  notePath: "Resources/Concepts/conviction-then-leave-pattern.md",
  provenance: {
    voice: "perishable",
    by: "claude-opus-4-6",
    written_at: "2026-04-30T22:15:00Z",
    basis: ["Journal/2026/2026-04-30.md"],
    reason: "synthesis on day-of-Canva-exit; 2-data-point pattern named under emotional context",
    source: "interview-prep session 2026-04-30",
  },
});
```

## Why this design

- **Rules-first, LLM-deferred.** The Agent B catalog gives us 8-10
  high-precision patterns that catch the third-bucket failure mode
  without false positives. Anything not matching goes to "unknown" for
  human review. An LLM-classifier can be added later for the long tail
  but isn't load-bearing in Phase A/B.
- **Markdown review, not TUI.** Per the annotation panel: keyboard-
  driven bulk action is the killer feature, but `vim` already does
  that on a markdown file. No state machine needed.
- **One commit per stamp.** Per-note rollback via `git revert <sha>`
  if something is wrong. Per-bucket rollback via `git reset --hard
  HEAD~N` where N is the bucket size.
- **Stamp commits are empty.** Zero file content change. The override
  semantics live entirely in commit metadata + the read path's
  stamp-walker. This means stamps NEVER risk corrupting note bodies.

## Pass criteria (from the annotation panel)

For Phase B3 to ship:
- 100% of `Resources/Concepts/` reviewed by a human.
- 100% of `Resources/People/` reviewed by a human.
- High-confidence auto-stamp acceptable for `Sources/` and similarly
  low-stakes folders.
- `Journal/` stays at file-level `durable` (section-level work
  deferred to a separate phase 2 — needs a span classifier with its
  own gold set).

After backfill, re-run the eval (`scripts/eval-provenance/run.ts`)
against a clone of the now-stamped vault to confirm behavior holds.

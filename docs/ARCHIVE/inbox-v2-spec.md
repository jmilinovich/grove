# Inbox v2 — Suggestions, Not Reviews

Status: spec locked 2026-05-20. Implementation pending.

## What this is

A redesign of Grove's review/inbox surface from "confirm this paragraph the LLM wrote" into "Google-Photos-y queue of proposed graph changes you accept, refine, or dismiss." The current `daily-vault-review`-shaped inbox is rebuilt around three suggestion classes, with non-blocking autonomy and forward-only rollback.

## Why

Today's inbox is full of generic reminder paragraphs nobody confirms. The verb set (confirm-durable / refine / dismiss / mark-stale) treats every item the same. There's no model for "Grove proposed a graph change" — only for "Grove drafted text about you." That ceiling is why 25 items sit untouched on prod.

The new model: inbox items are *decisions Grove made or wants to make about the graph*, surfaced for retrospective sign-off. Inbox stays near-empty by default — Grove acts autonomously when safe, escalates only when ambiguous or destructive.

## The 15 decisions (locked)

| # | Dimension | Locked value |
|---|---|---|
| 1 | Inbox kind | Suggestions / proposed changes (Google-Photos-y) |
| 2 | Threshold | Near-empty default; only ambiguous/destructive escalates |
| 3 | Trigger | Non-blocking: best-guess → mark → queue → run continues |
| 4 | Reversibility | Roll back + re-run on user correction |
| 5 | Cascade | Just X. No transitive cascade |
| 6 | Refine | Free instruction → spawns new autonomous task |
| 7 | TTL | Sit forever. No auto-expiry |
| 8 | Resolution UI | Item-specific options + free-text refine (AskUserQuestion-style) |
| 9 | Surface classes | Enrichment, Links, Disambiguation |
| 10 | Options source | Hybrid: schema for common types, LLM-proposed for rare |
| 11 | Old content-review items | Re-cast as Enrichment |
| 12 | Item shape | Every item is a Grove-made decision |
| 13 | v1 scope | Build all three classes at once |
| 14 | Dismiss | Soft suppress (N days, per (entity, suggestion-type)) |
| 15 | Decision tag | Git-as-event-log + `.grove/decisions.jsonl` + state.db as cache |

## Architecture

### Decision log

Source of truth: git history of the vault repo + `.grove/decisions.jsonl` (append-only event log committed alongside the changes that decision produced).

`.grove/decisions.jsonl` shape (one JSON object per line):

```json
{
  "id": "D-2026-05-20-001",
  "type": "link" | "enrichment" | "disambiguation",
  "skill_run_id": "SR-...",
  "created_at": "2026-05-20T14:33:12Z",
  "status": "provisional" | "confirmed" | "compensated",
  "payload": { /* type-specific */ },
  "options": [
    { "id": "opt-1", "label": "merge into Anna Chen", "source": "schema" | "llm" },
    { "id": "opt-2", "label": "keep separate", "source": "schema" }
  ],
  "chosen_option_id": "opt-1",
  "affected_paths": ["Resources/People/Anna Chen.md", "Journal/2026-05-19.md"],
  "compensated_by": null
}
```

Grove commits to main, one commit per **skill run**, with all decisions made during that run enumerated in the JSONL append. Commit message is human-readable ("daily-vault-review: 3 link suggestions, 1 enrichment"). The granular event stream lives in the JSONL.

### state.db is a pure projection

The per-vault SQLite table `decisions` is rebuildable by replaying `.grove/decisions.jsonl`. If state.db is lost or corrupted: `grove rebuild-projection <vault>` replays the JSONL.

The inbox API (`GET /v/<vault>/v1/tasks`) reads from state.db for speed. State.db never holds information not present in the JSONL.

### Rollback is forward

When the user picks a different option:

1. New skill task spawned: "compensate D-2026-05-20-001 + re-execute with chosen_option=opt-2"
2. Skill computes the compensation from the decision's `affected_paths` and `payload`
3. Emits a new commit with the compensation + re-execution
4. New JSONL entry references `compensates: "D-2026-05-20-001"`
5. Original decision's `status` → `compensated`

Never `git revert`. Never rewrites history. Cascade is just X — downstream work that built on the old decision stays unless the user separately corrects it (it'll show up in a future inbox item if it becomes inconsistent).

## The three suggestion classes

### Enrichment

> "This Concept has 2 sentences. Here's a 4-paragraph expansion drafted from Journal mentions. Apply?"

Payload: target note path, current content hash, proposed content (rendered).
Schema options: apply / dismiss / refine.
Replaces today's "confirm this paragraph the LLM wrote" — PR #71's plumbing carries over with the new item shape.

### Links

> "Journal entry 2026-05-19 mentions Anna with no link. Connect to [[Anna Chen]]?"

Payload: source path, surface form, target candidates ranked.
Schema options: link to <top candidate> / link to <2nd> / link to <3rd> / no link.
Highest volume; lowest stakes per item.

### Disambiguation

> "Anna in this entry — Anna Chen (designer) or Anna Kim (PM)?"

Payload: source path, ambiguous reference, candidates with disambiguation signals.
Schema options: <candidate A> / <candidate B> / archive both / refine.
Unblocks autonomous work that today degrades silently.

## Refine = free instruction

When the user types "actually merge into Anna Kim" in the refine box:

1. The text + the original item's payload spawn a new autonomous task
2. The task runs with the free instruction as its directive
3. Original decision is marked compensated; new task's output lands in inbox or is auto-applied if unambiguous

Not parsed back into the schema. Not iterative dialogue. Closer to "delegate the correction" than "fill in a form."

## Dismiss = soft suppress

Dismiss closes the item AND records a suppression key: `(vault, suggestion_type, primary_entity)`. Same exact suggestion won't resurface for N days (default 14, per-skill tunable).

Suppressions live in state.db (rebuildable from JSONL events: `{type: "dismiss", suppression_key: ..., until: ...}`).

## UI shape

### BacklogIsland (today)

`NeedsReviewList` shows items grouped. Today each row has uniform verbs. New behavior:

- Each row reads `task.options` and renders THOSE buttons, not a fixed verb set
- "Refine" stays as a fallback row affordance (opens existing `RefineModal`)
- First-write modal logic stays for enrichment items (write-class artifacts)

### Item types in payload

`Task` type gains an `item_type: "enrichment" | "link" | "disambiguation"` and an `options: ReviewOption[]` field. Mock + live impls stay parity-shaped.

## Migration from today

1. New endpoints, additive
2. `daily-vault-review` skill rewritten to emit suggestion items (or stop emitting; folded into a new `forage` skill)
3. Today's 25 prod review rows: scripted migration to the new shape OR mass-dismissal (TBD at deploy time)
4. `confirm-durable` verb deprecated; replaced by `apply` (or per-type equivalent)

## Phasing

- **P0** Lock spec (this doc), commit, push
- **P1** state.db schema: `decisions` table, `suppressions` table, `.grove/decisions.jsonl` writer
- **P2** Server: new `/v1/tasks` shape with `item_type` + `options`; suggestion-class item generators (Enrichment, Links, Disambiguation) — start with Disambiguation, smallest schema
- **P3** Server: rollback path (compensation + re-run from JSONL)
- **P4** www: BacklogIsland reads `task.options` and renders dynamic buttons; refine spawns new task
- **P5** Migrate prod 25 review rows
- **P6** Remove deprecated verbs

## Open / deferred

- Maturation/lifecycle as a fourth surface class — out of v1
- Unification with `Inbox/` folder — deferred
- Suppression learning beyond N-day timeout — deferred
- Notifications / push on new inbox items — deferred (pull-only for now)

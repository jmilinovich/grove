# Grove changelog

User-facing notes on what changed and what to try.

## 2026-05-09 — V3: provenance & age-aware search ranking

**What this changes for you, in one sentence.** Grove search now knows the difference between *what John actually thinks* (durable) and *what an AI synthesized at a moment in time* (perishable), and ranks accordingly. When a result is perishable, every search response carries the same "pause and name it" directive that `get` already emits — so Claude can't silently extend an AI guess as if it were your standing position.

### Live now

- **Personal vault (`grove.md/@jm`)**: V3 ranking is on. Other vaults (sharpshoot, ryan, test-vault) still on the old ranking — they'll flip after a soak period.
- **Search response envelope** now carries `voice` + `written_at` on every hit. When voice is `perishable`, the response also includes `usage_directive` instructing Claude to name the perishable framing before quoting or extending.
- **Auto-detected query intent**: queries with date markers or freshness terms ("today", "latest", "this week", `2026-05-09`) automatically prefer recent perishable results. Queries with durable-intent terms ("understanding", "theory", "framework", "philosophy") force canonical mode even if they also contain freshness words ("latest understanding of attachment theory" stays canonical).
- **`getNoteVoicesAndAges` slugify-on-read** — new search reweight matches QMD's lowercase-kebab path against `note_blame`'s filesystem path correctly. Hotfix [#149](https://github.com/jmilinovich/grove/pull/149) on top of [#147](https://github.com/jmilinovich/grove/pull/147).

### What you'll actually see

For the **183 perishable-stamped notes** from Phase A (the known-contaminated AI-synthesized notes John flagged on 2026-05-07), search results now show:

```
**<Note title>** (https://grove.md/...)
<snippet>
_voice: perishable, written 2026-04-30T22:15:00Z_
> This note contains perishable segments — moment-in-time synthesis or
> prediction by an AI agent that may now be stale. You MUST: ...
```

For everything else (~1,500 unstamped notes), results show `_voice: legacy-unknown_` with no directive. Behind the scenes, a per-note prior (folder + age + AI-watermark heuristics) gently biases ranking — `Resources/Concepts/` and `Resources/People/` lean durable, `Inbox/` leans perishable. You won't notice this on most queries; you'll notice it most when an Inbox AI-synthesis would have outranked your canonical concept note.

### What's deferred to v3.1

Captured in `IDEAS.md` under "v3.1 search-quality cluster":

1. **Runtime-mutable per-collection flag** — today, flipping ranking off requires SSH + edit `.env` + `pm2 reload`. ≤60s admin-endpoint flag is the gate to the multi-vault rollout.
2. **7-day soak harness with reason chips** — production-judgment gate (offline eval can't predict subjective quality on a 1,500-note vault).
3. **Per-list voice factor inside `rrfFuse`** — IR-panel improvement; needs 7 days of `voice_at_rank{list}` observability data first.
4. **Multi-segment matched-span resolution** — full §D2 worst-case-voice rule (current implementation uses note-level modal voice).

### How to revert

```sh
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231
sudo sed -i 's/GROVE_PROV_RANKING_ENABLED=true/GROVE_PROV_RANKING_ENABLED=false/' /root/grove/.env
sudo bash -c 'cd /root/grove && pm2 reload ecosystem.runtime.config.cjs --only grove-server-personal --update-env'
```

### Prompts to try in your vault

These will show you the difference. Try each via Claude.ai (Grove MCP connected to your personal vault).

#### 1. Watch a known-contaminated note get tagged

```
Search Grove for "conviction then leave pattern" and tell me what you find.
```

The Phase A stamp on `Resources/Concepts/Conviction-Then-Leave Pattern.md` will surface as `_voice: perishable, written 2026-04-30T22:15:00Z_` with the directive. Notice Claude's response: it should *name* the perishable framing before extending. ("This note is perishable — I'm reading it as a quoted artifact, not a standing claim.")

#### 2. Test the freshness-intent auto-detect (positive)

```
Search Grove for "what are the latest Claude models I'm tracking right now"
```

The query has `latest` + `right now`. Auto-detect picks `recent` mode → recent perishable Inbox notes about model lineups float up. Compare to before: those would have ranked alongside / below durable concept notes about Claude.

#### 3. Test the freshness-intent negative gate

```
Search Grove for "latest understanding of attachment theory"
```

Same `latest` token, but `understanding` is in the durable-intent gate → mode forces `mixed` → the durable `Resources/Concepts/Attachment Theory.md` (or equivalent) wins. This is the case the panels worried we'd misroute. We didn't.

#### 4. Surface a perishable contamination case

Pick another note from the Agent B catalog (Phase A's known-contaminated set). Try:

```
Search Grove for "reading recruiter signals" — what does the system say about provenance?
```

If the cache for that path has been warmed (one prior `get` call), search will now correctly tag it perishable with the directive. If not yet warmed, a single `get` call will populate the cache for next time.

#### 5. Same-vault A/B by query rephrase

Run these two consecutively and compare top-3:

```
Search Grove for "parametric design" — show me the top 3.
Search Grove for "parametric design philosophy concept" — show me the top 3.
```

The second triggers the durable-intent gate (`philosophy`, `concept`) more strongly. Watch whether `Resources/Concepts/Parametric Design` outranks the Inbox/Sources hits more cleanly on the second.

### Honest gotchas

- **Most results still show `legacy-unknown`** because the cache is cold. As you `get` notes (manually or via Claude pulling them through), the cache warms and subsequent searches show real voice.
- **Only the personal vault has the flag on.** Other vaults retain the old behavior until we soak this for ~24h.
- **Latency on first read of a stamped note** is slightly higher (the blame walker fires once per note). Cache hit on subsequent reads — back to baseline.
- **The 5-min cron sync** rotates the blame cache today. The post-sync warmup hook is in place but won't fire until the next sync (within 5 min of writing this).
- **Auto-revert is manual** — the runtime-flag work (v3.1 #1) hasn't shipped, so revert is the SSH dance above (~30 seconds with the right .env line). Track-the-revert-clock work is in IDEAS.md.

### Status

| Component | State |
|---|---|
| Code in main | ✓ ([#147](https://github.com/jmilinovich/grove/pull/147), [#149](https://github.com/jmilinovich/grove/pull/149)) |
| Deployed to prod | ✓ SHA `d9639fd` + slugify hotfix on top |
| Flag on (personal vault) | ✓ |
| Flag on (sharpshoot, ryan, test-vault) | ✗ — soak first |
| Post-sync warmup wired | ✓ (next cron will populate cache) |
| Observability metrics | ✓ — voice-at-rank, legacy-unknown share, lookup latency, voice_preference, 1% reweight-delta sample |
| Runtime-mutable flag | ✗ — v3.1 |
| 7-day soak harness | ✗ — v3.1 |

### Iteration trail

V1 → V2 → V3 across three rounds of three parallel expert panels (IR/ranking, KG/semantic-memory, Production/SRE). Round 3 verdict: "architecture is sound; spec tightening only." Full trail at `scripts/eval-search-quality/V{1,2,3}_PLAN.md`.

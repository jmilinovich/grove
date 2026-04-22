# ship.ts — autonomous batch orchestrator

`scripts/ship.ts` spawns parallel Claude Code agents in git worktrees, merges their work into a `ship/<batch-id>` branch, opens a PR, and waits for GitHub's auto-merge to land it. Replaces the four bash scripts (`run-batch.sh`, `ship-phases-16-17-18.sh`, `ship-remaining.sh`, `ship-final.sh`) that used to do this job less reliably.

## When to use

When you want to ship a batch of related tasks from `PLAN.md` without hand-orchestrating each one. The batch registry at `scripts/ship/batches.ts` lists every pending batch with its agent prompts and prerequisites.

## Commands

```bash
npm run ship -- --list                  # show batches + status
npm run ship -- --dry-run               # plan, don't execute (from first pending)
npm run ship -- --dry-run --from p8a-2  # plan from p8a-2 onwards
npm run ship -- --only p8a-1            # just this batch
npm run ship -- --from p8a-1            # run p8a-1 to end
npm run ship                            # run next pending batch onwards
```

The `--` is required; npm passes everything after it as script args.

## What it does per batch

1. **Preflight** — asserts grove and grove-www are both on `main`, clean, synced with origin.
2. **Worktree setup** — for each agent in the batch, creates `.claude/worktrees/<slug>/` on a fresh `worktree-<slug>` branch off `origin/main`.
3. **Agent spawn** — runs each worktree's agent in parallel via `@anthropic-ai/claude-agent-sdk`'s `query()`. Two timeouts:
   - **30-min hard cap** per agent — aborts stuck work.
   - **5-min heartbeat** — if the agent stops producing events for 5 min, we assume it's hung and abort. Kills the p18-style hang we saw last week.
4. **grove-www sync** — if agents committed to grove-www's main, push it. If they committed to a feature branch, cherry-pick onto main and push. grove-www has no branch protection — direct push is fine there.
5. **Ship branch** — `git checkout -B ship/<batch-id> origin/main` then merge each `worktree-<slug>` into it. Fails fast if no commits landed.
6. **Open PR** — `gh pr create`, then `gh pr merge --auto --squash --delete-branch`. The PR waits in GitHub's auto-merge queue until required checks (`test`, `plan-drift`, `audit`, `secrets`) pass.
7. **Poll** — every 15s, check if the PR merged. If `mergeStateStatus` goes `BEHIND` (Dependabot merged ahead of us), run `gh pr update-branch` and keep waiting. 30-min cap on total wait.
8. **Log progress** — append a JSON line to `.agents/progress.jsonl`.
9. **Advance** — pull main, clean up worktrees, move to the next batch.

## Resume

`ship.ts` resolves "what still needs to run" from three sources in priority order:

1. **`gh pr list --state merged --search "ship/ in:head"`** — authoritative: any batch whose ship PR is merged is done.
2. `.agents/progress.jsonl` — local cache of batch outcomes.
3. Batch registry in `scripts/ship/batches.ts` — controls order.

So `npm run ship -- --from p8a-3` skips `p8a-1` and `p8a-2` automatically if their ship PRs are already merged, even if `progress.jsonl` is out of sync with reality. Never trust progress.jsonl alone.

## Failure modes

| Symptom | What happened | How to recover |
|---|---|---|
| `halting. Worktrees preserved for inspection.` | One or more agents failed or timed out. | Inspect `.claude/worktrees/<slug>/` for partial work. Fix the prompt or the task spec. Re-run `npm run ship -- --from <batch>`. |
| `ship/<id>: no code merged` | All agent worktrees were empty — they exited without committing. | Confirm the Stop hook is wired (`.claude/settings.json`). If it is, the safety-net commit should have landed. If not, something in the hook or prompt is broken. |
| `PR #N did not merge within 30m` | CI is failing or blocked, or auto-merge never fired. | `gh pr view <N>` — check which required check is red. Fix manually, re-run `ship --from <next-batch>`. |
| `mergeStateStatus: BEHIND` (repeatedly) | Dependabot is racing. Usually resolves on its own, but if it loops forever: | `gh pr update-branch <N>` manually, or rebase `ship/<id>` onto latest main and force-push. |

## Emergency abort

Mid-run, **`Ctrl-C`**. Worktrees stay on disk. To reset:

```bash
git worktree list                                    # see what's there
git worktree remove .claude/worktrees/<slug> --force # per worktree
git branch -D worktree-<slug>                        # branch
git branch -D ship/<batch-id>                        # ship branch (if pushed, gh pr close first)
```

If a ship PR is already open and you want to abandon it: `gh pr close <N> --delete-branch`.

## Cross-repo asymmetry (important)

- **grove** → PR-only. Branch protection on main requires 4 green checks. `ship.ts` opens a PR.
- **grove-www** → direct push. No branch protection. `ship.ts` pushes agent commits directly to `origin/main`.

If grove-www ever gets branch protection, update `groveWwwSyncAfter()` in `ship.ts` to open a PR there too. This asymmetry is documented in `AGENTS.md` so future Claude sessions don't silently add protection without updating the orchestrator.

## Files

- `scripts/ship.ts` — orchestrator (~400 LOC)
- `scripts/ship/batches.ts` — batch registry; add new batches here
- `.agents/progress.jsonl` — per-batch outcomes (gitignored)
- `.claude/worktrees/<slug>/` — live worktrees (gitignored)

## What it does NOT do

- Run tests on agent commits before opening the PR — that's what CI is for. Agents run `npm test` themselves per their prompt, but the authoritative pass is the CI `test` check.
- Roll back a failed merge. If a PR merges something broken, `git revert <merge-sha>` on main + open a follow-up PR.
- Handle more than one batch executing in parallel. Batches run strictly sequentially.

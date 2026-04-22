# grove — agent notes

Architecture rules live in `CLAUDE.md`. This file holds the rules for
how agents open, verify, and merge PRs.

## Before shipping a change

Run **`npm run check`** — the fast local gate. It runs:

1. `npx tsc --noEmit` — typecheck.
2. `npm test` — the full vitest suite.

The same checks run in CI (`check / test` + `check / audit` + `check / secrets`)
plus a `plan-drift` job that validates `PLAN.md` tasks against the code.
CI must be green before merge.

## Pre-push hook (opt-in)

`.githooks/pre-push` runs `npm run check` before every push so local
regressions don't burn a CI minute. Opt in once per clone:

```bash
git config core.hooksPath .githooks
```

Opt out with `git config --unset core.hooksPath`. Bypass a single push
with `git push --no-verify` — don't make a habit.

## Merging PRs — standing authorization

You are authorized to merge PRs into `main` without asking first, *if*
all of the following are true:

- CI is green: `test`, `plan-drift`, `audit`, `secrets` all SUCCESS.
- `mergeable == "MERGEABLE"` and `mergeStateStatus` is `CLEAN`.
- Not a draft.
- No `changes requested` review.
- No label named `needs-human`, `wip`, or `do-not-merge`.
- For Dependabot PRs: any version bump passing CI is fair game,
  including majors of dev tooling. `@modelcontextprotocol/sdk` and
  `better-sqlite3` **majors** are always off-limits — Dependabot is
  configured to skip them but check anyway. `@anthropic-ai/sdk` updates
  (including majors) are fine; the SDK tracks Claude releases we want.

**Default for your own PRs:** `gh pr merge <n> --auto --squash --delete-branch`.
This uses GitHub's native auto-merge queue — the PR sits until required
checks pass, then merges without a second touch.

**For existing Dependabot PRs that are already green:**
`gh pr merge <n> --squash --delete-branch`.

Stale PRs from Dependabot: comment `@dependabot rebase` and re-check
status before merging.

### Ask before merging when

- The PR changes `CLAUDE.md`, `AGENTS.md`, or `PLAN.md` substantively.
- The PR removes tests, lowers the CI bar, or disables status checks.
- The PR touches `src/db-migration*.ts` or `src/db.ts` schema — the
  deploy job has a schema-change guard that requires explicit
  confirmation.
- CI is red for a reason that isn't "rebase onto current main."
- The PR author is a first-time external contributor.

### GitHub auth note

The `gh` CLI used for merges must have the `workflow` scope to merge
PRs that touch `.github/workflows/*`. If `gh pr merge` fails with
"refusing to allow an OAuth App to create or update workflow", run
`gh auth refresh -s workflow` once to grant the scope.

## Claude Code hooks

`.claude/settings.json` wires two hooks active for every agent session in this repo:

- **`Stop`** (`.claude/hooks/stop-autocommit.sh`) — runs only inside agent
  worktrees (`.claude/worktrees/<branch>/`), never in the main repo. If the
  worktree has uncommitted work when the agent exits, auto-commits with
  subject `auto: Stop hook safety-net — agent exited without committing`.
  Protects against data loss when an agent finishes work and exits without
  committing. Review these commits — they're a signal the prompt's commit
  step was skipped and may need reinforcement. Don't propagate them as
  real feature commits; squash or rewrite before merging.
- **`PostToolUse`** on `Bash` (`.claude/hooks/post-commit-mark-plan.sh`) —
  after any successful `git commit`, parses the subject for a task ID
  (`feat(P8-A1): …`, `fix(CLI-A3): …`, etc.) and delegates to
  `scripts/mark-plan-task.mjs`, which idempotently appends `✅ COMPLETE
  <date> (<sha>)` to the corresponding `#### <id>:` heading in PLAN.md
  and stages the change. Ignores `auto:`-prefixed safety-net commits.
  Run `bash scripts/test-hooks.sh` to verify the hooks locally.

Net: agents don't hand-edit PLAN.md, and the main-repo `scripts/check-plan-drift.ts`
CI gate stays as belt-and-suspenders for non-agent commits (manual PRs,
Dependabot).

## CI topology

**`check` workflow (`.github/workflows/ci.yml`)** runs on every PR:
- **`test`** — `npm ci` → `tsc --noEmit` → `npm test` (vitest)
- **`plan-drift`** — validates `PLAN.md` against code
- **`audit`** — `npm audit --audit-level=high`
- **`secrets`** — gitleaks scan
- **`deploy`** — `workflow_dispatch` only; SSHes to the VPS, snapshots
  the current SHA, deploys, polls `/health`, auto-rolls-back on
  failure. See the deploy job in `ci.yml` and `deploys.md` for history.

**`dependabot-auto-merge` workflow** runs on every Dependabot PR,
classifies the update, and enables `--auto --squash` on anything that
isn't a listed framework major. Uses `AUTOMERGE_PAT` (repo secret) so
commits this workflow pushes retrigger CI normally.

## Dependencies

Dependabot (`.github/dependabot.yml`) opens one grouped weekly PR for
npm bumps (dev-deps: all update types; prod: minor+patch only). Major
production updates come as individual PRs. GitHub Actions pin bumps
come as one grouped monthly PR. `@modelcontextprotocol/sdk` and
`better-sqlite3` majors are ignored outright.

## Branch protection (configured on GitHub)

Recommended rules on `main`:

- Require pull request before merging.
- Require status checks: `test`, `plan-drift`, `audit`, `secrets`.
- Require branches to be up to date before merging.
- Block force pushes.
- Restrict deletions.

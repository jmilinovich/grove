#!/usr/bin/env bash
# Stop hook — safety net for agents that exit without committing.
#
# Fires on Claude session Stop. Only acts inside agent worktrees
# (path contains /worktrees/). Never fires in the main repo session.
# Guards against in-progress rebase/merge/cherry-pick. Respects
# stop_hook_active so /clear-style stops don't loop.
#
# Input: JSON on stdin from Claude Code with at least
#   { "stop_hook_active": bool, "session_id": "...", ... }
#
# Exit 0 in all normal paths. Non-zero would block Stop, which is
# never what we want here.

set -euo pipefail

# Must be inside an agent worktree — never the main repo
case "$PWD" in
  */.claude/worktrees/*) : ;;
  *) exit 0 ;;
esac

# Git ops in progress? Leave alone — committing mid-rebase corrupts state
if [ -d .git/rebase-merge ] \
   || [ -d .git/rebase-apply ] \
   || [ -f .git/MERGE_HEAD ] \
   || [ -f .git/CHERRY_PICK_HEAD ] \
   || [ -f .git/REVERT_HEAD ]; then
  exit 0
fi

# Parse input JSON (if present). Avoid looping on recursive Stop events.
input=""
if [ ! -t 0 ]; then
  input=$(cat)
fi
if [ -n "$input" ] && command -v jq >/dev/null 2>&1; then
  active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null || echo "false")
  [ "$active" = "true" ] && exit 0
fi

# Detect uncommitted work (tracked changes + untracked).
# Exclude node_modules and any .env files as a hard guard against
# ever staging secrets or dep graphs.
dirty=false
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  dirty=true
fi
if [ "$dirty" = false ]; then
  # Look for untracked files that aren't already ignored (and aren't in the exclude-list)
  untracked=$(git ls-files --others --exclude-standard 2>/dev/null \
    | grep -vE '^(node_modules/|\.env($|\.)|\.claude/worktrees/)' \
    || true)
  [ -n "$untracked" ] && dirty=true
fi

[ "$dirty" = false ] && exit 0

# Safety-net commit. The label is intentional so humans reading the log
# know this wasn't a real feature commit. AGENTS.md documents this.
git add -A -- ':!node_modules' ':!.env' ':!.env.*' 2>/dev/null || true

# Nothing staged after the exclusions? (rare, but possible)
if git diff --cached --quiet 2>/dev/null; then
  exit 0
fi

git commit --no-verify -m "auto: Stop hook safety-net — agent exited without committing

The agent finished its session with uncommitted work. This commit was
created by .claude/hooks/stop-autocommit.sh to prevent data loss when
the worktree is cleaned up. Review these changes before propagating
them as a real feature commit." >/dev/null 2>&1 || true

exit 0

#!/usr/bin/env bash
# PostToolUse hook (matcher: Bash) — auto-marks PLAN.md when a commit
# subject references a known task ID (feat(P8-A1): …, fix(CLI-A3): …).
#
# Fires after every Bash tool use. Short-circuits unless:
#   - the command was a git commit
#   - the commit succeeded (exit_code 0)
#   - the resulting HEAD has a conventional subject with a task ID
#
# The actual PLAN.md mutation lives in scripts/mark-plan-task.mjs.
# This script is just the dispatcher.

set -euo pipefail

# No input? Nothing to do (unusual but safe to bail).
[ -t 0 ] && exit 0
input=$(cat)

# Need jq for stdin parsing. Fail open — if jq is missing, don't block.
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
exit_code=$(printf '%s' "$input" | jq -r '.tool_response.exit_code // .tool_response.exit // 1' 2>/dev/null || echo "1")

# Only care about git commits that succeeded.
[[ "$cmd" =~ git[[:space:]]+commit ]] || exit 0
[ "$exit_code" = "0" ] || exit 0

# Ignore safety-net commits (don't mark PLAN.md for those).
# The stop-autocommit hook commits with subject prefix "auto:".
subject=$(git log -1 --format=%s HEAD 2>/dev/null || echo "")
case "$subject" in
  auto:*) exit 0 ;;
esac

# Match task IDs: P8-A1, P4-API-2, CLI-A3, REST-2, etc.
# Mirror of scripts/check-plan-drift.ts regex.
if [[ "$subject" =~ \((P[0-9]+(-[A-Z]+)*-[A-Z0-9]+|CLI-[A-Z][0-9]+|REST-[0-9]+)\) ]]; then
  task_id="${BASH_REMATCH[1]}"
else
  exit 0
fi

# Find the marker script relative to THIS hook, not via CLAUDE_PROJECT_DIR.
# The hook lives at .claude/hooks/post-commit-mark-plan.sh inside the repo,
# so the script sits two levels up + /scripts/. Using our own path keeps
# the hook working regardless of how/where Claude Code sets its env.
hook_dir=$(cd "$(dirname "$0")" && pwd)
mark_script="$(cd "$hook_dir/../.." && pwd)/scripts/mark-plan-task.mjs"

if [ ! -f "$mark_script" ]; then
  echo "[mark-plan] mark-plan-task.mjs not found at $mark_script — skipping" >&2
  exit 0
fi

sha=$(git log -1 --format=%h HEAD 2>/dev/null || echo "")

# Delegate to the Node helper. CLAUDE_PROJECT_DIR (or the cwd's git
# toplevel) is the PLAN.md target — mark-plan-task.mjs resolves that
# itself. Silent success; log a note on failure without blocking.
if ! node "$mark_script" "$task_id" "$sha" 2>&1 | sed 's/^/[mark-plan] /' >&2; then
  :
fi

exit 0

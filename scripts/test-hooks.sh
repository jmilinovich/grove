#!/usr/bin/env bash
# test-hooks.sh — fixture-based tests for the Claude Code hooks.
#
# Runs the Stop hook and PostToolUse hook against fixture inputs in an
# isolated temp git repo. Asserts each scenario behaves as spec'd.
# No network, no API calls, no claude CLI needed. Run locally or in CI.

set -uo pipefail
# Deliberately not using `set -e` — assertions tolerate failures, and the
# fixture repos are set up in ways where individual git commands may
# legitimately exit non-zero (e.g. `git log` when no commits exist).

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STOP_HOOK="$PROJECT_DIR/.claude/hooks/stop-autocommit.sh"
POST_HOOK="$PROJECT_DIR/.claude/hooks/post-commit-mark-plan.sh"
MARK_SCRIPT="$PROJECT_DIR/scripts/mark-plan-task.mjs"

pass=0
fail=0

assert() {
  local label="$1"; shift
  if "$@"; then
    echo "  ✓ $label"
    pass=$((pass + 1))
  else
    echo "  ✗ $label"
    fail=$((fail + 1))
  fi
}

# ── Setup ──────────────────────────────────────────────────────────

[ -x "$STOP_HOOK" ] || { echo "FAIL: $STOP_HOOK not executable"; exit 1; }
[ -x "$POST_HOOK" ] || { echo "FAIL: $POST_HOOK not executable"; exit 1; }
[ -f "$MARK_SCRIPT" ] || { echo "FAIL: $MARK_SCRIPT not found"; exit 1; }

command -v jq >/dev/null 2>&1 || { echo "FAIL: jq required"; exit 1; }

# ── Test 1: Stop hook in main repo (not a worktree) ──────────────────
echo "[1] Stop hook in main repo (not a worktree) — should no-op"

tmp1=$(mktemp -d)
pushd "$tmp1" >/dev/null
git init -q -b main
git config user.email "t@example.com"
git config user.name "T"
echo "hello" > a.txt
# Non-worktree path: /tmp/... — hook should exit 0 without committing
CLAUDE_PROJECT_DIR="$tmp1" bash "$STOP_HOOK" < /dev/null || true
commits_after=$(git log --oneline 2>/dev/null | wc -l | tr -d ' ')
assert "no commit created" test "$commits_after" = "0"
popd >/dev/null
rm -rf "$tmp1"

# ── Test 2: Stop hook inside worktrees/ path (dirty) ─────────────────
echo "[2] Stop hook in worktree path with dirty tree — should commit"

tmp2=$(mktemp -d)
mkdir -p "$tmp2/.claude/worktrees/fake-agent"
pushd "$tmp2/.claude/worktrees/fake-agent" >/dev/null
git init -q -b main
git config user.email "t@example.com"
git config user.name "T"
git commit -q --allow-empty -m "initial"
echo "work" > scratch.txt
# Simulate Stop hook with no stop_hook_active loop
printf '{"session_id":"abc","stop_hook_active":false}' | CLAUDE_PROJECT_DIR="$tmp2" bash "$STOP_HOOK" || true
sub=$(git log -1 --format=%s 2>/dev/null || echo "")
assert "safety-net commit created" test "${sub:0:4}" = "auto"
popd >/dev/null
rm -rf "$tmp2"

# ── Test 3: Stop hook with stop_hook_active=true — should skip ──────
echo "[3] Stop hook with stop_hook_active — should no-op"

tmp3=$(mktemp -d)
mkdir -p "$tmp3/.claude/worktrees/fake-agent"
pushd "$tmp3/.claude/worktrees/fake-agent" >/dev/null
git init -q -b main
git config user.email "t@example.com"
git config user.name "T"
git commit -q --allow-empty -m "initial"
echo "work" > scratch.txt
printf '{"session_id":"abc","stop_hook_active":true}' | CLAUDE_PROJECT_DIR="$tmp3" bash "$STOP_HOOK" || true
commits=$(git log --oneline 2>/dev/null | wc -l | tr -d ' ')
assert "still only 1 commit" test "$commits" = "1"
popd >/dev/null
rm -rf "$tmp3"

# ── Test 4: Stop hook with no dirty state — no-op ────────────────────
echo "[4] Stop hook with clean tree — should no-op"

tmp4=$(mktemp -d)
mkdir -p "$tmp4/.claude/worktrees/fake-agent"
pushd "$tmp4/.claude/worktrees/fake-agent" >/dev/null
git init -q -b main
git config user.email "t@example.com"
git config user.name "T"
git commit -q --allow-empty -m "initial"
# Clean tree — no files added
printf '{"session_id":"abc","stop_hook_active":false}' | CLAUDE_PROJECT_DIR="$tmp4" bash "$STOP_HOOK" || true
commits=$(git log --oneline 2>/dev/null | wc -l | tr -d ' ')
assert "still only 1 commit on clean tree" test "$commits" = "1"
popd >/dev/null
rm -rf "$tmp4"

# ── Test 5: PostToolUse hook — non-git-commit Bash call ──────────────
echo "[5] PostToolUse on non-git-commit Bash call — should no-op"

tmp5=$(mktemp -d)
cp "$PROJECT_DIR/PLAN.md" "$tmp5/PLAN.md"
pushd "$tmp5" >/dev/null
git init -q -b main
git config user.email "t@example.com"
git config user.name "T"
git add PLAN.md
git commit -q -m "initial"
before=$(md5 -q PLAN.md 2>/dev/null || md5sum PLAN.md | cut -d' ' -f1)
printf '{"tool_input":{"command":"ls -la"},"tool_response":{"exit_code":0}}' | CLAUDE_PROJECT_DIR="$tmp5" bash "$POST_HOOK" || true
after=$(md5 -q PLAN.md 2>/dev/null || md5sum PLAN.md | cut -d' ' -f1)
assert "PLAN.md unchanged" test "$before" = "$after"
popd >/dev/null
rm -rf "$tmp5"

# ── Test 6: PostToolUse — git commit with PX-Y, PLAN.md has that task ─
echo "[6] PostToolUse marks PLAN.md when task is active and unmarked"

tmp6=$(mktemp -d)
cat > "$tmp6/PLAN.md" <<'MD'
# Test PLAN

#### P99-X1: Fake task for hook testing

Some description.

#### P99-X2: Already-marked task ✅ COMPLETE 2026-01-01 (beef123)

Already done.
MD
pushd "$tmp6" >/dev/null
git init -q -b main
git config user.email "t@example.com"
git config user.name "T"
git add PLAN.md
git commit -q -m "feat(P99-X1): fake implementation"
sha=$(git log -1 --format=%h HEAD)
printf '{"tool_input":{"command":"git commit -m test"},"tool_response":{"exit_code":0}}' \
  | CLAUDE_PROJECT_DIR="$tmp6" bash "$POST_HOOK" 2>/dev/null || true
grep -qE "^#### P99-X1:.*✅ COMPLETE.*\($sha\)" PLAN.md
rc=$?
popd >/dev/null
assert "PLAN.md got ✅ COMPLETE with correct sha" test $rc -eq 0
rm -rf "$tmp6"

# ── Test 7: PostToolUse idempotent — already-marked task ─────────────
echo "[7] PostToolUse on already-marked task — idempotent"

tmp7=$(mktemp -d)
cat > "$tmp7/PLAN.md" <<'MD'
#### P99-X2: Already-marked task ✅ COMPLETE 2026-01-01 (beef123)

Nothing new here.
MD
pushd "$tmp7" >/dev/null
git init -q -b main
git config user.email "t@example.com"
git config user.name "T"
git add PLAN.md
git commit -q -m "feat(P99-X2): poke"
before=$(md5 -q PLAN.md 2>/dev/null || md5sum PLAN.md | cut -d' ' -f1)
printf '{"tool_input":{"command":"git commit -m test"},"tool_response":{"exit_code":0}}' \
  | CLAUDE_PROJECT_DIR="$tmp7" bash "$POST_HOOK" 2>/dev/null || true
after=$(md5 -q PLAN.md 2>/dev/null || md5sum PLAN.md | cut -d' ' -f1)
popd >/dev/null
assert "PLAN.md unchanged on already-marked task" test "$before" = "$after"
rm -rf "$tmp7"

# ── Test 8: PostToolUse ignores 'auto:' safety-net commits ───────────
echo "[8] PostToolUse ignores auto: safety-net commits"

tmp8=$(mktemp -d)
cat > "$tmp8/PLAN.md" <<'MD'
#### P99-X3: Fake task
MD
pushd "$tmp8" >/dev/null
git init -q -b main
git config user.email "t@example.com"
git config user.name "T"
git add PLAN.md
git commit -q -m "auto: Stop hook safety-net — agent exited without committing"
printf '{"tool_input":{"command":"git commit -m test"},"tool_response":{"exit_code":0}}' \
  | CLAUDE_PROJECT_DIR="$tmp8" bash "$POST_HOOK" 2>/dev/null || true
before=$(git log --oneline | wc -l | tr -d ' ')
grep -qE "^#### P99-X3:.*✅" PLAN.md && rc=0 || rc=1
popd >/dev/null
assert "safety-net commits don't trigger PLAN.md marks" test $rc -ne 0
rm -rf "$tmp8"

# ── Test 9: PostToolUse — non-zero exit should no-op ─────────────────
echo "[9] PostToolUse with exit_code != 0 — should no-op"

tmp9=$(mktemp -d)
cat > "$tmp9/PLAN.md" <<'MD'
#### P99-X4: Fake task
MD
pushd "$tmp9" >/dev/null
git init -q -b main
git config user.email "t@example.com"
git config user.name "T"
git add PLAN.md
git commit -q -m "feat(P99-X4): fake"
printf '{"tool_input":{"command":"git commit -m test"},"tool_response":{"exit_code":1}}' \
  | CLAUDE_PROJECT_DIR="$tmp9" bash "$POST_HOOK" 2>/dev/null || true
grep -qE "^#### P99-X4:.*✅" PLAN.md && rc=0 || rc=1
popd >/dev/null
assert "failed commits don't trigger PLAN.md marks" test $rc -ne 0
rm -rf "$tmp9"

# ── Summary ──────────────────────────────────────────────────────────
echo
echo "passed: $pass"
echo "failed: $fail"
[ $fail -eq 0 ]

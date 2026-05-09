#!/usr/bin/env bash
# Called after vault git sync (cron pull) to enqueue changed notes for discovery.
# Usage: post-sync-discover.sh <vault-path> [fallback-since-ref] [server-port] [vault-slug]
#
# Finds .md files changed since the last successful run and POSTs each
# to the per-vault grove-server discovery trigger. The server_port arg
# lets multi-vault deployments target the right backend — each vault's
# grove-server-<slug> listens on its own port, so a single hardcoded
# 8190 would miss every non-personal vault.
#
# **Last-ref tracking** (added 2026-05 to fix amplification bug PR #140):
# we persist the SHA we successfully enqueued at to
# ${GROVE_STATE_DIR}/sync-ref-<vault-slug> and diff against THAT next
# run, instead of always against HEAD~1. With the old static HEAD~1
# diff, if no new commits landed in the 5-min cron window the same set
# of paths would re-enqueue every tick (4–7x amplification observed on
# personal vault), driving redundant Anthropic API spend. The state
# file collapses idle ticks to a no-op.
#
# - First run (no state file): we fall back to the legacy `HEAD~1`
#   behavior so a fresh deploy still pushes recent notes through. From
#   then on, the file is the source of truth.
# - State file is updated **only after the curl loop completes** —
#   if the loop dies mid-way, the next run still reprocesses from the
#   prior ref. This may briefly resurrect an in-flight path, but
#   downstream queue dedup (db.ts enqueueDiscovery) absorbs it.
# - State is per-vault (`<vault-slug>` in the filename). Two vaults
#   sharing a basename never collide.

set -euo pipefail

VAULT="${1:?Usage: post-sync-discover.sh <vault-path> [fallback-since-ref] [server-port] [vault-slug]}"
FALLBACK_SINCE="${2:-HEAD~1}"
PORT="${3:-8190}"
SLUG="${4:-}"

SERVER="http://127.0.0.1:${PORT}"
STATE_DIR="${GROVE_STATE_DIR:-/root/.grove/sync-state}"

cd "$VAULT"

# If no slug was passed (older sync-all-vaults.sh installs that haven't
# been re-deployed yet), derive a stable identifier from the absolute
# vault path. SHA1 keeps the filename short and avoids slash issues.
if [[ -z "$SLUG" ]]; then
  if command -v sha1sum >/dev/null 2>&1; then
    SLUG="$(printf '%s' "$VAULT" | sha1sum | cut -c1-12)"
  else
    SLUG="$(printf '%s' "$VAULT" | shasum -a 1 | cut -c1-12)"
  fi
fi

STATE_FILE="${STATE_DIR}/sync-ref-${SLUG}"
mkdir -p "$STATE_DIR"

current_head=$(git rev-parse HEAD)

if [[ -s "$STATE_FILE" ]]; then
  last_ref=$(<"$STATE_FILE")
else
  last_ref=""
fi

# Decide which ref to diff against:
#   - state file present + ref still reachable → use that
#   - state file present but ref unreachable (force-push, history rewrite) →
#     fall back to FALLBACK_SINCE so we don't silently skip changes
#   - no state file → first run, fall back to FALLBACK_SINCE
if [[ -n "$last_ref" ]] && git cat-file -e "${last_ref}^{commit}" 2>/dev/null; then
  if [[ "$last_ref" == "$current_head" ]]; then
    # Nothing new since last run — collapse to a no-op. This is the
    # path the bug fix is targeting: with the old script this branch
    # didn't exist and we'd diff `HEAD~1..HEAD` and re-enqueue the
    # last commit every cron tick.
    echo "[post-sync] no new commits since ${last_ref:0:12} (port=${PORT}, slug=${SLUG})"
    exit 0
  fi
  since="$last_ref"
else
  since="$FALLBACK_SINCE"
fi

# Get changed .md files since last sync
changed=$(git diff --name-only "$since" HEAD -- '*.md' 2>/dev/null || true)

if [[ -z "$changed" ]]; then
  # No file-level change in scope, but still advance the state file so
  # we don't keep rerunning this same diff next tick.
  printf '%s\n' "$current_head" > "$STATE_FILE"
  exit 0
fi

count=0
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  curl -sf "$SERVER/internal/discovery-trigger?path=$(printf '%s' "$path" | jq -sRr @uri)" > /dev/null 2>&1 || true
  count=$((count + 1))
done <<< "$changed"

# Advance the watermark only after the loop completes — if curl partially
# succeeded that's fine, the server-side queue dedup handles re-emits.
printf '%s\n' "$current_head" > "$STATE_FILE"

echo "[post-sync] enqueued $count note(s) for discovery (port=${PORT}, slug=${SLUG}, since=${since:0:12})"

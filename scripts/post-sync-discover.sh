#!/usr/bin/env bash
# Called after vault git sync (cron pull) to enqueue changed notes for discovery.
# Usage: post-sync-discover.sh <vault-path> [since-ref] [server-port]
#
# Finds .md files changed since last sync and POSTs each to the discovery
# trigger of the per-vault grove-server. The server_port argument lets
# multi-vault deployments target the right backend — each vault's
# grove-server-<slug> listens on its own port, so a single hardcoded 8190
# would miss every non-personal vault.

set -euo pipefail

VAULT="${1:?Usage: post-sync-discover.sh <vault-path> [since-ref] [server-port]}"
SINCE="${2:-HEAD~1}"
PORT="${3:-8190}"
SERVER="http://127.0.0.1:${PORT}"

cd "$VAULT"

# Get changed .md files since last sync
changed=$(git diff --name-only "$SINCE" HEAD -- '*.md' 2>/dev/null || true)

if [[ -z "$changed" ]]; then
  exit 0
fi

count=0
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  curl -sf "$SERVER/internal/discovery-trigger?path=$(printf '%s' "$path" | jq -sRr @uri)" > /dev/null 2>&1 || true
  count=$((count + 1))
done <<< "$changed"

echo "[post-sync] enqueued $count note(s) for discovery (port=${PORT})"

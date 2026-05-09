#!/usr/bin/env bash
# Sync all vaults (git pull + discovery trigger) — cron-driven.
#
# Replaces the single hardcoded `cd /root/life && git pull && post-sync-discover.sh /root/life`
# cron entry. Reads the full vault list from the DB so new vaults picked
# up by `grove vault create` start syncing automatically on the next tick.
#
# Usage (cron):
#   */5 * * * * /root/grove/scripts/sync-all-vaults.sh >> /var/log/grove-discovery.log 2>&1
#
# Env:
#   GROVE_DB_PATH   Path to grove.db (default: /root/.grove/grove.db)
#   GROVE_REPO      Path to grove checkout (default: /root/grove)

set -euo pipefail

DB_PATH="${GROVE_DB_PATH:-/root/.grove/grove.db}"
REPO_ROOT="${GROVE_REPO:-/root/grove}"
POST_SYNC="${REPO_ROOT}/scripts/post-sync-discover.sh"

if [[ ! -f "$DB_PATH" ]]; then
  echo "[sync-all-vaults] $DB_PATH not found — aborting" >&2
  exit 1
fi

if [[ ! -x "$POST_SYNC" ]]; then
  echo "[sync-all-vaults] $POST_SYNC not executable — aborting" >&2
  exit 1
fi

# Dump (slug, git_repo_path, server_port) tuples. `server_port` may be
# null for half-provisioned rows — skip those via a WHERE filter.
# sqlite3 -separator '|' keeps the output parseable even if a path
# contains spaces (no vault path does today, but be defensive).
mapfile -t vaults < <(
  sqlite3 -separator '|' "$DB_PATH" \
    "SELECT slug, git_repo_path, COALESCE(server_port, 8190)
       FROM vaults
      WHERE server_port IS NOT NULL
      ORDER BY slug"
)

if [[ ${#vaults[@]} -eq 0 ]]; then
  echo "[sync-all-vaults] no provisioned vaults in $DB_PATH — nothing to sync"
  exit 0
fi

ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
echo "[sync-all-vaults] ${ts} — syncing ${#vaults[@]} vault(s)"

for row in "${vaults[@]}"; do
  IFS='|' read -r slug path port <<< "$row"
  if [[ ! -d "$path/.git" ]]; then
    echo "[sync-all-vaults] ${slug}: skipping — $path is not a git repo"
    continue
  fi
  echo "[sync-all-vaults] ${slug} (${path}, port=${port})"
  # No remote configured? Mirror the silent-skip behavior of vault-ops.gitPush
  # (see src/vault-ops.ts:hasGitRemote). Vaults provisioned without
  # GROVE_VAULT_REMOTE_TEMPLATE are deliberately remote-less and have nothing
  # to pull — but they still get local writes from grove-server, so we still
  # want to run post-sync-discover so those new commits are picked up.
  if [[ -z "$(git -C "$path" remote)" ]]; then
    echo "[sync-all-vaults] ${slug}: no git remote configured — skipping pull, still running discovery"
  else
    # git pull --ff-only — if the upstream has diverged (unlikely because the
    # server is the sole writer per CLAUDE.md rule #2), we'd rather fail
    # loudly than auto-merge and corrupt state.
    if ! git -C "$path" pull --ff-only; then
      echo "[sync-all-vaults] ${slug}: git pull failed — skipping discovery trigger"
      continue
    fi
  fi
  # Pass the vault slug so post-sync-discover.sh can persist a per-vault
  # last-processed ref under /root/.grove/sync-state/. Without the slug,
  # it falls back to a SHA of the path which still works but is harder
  # to read in the filesystem.
  "$POST_SYNC" "$path" HEAD~1 "$port" "$slug" || true
done

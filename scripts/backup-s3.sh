#!/bin/bash
set -euo pipefail

BUCKET="grove-backups-jm"
PREFIX="daily"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="/tmp/grove-backup-${TIMESTAMP}.tar.gz"
GROVE_DIR="${HOME}/.grove"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting Grove backup..."

# Checkpoint WAL to ensure consistent SQLite snapshot — control db
# (grove.db) plus any per-vault state.db files under ~/.grove/vaults/.
sqlite3 "${GROVE_DIR}/grove.db" "PRAGMA wal_checkpoint(TRUNCATE);"
if [ -d "${GROVE_DIR}/vaults" ]; then
  for state_db in "${GROVE_DIR}"/vaults/*/state.db; do
    [ -f "${state_db}" ] || continue
    sqlite3 "${state_db}" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true
  done
fi

# Enumerate per-vault state.db files for the tarball (relative to GROVE_DIR
# so they restore back into the same layout). Written to a manifest file
# the tarball reads via -T to dodge bash 3.2 empty-array-under-nounset.
MANIFEST="$(mktemp -t grove-backup-manifest.XXXXXX)"
trap 'rm -f "${MANIFEST}"' EXIT

printf "grove.db\ncli.json\n" > "${MANIFEST}"
if [ -d "${GROVE_DIR}/vaults" ]; then
  (cd "${GROVE_DIR}" && find ./vaults -mindepth 2 -maxdepth 2 -name state.db -print 2>/dev/null) \
    | sed 's|^\./||' \
    >> "${MANIFEST}"
fi

# Create tarball — control db, CLI config, and any per-vault state.db files.
tar czf "${BACKUP_FILE}" \
  -C "${GROVE_DIR}" \
  -T "${MANIFEST}" \
  2>/dev/null || true

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Uploading to s3://${BUCKET}/${PREFIX}/..."
aws s3 cp "${BACKUP_FILE}" "s3://${BUCKET}/${PREFIX}/grove-backup-${TIMESTAMP}.tar.gz" --quiet

# Cleanup local temp file
rm -f "${BACKUP_FILE}"

# Retain last 30 backups
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Pruning old backups (keeping last 30)..."
aws s3 ls "s3://${BUCKET}/${PREFIX}/" \
  | awk '{print $4}' \
  | sort \
  | head -n -30 \
  | while read -r file; do
      if [ -n "${file}" ]; then
        aws s3 rm "s3://${BUCKET}/${PREFIX}/${file}" --quiet
        echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Deleted: ${file}"
      fi
    done

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Backup complete: grove-backup-${TIMESTAMP}.tar.gz"

#!/usr/bin/env bash
# P8-A7 — end-to-end multi-vault isolation smoke test.
#
# Verifies that provisioning a second vault on the same Grove server
# produces full isolation: each vault has its own grove-server +
# grove-discovery process, its own data, and no cross-vault leakage.
#
# Runs against the live VPS (`api.grove.md` by default) over SSH. Set
# `GROVE_VPS_HOST` / `GROVE_VPS_KEY` to target another host. Requires:
#
#   - SSH access to the VPS (the key from `docs/operations.md`)
#   - `sudo` on the VPS (for `pm2 reload`)
#   - an admin `ANTHROPIC_API_KEY` for the owner-key path
#
# Idempotent: the test cleans up its probe vault on exit. Re-runs with
# `KEEP_PROBE=1` leave the probe vault behind for manual inspection.
#
# Usage:
#   bash test/smoke/08-multi-vault.smoke.sh                 # happy path
#   KEEP_PROBE=1 bash test/smoke/08-multi-vault.smoke.sh    # leave probe vault
#   GROVE_VPS_HOST=54.1.2.3 bash test/smoke/08-multi-vault.smoke.sh

set -euo pipefail

SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_helpers.sh
source "${SMOKE_DIR}/_helpers.sh"

VPS_HOST="${GROVE_VPS_HOST:-52.37.76.231}"
VPS_KEY="${GROVE_VPS_KEY:-${HOME}/.ssh/grove-aws.pem}"
API_BASE="${GROVE_API_BASE:-https://api.grove.md}"
PROBE_SLUG="probe-$(date +%s | tail -c 6)"
OWNER_EMAIL="smoke+${PROBE_SLUG}@grove.local"

ssh_vps() {
  ssh -i "${VPS_KEY}" -o StrictHostKeyChecking=accept-new ubuntu@"${VPS_HOST}" "$@"
}

cleanup_probe() {
  if [ "${KEEP_PROBE:-0}" = "1" ]; then
    printf "  [KEEP_PROBE=1] leaving probe vault %s in place\n" "${PROBE_SLUG}"
    return 0
  fi
  ssh_vps "sudo pm2 delete grove-server-${PROBE_SLUG} grove-discovery-${PROBE_SLUG} 2>/dev/null || true; sudo rm -rf /root/vaults/${PROBE_SLUG} /root/qmd/${PROBE_SLUG}"
  ssh_vps "sqlite3 /root/.grove/grove.db \"DELETE FROM vault_members WHERE vault_id IN (SELECT id FROM vaults WHERE slug='${PROBE_SLUG}'); DELETE FROM api_keys WHERE vault_id IN (SELECT id FROM vaults WHERE slug='${PROBE_SLUG}'); DELETE FROM vaults WHERE slug='${PROBE_SLUG}';\""
}
trap cleanup_probe EXIT

echo "==> personal vault health"
personal_health=$(curl -sf "${API_BASE}/v/personal/health" || echo "")
assert "personal /health returns ok:true" "true" "$(echo "${personal_health}" | grep -o '"ok":true' >/dev/null && echo true || echo false)"

echo "==> provision probe vault ${PROBE_SLUG}"
provision=$(ssh_vps "cd /root/grove && node bin/grove vault create ${PROBE_SLUG} --owner ${OWNER_EMAIL} --json")
assert "grove vault create returns ok:true" "true" "$(echo "${provision}" | grep -o '"ok":true' >/dev/null && echo true || echo false)"
probe_token=$(echo "${provision}" | sed -n 's/.*"owner_api_token":"\([^"]*\)".*/\1/p')
assert "probe token minted" "nonempty" "$([ -n "${probe_token}" ] && echo nonempty || echo empty)"

echo "==> pm2 shows per-vault processes"
pm2_list=$(ssh_vps "sudo pm2 list --no-color")
assert "grove-server-${PROBE_SLUG} running" "yes" "$(echo "${pm2_list}" | grep -q "grove-server-${PROBE_SLUG}" && echo yes || echo no)"
assert "grove-discovery-${PROBE_SLUG} running" "yes" "$(echo "${pm2_list}" | grep -q "grove-discovery-${PROBE_SLUG}" && echo yes || echo no)"

echo "==> probe vault health"
probe_health=$(curl -sf "${API_BASE}/v/${PROBE_SLUG}/health" || echo "")
assert "probe /health returns ok:true" "true" "$(echo "${probe_health}" | grep -o '"ok":true' >/dev/null && echo true || echo false)"

echo "==> write + read isolation"
probe_note_path="Notes/smoke-${PROBE_SLUG}.md"
probe_note_content="# probe note ${PROBE_SLUG}\nisolation test"
write_resp=$(curl -sf -X PUT \
  -H "Authorization: Bearer ${probe_token}" \
  -H "Content-Type: application/json" \
  -d "{\"content\":\"${probe_note_content}\",\"frontmatter\":{\"type\":\"note\"}}" \
  "${API_BASE}/v/${PROBE_SLUG}/v1/notes/${probe_note_path}")
assert "write to probe vault accepted" "yes" "$(echo "${write_resp}" | grep -q '"ok":true' && echo yes || echo no)"

echo "==> search in probe vault finds the note"
search_probe=$(curl -sf -H "Authorization: Bearer ${probe_token}" \
  "${API_BASE}/v/${PROBE_SLUG}/v1/query?q=probe+note+${PROBE_SLUG}")
assert "search in probe finds its own note" "yes" "$(echo "${search_probe}" | grep -q "smoke-${PROBE_SLUG}" && echo yes || echo no)"

echo "==> personal vault does NOT see probe's note"
# Requires a personal admin token — read from env
if [ -n "${GROVE_PERSONAL_TOKEN:-}" ]; then
  search_personal=$(curl -sf -H "Authorization: Bearer ${GROVE_PERSONAL_TOKEN}" \
    "${API_BASE}/v/personal/v1/query?q=probe+note+${PROBE_SLUG}" || echo "")
  assert "personal search does NOT leak probe note" "yes" "$(echo "${search_personal}" | grep -vq "smoke-${PROBE_SLUG}" && echo yes || echo no)"
else
  printf "  [SKIP] personal-isolation check — set GROVE_PERSONAL_TOKEN to enable\n"
fi

echo "==> graceful shutdown of probe server"
probe_pid=$(ssh_vps "sudo pm2 id grove-server-${PROBE_SLUG} 2>/dev/null | head -1 | tr -d '[:space:]' || true")
if [ -n "${probe_pid}" ]; then
  probe_os_pid=$(ssh_vps "sudo pm2 jlist | sed 's/.*grove-server-${PROBE_SLUG}.*//' | head -1" || true)
  ssh_vps "sudo pm2 sendSignal SIGTERM grove-server-${PROBE_SLUG}"
  sleep 8
  log_tail=$(ssh_vps "sudo pm2 logs grove-server-${PROBE_SLUG} --lines 20 --nostream --no-color 2>&1 || true")
  assert "probe shutdown drained cleanly" "yes" "$(echo "${log_tail}" | grep -q 'shutdown complete' && echo yes || echo no)"
fi

echo "==> vault_usage_daily rows for both vaults"
usage_count=$(ssh_vps "sqlite3 /root/.grove/grove.db \"SELECT COUNT(DISTINCT vault_id) FROM vault_usage_daily WHERE date = DATE('now');\"" | tr -d '[:space:]')
assert "vault_usage_daily has ≥ 2 vault_ids today" "yes" "$([ "${usage_count}" -ge 2 ] && echo yes || echo no)"

echo "==> structured logs include vault_id + vault_slug"
log_sample=$(ssh_vps "sudo pm2 logs --nostream --lines 50 --no-color 2>&1 || true")
assert "log lines include vault_id" "yes" "$(echo "${log_sample}" | grep -q 'vault_id' && echo yes || echo no)"

echo
if [ "${fail_count}" -gt 0 ]; then
  printf "\033[31mFAILED\033[0m %d/%d checks passed\n" "${pass_count}" $((pass_count + fail_count))
  exit 1
fi
printf "\033[32mOK\033[0m %d/%d checks passed\n" "${pass_count}" "${pass_count}"

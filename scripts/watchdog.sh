#!/usr/bin/env bash
# Grove discovery watchdog — runs every 15 min via cron, emails on anomalies.
#
# Catches early signals of the failure modes we've actually hit:
#
#   1. JSON parse error growth (the PR #141 truncation bug returning, or a
#      new Anthropic-side regression). Compares current count in the PM2
#      error log against last seen; alerts if delta > 5/run.
#   2. Same path extracted >3x in last 200 lines of the PM2 out log
#      (cron amplification regression — what PR #140 fixed).
#   3. discovery_queue rows stuck in 'processing' >10 min (the 6-day
#      stuck `claude -p /grove:assure` analog for the worker — a lifecycle
#      bug we'd otherwise only notice from the bill).
#   4. Pending queue depth >50 (worker falling behind, regardless of cause).
#
# Throttle: max one email per hour even if the condition persists, so a
# real outage doesn't spam the inbox 96×/day. We always log to stderr
# (which flows to /var/log/grove-watchdog.log via cron redirection),
# regardless of throttle state.
#
# State files live under ${GROVE_WATCHDOG_STATE:-/root/.grove/watchdog}.
# These are local-only and harmless to delete (a fresh start re-baselines).

set -uo pipefail

# Source the user's env (RESEND_API_KEY, GROVE_ADMIN_EMAIL). cron doesn't
# load /root/.bashrc, and bashrc bails early in non-interactive shells
# anyway. /root/.grove/watchdog.env is a dedicated file with just the
# exports we need — populated by setup-watchdog-env.sh from .bashrc.
ENV_FILE="${GROVE_WATCHDOG_ENV:-/root/.grove/watchdog.env}"
if [ -f "$ENV_FILE" ]; then
  set +u
  source "$ENV_FILE"
  set -u
fi

STATE_DIR="${GROVE_WATCHDOG_STATE:-/root/.grove/watchdog}"
mkdir -p "$STATE_DIR"

DB="/root/.grove/grove.db"
ERR_LOG="/root/.pm2/logs/grove-discovery-personal-error.log"
OUT_LOG="/root/.pm2/logs/grove-discovery-personal-out.log"
LAST_ALERT_FILE="$STATE_DIR/last-alert-sent"
LAST_ERR_COUNT_FILE="$STATE_DIR/last-error-count"

ALERT_TO="${GROVE_WATCHDOG_TO:-${GROVE_ADMIN_EMAIL:-}}"
ALERT_FROM="${GROVE_WATCHDOG_FROM:-Grove watchdog <noreply@grove.md>}"

NOW_EPOCH=$(date -u +%s)
NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
HOST=$(hostname)

log() { echo "[$NOW_ISO] $*" >&2; }

# Bail loudly if we can't email — better to fail visibly than silently.
if [ -z "${RESEND_API_KEY:-}" ]; then
  log "ERROR: RESEND_API_KEY not set — refusing to run."
  exit 2
fi
if [ -z "$ALERT_TO" ]; then
  log "ERROR: neither GROVE_WATCHDOG_TO nor GROVE_ADMIN_EMAIL set — refusing to run."
  exit 2
fi

ALERTS=()

# ---------- Signal 1: JSON parse error growth ----------
CURR_ERRORS=0
DELTA=0
if [ -f "$ERR_LOG" ]; then
  CURR_ERRORS=$(grep -cE "JSON|parse|Unterminated|Unexpected end" "$ERR_LOG" 2>/dev/null || echo 0)
  PREV_ERRORS=$(cat "$LAST_ERR_COUNT_FILE" 2>/dev/null || echo 0)
  DELTA=$((CURR_ERRORS - PREV_ERRORS))
  # First run after a log rotation: CURR < PREV. Treat as re-baseline (no alert).
  if [ "$DELTA" -gt 5 ]; then
    SAMPLE=$(grep -E "JSON|parse|Unterminated|Unexpected end" "$ERR_LOG" 2>/dev/null | tail -3 || true)
    ALERTS+=("Signal 1: JSON parse errors grew by $DELTA since last check (now $CURR_ERRORS total).
Last 3 errors:
$SAMPLE")
  fi
  echo "$CURR_ERRORS" > "$LAST_ERR_COUNT_FILE"
fi

# ---------- Signal 2: duplicate extractions ----------
# Only meaningful when the worker is actively writing. The discovery queue
# drains to zero between bursts; once idle, the same 200 lines sit in the
# tail buffer indefinitely. A real episode that already self-resolved would
# otherwise keep re-firing Signal 2 every 15 min for hours — observed in
# the 2026-05-10 23:00 UTC incident, which triggered ~36h of alert emails
# after the underlying loop terminated at ~04:15 UTC. mtime gate: if no
# new bytes in 30 min, any duplicates in the tail are stale.
DUPS=""
if [ -f "$OUT_LOG" ]; then
  LOG_MTIME=$(stat -c "%Y" "$OUT_LOG" 2>/dev/null || echo 0)
  LOG_AGE=$((NOW_EPOCH - LOG_MTIME))
  if [ "$LOG_AGE" -lt 1800 ]; then
    DUPS=$(tail -200 "$OUT_LOG" 2>/dev/null \
      | grep -oE "extracted [0-9]+ entities[^\"]+from \S+\.md" \
      | awk '{print $NF}' \
      | sort | uniq -c | awk '$1 > 3 {print}' || true)
    if [ -n "$DUPS" ]; then
      ALERTS+=("Signal 2: same paths extracted >3x in last 200 log lines (cron amplification regression?):
$DUPS")
    fi
  fi
fi

# ---------- Signal 3: stuck processing rows ----------
STUCK=""
STUCK_COUNT=0
if [ -f "$DB" ]; then
  STUCK=$(sqlite3 "$DB" "SELECT vault_id || '  ' || path || '  (queued ' || queued_at || ')' FROM discovery_queue WHERE status='processing' AND queued_at < datetime('now','-10 minutes') ORDER BY queued_at LIMIT 10" 2>/dev/null || true)
  if [ -n "$STUCK" ]; then
    STUCK_COUNT=$(printf '%s\n' "$STUCK" | wc -l)
    ALERTS+=("Signal 3: $STUCK_COUNT discovery_queue rows stuck in 'processing' >10 min (showing first 10):
$STUCK")
  fi
fi

# ---------- Signal 4: pending queue depth ----------
PENDING=0
if [ -f "$DB" ]; then
  PENDING=$(sqlite3 "$DB" "SELECT COUNT(*) FROM discovery_queue WHERE status='pending'" 2>/dev/null || echo 0)
  if [ "$PENDING" -gt 50 ]; then
    BY_VAULT=$(sqlite3 "$DB" "SELECT vault_id || ': ' || COUNT(*) FROM discovery_queue WHERE status='pending' GROUP BY vault_id" 2>/dev/null || true)
    ALERTS+=("Signal 4: pending queue depth = $PENDING (threshold 50). Worker may be falling behind.
By vault:
$BY_VAULT")
  fi
fi

# ---------- Send email if alerts (and not throttled) ----------
SUMMARY="errors=$CURR_ERRORS (Δ$DELTA) pending=$PENDING stuck=$STUCK_COUNT dups=$([ -n "$DUPS" ] && echo Y || echo N)"

if [ "${#ALERTS[@]}" -eq 0 ]; then
  log "$HOST: clean — $SUMMARY"
  exit 0
fi

# Throttle: skip alert if we sent one in the last hour.
THROTTLED=0
if [ -f "$LAST_ALERT_FILE" ]; then
  LAST_ALERT=$(cat "$LAST_ALERT_FILE")
  AGO=$((NOW_EPOCH - LAST_ALERT))
  if [ "$AGO" -lt 3600 ]; then
    THROTTLED=1
    log "$HOST: ${#ALERTS[@]} alert(s) — $SUMMARY (THROTTLED, last alert ${AGO}s ago)"
  fi
fi

if [ "$THROTTLED" -eq 1 ]; then
  exit 0
fi

# Build HTML email.
BODY="<h2>Grove watchdog: ${#ALERTS[@]} alert(s)</h2><p><b>$NOW_ISO</b> on <code>$HOST</code></p><p>$SUMMARY</p>"
for a in "${ALERTS[@]}"; do
  BODY+="<pre style='background:#f5f5f5;padding:8px;border-radius:4px;font-size:12px;white-space:pre-wrap;'>$a</pre>"
done
BODY+="<p>Triage: <code>ssh -i ~/.ssh/grove-aws.pem ubuntu@api.grove.md</code><br>Then check <code>/var/log/grove-discovery.log</code>, <code>sudo pm2 list</code>, or <code>sqlite3 $DB</code>.</p>"
BODY+="<p style='color:#888;font-size:11px;'>Throttled to 1/hour. State at $STATE_DIR.</p>"

JSON=$(jq -n \
  --arg from "$ALERT_FROM" \
  --arg to "$ALERT_TO" \
  --arg subject "[grove-watchdog] ${#ALERTS[@]} alert(s) on $HOST" \
  --arg html "$BODY" \
  '{from: $from, to: [$to], subject: $subject, html: $html}')

HTTP_CODE=$(curl -s -o /tmp/watchdog-resp.$$ -w "%{http_code}" -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$JSON" || echo "000")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "202" ]; then
  echo "$NOW_EPOCH" > "$LAST_ALERT_FILE"
  log "$HOST: ${#ALERTS[@]} alert(s) sent to $ALERT_TO — $SUMMARY"
else
  log "$HOST: FAILED to send (HTTP $HTTP_CODE): $(cat /tmp/watchdog-resp.$$ 2>/dev/null | head -c 300)"
  log "  Alerts that would have sent:"
  printf '    %s\n' "${ALERTS[@]}" >&2
fi
rm -f /tmp/watchdog-resp.$$

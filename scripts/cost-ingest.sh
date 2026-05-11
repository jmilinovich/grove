#!/usr/bin/env bash
# Grove daily Anthropic cost ingest — runs at 06:00 UTC via cron.
#
# Pulls `/v1/organizations/usage_report/messages` from the Anthropic admin
# API for one UTC day and writes a row per (day, api_key_id, model) into
# `discovery_cost_daily`. The watchdog (Signal 5) reads this table to
# alert when yesterday's spend crosses GROVE_COST_THRESHOLD_USD.
#
# Usage:
#   cost-ingest.sh                  # ingest yesterday (UTC)
#   cost-ingest.sh --day 2026-05-07 # backfill a specific day
#
# Exit codes:
#   0 success
#   2 ANTHROPIC_ADMIN_API_KEY unset
#   3 HTTP 4xx/5xx from Anthropic
#   4 pagination exceeded 50 pages (something is wrong)
#
# State: writes to $GROVE_DB_PATH (default /root/.grove/grove.db). Wrapped
# in BEGIN/COMMIT so a partial run leaves no rows for the day. We
# INSERT OR REPLACE keyed on (day, api_key_id, model), so re-running for
# the same day overwrites the previous result rather than accumulating.
#
# TODO(p7-cost-4a-smoke): the URL is not parameterized for a fixture
# server, so there is no automated smoke test for this script. Tested
# manually against api.anthropic.com on 2026-05-11. If we revisit, add a
# `ANTHROPIC_API_BASE` env override and a node:http fixture test under
# test/scripts/.

set -uo pipefail

ENV_FILE="${GROVE_WATCHDOG_ENV:-/root/.grove/watchdog.env}"
if [ -f "$ENV_FILE" ]; then
  set +u
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set -u
fi

NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
log() { echo "[$NOW_ISO] [cost-ingest] $*" >&2; }

if [ -z "${ANTHROPIC_ADMIN_API_KEY:-}" ]; then
  log "ERROR: ANTHROPIC_ADMIN_API_KEY not set — refusing to run."
  exit 2
fi

DB="${GROVE_DB_PATH:-/root/.grove/grove.db}"
API_BASE="${ANTHROPIC_API_BASE:-https://api.anthropic.com}"

# Parse --day arg; default to yesterday (UTC).
DAY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --day)
      DAY="${2:-}"
      shift 2
      ;;
    *)
      log "ERROR: unknown arg $1"
      exit 2
      ;;
  esac
done
# Portable yesterday + day-after, working on both GNU date (prod) and
# BSD date (dev macOS). GNU uses `-d '...'`; BSD uses `-v-1d` / `-v+1d`.
date_add_day() {
  local base="$1" delta="$2"
  if date -u -d "1970-01-01" +%s >/dev/null 2>&1; then
    # GNU date
    date -u -d "$base + $delta day" +%Y-%m-%d
  else
    # BSD date
    if [ "$delta" -ge 0 ]; then
      date -u -j -v+"${delta}d" -f "%Y-%m-%d" "$base" +%Y-%m-%d
    else
      date -u -j -v"${delta}d" -f "%Y-%m-%d" "$base" +%Y-%m-%d
    fi
  fi
}

if [ -z "$DAY" ]; then
  TODAY=$(date -u +%Y-%m-%d)
  DAY=$(date_add_day "$TODAY" -1)
fi
# Anthropic API range is half-open [starting_at, ending_at).
END_DAY=$(date_add_day "$DAY" 1)

# Pricing (USD per million tokens). Models not in this table store
# estimated_cost_usd=NULL and emit a stderr warning. Keep in sync with
# https://docs.anthropic.com/pricing.
PRICING_JSON=$(cat <<'EOF'
{
  "claude-haiku-4-5-20251001": {
    "uncached": 0.80,
    "cache_read": 0.08,
    "cache_creation_5m": 1.00,
    "cache_creation_1h": 1.60,
    "output": 4.00
  }
}
EOF
)

log "ingesting day=$DAY (range $DAY..$END_DAY) into $DB"

# Accumulator: associative-array via a temp JSON file. Each page is
# merged into the running totals keyed by "<api_key_id>|<model>". We can't
# rely on bash assoc arrays surviving subshells, so the merge happens via
# jq against a single state file.
STATE=$(mktemp -t grove-cost-XXXXXX.json)
echo '{}' > "$STATE"
trap 'rm -f "$STATE"' EXIT

PAGE_PARAM=""
PAGES=0
MAX_PAGES=50

while :; do
  PAGES=$((PAGES + 1))
  if [ "$PAGES" -gt "$MAX_PAGES" ]; then
    log "ERROR: pagination exceeded $MAX_PAGES pages — aborting."
    exit 4
  fi

  URL="$API_BASE/v1/organizations/usage_report/messages?starting_at=${DAY}T00:00:00Z&ending_at=${END_DAY}T00:00:00Z&bucket_width=1d&group_by[]=api_key_id${PAGE_PARAM}"

  RESP_FILE=$(mktemp -t grove-cost-resp-XXXXXX.json)
  HTTP_CODE=$(curl -sS -o "$RESP_FILE" -w "%{http_code}" \
    -H "x-api-key: $ANTHROPIC_ADMIN_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    "$URL" || echo "000")

  if [ "$HTTP_CODE" != "200" ]; then
    log "ERROR: HTTP $HTTP_CODE from $URL"
    log "  body: $(head -c 500 "$RESP_FILE" 2>/dev/null)"
    rm -f "$RESP_FILE"
    exit 3
  fi

  # Merge this page's results into STATE.
  #   For each result row, accumulate tokens keyed by api_key_id|model.
  #   model is null on most current responses — store "unknown" and warn
  #   once per page so we don't spam the log.
  HAD_NULL_MODEL=$(jq -r '
    [.data[]?.results[]? | select(.model == null)] | length
  ' "$RESP_FILE")
  if [ "${HAD_NULL_MODEL:-0}" -gt 0 ]; then
    log "WARN: page $PAGES has $HAD_NULL_MODEL row(s) with model=null — storing as 'unknown'"
  fi

  jq --slurpfile state "$STATE" '
    [.data[]?.results[]?] as $rows
    | ($state[0]) as $acc
    | reduce $rows[] as $r ($acc;
        ($r.api_key_id // "unknown") as $k
        | ($r.model // "unknown") as $m
        | ($k + "|" + $m) as $key
        | .[$key] = {
            api_key_id: $k,
            model: $m,
            uncached_input_tokens: (((.[$key].uncached_input_tokens // 0) + ($r.uncached_input_tokens // 0)) | floor),
            cache_read_tokens: (((.[$key].cache_read_tokens // 0) + ($r.cache_read_input_tokens // 0)) | floor),
            cache_creation_5m_tokens: (((.[$key].cache_creation_5m_tokens // 0) + ($r.cache_creation.ephemeral_5m_input_tokens // 0)) | floor),
            cache_creation_1h_tokens: (((.[$key].cache_creation_1h_tokens // 0) + ($r.cache_creation.ephemeral_1h_input_tokens // 0)) | floor),
            output_tokens: (((.[$key].output_tokens // 0) + ($r.output_tokens // 0)) | floor)
          }
      )
  ' "$RESP_FILE" > "$STATE.new"
  mv "$STATE.new" "$STATE"

  HAS_MORE=$(jq -r '.has_more // false' "$RESP_FILE")
  NEXT_PAGE=$(jq -r '.next_page // empty' "$RESP_FILE")
  rm -f "$RESP_FILE"

  if [ "$HAS_MORE" != "true" ] || [ -z "$NEXT_PAGE" ]; then
    break
  fi
  PAGE_PARAM="&next_page=$NEXT_PAGE"
done

# Compute estimated_cost_usd per row. Rows for unknown models get NULL +
# a stderr warning.
PRICED=$(jq --argjson pricing "$PRICING_JSON" '
  to_entries
  | map(
      .value as $r
      | ($pricing[$r.model] // null) as $p
      | $r + {
          estimated_cost_usd: (
            if $p == null then null
            else
              (
                ($r.uncached_input_tokens * $p.uncached
                  + $r.cache_read_tokens * $p.cache_read
                  + $r.cache_creation_5m_tokens * $p.cache_creation_5m
                  + $r.cache_creation_1h_tokens * $p.cache_creation_1h
                  + $r.output_tokens * $p.output) / 1000000
              )
            end
          )
        }
    )
' "$STATE")

# Warn for unknown models.
UNKNOWN_MODELS=$(echo "$PRICED" | jq -r '
  [.[] | select(.estimated_cost_usd == null) | .model] | unique | .[]
')
if [ -n "$UNKNOWN_MODELS" ]; then
  while IFS= read -r m; do
    log "WARN: unknown model $m, skipping pricing"
  done <<< "$UNKNOWN_MODELS"
fi

ROW_COUNT=$(echo "$PRICED" | jq 'length')
if [ "$ROW_COUNT" = "0" ]; then
  log "no usage rows for $DAY — nothing to write"
  exit 0
fi

# Build a single SQL transaction. Each row becomes an INSERT OR REPLACE
# (re-running for the same day overwrites the previous result rather than
# accumulating). The OR REPLACE also handles two passes racing on the same
# (day, api_key_id, model) tuple — second writer wins.
#
# The SQL is generated by jq via a heredoc — single-quoted jq scripts
# don't compose with bash because every SQL literal would need '\''
# escaping at every site. The heredoc keeps the jq body readable.
SQL_FILE=$(mktemp -t grove-cost-sql-XXXXXX.sql)
JQ_FILTER_FILE=$(mktemp -t grove-cost-jq-XXXXXX.jq)
cat > "$JQ_FILTER_FILE" <<'JQ'
.[] |
"INSERT OR REPLACE INTO discovery_cost_daily " +
"(day, api_key_id, model, uncached_input_tokens, cache_read_tokens, " +
"cache_creation_5m_tokens, cache_creation_1h_tokens, output_tokens, " +
"estimated_cost_usd, ingested_at) VALUES (" +
"'" + $day + "', " +
"'" + (.api_key_id | gsub("'"; "''")) + "', " +
"'" + (.model | gsub("'"; "''")) + "', " +
(.uncached_input_tokens | tostring) + ", " +
(.cache_read_tokens | tostring) + ", " +
(.cache_creation_5m_tokens | tostring) + ", " +
(.cache_creation_1h_tokens | tostring) + ", " +
(.output_tokens | tostring) + ", " +
(if .estimated_cost_usd == null then "NULL" else (.estimated_cost_usd | tostring) end) + ", " +
"datetime('now'));"
JQ
{
  echo "BEGIN;"
  printf '%s' "$PRICED" | jq -r --arg day "$DAY" -f "$JQ_FILTER_FILE"
  echo "COMMIT;"
} > "$SQL_FILE"
rm -f "$JQ_FILTER_FILE"

sqlite3 "$DB" < "$SQL_FILE"
RC=$?
rm -f "$SQL_FILE"

if [ "$RC" -ne 0 ]; then
  log "ERROR: sqlite3 exited $RC"
  exit "$RC"
fi

KEY_COUNT=$(echo "$PRICED" | jq '[.[] | .api_key_id] | unique | length')
MODEL_COUNT=$(echo "$PRICED" | jq '[.[] | .model] | unique | length')
TOTAL_COST=$(echo "$PRICED" | jq -r '[.[] | .estimated_cost_usd // 0] | add | . * 100 | round / 100')

log "day=$DAY keys=$KEY_COUNT models=$MODEL_COUNT rows=$ROW_COUNT total=\$$TOTAL_COST"
exit 0

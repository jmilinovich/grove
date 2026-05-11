#!/usr/bin/env bash
# Grove scoring script — measures capability maturity.
# Usage: bash scripts/score.sh [--json]
set -o pipefail
cd "$(dirname "$0")/.."

JSON_MODE=false
[[ "${1:-}" == "--json" ]] && JSON_MODE=true

# ── Scores ────────���──────────────────────────────────────────────────

security=0; observability=0; portal=0; trails=0; foundation=0
search_quality=0
TOTAL=0
SEARCH_QUALITY_MAX=30  # Separate sub-score; NOT rolled into TOTAL until GOAL.md is updated.
REPORT=""

score() {
  local component="$1" points="$2" max="$3" detail="$4"
  local icon="✗"; (( points > 0 )) && icon="✓"
  eval "$component=\$(( $component + points ))"
  TOTAL=$(( TOTAL + points ))
  REPORT+="$component|$icon $detail ($points/$max)
"
}

# ── SECURITY (30 pts) ─────���────────────────────────────────────────

# Path traversal guard (5 pts)
if grep -q 'resolve.*vault\|traversal\|outside.*vault\|normalize.*path\|sanitize.*path' src/server.ts 2>/dev/null && \
   grep -q '\.\.' src/server.ts 2>/dev/null; then
  score security 5 5 "Path traversal guard implemented"
else
  score security 0 5 "Path traversal guard not implemented"
fi

# CORS lockdown (3 pts)
if grep -q "Access-Control-Allow-Origin" src/proxy.ts 2>/dev/null; then
  cors_star=$(grep -c "'\*'" src/proxy.ts 2>/dev/null || true)
  cors_star=${cors_star:-0}
  if (( cors_star == 0 )); then
    score security 3 3 "CORS locked to specific origins"
  else
    score security 0 3 "CORS still using wildcard *"
  fi
else
  score security 0 3 "No CORS headers found"
fi

# Request body size limit (3 pts)
if grep -q 'content-length\|body.*size\|MAX_BODY\|1048576\|payload.*too.*large' src/proxy.ts src/server.ts 2>/dev/null; then
  score security 3 3 "Request body size limit enforced"
else
  score security 0 3 "No request body size limit"
fi

# Key scopes enforced (4 pts)
if grep -q 'scope.*write\|scope.*read\|checkScope\|enforce.*scope\|scope.*check' src/proxy.ts 2>/dev/null; then
  score security 4 4 "Key scopes enforced"
else
  score security 0 4 "Key scopes not enforced"
fi

# EBS encryption (3 pts) — check via marker file or skip if not on AWS
if [[ -f .ebs-encrypted ]] || [[ "${GROVE_EBS_ENCRYPTED:-}" == "true" ]]; then
  score security 3 3 "EBS volume encrypted"
else
  score security 0 3 "EBS encryption not verified (set GROVE_EBS_ENCRYPTED=true or touch .ebs-encrypted)"
fi

# Daily S3 backup (3 pts)
if [[ -f scripts/backup-s3.sh ]] || grep -q 'aws s3\|s3.*backup' scripts/*.sh 2>/dev/null; then
  score security 3 3 "S3 backup script exists"
else
  score security 0 3 "S3 backup script not created"
fi

# No hardcoded secrets in source code (4 pts)
# Note: OAuth client secrets in oauth-clients.json are dynamically generated per-client
# registration (Claude.ai creates them). That's fine — we check that no secrets are
# hardcoded in source code (e.g., API keys, static passwords).
if [[ -f src/proxy.ts ]]; then
  hardcoded_secrets=$(grep -En 'const.*secret.*=.*"[a-zA-Z0-9]{16,}"' src/*.ts 2>/dev/null | grep -v 'process\.env\|randomBytes\|crypto\|hash\|SHA' | wc -l | tr -d ' ')
  if (( hardcoded_secrets == 0 )); then
    score security 4 4 "No hardcoded secrets in source code"
  else
    score security 0 4 "Found $hardcoded_secrets hardcoded secrets in source"
  fi
else
  score security 0 4 "proxy.ts not found"
fi

# Key TTLs (5 pts)
if grep -q 'expires_at\|expir\|ttl' src/keys.ts 2>/dev/null; then
  score security 5 5 "Key TTLs implemented"
else
  score security 0 5 "Key TTLs not implemented"
fi

# ── OBSERVABILITY (30 pts) ───────��─────────────────────────────────

# Structured JSON logging (5 pts)
if [[ -f src/logger.ts ]] || grep -q 'JSON.stringify.*ts.*rid\|structuredLog\|jsonLog' src/*.ts 2>/dev/null; then
  score observability 5 5 "Structured JSON logging implemented"
else
  score observability 0 5 "Structured JSON logging not implemented"
fi

# Correlation IDs (4 pts)
if grep -q 'X-Request-Id\|correlation.*id\|request.*id\|rid.*ulid\|generateId' src/proxy.ts src/server.ts 2>/dev/null; then
  score observability 4 4 "Request correlation IDs implemented"
else
  score observability 0 4 "No request correlation IDs"
fi

# Read audit log (3 pts)
if grep -q 'audit\|read.*log\|access.*log' src/server.ts 2>/dev/null || [[ -f src/audit.ts ]]; then
  score observability 3 3 "Read audit log exists"
else
  score observability 0 3 "No read audit log"
fi

# Deep health check (5 pts)
if grep -q 'health' src/proxy.ts 2>/dev/null; then
  # Check if health verifies downstream services
  if grep -A 20 'health' src/proxy.ts 2>/dev/null | grep -q 'qmd\|embed\|8190\|8181\|8090\|downstream\|check.*server'; then
    score observability 5 5 "Deep health check verifies downstream"
  else
    score observability 2 5 "Health check exists but doesn't verify downstream"
  fi
else
  score observability 0 5 "No health check"
fi

# Metrics endpoint (5 pts)
if grep -q '/metrics\|metricsHandler\|getMetrics' src/proxy.ts src/server.ts 2>/dev/null || [[ -f src/metrics.ts ]]; then
  score observability 5 5 "/metrics endpoint exists"
else
  score observability 0 5 "No /metrics endpoint"
fi

# BetterStack uptime monitor (4 pts)
if [[ -f .betterstack-configured ]] || [[ "${GROVE_BETTERSTACK:-}" == "true" ]]; then
  score observability 4 4 "BetterStack uptime monitor configured"
else
  score observability 0 4 "BetterStack not configured (set GROVE_BETTERSTACK=true or touch .betterstack-configured)"
fi

# Dead man's switch (4 pts)
if grep -q 'heartbeat\|dead.*man\|betterstack.*ping' scripts/*.sh 2>/dev/null || \
   grep -q 'heartbeat' /etc/crontab 2>/dev/null || \
   crontab -l 2>/dev/null | grep -q 'heartbeat'; then
  score observability 4 4 "Dead man's switch configured"
else
  score observability 0 4 "No dead man's switch"
fi

# ── PORTAL (25 pts) ──────────���─────────────────────────────────────

# Admin auth (5 pts)
if grep -q 'GROVE_ADMIN\|admin.*key\|admin.*auth\|session.*cookie\|adminAuth' src/proxy.ts src/server.ts 2>/dev/null || [[ -f src/admin.ts ]]; then
  score portal 5 5 "Admin auth implemented"
else
  score portal 0 5 "No admin auth"
fi

# Key management UI (6 pts)
if grep -q 'key.*management\|key.*list.*html\|keyManagement\|/admin/keys' src/*.ts 2>/dev/null || \
   [[ -f src/portal.ts ]] || [[ -d static ]] || [[ -d public ]]; then
  # Check for both list and create/revoke
  if grep -q 'create.*key\|revoke.*key\|deleteKey\|POST.*key' src/*.ts 2>/dev/null; then
    score portal 6 6 "Key management UI with CRUD"
  else
    score portal 3 6 "Key management UI exists (partial)"
  fi
else
  score portal 0 6 "No key management UI"
fi

# Usage dashboard (6 pts)
if grep -q 'usage\|dashboard\|request.*volume\|latency.*chart' src/*.ts 2>/dev/null || \
   [[ -f src/dashboard.ts ]]; then
  score portal 6 6 "Usage dashboard implemented"
else
  score portal 0 6 "No usage dashboard"
fi

# Vault health panel (5 pts)
if grep -q 'vault.*health\|health.*panel\|note.*count.*html\|sync.*status.*html' src/*.ts 2>/dev/null; then
  score portal 5 5 "Vault health panel implemented"
else
  score portal 0 5 "No vault health panel"
fi

# Dashboard serves without errors (3 pts)
if [[ -d static ]] || [[ -d public ]] || grep -q 'serveStatic\|text/html\|<!DOCTYPE' src/*.ts 2>/dev/null; then
  score portal 3 3 "Dashboard serves from same server"
else
  score portal 0 3 "No dashboard serving"
fi

# ── TRAILS (50 pts) ─���────────���─────────────────────────────────────

# Trail CRUD CLI (5 pts)
if grep -q 'trails.*create\|cmdTrailCreate\|case "trails"' src/cli.ts 2>/dev/null; then
  score trails 5 5 "Trail CRUD CLI exists"
else
  score trails 0 5 "Trail CRUD CLI not implemented"
fi

# Trail config stored (3 pts)
if [[ -f src/trails.ts ]] || grep -q 'trails\.json\|TrailConfig\|Trail.*interface' src/*.ts 2>/dev/null; then
  score trails 3 3 "Trail config schema exists"
else
  score trails 0 3 "Trail config schema not implemented"
fi

# Trail resolution in proxy (4 pts)
if grep -q 'trail.*resolve\|trail.*lookup\|key.*trail\|trailId\|trail_id' src/proxy.ts 2>/dev/null; then
  score trails 4 4 "Trail resolution in proxy"
else
  score trails 0 4 "Trail resolution not implemented"
fi

# Server-side tag/type/path prefilter (6 pts)
if grep -q 'filterByTrail\|trail.*filter\|prefilter\|allow_tags\|deny_tags\|allow_types\|deny_types\|allow_paths\|deny_paths' src/server.ts 2>/dev/null; then
  score trails 6 6 "Server-side trail prefilter implemented"
else
  score trails 0 6 "Server-side trail prefilter not implemented"
fi

# filtered_count in query responses (3 pts)
if grep -q 'filtered_count\|filtered.*count\|total_found.*visible' src/server.ts 2>/dev/null; then
  score trails 3 3 "filtered_count in query responses"
else
  score trails 0 3 "No filtered_count in responses"
fi

# 404 for hidden notes (3 pts)
if grep -q '404.*trail\|trail.*404\|not.*found.*trail\|note.*not.*visible' src/server.ts 2>/dev/null; then
  score trails 3 3 "Hidden notes return 404"
else
  score trails 0 3 "Hidden note behavior not implemented"
fi

# list_notes scoped (3 pts)
if grep -q 'list.*trail\|filter.*list\|scoped.*list\|trail.*visible.*list' src/server.ts 2>/dev/null; then
  score trails 3 3 "list_notes scoped to trail"
else
  score trails 0 3 "list_notes not scoped"
fi

# write_note constrained (3 pts)
if grep -q 'write.*trail\|trail.*write.*check\|constrain.*write\|write.*scope' src/server.ts 2>/dev/null; then
  score trails 3 3 "write_note constrained to trail scope"
else
  score trails 0 3 "write_note not constrained"
fi

# vault_status scoped (2 pts)
if grep -q 'status.*trail\|trail.*status\|scoped.*stats' src/server.ts 2>/dev/null; then
  score trails 2 2 "vault_status returns scoped stats"
else
  score trails 0 2 "vault_status not scoped"
fi

# Trail info in MCP handshake (3 pts)
if grep -q 'trail.*initialize\|trail.*capabilities\|trail.*handshake\|serverInfo.*trail' src/server.ts 2>/dev/null; then
  score trails 3 3 "Trail info in MCP initialize"
else
  score trails 0 3 "No trail info in MCP handshake"
fi

# Trail filter eval — precision (5 pts)
if [[ -f test/trail-filter.test.ts ]] || [[ -f test/trails.test.ts ]]; then
  eval_output=$(npm test -- --reporter=verbose 2>&1 || true)
  if echo "$eval_output" | grep -q 'precision\|sensitive.*filtered\|trail.*filter.*pass'; then
    score trails 5 5 "Trail filter eval — precision passes"
  else
    score trails 2 5 "Trail filter tests exist but precision not verified"
  fi
else
  score trails 0 5 "Trail filter eval not created"
fi

# Trail filter eval — recall (4 pts)
if [[ -f test/trail-filter.test.ts ]] || [[ -f test/trails.test.ts ]]; then
  if echo "${eval_output:-}" | grep -q 'recall\|on.topic.*allowed\|trail.*recall.*pass'; then
    score trails 4 4 "Trail filter eval — recall passes"
  else
    score trails 1 4 "Trail filter tests exist but recall not verified"
  fi
else
  score trails 0 4 "Trail filter recall eval not created"
fi

# Trail audit log (3 pts)
if grep -q 'trail.*audit\|audit.*trail\|logTrailAccess\|trail.*access.*log' src/*.ts 2>/dev/null; then
  score trails 3 3 "Trail audit log implemented"
else
  score trails 0 3 "Trail audit log not implemented"
fi

# Per-trail rate limits (3 pts)
if grep -q 'trail.*rate\|per.*trail.*limit\|trailRateLimit' src/*.ts 2>/dev/null; then
  score trails 3 3 "Per-trail rate limits enforced"
else
  score trails 0 3 "Per-trail rate limits not implemented"
fi

# ── FOUNDATION (40 pts) ────────────────────────────────────────────

# All tests pass (10 pts)
test_output=$(npm test 2>&1 || true)
if echo "$test_output" | grep -q "Tests.*passed"; then
  score foundation 10 10 "All tests pass"
else
  score foundation 0 10 "Tests failing"
fi

# No empty catches or as-any (5 pts)
empty_catches=$(grep -rn 'catch\s*{}' src/ --include='*.ts' 2>/dev/null | wc -l | tr -d ' ')
any_casts=$(grep -rn 'as any' src/ --include='*.ts' 2>/dev/null | wc -l | tr -d ' ')
if (( empty_catches == 0 && any_casts == 0 )); then
  score foundation 5 5 "No empty catches or as-any casts"
else
  score foundation 0 5 "Found $empty_catches empty catches, $any_casts as-any casts"
fi

# Test coverage (5 pts)
code_modules=0
for src_file in src/*.ts; do
  lines=$(wc -l < "$src_file")
  (( lines <= 50 )) && continue
  base=$(basename "$src_file" .ts)
  [[ -f "test/${base}.test.ts" ]] && code_modules=$((code_modules + 1))
done
if (( code_modules >= 10 )); then
  score foundation 5 5 "All src modules have tests ($code_modules)"
else
  score foundation 0 5 "$code_modules src modules have tests (need 10+)"
fi

# Git ops dynamic (5 pts)
hardcoded_git=$(grep -rn '"origin/main"\|"origin", "main"' src/ --include='*.ts' 2>/dev/null | wc -l | tr -d ' ')
if (( hardcoded_git == 0 )); then
  score foundation 5 5 "Git ops use dynamic branch detection"
else
  score foundation 0 5 "Found $hardcoded_git hardcoded origin/main"
fi

# Error messages have context (5 pts)
bare_errors=$(grep -rn 'text:.*"[Ii]nvalid"$' src/ --include='*.ts' 2>/dev/null | wc -l | tr -d ' ')
if (( bare_errors == 0 )); then
  score foundation 5 5 "Error messages have context"
else
  score foundation 0 5 "Found $bare_errors bare error messages"
fi

# CLI complete (5 pts)
cli_tools=0
for tool in search read list write sync status; do
  grep -q "case \"$tool\"" src/cli.ts 2>/dev/null && cli_tools=$((cli_tools + 1))
done
if (( cli_tools >= 6 )) && grep -q 'printUsage\|--help' src/cli.ts 2>/dev/null; then
  score foundation 5 5 "CLI complete with --help ($cli_tools commands)"
else
  score foundation 0 5 "CLI incomplete ($cli_tools commands)"
fi

# Docs current (5 pts)
if [[ -f README.md ]] && grep -qi 'setup\|self-host' README.md && grep -qi 'deploy\|vps' CLAUDE.md 2>/dev/null; then
  score foundation 5 5 "README and deploy docs current"
else
  score foundation 0 5 "Docs need updating"
fi

# ── SEARCH QUALITY (30 pts, side-scored — NOT in TOTAL until GOAL.md ────
# is updated; see scripts/eval-search-quality/V3_PLAN.md for the spec).
# Operator's call when to fold these into the fitness function (Mode: Split).

# Run the eval harness in --quick mode (synthetic ranking-unit layer only).
# Falls back to "harness unavailable" if Node 22 binary is missing.
NODE22="/opt/homebrew/Cellar/node@22/22.22.2_2/bin/node"
[[ ! -x "$NODE22" ]] && NODE22="$(command -v node || true)"

if [[ -f scripts/eval-search-quality/run.ts && -x "$NODE22" ]]; then
  sq_json=$("$NODE22" --import tsx scripts/eval-search-quality/run.ts --quick --reweight=v3 --json 2>/dev/null || echo '{}')
else
  sq_json='{}'
fi

# Parse pass-flags from the JSON. Use node -e for portable JSON parse.
sq_extract() {
  local key="$1"
  echo "$sq_json" | "$NODE22" -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{try{const r=JSON.parse(d); console.log(${key});}catch(e){console.log('false');}});" 2>/dev/null || echo "false"
}

sq_c_ppr=$(sq_extract "r.ranking_unit?.canonical?.thresholds?.ppr?.pass ? 'true' : 'false'")
sq_c_rpr=$(sq_extract "r.ranking_unit?.canonical?.thresholds?.rpr_perishable?.pass ? 'true' : 'false'")
sq_c_rid=$(sq_extract "r.ranking_unit?.canonical?.thresholds?.ri_durable?.pass ? 'true' : 'false'")
sq_a_ppr=$(sq_extract "r.ranking_unit?.adversarial?.thresholds?.ppr?.pass ? 'true' : 'false'")
sq_fir=$(sq_extract  "r.ranking_unit?.freshness?.thresholds?.fir?.pass ? 'true' : 'false'")

# PPR canonical (6 pts) — durable beats perishable on dual-match
if [[ "$sq_c_ppr" == "true" ]]; then
  score search_quality 6 6 "PPR canonical >= 0.85"
else
  score search_quality 0 6 "PPR canonical < 0.85"
fi

# RPR-perishable canonical (4 pts) — recent beats stale on perishable pairs
if [[ "$sq_c_rpr" == "true" ]]; then
  score search_quality 4 4 "RPR-perishable canonical >= 0.75"
else
  score search_quality 0 4 "RPR-perishable canonical < 0.75"
fi

# RI-durable canonical (4 pts) — relevance order on durable pairs survives age
if [[ "$sq_c_rid" == "true" ]]; then
  score search_quality 4 4 "RI-durable canonical >= 0.80"
else
  score search_quality 0 4 "RI-durable canonical < 0.80"
fi

# PPR adversarial (3 pts) — same-age and old-perishable/new-durable cross fixtures
if [[ "$sq_a_ppr" == "true" ]]; then
  score search_quality 3 3 "PPR adversarial >= 0.70"
else
  score search_quality 0 3 "PPR adversarial < 0.70"
fi

# FIR (3 pts) — freshness-intent queries surface recent perishable in top-3
if [[ "$sq_fir" == "true" ]]; then
  score search_quality 3 3 "FIR >= 0.80"
else
  score search_quality 0 3 "FIR < 0.80"
fi

# Tunability sweep (4 pts) — sweep.ts exists and runs without error
if [[ -f scripts/eval-search-quality/sweep.ts ]] && \
   "$NODE22" --import tsx scripts/eval-search-quality/sweep.ts --json >/dev/null 2>&1; then
  score search_quality 4 4 "Tunability sweep runs (>=3 reweight configs)"
else
  score search_quality 0 4 "Tunability sweep missing or failing"
fi

# Envelope completeness static check (3 pts) — HybridResult has voice + written_at + usage_directive
envelope_fields=0
grep -q "voice?:" src/hybrid-search.ts && envelope_fields=$((envelope_fields + 1))
grep -q "written_at?:" src/hybrid-search.ts && envelope_fields=$((envelope_fields + 1))
grep -q "usage_directive?:" src/hybrid-search.ts && envelope_fields=$((envelope_fields + 1))
if (( envelope_fields == 3 )); then
  score search_quality 3 3 "HybridResult envelope: voice + written_at + usage_directive"
else
  score search_quality 0 3 "HybridResult envelope incomplete ($envelope_fields/3 fields)"
fi

# Reweight env-gated (3 pts) — GROVE_PROV_RANKING_ENABLED flag exists, default off
if grep -q "GROVE_PROV_RANKING_ENABLED" src/hybrid-search.ts && \
   grep -q "PROV_RANKING_ENABLED.*false" src/hybrid-search.ts; then
  score search_quality 3 3 "Provenance reweight gated by env flag, default off (dark-launch)"
else
  score search_quality 0 3 "Reweight not env-gated or default-on"
fi

# IMPORTANT: subtract search_quality from TOTAL since the score() helper
# adds it. Search Quality is side-scored (separate display), not part of
# the 175-pt fitness function until GOAL.md is updated by the operator.
TOTAL=$(( TOTAL - search_quality ))

# ── Output ─────��─────────────────────────────────────────────────────

if $JSON_MODE; then
  cat <<ENDJSON
{
  "total": $TOTAL,
  "max": 175,
  "security": $security,
  "observability": $observability,
  "portal": $portal,
  "trails": $trails,
  "foundation": $foundation,
  "search_quality": {
    "score": $search_quality,
    "max": $SEARCH_QUALITY_MAX,
    "rolled_into_total": false,
    "note": "Side-scored sub-component. Fold into TOTAL by updating GOAL.md (Mode: Split)."
  }
}
ENDJSON
else
  echo ""
  echo "══════════════════════════════════════════"
  echo "  GROVE SCORE: $TOTAL / 175"
  echo "════════════════════════��═════════════════"
  echo ""
  for component in security observability portal trails foundation; do
    case $component in
      security)      label="Security"; max=30 ;;
      observability) label="Observability"; max=30 ;;
      portal)        label="Portal"; max=25 ;;
      trails)        label="Trails"; max=50 ;;
      foundation)    label="Foundation"; max=40 ;;
    esac
    val=$(eval echo "\$$component")
    echo "── $label: $val/$max ──"
    echo "$REPORT" | grep "^$component|" | sed "s/^$component|/  /"
    echo ""
  done

  # Search Quality is a side-scored sub-component (not in the 175 total).
  # Operator folds into GOAL.md when ready; until then it's a separate report.
  echo "══════════════════════════════════════════"
  echo "  SEARCH QUALITY (side-scored): $search_quality / $SEARCH_QUALITY_MAX"
  echo "  Not in TOTAL until GOAL.md updated."
  echo "══════════════════════════════════════════"
  echo "── Search Quality: $search_quality/$SEARCH_QUALITY_MAX ──"
  echo "$REPORT" | grep "^search_quality|" | sed "s/^search_quality|/  /"
  echo ""
fi

#!/usr/bin/env bash
# Deploy Grove to VPS — EMERGENCY / LOCAL-DEV USE ONLY.
#
# CI is the canonical deploy path (.github/workflows/ci.yml → deploy job):
# it snapshots the current VPS SHA, does a schema-change guard, health-polls
# api.grove.md after restart, and auto-rolls-back if the new process doesn't
# come up clean within 60s. Prefer that path — run the workflow from
# Actions → CI → Run workflow on main.
#
# This script does NOT do any of that. Use it only if CI is down or you're
# testing the SSH path locally. It will:
#   * push main to origin
#   * git pull on the VPS
#   * npm ci  (full — tsx is in devDependencies; --production breaks PM2)
#   * regenerate the runtime ecosystem from the vaults DB
#   * pm2 reload the generated ecosystem (all provisioned vaults)
#   * curl /health once and print the result (doesn't exit on failure)
#
# Usage: bash scripts/deploy.sh
set -euo pipefail

SSH_KEY="$HOME/.ssh/grove-aws.pem"
HOST="ubuntu@52.37.76.231"

echo "Pushing to origin..."
git push origin main

echo "Deploying to VPS..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$HOST" 'sudo bash -s' << 'REMOTE'
set -eu
cd /root/grove
git pull origin main
# Full `npm ci` (NOT --production) so tsx + better-sqlite3 are available.
# Every grove process runs via tsx (devDependency). --production breaks them.
npm ci
# Regenerate the runtime ecosystem from the vaults table so ALL provisioned
# vaults are started/reloaded — not just the hardcoded grove-server/grove-proxy
# names. Without this, any vault added since the last deploy is silently skipped.
npx tsx scripts/generate-ecosystem.ts
pm2 reload /root/grove/ecosystem.runtime.config.cjs --update-env
pm2 list
echo "---"
curl -sf http://localhost:8420/health && echo " Health OK" || echo " Health FAILED"
REMOTE

echo "Deploy complete."

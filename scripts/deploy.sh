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
#   * npm install --production
#   * pm2 restart
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
cd /root/grove
git pull origin main
npm install --production
pm2 restart grove-server grove-proxy
sleep 3
pm2 list
echo "---"
curl -sf http://localhost:8420/health && echo " Health OK" || echo " Health FAILED"
REMOTE

echo "Deploy complete."

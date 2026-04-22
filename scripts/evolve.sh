#!/bin/bash
# Quick evolve loop: push local changes, eval on server, show results
set -e
cd "$(dirname "$0")/.."

# Commit if there are changes
if ! git diff --quiet src/hybrid-search.ts 2>/dev/null; then
  MSG="${1:-evo: unnamed mutation}"
  git add src/hybrid-search.ts
  git commit -m "$MSG" --no-gpg-sign
fi

git push origin main 2>&1 | tail -2

ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 "sudo bash -c '\
cd /root/grove && git pull -q && \
set -a && source /root/grove/.env && set +a && \
npx tsx scripts/eval-vector-search.ts 2>&1'" | grep -E "Summary:|BM25:|Vector:|Hybrid:|✗.*\|"

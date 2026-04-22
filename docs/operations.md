# Grove operations

Operator runbook for the live `api.grove.md` deployment. Only covers
actions that require human judgment — automation lives in `scripts/`
and `.github/workflows/`.

## Deploys

PR-triggered deploys happen automatically once CI is green (`ci.yml` →
`deploy` job, appleboy/ssh-action). Schema-touching PRs (anything that
modifies `src/db.ts` or `src/db-migration*.ts`) trip the Tier 2 guard
and require a follow-up `workflow_dispatch` with
`confirm_schema_change=true` input.

For `npm run ship` orchestration, `SHIP_AUTO_CONFIRM_SCHEMA=1` pre-
authorizes the schema-confirm dispatch so batches like `p8a-1` /
`p8b-1` auto-merge + auto-deploy without waiting for a human. Default
(env unset) still halts for review.

## Multi-vault provisioning (P8-A4)

New vaults are created directly on the VPS via `grove vault create`:

```bash
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231
cd /root/grove
node bin/grove vault create <slug> --owner <email>
```

The command prints the connector URL and a one-shot owner token. Save
the token — it can't be recovered. PM2 reloads with the regenerated
`ecosystem.config.cjs`; the health check polls for 60s before
returning.

## Multi-vault smoke test (P8-A7)

`test/smoke/08-multi-vault.smoke.sh` provisions a throwaway probe
vault, verifies isolation, and cleans up on exit. Runs over SSH from
any workstation with VPS access.

```bash
# happy path — cleans up after itself
bash test/smoke/08-multi-vault.smoke.sh

# leave the probe vault behind for manual inspection
KEEP_PROBE=1 bash test/smoke/08-multi-vault.smoke.sh

# alternate host / API base (for staging clones)
GROVE_VPS_HOST=54.1.2.3 GROVE_API_BASE=https://api.staging.grove.md \
  bash test/smoke/08-multi-vault.smoke.sh
```

Set `GROVE_PERSONAL_TOKEN=<token>` to enable the cross-vault leakage
check — it queries the `personal` vault with a personal-scoped token
and asserts the probe vault's note does NOT appear in results.

## Graceful shutdown (P8-A5)

`grove-server` responds to `SIGTERM` / `SIGUSR2` / `SIGINT` by:

1. closing the HTTP listener (new connections rejected, existing drain)
2. draining the write queue (`flushWriteQueue`)
3. fsync-checking git state (`git status --porcelain`)
4. exiting 0, or 1 if the 60s hard timeout fires

60s matches the deploy workflow's 12 × 5s health-poll window. If the
shutdown path ever exceeds that, PM2 will SIGKILL the process and the
deploy's auto-rollback takes over.

## Legacy-route sunset

`/mcp` and `/v1/*` without a slug fall through to the token's bound
vault with `Sunset: <HTTP-date>` (90 days ahead) in the response. After
sunset those endpoints return 410 Gone with a migration hint. Check
`vault_usage_daily` + structured log output for legacy-route hit counts
before the cutover.

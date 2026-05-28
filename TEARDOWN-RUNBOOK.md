# Grove — Teardown Runbook

**Status:** unexecuted plan. Read end-to-end before doing anything.
**Operator:** John (`jrmilinovich@gmail.com`). Claude alongside.
**Date of plan:** 2026-05-27.

The point of this runbook is to wind Grove down **without losing data**, **without surprise charges**, and **without going past the point of no return until snapshots are proven good**. Every destructive step has a verification-before, verification-after, and rollback.

The IRREVERSIBLE point of no return is **Phase 7** (EC2 terminate + EIP release + EBS volume delete). Everything before that can be undone in under an hour. Everything after that can only be recovered from the snapshots taken in Phases 1 and 6.

---

## Ground truth (captured 2026-05-27 from prod)

| Thing | Value |
|---|---|
| EC2 instance ID | `i-00bab266c07a904ce` |
| Instance type | `t3.medium` |
| Region | `us-west-2` |
| AZ | `us-west-2c` |
| AMI | `ami-0b0efc9bee98cf2eb` (Ubuntu) |
| Public IP | `52.37.76.231` |
| Elastic IP alloc ID | `eipalloc-073945eb681ade332` |
| Elastic IP assoc ID | `eipassoc-0137cc538bd00fd1e` |
| EBS root volume | `vol-014a37b81906b47b9` (100 GB gp3, encrypted KMS, `DeleteOnTermination=false`) |
| KMS key | `arn:aws:kms:us-west-2:420265757862:key/b99bcc65-cf3d-4ba8-b761-797e9d595933` |
| Security group | `sg-013de5e77001cd14c` (`grove-sg`) — ports 22, 80, 443 from `0.0.0.0/0` |
| VPC | `vpc-07a2c841bd34cfc10` |
| Subnet | `subnet-000a217a3a32e8c07` |
| Key pair | `grove-key` (local: `~/.ssh/grove-aws.pem`) |
| IAM instance profile | `grove-ec2-profile` |
| AWS account | `420265757862` |
| S3 backup bucket | `s3://grove-backups-jm` (us-west-2, daily tarballs of `~/.grove/*` since 2026-05-08) |
| Vaults (5) | `personal`, `test-vault`, `sharpshoot`, `ryan`, `echo` |
| Vault paths on prod | `personal` → `/root/life`; others → `/root/vaults/<slug>` |
| Per-vault state DBs | `/root/.grove/vaults/<slug>/state.db` |
| Control DB | `/root/.grove/grove.db` (4.7 MB) |
| Personal vault git remote | `git@github.com:jmilinovich/vault-life.git` |
| Other vault remotes | None (`git remote -v` empty for echo/ryan/sharpshoot/test-vault — local-only) |
| PM2 processes | 16: `grove-proxy` + `{server,discovery,scheduler}-<slug>` × 5 vaults |
| Crontabs (root) | `backup-s3.sh @ 03:00`, `sync-all-vaults.sh @ */5min`, `watchdog.sh @ */15min`, `cost-ingest.sh @ 06:00` |
| nginx site | `/etc/nginx/sites-enabled/grove` — `api.grove.md` → `:8420` |
| TLS cert | `/etc/letsencrypt/live/api.grove.md/` (Let's Encrypt, certbot-managed) |
| DNS provider | **Cloudflare** (`grove.md` NS = `hunts.ns.cloudflare.com`, `lauryn.ns.cloudflare.com`). Not Route 53 (`list-hosted-zones` returned `[]`). |
| `api.grove.md` → | `52.37.76.231` (A record, Cloudflare proxy off) |
| `grove.md` / `www.grove.md` → | `76.76.21.21` (Vercel) — landing page is on Vercel, not the EC2 box |
| Registrar | `.md` ccTLD via Moldova STISC. The actual registrar account is not detectable from outside — `<<TODO: confirm whether grove.md is registered via Namecheap, Porkbun, or directly with .md registrar — log into the registrar to find out>>` |
| Local AWS CLI | configured, `us-west-2`, account `420265757862` ✓ |
| Local SSH key | `~/.ssh/grove-aws.pem` ✓ |
| Local `~/.grove/` | `cli.json`, stale `grove.db` (from old single-vault era), `keys.json.migrated` |
| Companion repos | `~/src/grove` only. `~/src/grove-www`, `~/src/grove-phase-1-2`, `~/src/grove-www-worktrees` do **not** exist locally |

**Unknowns / placeholders that this runbook leaves for the operator:**
- `<<TODO: registrar>>` — where `grove.md` is registered (Namecheap / Porkbun / direct with .md). Find by logging in to the suspected provider, or check email for renewal receipts.
- `<<TODO: cloudflare-account>>` — which Cloudflare account holds the `grove.md` zone. The two nameservers (`hunts.ns.cloudflare.com`, `lauryn.ns.cloudflare.com`) confirm Cloudflare; the account is John's.
- `<<TODO: vercel-project-id>>` — `grove.md` resolves to Vercel (`76.76.21.21`) but `~/src/grove-www` isn't on this machine. Project ID is in the Vercel dashboard under "grove-www" (or similar).
- `<<TODO: voyage-key-prefix>>` — first 8 chars of `VOYAGE_API_KEY` so the right key gets revoked. Read from `/root/grove/.env` on prod when ready.
- `<<TODO: resend-key-prefix>>` — same, for `RESEND_API_KEY`.

---

## Conventions used throughout

- `ssh prod` is shorthand for: `ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231`
- `SNAP_DIR` (set in Phase 1) is the local snapshot tree: `~/grove-final-snapshots/<ISO-TIMESTAMP>/`
- Anything in `<<...>>` is a placeholder — never paste those literally; resolve them first.
- "Reversible" means: you can get the system back to working state without touching destructive AWS verbs.

---

# Phase 0 — Pre-flight verification

**Goal:** prove the world matches what this runbook assumes before touching anything.

**Reversibility:** Reversible (read-only).

**Prerequisites:** local AWS CLI works (`aws sts get-caller-identity` returns account `420265757862`); SSH to prod works.

**Verification before:** none — this *is* the verification phase.

**Commands:**

```bash
# 0.1 — Local tooling alive
aws sts get-caller-identity            # expect Account: 420265757862
aws configure list                     # expect region us-west-2
which gh && gh auth status             # expect logged in
ls -la ~/.ssh/grove-aws.pem            # expect -rw------- (mode 0600)

# 0.2 — Can we still reach prod?
ssh -i ~/.ssh/grove-aws.pem -o ConnectTimeout=10 ubuntu@52.37.76.231 'echo OK; date'

# 0.3 — EC2 still where we left it?
aws ec2 describe-instances --instance-ids i-00bab266c07a904ce --region us-west-2 \
  --query 'Reservations[0].Instances[0].{State:State.Name,IP:PublicIpAddress,Type:InstanceType}'
# expect: State=running, IP=52.37.76.231, Type=t3.medium

# 0.4 — Elastic IP still attached to this instance?
aws ec2 describe-addresses --region us-west-2 --allocation-ids eipalloc-073945eb681ade332 \
  --query 'Addresses[0].{IP:PublicIp,Inst:InstanceId,AssocId:AssociationId}'
# expect: IP=52.37.76.231, Inst=i-00bab266c07a904ce

# 0.5 — EBS volume id still correct?
aws ec2 describe-volumes --volume-ids vol-014a37b81906b47b9 --region us-west-2 \
  --query 'Volumes[0].{State:State,Size:Size,DelOnTerm:Attachments[0].DeleteOnTermination}'
# expect: State=in-use, Size=100, DelOnTerm=false

# 0.6 — DNS: api.grove.md still points where we think
dig +short api.grove.md             # expect 52.37.76.231
dig +short NS grove.md              # expect *.ns.cloudflare.com
dig +short grove.md                 # expect 76.76.21.21 (Vercel)

# 0.7 — Health check answers
curl -sS https://api.grove.md/healthz && echo
# expect HTTP 200, JSON {ok:true} or similar

# 0.8 — Vault and process inventory matches expectations
ssh prod 'sudo pm2 list | grep -c grove-'      # expect 16
ssh prod 'sudo sqlite3 /root/.grove/grove.db "SELECT slug FROM vaults"'
# expect personal, test-vault, sharpshoot, ryan, echo

# 0.9 — External service dashboards open in browser (no automation; visual check)
open https://dash.voyageai.com/
open https://resend.com/api-keys
open https://console.aws.amazon.com/billing/home#/bills
open https://dash.cloudflare.com/                     # confirm grove.md zone
open https://vercel.com/dashboard                     # confirm grove-www project
```

**Verification after:** every command in this phase exited 0 and matched the expected value. Any mismatch — STOP and reconcile.

**Rollback:** nothing to roll back.

**Go/no-go gate:**
- [ ] AWS CLI returns expected account/region
- [ ] SSH to prod works
- [ ] EC2 instance ID, EIP alloc, EBS vol ID all match the ground-truth table
- [ ] DNS for api.grove.md still 52.37.76.231
- [ ] `pm2 list` shows 16 grove processes
- [ ] `vaults` table shows 5 expected slugs
- [ ] Voyage/Resend/AWS Billing/Cloudflare/Vercel dashboards confirmed accessible
- [ ] Operator has 60 uninterrupted minutes (Phases 1–5 take ~30, Phases 6–10 take ~30)

---

# Phase 1 — Final snapshots (BEFORE freezing writes)

**Goal:** capture every byte that matters — vault repos (one bundle per vault) + control DB + per-vault state DBs — to **local disk** and **S3** before any state is mutated. Snapshots are taken while the system is still running so we don't lose late writes.

**Reversibility:** Reversible (read-only on prod; only writes to local disk + S3).

**Prerequisites:** Phase 0 green.

**Verification before:**

```bash
# 1.0 — Local disk has space (snapshots ~600MB total: 522M personal + small others + DB)
df -h ~/                        # expect >5GB free
```

**Commands:**

```bash
# 1.1 — Set up snapshot tree
export SNAP_TS=$(date -u +%Y%m%dT%H%M%SZ)
export SNAP_DIR=~/grove-final-snapshots/$SNAP_TS
mkdir -p "$SNAP_DIR"/{bundles,state,control,logs,manifests}
echo "SNAP_DIR=$SNAP_DIR"

# 1.2 — Checkpoint WAL on prod (so the .db file is a complete snapshot, not split with .db-wal)
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo bash -c "
  sqlite3 /root/.grove/grove.db \"PRAGMA wal_checkpoint(TRUNCATE);\"
  for db in /root/.grove/vaults/*/state.db; do
    [ -f \"\$db\" ] && sqlite3 \"\$db\" \"PRAGMA wal_checkpoint(TRUNCATE);\"
  done
  echo CHECKPOINT_OK
"'

# 1.3 — Bundle every vault repo on prod and pull bundles down
#   personal → /root/life
#   others   → /root/vaults/<slug>
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo bash -c "
  mkdir -p /tmp/grove-bundles
  cd /root/life            && git bundle create /tmp/grove-bundles/personal.bundle    --all
  cd /root/vaults/echo       && git bundle create /tmp/grove-bundles/echo.bundle       --all
  cd /root/vaults/ryan       && git bundle create /tmp/grove-bundles/ryan.bundle       --all
  cd /root/vaults/sharpshoot && git bundle create /tmp/grove-bundles/sharpshoot.bundle --all
  cd /root/vaults/test-vault && git bundle create /tmp/grove-bundles/test-vault.bundle --all
  chmod -R a+r /tmp/grove-bundles
  ls -la /tmp/grove-bundles
"'
scp -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231:/tmp/grove-bundles/*.bundle "$SNAP_DIR/bundles/"

# 1.4 — Pull control DB and per-vault state DBs
#   (post-checkpoint these are clean files, no WAL split.)
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo bash -c "
  mkdir -p /tmp/grove-state
  cp /root/.grove/grove.db /tmp/grove-state/grove.db
  cp /root/.grove/cli.json /tmp/grove-state/cli.json 2>/dev/null || true
  cp -r /root/.grove/vaults /tmp/grove-state/vaults
  chmod -R a+r /tmp/grove-state
"'
scp -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231:/tmp/grove-state/grove.db "$SNAP_DIR/control/"
scp -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231:/tmp/grove-state/cli.json "$SNAP_DIR/control/" 2>/dev/null || true
scp -i ~/.ssh/grove-aws.pem -r ubuntu@52.37.76.231:/tmp/grove-state/vaults "$SNAP_DIR/state/"

# 1.5 — Snapshot the PM2 process inventory (for the retro and for sanity)
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo pm2 jlist'  > "$SNAP_DIR/manifests/pm2-jlist.json"
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo pm2 list'   > "$SNAP_DIR/manifests/pm2-list.txt"
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo crontab -l' > "$SNAP_DIR/manifests/crontab-root.txt"
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo cat /etc/nginx/sites-enabled/grove' \
  > "$SNAP_DIR/manifests/nginx-grove.conf"
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo sqlite3 /root/.grove/grove.db ".dump"' \
  > "$SNAP_DIR/manifests/grove-db.sql"

# 1.6 — Save EC2 / EBS / EIP / SG describe outputs so post-mortem ID lookups don't depend on the resources still existing
aws ec2 describe-instances        --instance-ids i-00bab266c07a904ce        --region us-west-2 > "$SNAP_DIR/manifests/ec2-instance.json"
aws ec2 describe-volumes          --volume-ids vol-014a37b81906b47b9        --region us-west-2 > "$SNAP_DIR/manifests/ec2-volume.json"
aws ec2 describe-addresses        --allocation-ids eipalloc-073945eb681ade332 --region us-west-2 > "$SNAP_DIR/manifests/ec2-eip.json"
aws ec2 describe-security-groups  --group-ids sg-013de5e77001cd14c          --region us-west-2 > "$SNAP_DIR/manifests/ec2-sg.json"

# 1.7 — Round-trip clone test: prove the personal bundle is restorable
mkdir -p /tmp/grove-roundtrip && cd /tmp/grove-roundtrip
git clone "$SNAP_DIR/bundles/personal.bundle" personal-test
cd personal-test
git log --oneline | head -5
git log --oneline | wc -l           # should be >0; eyeball matches `ssh prod 'cd /root/life && git log --oneline | wc -l'`
cd ~- && rm -rf /tmp/grove-roundtrip

# 1.8 — Repeat round-trip for one non-personal vault (sharpshoot has the most cross-tenant history)
mkdir -p /tmp/grove-roundtrip && cd /tmp/grove-roundtrip
git clone "$SNAP_DIR/bundles/sharpshoot.bundle" sharpshoot-test
git -C sharpshoot-test log --oneline | head -3
cd ~- && rm -rf /tmp/grove-roundtrip

# 1.9 — Hash everything in the snapshot for the manifest
cd "$SNAP_DIR" && find . -type f -not -name SHA256SUMS | sort | xargs shasum -a 256 > SHA256SUMS
wc -l SHA256SUMS                     # should match `find . -type f -not -name SHA256SUMS | wc -l`

# 1.10 — Push the whole snapshot tree to S3 (versioned by timestamp)
aws s3 sync "$SNAP_DIR" "s3://grove-backups-jm/teardown/$SNAP_TS/" --region us-west-2
aws s3 ls   "s3://grove-backups-jm/teardown/$SNAP_TS/" --recursive --human-readable --summarize

# 1.11 — Clean up tmp dirs on prod
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo rm -rf /tmp/grove-bundles /tmp/grove-state'
```

**Verification after:**

```bash
# All bundles present, non-empty
ls -la "$SNAP_DIR/bundles/"
# Expect 5 files: personal.bundle, echo.bundle, ryan.bundle, sharpshoot.bundle, test-vault.bundle
# personal.bundle should be the largest (~300-500MB compressed)

# Control DB readable
sqlite3 "$SNAP_DIR/control/grove.db" 'SELECT slug FROM vaults'
# Expect 5 rows matching prod

# State DBs present
ls -la "$SNAP_DIR/state/vaults/"
# Expect 5 subdirs (personal, echo, ryan, sharpshoot, test-vault) each with state.db

# Hashes present
test -s "$SNAP_DIR/SHA256SUMS" && echo "manifest OK"

# S3 copy reachable
aws s3 ls "s3://grove-backups-jm/teardown/$SNAP_TS/" --recursive | wc -l   # should be >= local file count
```

**Rollback:** none needed — these are all reads. If a bundle round-trip fails, **do not proceed** until you find out why (could be a quirk in `git bundle --all` on shallow clones, or permissions on a worktree).

**Go/no-go gate:**
- [ ] All 5 bundles present locally
- [ ] All 5 bundles round-trip clone successfully and `git log` looks non-empty
- [ ] `grove.db` opens with `sqlite3` and lists 5 vaults
- [ ] All 5 per-vault `state.db` files copied
- [ ] PM2 jlist, crontab, nginx config, DB dump captured into manifests
- [ ] EC2/EBS/EIP/SG describe-output JSONs captured (so IDs survive even if AWS resources are deleted)
- [ ] `SHA256SUMS` exists and matches file count
- [ ] S3 sync completed; file count in S3 >= local

---

# Phase 2 — Freeze writes (sync + workers, leave reads up)

**Goal:** stop all writers to the vault repos and per-vault state DBs so the snapshots taken in Phase 1 remain authoritative. Leave grove-server + grove-proxy running so reads still work during the wind-down.

**Reversibility:** Reversible (re-enable cron, `pm2 start` the stopped workers).

**Prerequisites:** Phase 1 green; snapshots verified.

**Verification before:**

```bash
# 2.0 — Confirm cron is currently active
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo crontab -l | grep -v "^#"'
# Expect 4 jobs: backup-s3, sync-all-vaults, watchdog, cost-ingest

# 2.1 — Confirm discovery + scheduler workers are online
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo pm2 list | grep -E "(discovery|scheduler)" | grep online | wc -l'
# Expect 10 (5 discovery + 5 scheduler)
```

**Commands:**

```bash
# 2.2 — Disable the root crontab (comment out, don't delete — preserves rollback)
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 "sudo bash -c '
  # Back up first
  crontab -l > /root/crontab.pre-teardown.bak
  # Replace each non-comment line with a commented version
  crontab -l | sed -E \"s|^([^#].*)|# TEARDOWN-DISABLED \1|\" | crontab -
  echo === new crontab ===
  crontab -l
'"

# 2.3 — Stop all discovery + scheduler workers (per-vault)
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo pm2 stop \
  grove-discovery-personal grove-discovery-echo grove-discovery-ryan \
  grove-discovery-sharpshoot grove-discovery-test-vault \
  grove-scheduler-personal grove-scheduler-echo grove-scheduler-ryan \
  grove-scheduler-sharpshoot grove-scheduler-test-vault'

ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo pm2 list'
# Expect: discovery + scheduler rows now show "stopped"; server + proxy still "online"
```

**Verification after:**

```bash
# 2.4 — Cron disabled
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo crontab -l | grep -v "^#" | grep -v "^$" | wc -l'
# Expect 0

# 2.5 — Workers stopped, server + proxy still up
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo pm2 list' | tee /tmp/pm2-after-freeze.txt
# All discovery-* and scheduler-* should be "stopped". grove-server-* + grove-proxy still "online".

# 2.6 — WAIT 6 minutes (one cron cycle + slack), then check no new commits
sleep 360
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo bash -c "
  for p in /root/life /root/vaults/echo /root/vaults/ryan /root/vaults/sharpshoot /root/vaults/test-vault; do
    echo == \$p ==
    git -C \$p log --since=\"7 minutes ago\" --oneline
  done
"'
# Expect: no commits in any vault since freeze.

# 2.7 — Confirm reads still work end-to-end through proxy
curl -sS https://api.grove.md/healthz && echo
```

**Rollback:**

```bash
# Restore crontab
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo crontab /root/crontab.pre-teardown.bak'
# Restart workers
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo pm2 start grove-discovery-personal grove-discovery-echo grove-discovery-ryan grove-discovery-sharpshoot grove-discovery-test-vault grove-scheduler-personal grove-scheduler-echo grove-scheduler-ryan grove-scheduler-sharpshoot grove-scheduler-test-vault'
```

**Go/no-go gate:**
- [ ] Cron has 0 active jobs
- [ ] All 10 worker processes are "stopped"
- [ ] grove-server + grove-proxy still "online" (6 processes)
- [ ] After 6-minute wait, zero new commits in any vault repo
- [ ] `/healthz` still returns 200

---

# Phase 3 — Notify dependents (optional)

**Goal:** give the other vault owners (sharpshoot, ryan, echo) their final bundle + a one-line "here's where to take this next" message. Optionally add a retirement banner if you want to be polite to any leftover clients.

**Reversibility:** Reversible.

**Prerequisites:** Phase 2 green.

**Commands:**

```bash
# 3.1 — Each non-personal vault gets a tarball with its bundle + state.db copy
for slug in sharpshoot ryan echo test-vault; do
  mkdir -p "$SNAP_DIR/handoffs/$slug"
  cp "$SNAP_DIR/bundles/$slug.bundle"          "$SNAP_DIR/handoffs/$slug/"
  cp "$SNAP_DIR/state/vaults/$slug/state.db"   "$SNAP_DIR/handoffs/$slug/" 2>/dev/null || true
  cat > "$SNAP_DIR/handoffs/$slug/README.md" <<EOF
# Your Grove vault — final snapshot

This tarball contains your vault as it existed on $(date -u +%Y-%m-%dT%H:%M:%SZ),
just before api.grove.md was retired.

Files:
- $slug.bundle   git bundle of all branches/refs. Restore: \`git clone $slug.bundle <newrepo>\`
- state.db       sqlite db with embeddings + provenance + lifecycle data Grove was tracking

If you want to keep using Obsidian, just clone the bundle into your vault folder and
you're back. If you want a Grove-style hosted experience, you can stand up your own
copy from \`github.com/jmilinovich/grove\` against a fresh vault.

Personal contact: jrmilinovich@gmail.com
EOF
  tar -czf "$SNAP_DIR/handoffs/$slug.tar.gz" -C "$SNAP_DIR/handoffs" "$slug"
  ls -la "$SNAP_DIR/handoffs/$slug.tar.gz"
done

# 3.2 — Hand the tarballs to their owners by whatever channel makes sense
#   - sharpshoot → SMS / Signal with a 1-time download URL (or AirDrop if same city)
#   - ryan, echo, test-vault → same
# Do this NOW, while api.grove.md still serves /healthz so they can verify the tarball
# is the same content their last reads saw.

# 3.3 — (Optional) Retirement banner on grove.md landing
#   grove.md is on Vercel (project not on this machine; sits at 76.76.21.21).
#   <<TODO: vercel-project-id>> — edit Vercel project "grove-www" (or whatever it's named),
#   replace the landing page with a static "Grove is retired as of YYYY-MM-DD" page,
#   redeploy. Verify: curl -sI https://grove.md returns 200 with the retirement page.

# 3.4 — (Optional) 410 GONE on api.grove.md instead of waiting until Phase 6
#   Edit nginx config to return 410 for any request:
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo bash -c "
  cp /etc/nginx/sites-enabled/grove /etc/nginx/sites-enabled/grove.pre-teardown
  cat > /etc/nginx/sites-enabled/grove <<NGINX
server {
    server_name api.grove.md;
    listen 443 ssl;
    ssl_certificate     /etc/letsencrypt/live/api.grove.md/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.grove.md/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    location / {
        return 410 \"Grove has been retired. Contact jrmilinovich@gmail.com if you need your data.\\n\";
        add_header Content-Type text/plain;
    }
}
server {
    if (\\\$host = api.grove.md) { return 301 https://\\\$host\\\$request_uri; }
    listen 80;
    server_name api.grove.md;
    return 404;
}
NGINX
  nginx -t && systemctl reload nginx
"'
curl -sS https://api.grove.md/healthz   # expect HTTP 410 body
```

**Verification after:**

```bash
# 3.5 — Verify each owner can decompress their tarball (do this from their seat, by phone if needed)
# Locally:
for slug in sharpshoot ryan echo test-vault; do
  tar -tzf "$SNAP_DIR/handoffs/$slug.tar.gz" | head -3
done

# 3.6 — If you flipped the 410:
curl -sI https://api.grove.md/anything   # expect HTTP/2 410
```

**Rollback:** restore nginx:

```bash
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo bash -c "cp /etc/nginx/sites-enabled/grove.pre-teardown /etc/nginx/sites-enabled/grove && nginx -t && systemctl reload nginx"'
```

**Go/no-go gate:**
- [ ] Handoff tarballs created for each non-personal vault
- [ ] Each tarball is decompressible
- [ ] (If sent) owners have acknowledged receipt
- [ ] (If 410'd) `api.grove.md` returns 410 and `/healthz` returns 410 as well

---

# Phase 4 — Kill the services

**Goal:** stop everything PM2 is running, save the dump so we know exactly what was there, and remove pm2 from the boot path so a reboot wouldn't bring it back. EC2 still alive — fully reversible.

**Reversibility:** Reversible (pm2 resurrect from dump, or scp the files back into place).

**Prerequisites:** Phase 3 green.

**Verification before:**

```bash
# 4.0 — Snapshot pm2 dump file (so we have it even if pm2 home is wiped)
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo pm2 save'
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo cp /root/.pm2/dump.pm2 /tmp/dump-final.pm2 && sudo chmod a+r /tmp/dump-final.pm2'
scp -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231:/tmp/dump-final.pm2 "$SNAP_DIR/manifests/pm2-dump.pm2"
test -s "$SNAP_DIR/manifests/pm2-dump.pm2" && echo "pm2 dump captured"
```

**Commands:**

```bash
# 4.1 — Sanity check: snapshots really exist locally + in S3 before killing
ls "$SNAP_DIR/bundles/" | wc -l                                                    # expect 5
aws s3 ls "s3://grove-backups-jm/teardown/$SNAP_TS/bundles/" --region us-west-2 | wc -l   # expect 5

# 4.2 — Kill everything
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo pm2 kill'

# 4.3 — Disable pm2 startup so a reboot wouldn't relaunch it (the
#       startup unit was installed via `pm2 startup systemd -u root`)
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo pm2 unstartup systemd -u root --hp /root || true'
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'systemctl list-unit-files | grep -i pm2 || echo no-pm2-unit'
```

**Verification after:**

```bash
# 4.4 — No PM2 processes
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo pm2 list'
# Expect: "[PM2] Spawning PM2 daemon ..." then empty table (or "no process found")

# 4.5 — API is dead (or 502 from nginx upstream)
curl -sS -o /dev/null -w '%{http_code}\n' https://api.grove.md/healthz
# Expect 502 (nginx still up, upstream gone) — or 410 if Phase 3.4 was applied
```

**Rollback:**

```bash
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo pm2 resurrect'
# If that fails: copy the dump back from local
scp -i ~/.ssh/grove-aws.pem "$SNAP_DIR/manifests/pm2-dump.pm2" ubuntu@52.37.76.231:/tmp/dump.pm2
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo cp /tmp/dump.pm2 /root/.pm2/dump.pm2 && sudo pm2 resurrect'
```

**Go/no-go gate:**
- [ ] `pm2 list` shows empty
- [ ] `pm2-dump.pm2` saved locally and S3-synced
- [ ] PM2 startup unit removed (or systemd shows no pm2 unit)

---

# Phase 5 — Final EBS snapshot

**Goal:** take an AWS-side EBS snapshot of the root volume as the **last** chance to recover anything from the running OS (logs, configs we forgot to grab, the exact /etc state). Crucially, also re-pull a fresh copy of `~/.grove/` after services have stopped to capture any in-flight state at shutdown.

**Reversibility:** Reversible (the snapshot is in your account; restorable into a new volume).

**Prerequisites:** Phase 4 green; services are stopped (so the filesystem is quiescent except for nginx/system logs).

**Verification before:**

```bash
# 5.0 — Confirm nothing is writing to /root/.grove anymore
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo lsof +D /root/.grove 2>/dev/null | head'
# Expect: empty or only sshd / our own session
```

**Commands:**

```bash
# 5.1 — Re-pull /root/.grove one more time (post-shutdown) into the snapshot for completeness
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo tar czf /tmp/grove-final-dotgrove.tar.gz -C /root .grove && sudo chmod a+r /tmp/grove-final-dotgrove.tar.gz'
scp -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231:/tmp/grove-final-dotgrove.tar.gz "$SNAP_DIR/manifests/dotgrove-post-shutdown.tar.gz"

# 5.2 — Take the EBS snapshot
aws ec2 create-snapshot \
  --volume-id vol-014a37b81906b47b9 \
  --description "Grove final teardown snapshot $SNAP_TS — DO NOT DELETE without authorization" \
  --tag-specifications 'ResourceType=snapshot,Tags=[{Key=Name,Value=grove-final-teardown},{Key=Project,Value=grove},{Key=Purpose,Value=teardown-recovery}]' \
  --region us-west-2 | tee "$SNAP_DIR/manifests/ebs-snapshot.json"

# 5.3 — Capture the snapshot ID into an env var for later phases
export SNAP_ID=$(jq -r .SnapshotId "$SNAP_DIR/manifests/ebs-snapshot.json")
echo "EBS snapshot id: $SNAP_ID"

# 5.4 — Poll until snapshot completes (100%); this takes 5–15 min for a 100GB volume that's mostly empty
while true; do
  state=$(aws ec2 describe-snapshots --snapshot-ids "$SNAP_ID" --region us-west-2 \
    --query 'Snapshots[0].{State:State,Progress:Progress}' --output text)
  echo "$(date +%H:%M:%S)  $state"
  echo "$state" | grep -q '^completed' && break
  sleep 30
done
```

**Verification after:**

```bash
# 5.5 — Snapshot completed
aws ec2 describe-snapshots --snapshot-ids "$SNAP_ID" --region us-west-2 \
  --query 'Snapshots[0].{State:State,Progress:Progress,Size:VolumeSize}'
# Expect State=completed Progress=100% Size=100

# 5.6 — Snapshot ID written somewhere durable
echo "$SNAP_ID" >> "$SNAP_DIR/EBS_SNAPSHOT_ID.txt"
aws s3 cp "$SNAP_DIR/EBS_SNAPSHOT_ID.txt" "s3://grove-backups-jm/teardown/$SNAP_TS/EBS_SNAPSHOT_ID.txt"
```

**Rollback:** to restore: `aws ec2 create-volume --snapshot-id $SNAP_ID --availability-zone us-west-2c --volume-type gp3 --region us-west-2`, then attach to a new instance.

**Go/no-go gate:**
- [ ] EBS snapshot `State=completed`, `Progress=100%`
- [ ] Snapshot ID saved locally AND in S3
- [ ] Final `.grove` tarball captured post-shutdown

---

# Phase 6 — Optional intermediate kill switch: nginx + Let's Encrypt cleanup

**Goal:** stop the cert renewal cron (it's pointing at a soon-to-be-dead host) and stop nginx. Doesn't terminate anything in AWS; lets you verify the box is fully quiet before pulling the AWS plug.

**Reversibility:** Reversible (`systemctl start nginx`).

**Commands:**

```bash
# 6.1 — Stop and disable nginx
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo systemctl stop nginx && sudo systemctl disable nginx'

# 6.2 — Confirm certbot renewal cron isn't going to fire (we already disabled root crontab in Phase 2; certbot lives under /etc/cron.d/certbot)
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo cat /etc/cron.d/certbot'
# Read it. If active and you want belt-and-suspenders: rename it:
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo mv /etc/cron.d/certbot /etc/cron.d/certbot.disabled || true'

# 6.3 — (Optional, only if you want to mark the LE cert as "no longer in use" so the hostname can be safely re-acquired by someone else later — usually not needed since we keep the LE account around)
# ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo certbot revoke --cert-name api.grove.md --reason cessationofoperation'
# Skip unless you specifically want to revoke.
```

**Verification after:**

```bash
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'systemctl is-active nginx'   # expect "inactive"
curl -sI --max-time 5 https://api.grove.md/healthz                            # expect connection refused / 502
```

**Go/no-go gate:**
- [ ] nginx inactive on prod
- [ ] api.grove.md is unreachable (or 410, depending on Phase 3.4)

---

# Phase 7 — IRREVERSIBLE: Terminate EC2 + release Elastic IP + delete EBS volume

**Goal:** stop paying for the running infrastructure. After this phase, the EC2 host is gone, the public IP is released to the AWS pool, and only the EBS snapshot from Phase 5 + the local/S3 snapshots from Phase 1 can recover the system.

**Reversibility:** **IRREVERSIBLE.** From here, recovery means: launch a new EC2, restore EBS from snapshot, re-acquire an EIP (different IP), re-point DNS, re-issue TLS cert.

**Prerequisites:** ALL of Phase 1, 4, 5 green; operator has eyes on this phase; no panic.

**Verification before (REQUIRED — do not skip):**

```bash
# 7.0 — The "are you sure" checklist. Each of these must return the expected value.

# Snapshots:
test -s "$SNAP_DIR/bundles/personal.bundle"    && echo OK || echo MISSING_PERSONAL
test -s "$SNAP_DIR/control/grove.db"           && echo OK || echo MISSING_DB
ls "$SNAP_DIR/state/vaults/" | wc -l            # expect 5

# EBS snapshot completed:
aws ec2 describe-snapshots --snapshot-ids "$SNAP_ID" --region us-west-2 \
  --query 'Snapshots[0].State' --output text
# MUST be "completed". If "pending" — STOP, wait, then re-check.

# S3 has a copy:
aws s3 ls "s3://grove-backups-jm/teardown/$SNAP_TS/" --recursive | wc -l
# MUST be >= 12 (5 bundles + 5 state.dbs + control db + manifest)

# Process state on prod (should already be killed):
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo pm2 list 2>&1 | grep -c grove- || true'
# Expect 0

# Falsifier-first: if ANY of these fail, the next commands are NOT safe to run.

# 7.1 — Print exactly what will happen, with no hand-waving:
cat <<EOF

  About to:
    - Terminate EC2 instance i-00bab266c07a904ce  (irrecoverable)
    - Release Elastic IP eipalloc-073945eb681ade332  (52.37.76.231 returns to AWS pool)
    - Delete EBS volume vol-014a37b81906b47b9  (DeleteOnTermination=false, so we do this explicitly)

  Recovery: only via EBS snapshot $SNAP_ID + local bundles in $SNAP_DIR + S3 copy.

  Confirm by typing "TEARDOWN" at the prompt below.

EOF
read -r CONFIRM
[ "$CONFIRM" = "TEARDOWN" ] || { echo "ABORTING"; exit 1; }
```

**Commands:**

```bash
# 7.2 — Terminate the EC2 instance
aws ec2 terminate-instances --instance-ids i-00bab266c07a904ce --region us-west-2

# 7.3 — Poll until terminated
while true; do
  state=$(aws ec2 describe-instances --instance-ids i-00bab266c07a904ce --region us-west-2 \
    --query 'Reservations[0].Instances[0].State.Name' --output text 2>&1)
  echo "$(date +%H:%M:%S)  $state"
  [ "$state" = "terminated" ] && break
  sleep 20
done

# 7.4 — Release the Elastic IP (it's now disassociated since the instance terminated; releasing returns it to AWS)
aws ec2 release-address --allocation-id eipalloc-073945eb681ade332 --region us-west-2

# 7.5 — Delete the EBS volume (it was set DeleteOnTermination=false, so it'll linger as "available" until we delete it)
#   Wait for the detach to settle first:
while true; do
  state=$(aws ec2 describe-volumes --volume-ids vol-014a37b81906b47b9 --region us-west-2 \
    --query 'Volumes[0].State' --output text 2>&1)
  echo "$(date +%H:%M:%S)  volume=$state"
  [ "$state" = "available" ] || [ "$state" = "deleted" ] && break
  sleep 15
done
aws ec2 delete-volume --volume-id vol-014a37b81906b47b9 --region us-west-2

# 7.6 — Optionally delete the security group (only safe once nothing references it)
aws ec2 delete-security-group --group-id sg-013de5e77001cd14c --region us-west-2 || \
  echo "SG still in use somewhere — leave it; it costs $0"
```

**Verification after:**

```bash
# 7.7 — Confirm everything gone
aws ec2 describe-instances --instance-ids i-00bab266c07a904ce --region us-west-2 \
  --query 'Reservations[0].Instances[0].State.Name' --output text
# Expect "terminated"

aws ec2 describe-addresses --filters 'Name=public-ip,Values=52.37.76.231' --region us-west-2 \
  --query 'Addresses' --output text
# Expect empty (no longer in your account)

aws ec2 describe-volumes --volume-ids vol-014a37b81906b47b9 --region us-west-2 2>&1 | head
# Expect: InvalidVolume.NotFound

# 7.8 — Snapshot is still safe
aws ec2 describe-snapshots --snapshot-ids "$SNAP_ID" --region us-west-2 \
  --query 'Snapshots[0].State' --output text
# Expect "completed" — the snapshot survives volume deletion
```

**Rollback:** none. Recovery only via snapshots — `aws ec2 create-volume --snapshot-id $SNAP_ID …` then launch a new instance.

**Go/no-go gate:**
- [ ] Instance state = `terminated`
- [ ] Elastic IP no longer in account
- [ ] EBS volume returns NotFound
- [ ] EBS snapshot still `completed`

---

# Phase 8 — DNS retirement (Cloudflare)

**Goal:** stop resolving the dead hostname. Two options — full deletion (NXDOMAIN, hardest), or A→a black-hole IP (gentlest, lets a static error page be served somewhere else). Recommended: delete the `api.*` A record entirely, leave the zone in place since `grove.md` (the Vercel-hosted landing) is still there.

**Reversibility:** Reversible at Cloudflare any time within the registrar's grace; technically reversible forever as long as you own the domain.

**Prerequisites:** Phase 7 done; no clients should expect api.grove.md to work anymore.

**Verification before:**

```bash
# 8.0 — Confirm zone is in Cloudflare and confirm current records
dig +short NS grove.md     # expect *.ns.cloudflare.com
dig +short api.grove.md    # may still resolve to the now-dead 52.37.76.231 from cache

# 8.1 — Open the Cloudflare dashboard
open https://dash.cloudflare.com/    # <<TODO: cloudflare-account>>
# Navigate: grove.md zone → DNS → Records
```

**Commands (manual UI steps — Cloudflare):**

```
1. Delete the A record for `api` → 52.37.76.231.
2. Leave the root A record for `grove.md` → 76.76.21.21 (Vercel) IF you still want the
   landing page. If you want the landing page dead too, see Phase 8.5 below.
3. Save.

If you're using Cloudflare API instead of the UI, the equivalent is:
  ZONE_ID=<<TODO: find via dash → Overview → Zone ID>>
  CF_API_TOKEN=<<TODO: dash → My Profile → API Tokens, scope: Zone:DNS:Edit on grove.md>>
  # Find the record ID:
  curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
       "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?name=api.grove.md&type=A" | jq
  # Then delete it:
  RECORD_ID=<from above>
  curl -s -X DELETE -H "Authorization: Bearer $CF_API_TOKEN" \
       "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$RECORD_ID"
```

**Verification after:**

```bash
# 8.2 — Resolve from multiple resolvers, allowing TTL to roll
for resolver in 1.1.1.1 8.8.8.8 9.9.9.9; do
  echo "@$resolver: $(dig @$resolver +short api.grove.md)"
done
# Expect: all empty (NXDOMAIN) after ~5–10 min for TTL flush
```

**Phase 8.5 — Landing page (`grove.md`) retirement (optional):**

If you also want to retire the public landing:

```
Option A — Replace with static "Retired" page (recommended):
  In Vercel dashboard (https://vercel.com/dashboard, look for project "grove-www"
  or similar — <<TODO: vercel-project-id>>), replace the home page with a single
  static "Grove is no longer accepting signups" page and redeploy.

Option B — Delete the Vercel project and the grove.md A record:
  - Cloudflare: delete grove.md A record (76.76.21.21) and any www CNAME.
  - Vercel: project → Settings → Advanced → Delete.
  - Result: grove.md returns NXDOMAIN.

Option C — Keep the landing as a static memorial page indefinitely.
```

**Go/no-go gate:**
- [ ] `api.grove.md` returns NXDOMAIN from at least 3 resolvers
- [ ] `grove.md` either serves a retirement page or NXDOMAINs, per your choice

---

# Phase 9 — Revoke external services (API keys)

**Goal:** rotate-by-revocation. Even though the EC2 instance is gone, the API keys it held are still valid until revoked at the provider. Revoke them so a leaked key or an old backup can't be used to bill you.

**Reversibility:** Reversible at each provider (new keys can be re-issued), but the *specific revoked key* is dead.

**Prerequisites:** Phase 7 done.

**Commands (each is a dashboard action — no CLI for these):**

```
9.1 — Voyage AI
  - https://dash.voyageai.com → API Keys
  - Identify VOYAGE_API_KEY by prefix <<TODO: voyage-key-prefix>>.
    (To find: before terminating, run
       ssh prod 'sudo head -50 /root/grove/.env | grep VOYAGE | head -c 30'
     — capture the first 12 chars. Skip if you already terminated; just revoke ALL Voyage
     keys you've ever issued from this account if you can't identify the right one.)
  - Click "Revoke" / "Delete"
  - Verify: dashboard shows the key as revoked / removed

9.2 — Resend
  - https://resend.com/api-keys → identify by prefix <<TODO: resend-key-prefix>> → Revoke
  - Verify: dashboard shows it gone

9.3 — Any other API integrations the EC2 box held
  - Anthropic API (if used directly): https://console.anthropic.com/settings/keys
  - GitHub deploy keys: github.com/settings/keys → look for "grove-aws-deploy" (if such a key was added)
  - GitHub PAT for vault-life pushes: github.com/settings/tokens
    The vault-life remote uses SSH (`git@github.com:jmilinovich/vault-life.git`), so this is
    probably an SSH deploy key, not a PAT. Find under jmilinovich/vault-life → Settings →
    Deploy keys. Revoke "grove-server-ssh-key" or whatever it was named.
  - Cloudflare API tokens scoped to grove.md: dash → My Profile → API Tokens → revoke any that were issued for grove

9.4 — Sentry / Betterstack
  Grove had `.betterstack-configured` and `.betterstack.json` in the repo. Revoke
  the BetterStack source/key at https://betterstack.com if it ever phoned home from prod.
```

**Verification after:** each provider's dashboard shows the key as revoked. There is no `curl` test that proves a key is revoked from outside — you have to trust the dashboard.

**Go/no-go gate:**
- [ ] Voyage key revoked
- [ ] Resend key revoked
- [ ] Any other integrations revoked
- [ ] Each provider dashboard visually confirms

---

# Phase 10 — Verify billing stops

**Goal:** confirm that what we did actually translates to "the meter stopped." This is a wait-and-watch phase — there's no command that says "you owe $0 now," only "the next bill will be roughly X."

**Reversibility:** N/A (it's verification).

**Commands:**

```bash
# 10.1 — AWS Billing dashboard, after Phase 7 + Phase 9 have settled (give it ~1 hour)
open 'https://console.aws.amazon.com/billing/home#/'
# Look at:
#  - Forecasted next-month charge (should drop sharply versus this month)
#  - "Current month-to-date" stops rising
# Reasonable residual costs you may still see:
#  - EBS Snapshots: $0.05/GB-month for the snapshot you kept (~$5/mo for the 100GB volume but
#    snapshots are incremental, so actual is far less — likely $0.50–$2/mo)
#  - S3 standard storage in grove-backups-jm: pennies/mo at ~30MB total
#  - Data transfer: $0
# If anything else is non-zero (EC2-Other, NatGateway, etc.), investigate.

# 10.2 — Voyage AI usage
open https://dash.voyageai.com/usage
# Expect: token usage flat-lines from the time of Phase 9.1.

# 10.3 — Resend usage
open https://resend.com/emails
# Expect: no new sends since revocation.

# 10.4 — Cloudflare: nothing to verify; the free tier doesn't bill for empty zones.

# 10.5 — Vercel (if grove-www still exists): under Usage, expect bandwidth to drop to whatever
#    the retirement page draws.
```

**Go/no-go gate:**
- [ ] AWS daily charges fall to <$1/day within 48 hours
- [ ] Voyage usage flat
- [ ] Resend sends flat
- [ ] No surprise line items

---

# Phase 11 — Local cleanup

**Goal:** remove the operational tooling from John's laptop now that there's no Grove to operate. Keeps the snapshots.

**Reversibility:** Reversible (everything is in git or in the snapshot tree).

**Commands:**

```bash
# 11.1 — Confirm snapshot tree is whole one more time
ls -la "$SNAP_DIR/bundles/" "$SNAP_DIR/state/" "$SNAP_DIR/control/" "$SNAP_DIR/manifests/"
shasum -a 256 -c "$SNAP_DIR/SHA256SUMS" 2>&1 | tail -3
# Expect: all OK

# 11.2 — Round-trip the personal bundle one final time to confirm it's not corrupted on disk
rm -rf /tmp/final-roundtrip
git clone "$SNAP_DIR/bundles/personal.bundle" /tmp/final-roundtrip
git -C /tmp/final-roundtrip log --oneline | wc -l    # expect >0
rm -rf /tmp/final-roundtrip

# 11.3 — Remove the SSH key (or archive it)
mkdir -p ~/.local/share/grove-archive
mv ~/.ssh/grove-aws.pem ~/.local/share/grove-archive/grove-aws.pem.retired
chmod 400 ~/.local/share/grove-archive/grove-aws.pem.retired

# 11.4 — Remove 52.37.76.231 from known_hosts (prevents stale-key warnings if the IP gets reused)
ssh-keygen -R 52.37.76.231 2>/dev/null || true
ssh-keygen -R api.grove.md 2>/dev/null || true

# 11.5 — Archive local CLI config
mv ~/.grove ~/.local/share/grove-archive/dot-grove

# 11.6 — Archive the source repo (move out of ~/src so daily workflows don't see it as active)
mkdir -p ~/.local/share/grove-archive/src
mv /Users/jm/src/grove ~/.local/share/grove-archive/src/grove
# Note: TEARDOWN-RUNBOOK.md is committed to git, so it's preserved in the archive's git history.

# 11.7 — Check for grove-related companion repos (these were NOT present at planning time, but check anyway)
ls -d /Users/jm/src/grove-www /Users/jm/src/grove-www-worktrees /Users/jm/src/grove-phase-1-2 2>/dev/null
# Move whichever exist into the archive.

# 11.8 — Update ~/.claude/CLAUDE.md to remove Grove from the active-systems list
# Manual edit — see "Systems → Knowledge vault — Grove" section, mark it as retired.

# 11.9 — Update ~/.zshrc / ~/.bashrc to remove any GROVE_* env vars or PATH additions
grep -E "GROVE_|grove-aws|api.grove.md" ~/.zshrc ~/.zshenv ~/.bashrc 2>/dev/null
# Hand-edit anything that turns up.
```

**Verification after:**

```bash
# 11.10 — Snapshot still there
ls "$HOME/grove-final-snapshots/"
# Expect: $SNAP_TS dir present

# 11.11 — Local tooling gone
test -e ~/.grove && echo "STILL THERE" || echo "removed"
test -e ~/.ssh/grove-aws.pem && echo "STILL THERE" || echo "removed"
test -e /Users/jm/src/grove && echo "STILL THERE" || echo "removed"
# Expect all three: "removed"

# 11.12 — Archive is browsable
ls -la ~/.local/share/grove-archive/
```

**Rollback:** restore from `~/.local/share/grove-archive/` if you change your mind.

**Go/no-go gate:**
- [ ] `~/grove-final-snapshots/$SNAP_TS/` exists and round-trips
- [ ] `~/.grove`, `~/.ssh/grove-aws.pem`, `~/src/grove` all gone
- [ ] Archive directory has everything that was removed
- [ ] CLAUDE.md updated

---

# Phase 12 — The post-mortem write-up

**Goal:** capture in Grove (via the personal vault bundle, restored locally to `~/life/` if you want, or via Obsidian on the bundle) what was learned. Out of scope for this runbook to write that note; just don't forget.

**Reversibility:** N/A.

**Suggested location:** restore the personal bundle locally and create `Journal/$(date +%Y-%m-%d) — Grove retirement.md` with:
- What the snapshot IDs are (EBS + S3 prefix)
- Where the SSH key lives now
- What the public landing page says (if any)
- The forwarding address (jrmilinovich@gmail.com) for vault owners who didn't grab their tarball in time
- Anything the runbook had as `<<TODO: ...>>` that you ended up resolving — capture the actual answers

---

# Quick reference — emergency reverse

If you've done Phases 0–6 and decide to undo:

```bash
# Restart everything
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo systemctl start nginx'
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo crontab /root/crontab.pre-teardown.bak'
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo cp /etc/nginx/sites-enabled/grove.pre-teardown /etc/nginx/sites-enabled/grove && sudo nginx -t && sudo systemctl reload nginx'

# Restore PM2 (use the local dump if prod's is gone)
scp -i ~/.ssh/grove-aws.pem "$SNAP_DIR/manifests/pm2-dump.pm2" ubuntu@52.37.76.231:/tmp/dump.pm2
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'sudo cp /tmp/dump.pm2 /root/.pm2/dump.pm2 && sudo pm2 resurrect && sudo pm2 startup systemd -u root --hp /root'

# Smoke test
curl -sS https://api.grove.md/healthz
```

After Phase 7 — there is no reverse. Recovery means launching a new instance, restoring EBS from `$SNAP_ID`, re-acquiring an EIP, re-pointing DNS, re-issuing TLS. Plan for an hour.

---

# Snapshot index (filled in during execution)

- `SNAP_DIR`: `<<set in Phase 1.1>>`
- `SNAP_TS`: `<<set in Phase 1.1>>`
- `SNAP_ID`  (EBS snapshot): `<<set in Phase 5.3>>`
- S3 prefix: `s3://grove-backups-jm/teardown/$SNAP_TS/`

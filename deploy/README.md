# Deploying Gizmo

Production is one Hetzner Cloud box  running `docker compose`. It is administered **only over Tailscale**; the cloud firewall denies all public inbound, SSH included. Nothing listens publicly. The only published port is `search-ui`, bound to the box's tailnet IP.

## Day to day: merge to `main`

`/root/gizmo` on the box is a git checkout of `main`. A systemd timer (`gizmo-autodeploy.timer`, every 2 min, first run 2 min after boot) runs `autodeploy.sh` as a oneshot unit (`gizmo-autodeploy.service`, `HOME=/root`, 30 min timeout). Each run:

1. Takes `/run/gizmo-autodeploy.lock`, so a running build makes the next tick exit.
2. Mints a 1-hour, contents:read token for this repo from the GitHub App (`GIZMO_APP_ID` in `.env` + `secrets/github-app.pem`) and fetches `origin/main`. No other credential.
3. Exits if nothing moved. **Defers** if `coder` or `worker` answers `busy` on `/status`, so a deploy never kills a running job. It retries on the next tick.
4. `git merge --ff-only`, then `docker compose up -d --build`. A failed build leaves the running containers untouched.

```bash
journalctl -u gizmo-autodeploy        # what it did
```

`--ff-only` means any hand edit to a tracked file on the box blocks deploys until it's removed. Don't edit tracked files there.

### Verify a deploy

```bash
docker compose ps                                        # fresh uptime
docker logs gizmo-gizmo-1 | grep "socket connected"      # dedicated + personal
docker logs gizmo-gizmo-1 | grep brains:                 # active brain + subscription on/off
docker exec gizmo-gizmo-1 grep -r <new-symbol> src       # the new code is really in the image
```

### Emergency: `push.sh` (bypasses `main`)

```bash
bash deploy/push.sh
```

Rsyncs the working tree to the box over the tailnet, excluding `.env`, `data`, `secrets`, `.git` and `node_modules`. Then it rebuilds **only `gizmo`** and prints the `brains:` line. The box then differs from `main` until the next merge. Overrides: `GIZMO_HOST`, `GIZMO_SSH_KEY`, `GIZMO_REMOTE_DIR`.

## Runtime config

The box's `/root/gizmo/.env` is the source of truth; the local `.env` is stale. Edit it over ssh, then run `docker compose up -d` (recreate). `restart` keeps the old env. Every key is listed in `CLAUDE.md` → Config.

## New box from scratch

Needs ≥2 GB RAM (`bge-m3` embeddings run on CPU) **plus a 2 GB swapfile**: the native `better-sqlite3` rebuild OOM-thrashed a box without swap.

1. **Host:** run `provision.sh` as root on fresh Ubuntu. It installs Docker, Tailscale, restic and sqlite3. Then:
   - run `tailscale up`
   - set the cloud firewall to deny all inbound
   - add the swapfile
   - from then on, ssh only to the tailnet IP
2. **Code:** a git checkout of `main` at `/root/gizmo` with the GitHub repo as `origin` (autodeploy fetches it).
3. **State and secrets**, copied from the old box or a backup, never from git:
   - `.env`
   - `data/`
   - `secrets/github-app.pem`: the gizmo-coder App key, used by the coder service and autodeploy
4. **Start:**
   ```bash
   cd /root/gizmo
   docker compose up -d --build
   docker compose exec ollama ollama pull bge-m3   # one-time
   docker compose logs -f gizmo                    # both sockets connect; a pairing code if a session is logged out
   ```
5. **Autodeploy:**
   ```bash
   cp deploy/gizmo-autodeploy.service deploy/gizmo-autodeploy.timer /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now gizmo-autodeploy.timer
   ```

**Cutover:** WhatsApp allows one connection per linked session. Stop the old instance **before** starting the new one; never run both. If a socket logs "logged out — re-pair needed", pair that number again. Ingest is idempotent, so no data is lost.

## Backups (restic → Backblaze B2)

`deploy/backup.sh` runs nightly from `gizmo-backup.timer` (03:30 box time). It takes a
WAL-safe SQLite snapshot (`.backup`, checked with `PRAGMA quick_check`), then backs up,
encrypted and deduplicated: all of `data/` (DB snapshot, both Baileys creds, Google
token, people, people-groups, memory, **media**, files, ledger), the box `.env` and
`secrets/`, and the worker's `worker-work` + `worker-sessions` volumes. It skips the live
DB files and the re-downloadable caches (`worker-cache`, `ollama-models`). Media (~1.7 GB)
is included: it's the only copy of family photos and costs cents on B2.

Retention: 7 daily, 4 weekly, 12 monthly (`restic forget --prune`). Every Sunday it also
runs `restic check --read-data-subset=5%`. With `GIZMO_BACKUP_HEALTHCHECK_URL` set, it
pings Healthchecks.io (`/start`, success, `/fail`), and a skipped night alerts too.

### One-time setup
1. **B2:** create a **private** bucket, then *Application Keys → Add a New Application
   Key*, scoped to that bucket only, Read and Write. Note the keyID, the applicationKey
   (shown once) and the bucket's S3 endpoint (*Buckets* page, e.g.
   `s3.eu-central-003.backblazeb2.com`).
2. **Healthchecks.io** (optional): a new check, period 1 day, grace 2 hours.
3. **On the box:**
   ```bash
   cd /root/gizmo
   cp deploy/backup.env.example deploy/backup.env && chmod 600 deploy/backup.env
   nano deploy/backup.env        # fill in; keep RESTIC_PASSWORD off the box too!
   set -a && . deploy/backup.env && set +a && restic init
   cp deploy/gizmo-backup.service deploy/gizmo-backup.timer /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now gizmo-backup.timer
   systemctl start gizmo-backup.service      # first run, watch it:
   journalctl -u gizmo-backup -f
   ```
   Unit files in `/etc/systemd/system` are copies: re-copy and `daemon-reload` after
   changing them in the repo.

Status: `systemctl list-timers gizmo-backup.timer`, `journalctl -u gizmo-backup`,
`restic snapshots` (after sourcing `backup.env`).

### Restore
All commands need the restic env: `cd /root/gizmo && set -a && . deploy/backup.env && set +a`.
On a fresh box you need `backup.env` from your password manager; nothing else.

```bash
restic snapshots                       # pick one; "latest" works too
restic ls latest | less                # see what's in it
```

**Test restore (safe, touches nothing live):**
```bash
T=$(mktemp -d)
restic restore latest --target "$T" --include /root/gizmo/data/gizmo.db.bak
sqlite3 "$T/root/gizmo/data/gizmo.db.bak" 'PRAGMA integrity_check; SELECT count(*) FROM messages;'
rm -rf "$T"
```

**Full restore (box died or data is corrupt):**
```bash
docker compose down                    # NEVER restore under a running Gizmo
T=$(mktemp -d)
restic restore latest --target "$T"
mv data "data.broken.$(date +%s)"      # keep the old copy until the new one works
mv "$T/root/gizmo/data" data
mv data/gizmo.db.bak data/gizmo.db     # the snapshot becomes the live DB
cp "$T/root/gizmo/.env" .env; cp -r "$T/root/gizmo/secrets" .   # fresh box only
for v in worker-work worker-sessions; do
  docker volume create "gizmo_$v"
  cp -a "$T/var/lib/docker/volumes/gizmo_$v/_data/." "/var/lib/docker/volumes/gizmo_$v/_data/"
done
docker compose up -d
docker logs gizmo-gizmo-1 | grep "socket connected"   # both dedicated + personal
```
Single file (e.g. the ledger): `restic restore latest --target "$T" --include
/root/gizmo/data/ledger.json`, then copy it into place. Make sure the old box isn't
still running against the same WhatsApp numbers before you start a restored one.

## Dead-man's switch

Set `GIZMO_HEALTHCHECK_URL` (e.g. a healthchecks.io check) in `.env`. Gizmo pings it every 5 minutes, and the monitor alerts you if the box goes dark.

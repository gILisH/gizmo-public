#!/usr/bin/env bash
# Nightly encrypted backup of Gizmo state → restic repo on Backblaze B2 (S3 API).
# Reads restic/B2 env from deploy/backup.env (mode 600, box-only). Run by
# gizmo-backup.timer; safe to run by hand any time, including while Gizmo writes.
#
# What's in it: everything under data/ (SQLite snapshot, both Baileys creds, Google
# token, people + people-groups, memory, media, files, ledger), the box .env and
# secrets/ (the only copy of runtime config + keys — restic encrypts them), and the
# worker's work + session volumes.
# What's NOT: the live gizmo.db/-wal/-shm (a consistent snapshot goes in instead),
# worker-cache and ollama-models (re-downloadable caches).
set -euo pipefail
cd "$(dirname "$0")/.."   # gizmo repo root

# shellcheck disable=SC1091
set -a && . deploy/backup.env && set +a

# Dead-man's switch for the backup itself (a Healthchecks.io check, separate from the
# app's GIZMO_HEALTHCHECK_URL): /start now, success on exit 0, /fail otherwise. A run
# that never happens (timer gone, box down) alerts via the check's grace period.
hc() { [ -n "${GIZMO_BACKUP_HEALTHCHECK_URL:-}" ] && curl -fsS -m 10 --retry 3 -o /dev/null "$GIZMO_BACKUP_HEALTHCHECK_URL$1" || true; }
SNAP="data/gizmo.db.bak"
finish() {
  rc=$?
  rm -f "$SNAP"
  if [ "$rc" = 0 ]; then hc ""; else hc "/fail"; fi
}
trap finish EXIT
hc "/start"

# WAL-safe consistent snapshot via SQLite's online backup API (never copy a live DB
# mid-write). Then prove it's readable before shipping it.
rm -f "$SNAP"
sqlite3 "data/gizmo.db" ".timeout 30000" ".backup '$SNAP'"
[ "$(sqlite3 "$SNAP" 'PRAGMA quick_check;')" = "ok" ]

VOL=/var/lib/docker/volumes
restic unlock   # clears only stale locks a killed run left behind
restic backup --tag nightly \
  --exclude data/gizmo.db --exclude data/gizmo.db-wal --exclude data/gizmo.db-shm \
  "$PWD/data" "$PWD/.env" "$PWD/secrets" \
  "$VOL/gizmo_worker-work/_data" "$VOL/gizmo_worker-sessions/_data"

restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune

# Weekly (Sunday) integrity check, reading back a random 5% of the pack data.
if [ "$(date +%u)" = 7 ]; then restic check --read-data-subset=5%; fi

echo "backup ok: $(date -Is)"

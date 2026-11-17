#!/usr/bin/env bash
# One-command deploy from the Mac: rsync working tree → Hetzner box (tailnet), then rebuild.
# Protects the box's .env and data/ (never overwritten). Usage: bash deploy/push.sh
set -euo pipefail

HOST="${GIZMO_HOST:?set GIZMO_HOST=root@<your-box-tailnet-ip>}"
KEY="${GIZMO_SSH_KEY:-$HOME/.ssh/digitalocean_ed25519}" # key file kept its old name; it's the box's admin key
DIR="${GIZMO_REMOTE_DIR:-/root/gizmo}"
SSH="ssh -i $KEY"

cd "$(dirname "$0")/.."   # repo root

echo "→ syncing code to $HOST:$DIR (excluding .env, data, node_modules)"
rsync -az --exclude node_modules --exclude data --exclude .env --exclude .git --exclude secrets \
  -e "$SSH" ./ "$HOST:$DIR/"

echo "→ rebuilding + restarting gizmo"
$SSH "$HOST" "cd $DIR && docker compose up -d --build gizmo"

echo "→ brains:"
$SSH "$HOST" "cd $DIR && docker compose logs gizmo | grep -i brains | tail -1"

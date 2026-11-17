#!/usr/bin/env bash
# One-time host setup. Run as root on a fresh Ubuntu 22.04/24.04 box.
set -euo pipefail

echo "== Docker =="
curl -fsSL https://get.docker.com | sh

echo "== Tailscale (private admin access) =="
curl -fsSL https://tailscale.com/install.sh | sh

echo "== restic + sqlite3 (for encrypted backups) =="
apt-get update && apt-get install -y restic sqlite3

cat <<'NEXT'

Provision done. Next (manual):
  1. tailscale up            # join your tailnet; note the 100.x IP
  2. In the cloud firewall: DENY ALL inbound (including SSH/22).
     SSH from now on only over Tailscale (ssh root@<tailscale-ip>).
  3. Get the repo + state onto the box (see deploy/README.md), then:
       docker compose up -d --build
       docker compose exec ollama ollama pull bge-m3
NEXT

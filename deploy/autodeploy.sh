#!/usr/bin/env bash
# Pull-based deploy, run on the box by systemd every 2 minutes (deploy/gizmo-autodeploy.*).
# If origin/main moved: fast-forward /root/gizmo and rebuild. Merging to main IS the deploy.
# Auth = the gizmo-coder GitHub App key already on the box, narrowed to contents:read on this
# repo for one hour — no other credential. Outbound-only; nothing listens.
set -euo pipefail

# Wrapped in main() so bash parses the whole file before running: the merge below may
# rewrite this very script mid-run.
main() {
  cd "${GIZMO_DIR:-/root/gizmo}"
  exec 9>/run/gizmo-autodeploy.lock
  flock -n 9 || exit 0 # a build is still running

  local repo=your-github-user/gizmo app_id key=secrets/github-app.pem
  app_id=$(sed -n 's/^GIZMO_APP_ID=//p' .env | tail -1)
  [ -n "$app_id" ] && [ -r "$key" ] || { echo "no GitHub App configured"; exit 1; }

  local now h p jwt inst tok
  b64() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
  now=$(date +%s)
  h=$(printf '{"alg":"RS256","typ":"JWT"}' | b64)
  p=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now - 60)) $((now + 540)) "$app_id" | b64)
  jwt="$h.$p.$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -sign "$key" | b64)"
  inst=$(curl -fsS -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$repo/installation" | grep -o '"id": *[0-9]*' | head -1 | grep -o '[0-9]*$')
  tok=$(curl -fsS -X POST -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/app/installations/$inst/access_tokens" \
    -d "{\"repositories\":[\"${repo#*/}\"],\"permissions\":{\"contents\":\"read\"}}" | grep -o '"token": *"[^"]*"' | cut -d'"' -f4)

  git -c http.extraHeader="Authorization: Basic $(printf 'x-access-token:%s' "$tok" | base64 -w0)" \
    fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0

  # Never rebuild the coder or worker mid-job — that would kill the work. Retry next tick.
  # Their APIs need a shared key; each container has only its own in env, so send both.
  local svc port st
  for svc in coder:8787 worker:8788; do
    port=${svc#*:} st=0
    docker compose exec -T "${svc%%:*}" node -e "fetch('http://localhost:$port/status',{headers:{'x-gizmo-coder-key':process.env.GIZMO_CODER_SECRET||'','x-gizmo-worker-key':process.env.GIZMO_WORKER_KEY||''}}).then(r=>r.json()).then(j=>process.exit(j.busy?3:0)).catch(()=>process.exit(0))" >/dev/null 2>&1 || st=$?
    [ "$st" -eq 3 ] && { echo "${svc%%:*} busy — deploy of $(git rev-parse --short origin/main) deferred"; exit 0; }
  done

  # --ff-only: any hand edit on the box makes this fail loudly instead of being overwritten.
  git merge --ff-only -q origin/main
  echo "deploying $(git log -1 --format='%h %s')"
  # A failed build leaves the running containers untouched.
  docker compose up -d --build
  echo "deployed $(git log -1 --format=%h)"
  exit 0
}
main "$@"

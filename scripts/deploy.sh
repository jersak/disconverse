#!/usr/bin/env bash
# Deploys the committed HEAD to the home server: copies source + configs, rebuilds, restarts.
# Usage (Git Bash): scripts/deploy.sh
set -euo pipefail

# The SSH target comes from DEPLOY_HOST, or from .deploy.env (gitignored; see .deploy.env.example).
[ -f "$(dirname "$0")/../.deploy.env" ] && . "$(dirname "$0")/../.deploy.env"
HOST="${DEPLOY_HOST:?Set DEPLOY_HOST (e.g. in .deploy.env)}"
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "Warning: uncommitted changes are NOT deployed (deploying HEAD $(git rev-parse --short HEAD))." >&2
fi

echo "==> Copying source"
git archive --format=tar HEAD | ssh "$HOST" 'rm -rf ~/disconverse/src && mkdir -p ~/disconverse/src && tar -x -C ~/disconverse/src'

echo "==> Copying configs"
# Written in place (not replaced) so Caddy's single-file bind mount sees the change.
for f in docker-compose.yml livekit.yaml; do
  ssh "$HOST" "cat > ~/disconverse/$f" < "deploy/disconverse/$f"
done
for f in docker-compose.yml Caddyfile; do
  ssh "$HOST" "cat > ~/proxy/$f" < "deploy/proxy/$f"
done

echo "==> Building and restarting"
VERSION="$(git rev-parse --short HEAD)"
ssh "$HOST" "APP_VERSION=$VERSION bash -s" <<'REMOTE'
set -e
  cd ~/proxy && docker compose up -d
  cd ~/disconverse && docker compose up -d --build
  cd ~/proxy && docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile
  docker image prune -f >/dev/null
REMOTE

echo "==> Done"

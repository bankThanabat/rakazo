#!/usr/bin/env bash
# Build the support dependencies from verified sources. Never removes volumes.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/customer-sources.mjs
case "${1:-}" in
  up|stop|ps) action="$1" ;;
  *) echo 'Usage: scripts/customer-stack.sh up|stop|ps' >&2; exit 2 ;;
esac
root="$PWD"
for envfile in .env apps/openrag/.env infra/open-connector/.env; do
  if [[ ! -f "$envfile" ]]; then echo "Missing configuration: $envfile. See docs/self-host/customer-v1.md" >&2; exit 1; fi
done
if [[ "$action" == up ]]; then
  docker network inspect rakazo-support >/dev/null 2>&1 || docker network create rakazo-support >/dev/null
fi
args=("$action")
if [[ "$action" == up ]]; then args+=(--build --detach --wait --wait-timeout 240); fi
docker compose --project-name rakazo-support-connector --env-file "$root/infra/open-connector/.env" -f "$root/infra/open-connector/docker-compose.yml" -f "$root/infra/open-connector/docker-compose.build.yml" -f "$root/infra/compose/customer-connector.yml" "${args[@]}"
FRONTEND_PORT="${FRONTEND_PORT:-3001}" docker compose --project-name rakazo-support-rag --env-file "$root/apps/openrag/.env" -f "$root/apps/openrag/docker-compose.yml" -f "$root/infra/compose/customer-openrag.yml" "${args[@]}"
docker compose --project-name rakazo-support --env-file "$root/.env" -f "$root/infra/compose/docker-compose.yml" -f "$root/infra/compose/customer-rakazo.yml" "${args[@]}"

#!/usr/bin/env bash
# Build the support dependencies from verified sources. Never removes volumes.
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  up|stop|ps) action="$1" ;;
  *) echo 'Usage: scripts/customer-stack.sh up|stop|ps' >&2; exit 2 ;;
esac
root="$PWD"
if [[ "$action" != up ]]; then
  exec python3 "$root/scripts/customer-stack-control.py" "$action" \
    rakazo-support rakazo-support-rag rakazo-support-connector
fi
for envfile in .env apps/openrag/.env infra/open-connector/.env; do
  if [[ ! -f "$envfile" ]]; then echo "Missing configuration: $envfile. See docs/self-host/customer-v1.md" >&2; exit 1; fi
done
connector_source="$root/infra/open-connector"
export OPENCONNECTOR_SOURCE_ID
OPENCONNECTOR_SOURCE_ID=$(node scripts/customer-sources.mjs --connector-id)
export OPENRAG_SOURCE_ID OPENRAG_SOURCE_DIR
OPENRAG_SOURCE_ID=$(node scripts/customer-sources.mjs --openrag-id)
prepared_root=$(mktemp -d "${TMPDIR:-/tmp}/rakazo-customer-build.XXXXXX")
trap 'rm -rf "$prepared_root"' EXIT
OPENRAG_SOURCE_DIR="$prepared_root/openrag"
node scripts/customer-sources.mjs --prepare-openrag="$OPENRAG_SOURCE_DIR" >/dev/null
node scripts/customer-sources.mjs
connector_source="$prepared_root/connector"
node scripts/customer-sources.mjs --prepare-connector="$connector_source" >/dev/null
docker network inspect rakazo-support >/dev/null 2>&1 || docker network create rakazo-support >/dev/null
args=(up --build --detach --wait --wait-timeout 240)
docker compose --project-name rakazo-support-connector --env-file "$root/infra/open-connector/.env" -f "$connector_source/docker-compose.yml" -f "$connector_source/docker-compose.build.yml" -f "$root/infra/compose/customer-connector.yml" "${args[@]}"
FRONTEND_PORT="${FRONTEND_PORT:-3001}" docker compose --project-name rakazo-support-rag --project-directory "$root/apps/openrag" --env-file "$root/apps/openrag/.env" -f "$OPENRAG_SOURCE_DIR/docker-compose.yml" -f "$root/infra/compose/customer-openrag.yml" "${args[@]}"
docker compose --project-name rakazo-support --env-file "$root/.env" -f "$root/infra/compose/docker-compose.yml" -f "$root/infra/compose/customer-rakazo.yml" "${args[@]}"

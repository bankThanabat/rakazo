#!/usr/bin/env bash
# Run from any directory. Requires pnpm dependencies, Docker, and Playwright Chromium.
# All accounts/providers are fixtures; Postgres runs in a disposable container.
set -euo pipefail
cd "$(dirname "$0")/.."

for path in \
  apps/web/src/components/integrations/OpenConnectorCatalog.tsx \
  packages/ui-web/src/integration-card.tsx; do
  if [[ -e "$path" ]]; then
    echo "Replaced integration component remains: $path" >&2
    exit 1
  fi
done

pnpm db:generate
pnpm exec vitest run \
  apps/api/src/router-open-connector.test.ts \
  apps/web/src/pages/PluginsOverlay.test.tsx \
  packages/adapters/src/customer-relay.test.ts
pnpm test:integration -- --spec=packages/adapters/src/customer-conversations.postgres.test.ts
pnpm test:e2e -- --grep='open-connector.spec|integration-cards.spec|graphql-integrations.spec|mcp-oauth.spec|takeover, routine, plugins, and export'

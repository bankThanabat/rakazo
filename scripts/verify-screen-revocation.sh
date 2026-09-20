#!/usr/bin/env bash
# Synthetic screens and users only; PostgreSQL containers are owned by the harness.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm test:integration --spec=packages/testkit/src/screen-revocation.postgres.test.ts
pnpm test:integration --spec=packages/testkit/src/journeys.test.ts '--grep=two Team bots|expired takeover|controlled bot screen'
pnpm exec vitest run packages/core/src/node/screen-capability.test.ts apps/api/src/screen-proxy.test.ts apps/web/src/screen-proxy.test.ts apps/api/src/router.test.ts
pnpm --filter @rakazo/core --filter @rakazo/api --filter @rakazo/web --filter @rakazo/testkit check
API_PORT="${API_PORT:-3215}" WEB_PORT="${WEB_PORT:-5285}" pnpm test:e2e --spec=screen-proxy-revocation.spec.ts
pnpm --filter @rakazo/web exec playwright test --config=playwright.screen-proxy.config.ts --output=../../test-report/deskazo-v1/screen-isolation
pnpm exec biome check packages/core/src/node/screen-capability.ts packages/core/src/node/screen-capability.test.ts apps/api/src/router.ts apps/api/src/router.test.ts apps/api/src/screen-proxy.ts apps/api/src/screen-proxy.test.ts apps/web/e2e/screen-proxy-isolation.spec.ts apps/web/e2e/screen-proxy-revocation.spec.ts packages/testkit/src/screen-revocation.postgres.test.ts packages/testkit/src/cli/harness.ts

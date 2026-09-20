#!/usr/bin/env bash
# Verify shared admission and gateway cancellation/revocation with offline provider fixtures.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-report/deskazo-v1/checks
run_check() {
  local phase="$1"
  shift
  "$@" > "test-report/deskazo-v1/checks/instagram-rate-final-${phase}.log" 2>&1
}
# Sequential: integration commands each generate Prisma and migrate an isolated database.
run_check db pnpm test:integration --spec=packages/db/src/connector-rate-limit.postgres.test.ts
run_check small-pool pnpm test:integration --spec=packages/adapters/src/instagram-rate-gateway.postgres.test.ts
run_check gateway pnpm test:integration --spec=packages/adapters/src/integration-gateway.postgres.test.ts
run_check learning pnpm test:integration --spec=packages/adapters/src/social-learning.postgres.test.ts
run_check unit pnpm exec vitest run packages/adapters/src/open-connector-rate-limit.test.ts packages/adapters/src/open-connector.test.ts packages/adapters/src/integration-provider-settings.test.ts packages/adapters/src/integration-gateway-webhook.test.ts packages/adapters/src/customer-connector.test.ts
run_check types pnpm --filter @rakazo/adapter-kit --filter @rakazo/adapters --filter @rakazo/db --filter @rakazo/testkit check
printf '%s\n' 'Instagram account pacing offline checks passed.'

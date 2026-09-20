#!/usr/bin/env bash
# Isolated PostgreSQL exercises the real dispatch boundary and learning consumer.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-report/deskazo-v1/checks
for suite in instagram-comment-writes social-learning integration-gateway; do
  pnpm test:integration --spec="packages/adapters/src/${suite}.postgres.test.ts" \
    > "test-report/deskazo-v1/checks/instagram-provenance-${suite}.log" 2>&1
done
pnpm exec vitest run packages/adapters/src/integration-provider-settings.test.ts packages/adapters/src/instagram-learning.test.ts packages/adapters/src/customer-connector.test.ts \
  > test-report/deskazo-v1/checks/instagram-provenance-unit.log 2>&1
pnpm --filter @rakazo/adapters --filter @rakazo/db check \
  > test-report/deskazo-v1/checks/instagram-provenance-types.log 2>&1
printf '%s\n' 'Instagram provenance checks passed.'

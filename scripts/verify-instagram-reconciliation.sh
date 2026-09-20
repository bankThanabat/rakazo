#!/usr/bin/env bash
# Recovery must inspect durable evidence without repeating the original send.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-report/deskazo-v1/checks
prefix=${CHECK_PREFIX:-instagram-reconciliation}
for suite in instagram-comment-writes social-learning integration-gateway; do
  pnpm test:integration --spec="packages/adapters/src/${suite}.postgres.test.ts" \
    > "test-report/deskazo-v1/checks/${prefix}-${suite}.log" 2>&1
done
pnpm exec vitest run packages/adapters/src/integration-provider-settings.test.ts packages/adapters/src/customer-connector.test.ts packages/adapters/src/customer-runtime.test.ts packages/core/src/action-approval.test.ts packages/adapters/src/open-connector.test.ts \
  > "test-report/deskazo-v1/checks/${prefix}-unit.log" 2>&1
pnpm --filter @rakazo/adapter-kit --filter @rakazo/contracts --filter @rakazo/adapters --filter @rakazo/db check \
  > "test-report/deskazo-v1/checks/${prefix}-types.log" 2>&1
printf '%s\n' 'Instagram reconciliation checks passed.'

#!/usr/bin/env bash
# Run offline DM traversal, consent, final-write and private lifecycle checks.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-report/deskazo-v1/checks
run_check() {
  local phase="$1"
  shift
  "$@" > "test-report/deskazo-v1/checks/instagram-dm-history-final-${phase}.log" 2>&1
}
# Run sequentially: each runner generates Prisma and migrates an isolated database.
run_check social pnpm test:integration --spec=packages/adapters/src/social-learning.postgres.test.ts
run_check learning pnpm test:integration --spec=packages/adapters/src/continued-learning.postgres.test.ts
run_check export pnpm test:integration --spec=packages/testkit/src/account-export.postgres.test.ts
run_check unit pnpm exec vitest run packages/adapters/src/instagram-message-learning.test.ts packages/adapters/src/instagram-learning.test.ts packages/adapters/src/customer-connector.test.ts packages/core/src/action-approval.test.ts
run_check types pnpm --filter @rakazo/adapters --filter @rakazo/contracts --filter @rakazo/db --filter @rakazo/testkit check
printf '%s\n' 'Instagram message learning offline checks passed.'

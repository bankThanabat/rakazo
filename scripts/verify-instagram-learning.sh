#!/usr/bin/env bash
# Verify consent, durable reply import and the exact patched connector read effects.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-report/deskazo-v1/checks
run_check() {
  local phase="$1"
  shift
  "$@" > "test-report/deskazo-v1/checks/instagram-learning-final-${phase}.log" 2>&1
}
# The integration runner generates Prisma and migrates an isolated database first.
run_check integration pnpm test:integration --spec=packages/adapters/src/social-learning.postgres.test.ts
run_check unit pnpm exec vitest run packages/adapters/src/instagram-learning.test.ts packages/adapters/src/open-connector-effects.test.ts packages/adapters/src/customer-connector.test.ts packages/core/src/action-approval.test.ts
run_check types pnpm --filter @rakazo/adapters --filter @rakazo/contracts --filter @rakazo/db --filter @rakazo/testkit check
run_check connector node scripts/verify-instagram-replies.mjs infra/open-connector
printf '%s\n' 'Instagram reply learning checks passed.'

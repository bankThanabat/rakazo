#!/usr/bin/env bash
# Verify owner-configured escalation criteria without a live assessment provider.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-report/deskazo-v1/checks
run_check() {
  local phase="$1"
  shift
  "$@" > "test-report/deskazo-v1/checks/assessment-criteria-${phase}.log" 2>&1
}
run_check unit pnpm exec vitest run packages/adapters/src/customer-assessment.test.ts packages/adapters/src/approval-ask.test.ts packages/adapters/src/customer-runtime.test.ts
# The integration harness generates Prisma and migrates an isolated database.
run_check postgres pnpm test:integration --spec=packages/adapters/src/customer-conversations.postgres.test.ts
run_check types pnpm --filter @rakazo/contracts --filter @rakazo/adapter-kit --filter @rakazo/adapters check
printf '%s\n' 'Customer assessment criteria offline checks passed.'

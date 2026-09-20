#!/usr/bin/env bash
# Offline provider fixtures, then browser rendering. Prisma-generating harnesses are sequential.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-report/deskazo-v1/checks
run_check() {
  local phase="$1"
  shift
  "$@" > "test-report/deskazo-v1/checks/semantic-approval-detail-${phase}.log" 2>&1
}
run_check types pnpm --filter @rakazo/adapters --filter @rakazo/testkit --filter @rakazo/web check
run_check unit pnpm exec vitest run packages/adapters/src/approval-ask.test.ts packages/adapters/src/executor-approval-replay.test.ts
run_check integration pnpm test:integration --spec=packages/testkit/src/semantic-memory-approval.postgres.test.ts
run_check browser env API_PORT="${API_PORT:-3211}" WEB_PORT="${WEB_PORT:-5281}" pnpm test:e2e '--spec=(semantic-memory-approval|consequential-approval|approval-resume).spec.ts'
printf '%s\n' 'Semantic approval detail checks passed with offline provider fixtures.'

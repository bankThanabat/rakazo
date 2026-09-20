#!/usr/bin/env bash
# Offline approval replay checks, with database suites run sequentially.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-report/deskazo-v1/checks
run_check() {
  local phase="$1"
  shift
  "$@" > "test-report/deskazo-v1/checks/document-replay-${phase}.log" 2>&1
}
run_check types pnpm --filter @rakazo/adapters --filter @rakazo/testkit check
run_check unit pnpm exec vitest run packages/adapters/src/approval-ask.test.ts packages/adapters/src/executor-approval-replay.test.ts packages/adapters/src/executor-readonly-approval.test.ts packages/adapters/src/executor-effect-idempotency.test.ts packages/adapters/src/executor-approval-pi.test.ts
run_check integration pnpm test:integration --spec=packages/testkit/src/document-approval.postgres.test.ts
run_check regression pnpm test:integration
printf '%s\n' 'Document replay and offline integration checks passed.'

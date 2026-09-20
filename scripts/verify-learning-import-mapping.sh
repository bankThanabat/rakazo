#!/usr/bin/env bash
# Synthetic flat exports exercise explicit mapping; these are not native LINE acceptance fixtures.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-report/deskazo-v1/checks
run_check() {
  local phase="$1"
  shift
  "$@" > "test-report/deskazo-v1/checks/import-mapping-${phase}.log" 2>&1
}
run_check unit pnpm exec vitest run packages/core/src/learning-import.test.ts packages/core/src/learning-import-mapping.test.ts
# Sequential harness invocations generate Prisma and migrate isolated databases.
run_check history pnpm test:integration --spec=packages/adapters/src/learning-history.postgres.test.ts
run_check sources pnpm test:integration --spec=packages/db/src/learning.postgres.test.ts
run_check export pnpm test:integration --spec=packages/testkit/src/account-export.postgres.test.ts
run_check types pnpm --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/web check
run_check mobile-types pnpm --filter @rakazo/mobile exec tsc --noEmit
printf '%s\n' 'Learning import mapping offline checks passed.'

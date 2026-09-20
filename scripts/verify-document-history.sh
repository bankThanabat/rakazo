#!/usr/bin/env bash
# Byte-aware history regression, including real RPC serialization and database paging.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-report/deskazo-v1/checks
run_check() {
  local phase="$1"
  shift
  "$@" > "test-report/deskazo-v1/checks/document-history-${phase}.log" 2>&1
}
run_check types pnpm --filter @rakazo/api --filter @rakazo/testkit check
run_check unit pnpm exec vitest run apps/api/src/thread-message-pages.test.ts apps/api/src/thread-message-size.test.ts apps/web/src/lib/thread-events.test.ts apps/mobile/lib/api.test.ts
run_check integration pnpm test:integration --spec=packages/testkit/src/thread-message-pages.postgres.test.ts
run_check journeys pnpm test:integration --spec=packages/testkit/src/journeys.test.ts
run_check search pnpm test:integration --spec=packages/testkit/src/search.test.ts
run_check authorization pnpm test:integration --spec=packages/testkit/src/authorization.test.ts
printf '%s\n' 'Document history pagination checks passed.'

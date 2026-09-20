#!/usr/bin/env bash
# Offline provider fixtures and real PostgreSQL. Run Prisma-generating harnesses sequentially.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-report/deskazo-v1/checks
run_check() {
  local phase="$1"
  shift
  "$@" > "test-report/deskazo-v1/checks/semantic-compaction-${phase}.log" 2>&1
}
run_check types pnpm --filter @rakazo/contracts --filter @rakazo/adapter-kit --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/testkit check
run_check unit pnpm exec vitest run packages/adapters/src/history-compaction.test.ts packages/adapters/src/memory-save-scope.test.ts packages/adapters/src/serenity-memory-provider.test.ts packages/adapters/src/supermemory-memory-provider.test.ts packages/adapters/src/supermemory-removal.test.ts packages/adapters/src/supermemory-client.test.ts
run_check database pnpm test:integration --spec=packages/testkit/src/semantic-history-compaction.postgres.test.ts
run_check audit pnpm test:integration --spec=packages/testkit/src/semantic-memory-audit.postgres.test.ts
printf '%s\n' 'Semantic compaction checks passed with offline provider fixtures.'

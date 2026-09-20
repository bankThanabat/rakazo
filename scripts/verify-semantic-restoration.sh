#!/usr/bin/env bash
# Offline semantic-provider fixtures and real PostgreSQL. Run database harnesses sequentially.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-report/deskazo-v1/checks
run_check() {
  local phase="$1"
  shift
  "$@" > "test-report/deskazo-v1/checks/semantic-restore-${phase}.log" 2>&1
}
run_check types pnpm --filter @rakazo/contracts --filter @rakazo/adapter-kit --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/testkit check
run_check unit pnpm exec vitest run packages/adapters/src/semantic-memory-restore.test.ts packages/adapters/src/supermemory-removal.test.ts packages/adapters/src/serenity-memory-provider.test.ts packages/adapters/src/supermemory-client.test.ts packages/adapters/src/executor-approval-replay.test.ts packages/adapters/src/memory-tools.test.ts packages/adapters/src/approval-ask.test.ts packages/core/src/action-approval.test.ts
run_check database pnpm test:integration --spec=packages/testkit/src/semantic-memory-audit.postgres.test.ts
run_check approval pnpm test:integration --spec=packages/testkit/src/semantic-memory-approval.postgres.test.ts
printf '%s\n' 'Semantic restoration checks passed with offline provider fixtures.'

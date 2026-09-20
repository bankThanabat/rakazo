#!/usr/bin/env bash
# Staff approval and private customer setup, using synthetic external providers.
set -euo pipefail
cd "$(dirname "$0")/.."
report="${1:-test-report/deskazo-v1/checks/customer-preparation-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$(dirname "$report")"
mkdir "$report"
printf 'Reports: %s\n' "$report"
pnpm exec vitest run packages/core/src/action-approval.test.ts packages/adapters/src/approval-ask.test.ts packages/adapters/src/executor-readonly-approval.test.ts > "$report/customer-preparation-unit.log" 2>&1
pnpm test:integration --spec=packages/adapters/src/customer-conversations.postgres.test.ts > "$report/customer-preparation-postgres.log" 2>&1
pnpm --filter @rakazo/core --filter @rakazo/adapters check > "$report/customer-preparation-types.log" 2>&1
pnpm exec biome check packages/core/src/action-approval.ts packages/core/src/action-approval.test.ts packages/adapters/src/approval-ask.ts packages/adapters/src/approval-ask.test.ts packages/adapters/src/customer-tools.ts packages/adapters/src/executor.ts packages/adapters/src/executor-readonly-approval.test.ts packages/adapters/src/customer-conversations.ts packages/adapters/src/customer-conversations.postgres.test.ts > "$report/customer-preparation-style.log" 2>&1
printf '%s\n' 'Customer preparation checks passed.'

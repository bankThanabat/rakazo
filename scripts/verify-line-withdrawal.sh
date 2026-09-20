#!/usr/bin/env bash
# Verify source withdrawal without any real provider messages or services.
set -euo pipefail
cd "$(dirname "$0")/.."
report="${1:?Supply a new report directory}"
mkdir -m 700 "$report"
run_check() {
  local phase="$1"
  shift
  "$@" > "$report/$phase.log" 2>&1
}
run_check unit pnpm exec vitest run packages/adapters/src/customer-incoming.test.ts packages/adapters/src/customer-ingress.test.ts packages/adapters/src/customer-mapping.test.ts packages/adapters/src/customer-business-tools.test.ts
run_check migration pnpm test:integration --spec=packages/db/src/customer-schema.postgres.test.ts
run_check learning pnpm test:integration --spec=packages/db/src/learning.postgres.test.ts
run_check conversations pnpm test:integration --spec=packages/adapters/src/customer-conversations.postgres.test.ts
run_check continued-learning pnpm test:integration --spec=packages/adapters/src/continued-learning.postgres.test.ts
run_check types pnpm --filter @rakazo/contracts --filter @rakazo/db --filter @rakazo/adapters check
printf '%s\n' 'Offline source-withdrawal checks passed.'

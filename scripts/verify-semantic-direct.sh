#!/usr/bin/env bash
# Real database/API and loopback provider only. Never overlap the Prisma-generating harnesses.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-report/deskazo-v1/checks
run_check() {
  local phase="$1"
  shift
  "$@" > "test-report/deskazo-v1/checks/semantic-direct-${phase}.log" 2>&1
}
run_check types pnpm --filter @rakazo/contracts --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/chat-ui --filter @rakazo/web --filter @rakazo/testkit check
run_check mobile-types pnpm --filter @rakazo/mobile exec tsc --noEmit
run_check unit pnpm exec vitest run apps/web/src/pages/semantic-history.test.tsx apps/mobile/components/semantic-memory-history.test.tsx apps/mobile/lib/i18n.test.ts
run_check direct pnpm test:integration --spec=packages/testkit/src/semantic-memory-direct.postgres.test.ts
run_check audit pnpm test:integration --spec=packages/testkit/src/semantic-memory-audit.postgres.test.ts
run_check browser env API_PORT="${API_PORT:-3211}" WEB_PORT="${WEB_PORT:-5281}" pnpm test:e2e '--spec=(semantic-memory-direct|semantic-memory-history).spec.ts'
printf '%s\n' 'Direct semantic reversal checks passed using offline provider fixtures.'

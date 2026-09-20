#!/usr/bin/env bash
# Synthetic records only. Browser and database harnesses run sequentially because they generate Prisma.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-report/deskazo-v1/checks
run_check() {
  local phase="$1"
  shift
  "$@" > "test-report/deskazo-v1/checks/semantic-history-${phase}.log" 2>&1
}
run_check types pnpm --filter @rakazo/contracts --filter @rakazo/db --filter @rakazo/chat-ui --filter @rakazo/api --filter @rakazo/web --filter @rakazo/testkit check
run_check mobile-types pnpm --filter @rakazo/mobile exec tsc --noEmit
run_check unit pnpm exec vitest run apps/web/src/pages/semantic-history.test.tsx apps/mobile/components/semantic-memory-history.test.tsx apps/mobile/components/private-history.test.tsx apps/web/src/pages/KnowledgeSection.test.tsx apps/mobile/lib/i18n.test.ts
run_check database pnpm test:integration --spec=packages/testkit/src/semantic-memory-audit.postgres.test.ts
run_check approval pnpm test:integration --spec=packages/testkit/src/semantic-memory-approval.postgres.test.ts
run_check browser env API_PORT="${API_PORT:-3211}" WEB_PORT="${WEB_PORT:-5281}" pnpm test:e2e --spec=semantic-memory-history.spec.ts
printf '%s\n' 'Semantic history checks passed. Native device and live-provider acceptance require separate evidence.'

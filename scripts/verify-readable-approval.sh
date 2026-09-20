#!/usr/bin/env bash
# Offline contract, renderer and browser coverage; native touch flow is documented in mobile/e2e.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm exec vitest run packages/core/src/learning-approval.test.ts packages/adapters/src/approval-ask.test.ts apps/mobile/lib/i18n.test.ts apps/mobile/lib/ui-locale.test.ts
pnpm --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/adapters --filter @rakazo/web --filter @rakazo/mobile check
pnpm test:integration --spec=packages/testkit/src/document-approval.postgres.test.ts
API_PORT="${API_PORT:-3211}" WEB_PORT="${WEB_PORT:-5281}" pnpm test:e2e '--spec=(semantic-memory-approval|consequential-approval|approval-resume).spec.ts'

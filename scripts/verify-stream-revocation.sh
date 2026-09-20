#!/usr/bin/env bash
# Disposable PostgreSQL and synthetic accounts; both memory and PostgreSQL notifications.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm test:integration --spec=packages/testkit/src/event-stream-revocation.postgres.test.ts
pnpm test:integration --spec=packages/testkit/src/authorization.test.ts
pnpm test:integration --spec=packages/adapters/src/realtime.postgres.test.ts
pnpm exec vitest run packages/db/src/events.test.ts packages/adapters/src/realtime.test.ts packages/core/src/thread-subscription.test.ts apps/api/src/router.test.ts
pnpm --filter @rakazo/db --filter @rakazo/api --filter @rakazo/testkit check
pnpm exec biome check apps/api/src/app.ts apps/api/src/router.ts packages/db/src/events.ts packages/db/src/events.test.ts packages/testkit/src/event-stream-revocation.postgres.test.ts packages/testkit/src/cli/harness.ts

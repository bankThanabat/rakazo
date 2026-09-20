#!/usr/bin/env bash
# Offline PostgreSQL races and real executor callbacks, using synthetic providers.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm test:integration --spec=packages/db/src/member-work-revocation.postgres.test.ts
pnpm test:integration --spec=packages/testkit/src/executor-lifecycle.test.ts
pnpm test:integration --spec=packages/testkit/src/document-approval.postgres.test.ts
pnpm test:integration --spec=packages/testkit/src/account-deletion.postgres.test.ts
pnpm test:integration --spec=packages/adapters/src/account-deletion.postgres.test.ts
pnpm exec vitest run packages/adapters/src/executor.test.ts packages/adapters/src/executor-readonly-approval.test.ts packages/adapters/src/executor-effect-idempotency.test.ts packages/adapters/src/approval-effect.test.ts
pnpm --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/testkit check

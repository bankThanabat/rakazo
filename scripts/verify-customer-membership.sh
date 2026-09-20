#!/usr/bin/env bash
# Customer revocation and database ordering with isolated PostgreSQL and synthetic providers.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm test:integration --spec=packages/db/src/customer-member-revocation.postgres.test.ts
pnpm test:integration --spec=packages/adapters/src/customer-conversations.postgres.test.ts
pnpm test:integration --spec=apps/api/src/customer-website.postgres.test.ts
pnpm test:integration --spec=packages/testkit/src/account-deletion.postgres.test.ts
pnpm test:integration --spec=packages/adapters/src/account-deletion.postgres.test.ts
pnpm test:integration --spec=packages/db/src/space-membership.postgres.test.ts
pnpm --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/testkit check
pnpm exec biome check packages/db/src/customer-member-revocation.postgres.test.ts packages/adapters/src/customer-conversations.postgres.test.ts packages/adapters/src/account-deletion.postgres.test.ts packages/testkit/src/cli/harness.ts

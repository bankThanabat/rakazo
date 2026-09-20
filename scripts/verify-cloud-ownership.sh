#!/usr/bin/env bash
# Exercise cloud exports and legacy cleanup against isolated PostgreSQL and fake providers.
set -euo pipefail
cd "$(dirname "$0")/.."
VERIFY_LARGE_ACCOUNT_EXPORT=1 pnpm test:integration --spec=packages/testkit/src/account-export.postgres.test.ts
pnpm test:integration --spec=packages/adapters/src/cloud-agent.postgres.test.ts
pnpm test:integration --spec=packages/adapters/src/account-deletion.postgres.test.ts
pnpm --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/testkit check
pnpm exec biome check packages/db/src/account-export.ts packages/testkit/src/account-export.postgres.test.ts packages/adapters/src/cloud-agent-service.ts packages/adapters/src/cloud-agent.postgres.test.ts

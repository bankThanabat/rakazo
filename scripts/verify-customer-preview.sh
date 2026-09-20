#!/usr/bin/env bash
# Private customer practice through real PostgreSQL and synthetic external providers.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm test:integration --spec=packages/adapters/src/customer-conversations.postgres.test.ts
pnpm test:integration --spec=apps/api/src/customer-website.postgres.test.ts
pnpm test:integration --spec=packages/adapters/src/continued-learning.postgres.test.ts
pnpm test
pnpm --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/worker --filter @rakazo/testkit check
pnpm exec biome check apps/api/src/router-open-connector.test.ts packages/contracts/src/customer.ts packages/core/src/customer-delivery.ts packages/db/src/customer-inbox.ts packages/db/src/customers.ts packages/db/src/learning-queue.ts packages/adapters/src/customer-preview.ts packages/adapters/src/customer-conversations.ts packages/adapters/src/customer-conversations.postgres.test.ts packages/adapters/src/customer-business-tools.ts packages/adapters/src/customer-tools.ts packages/adapters/src/executor.ts

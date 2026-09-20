#!/usr/bin/env bash
# Offline conformance and browser checks. Requires Docker and installed pnpm dependencies.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-report/deskazo-v1/checks
pnpm --filter @rakazo/db generate > test-report/deskazo-v1/checks/generate.log 2>&1
pnpm -r --filter @rakazo/contracts --filter @rakazo/adapter-kit --filter @rakazo/db --filter @rakazo/memory --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/worker --filter @rakazo/web --filter @rakazo/testkit check > test-report/deskazo-v1/checks/types.log 2>&1
pnpm --filter @rakazo/mobile exec tsc --noEmit > test-report/deskazo-v1/checks/mobile-types.log 2>&1
pnpm test > test-report/deskazo-v1/checks/unit.log 2>&1
python3 scripts/verify-deployment-backup.py > test-report/deskazo-v1/checks/deployment-recovery.log 2>&1
pnpm test:integration --spec=packages/db/src/customer-schema.postgres.test.ts > test-report/deskazo-v1/checks/customer-migrations.log 2>&1
pnpm test:integration --spec=packages/testkit/src/memory-audit.postgres.test.ts > test-report/deskazo-v1/checks/memory-audit.log 2>&1
pnpm test:integration --spec=packages/testkit/src/private-history.postgres.test.ts > test-report/deskazo-v1/checks/private-history.log 2>&1
pnpm test:integration --spec=packages/testkit/src/skill-audit.postgres.test.ts > test-report/deskazo-v1/checks/skill-audit.log 2>&1
pnpm test:integration --spec=packages/memory/src/commit.postgres.test.ts > test-report/deskazo-v1/checks/private-account-memory.log 2>&1
pnpm test:integration --spec=packages/db/src/learning.postgres.test.ts > test-report/deskazo-v1/checks/learning-database.log 2>&1
pnpm test:integration --spec=packages/adapters/src/learning-history.postgres.test.ts > test-report/deskazo-v1/checks/learning-history.log 2>&1
pnpm test:integration --spec=packages/adapters/src/social-learning.postgres.test.ts > test-report/deskazo-v1/checks/social-learning.log 2>&1
pnpm test:integration --spec=packages/adapters/src/continued-learning.postgres.test.ts > test-report/deskazo-v1/checks/continued-learning.log 2>&1
pnpm test:integration --spec=packages/adapters/src/customer-operation.postgres.test.ts > test-report/deskazo-v1/checks/customer-operations.log 2>&1
pnpm test:integration --spec=packages/adapters/src/customer-conversations.postgres.test.ts > test-report/deskazo-v1/checks/customer-runtime.log 2>&1
pnpm test:integration --spec=packages/adapters/src/customer-line-alerts.postgres.test.ts > test-report/deskazo-v1/checks/customer-line-alerts.log 2>&1
pnpm test:integration --spec=packages/adapters/src/customer-purchases.postgres.test.ts > test-report/deskazo-v1/checks/customer-purchases.log 2>&1
pnpm test:integration --spec=packages/testkit/src/connections.test.ts > test-report/deskazo-v1/checks/purchase-connection-revocation.log 2>&1
pnpm test:integration --spec=packages/adapters/src/account-deletion.postgres.test.ts > test-report/deskazo-v1/checks/deletion-recovery.log 2>&1
pnpm test:integration --spec=packages/testkit/src/account-deletion.postgres.test.ts > test-report/deskazo-v1/checks/account-deletion.log 2>&1
pnpm test:integration --spec=packages/testkit/src/account-export.postgres.test.ts > test-report/deskazo-v1/checks/account-export.log 2>&1
API_PORT="${API_PORT:-3211}" WEB_PORT="${WEB_PORT:-5281}" pnpm test:e2e '--grep=learning documents|social learning evidence|memory and skills are readable|website visitor|website shopper|account data export' > test-report/deskazo-v1/checks/browser.log 2>&1
echo 'Deskazo offline verification passed. Logs: test-report/deskazo-v1/checks'

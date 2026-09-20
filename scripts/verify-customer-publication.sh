#!/usr/bin/env bash
# Durable customer publication recovery, disposable PostgreSQL and local review Langflow.
set -euo pipefail
cd "$(dirname "$0")/.."
report="${1:-test-report/deskazo-v1/checks/customer-publication-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$(dirname "$report")"
mkdir "$report"
printf 'Reports: %s\n' "$report"
pnpm exec vitest run packages/adapters/src/customer-runtime.test.ts > "$report/unit.log" 2>&1
VERIFY_LANGFLOW=1 pnpm exec vitest run packages/adapters/src/customer-runtime.langflow.test.ts > "$report/langflow.log" 2>&1
for suite in customer-publications customer-conversations account-deletion; do
  pnpm test:integration --spec="packages/adapters/src/$suite.postgres.test.ts" > "$report/$suite.log" 2>&1
done
VERIFY_LANGFLOW=1 pnpm test:integration --spec=packages/testkit/src/customer-setup-langflow.postgres.test.ts > "$report/setup.log" 2>&1
pnpm --filter @rakazo/adapter-kit --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/worker --filter @rakazo/testkit check > "$report/types.log" 2>&1
pnpm exec biome check packages/adapter-kit/src/customer-runtime.ts packages/adapters/src/customer-runtime.ts packages/adapters/src/customer-runtime.test.ts packages/adapters/src/customer-runtime.langflow.test.ts packages/adapters/src/customer-conversations.ts packages/adapters/src/customer-conversations.postgres.test.ts packages/adapters/src/customer-publications.ts packages/adapters/src/customer-publications.postgres.test.ts packages/adapters/src/account-deletion.ts packages/testkit/src/customer-setup-langflow.postgres.test.ts packages/testkit/src/cli/harness.ts apps/api/src/app.ts apps/worker/src/index.ts scripts/configure-operator-settings.mts > "$report/style.log" 2>&1
printf '%s\n' 'Customer publication recovery checks passed.'

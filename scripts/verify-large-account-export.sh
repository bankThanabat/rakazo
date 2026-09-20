#!/usr/bin/env bash
# Seed synthetic accounts and verify archive contents/limits in an isolated database.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-report/deskazo-v1/checks
VERIFY_LARGE_ACCOUNT_EXPORT=1 pnpm test:integration \
  --spec=packages/testkit/src/account-export.postgres.test.ts \
  > test-report/deskazo-v1/checks/large-account-export-postgres.log 2>&1
printf '%s\n' 'Large account export checks passed.'

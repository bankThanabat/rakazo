#!/usr/bin/env bash
# Reproduce computer dispatch authorization races with PostgreSQL and synthetic providers.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm test:integration --spec=packages/testkit/src/executor-lifecycle.test.ts
pnpm exec vitest run packages/adapters/src/executor.test.ts packages/adapters/src/executor-readonly-approval.test.ts packages/adapters/src/executor-effect-idempotency.test.ts packages/adapters/src/approval-effect.test.ts packages/adapters/src/browser-tools.test.ts packages/adapters/src/computer-browser.test.ts
pnpm --filter @rakazo/adapters --filter @rakazo/testkit check
pnpm exec biome check packages/adapters/src/executor.ts packages/testkit/src/executor-lifecycle.test.ts

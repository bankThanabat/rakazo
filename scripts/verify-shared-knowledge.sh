#!/usr/bin/env bash
# Re-runnable offline verification; database and browser suites use disposable fixtures.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm db:generate
pnpm exec vitest run packages/adapters/src/knowledge-openrag.test.ts packages/adapters/src/knowledge-conformance.test.ts
pnpm test:integration -- --spec=packages/adapters/src/knowledge.postgres.test.ts
pnpm test:integration -- --spec=packages/adapters/src/customer-conversations.postgres.test.ts
pnpm test:e2e -- --grep=shared-knowledge.spec

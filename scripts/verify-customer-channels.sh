#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm exec vitest run packages/adapters/src/customer-channels packages/adapters/src/chat-sdk-surface.test.ts packages/testkit/src/pi-offline.test.ts packages/adapters/src/background-job-handlers.test.ts packages/adapter-kit/src/background-jobs.test.ts packages/adapters/src/wakeup.test.ts
for project in packages/adapters apps/api apps/worker apps/web apps/mobile; do
  pnpm exec tsc --noEmit -p "$project/tsconfig.json"
done
pnpm test:integration --spec=packages/testkit/src/customer-support.postgres.test.ts
pnpm test:e2e --spec='(inbox-tabs|customer-channels).spec.ts'

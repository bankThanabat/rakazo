#!/usr/bin/env bash
# Account erasure waits for cloud cancellation; all provider calls use offline emulators.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm test:integration --spec=packages/adapters/src/account-deletion.postgres.test.ts
pnpm test:integration --spec=packages/adapters/src/cloud-agent.postgres.test.ts
pnpm test:integration --spec=packages/testkit/src/account-deletion.postgres.test.ts
pnpm exec vitest run packages/adapters/src/cloud-agent-conformance.test.ts packages/adapters/src/cursor-cloud-agent.test.ts packages/adapters/src/cloud-agent-tools.test.ts packages/adapters/src/executor.test.ts
pnpm --filter @rakazo/adapter-kit --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/worker check
pnpm exec biome check packages/adapter-kit/src/interfaces.ts packages/adapters/src/account-deletion.ts packages/adapters/src/account-deletion.postgres.test.ts packages/adapters/src/cloud-agent-poll.ts packages/adapters/src/cloud-agent-service.ts packages/adapters/src/cloud-agent-emulator.ts packages/adapters/src/cursor-cloud-agent.ts packages/adapters/src/cloud-agent-conformance.test.ts packages/adapters/src/cloud-agent.postgres.test.ts packages/db/src/account-deletion.ts apps/api/src/app.ts apps/worker/src/index.ts

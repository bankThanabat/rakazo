#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Keep retired transports out while preserving the read-only customer archive.
for path in \
  packages/adapters/src/customer-channels \
  packages/adapters/src/customer-service.ts \
  packages/adapters/src/line-webhook.ts \
  apps/api/src/connection-channels.ts \
  apps/web/src/components/integrations/ConnectionIncomingSetup.tsx \
  apps/web/src/pages/CustomerChannelsPanel.tsx \
  apps/mobile/app/customer-channels.tsx; do
  if [[ -e "$path" ]]; then
    echo "Retired transport remains: $path" >&2
    exit 1
  fi
done

pnpm exec vitest run \
  apps/api/src/router.test.ts \
  packages/adapters/src/background-job-handlers.test.ts \
  packages/testkit/src/customer-archive.postgres.test.ts

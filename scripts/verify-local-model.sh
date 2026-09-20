#!/usr/bin/env bash
# Requires a local Qwen model on loopback:11435. No cloud inference or merchant data.
set -euo pipefail
cd "$(dirname "$0")/.."
report="${1:-test-report/deskazo-v1/checks/local-model-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$(dirname "$report")"
mkdir "$report"
report="$(cd "$report" && pwd)"
VERIFY_LOCAL_MODEL=1 VERIFY_LOCAL_MODEL_RECEIPT="$report/result.json" \
  pnpm test:integration --spec=packages/testkit/src/local-model.postgres.test.ts \
  > "$report/journey.log" 2>&1
printf '%s\n' 'Local model product check passed.'

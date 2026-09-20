#!/usr/bin/env bash
# Real local Langflow and application, scripted model, disposable PostgreSQL.
# Requires the review Langflow on loopback:17860 with the installed customer component.
set -euo pipefail
cd "$(dirname "$0")/.."
report="${1:-test-report/deskazo-v1/checks/customer-setup-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$(dirname "$report")"
mkdir "$report"
printf 'Reports: %s\n' "$report"
VERIFY_LANGFLOW=1 pnpm test:integration --spec=packages/testkit/src/customer-setup-langflow.postgres.test.ts > "$report/journey.log" 2>&1
# Package checks exclude tests; check this test and its imports explicitly.
node --input-type=module - "$report" <<'JS'
import { writeFileSync } from "node:fs";
import path from "node:path";
writeFileSync(path.join(process.argv[2], "types.json"), JSON.stringify({
  extends: path.resolve("tsconfig.base.json"),
  compilerOptions: { noEmit: true },
  include: [path.resolve("packages/testkit/src/customer-setup-langflow.postgres.test.ts")],
}));
JS
pnpm exec tsc -p "$report/types.json" > "$report/types.log" 2>&1
pnpm exec biome check packages/testkit/src/customer-setup-langflow.postgres.test.ts > "$report/style.log" 2>&1
printf '%s\n' 'Customer setup through local Langflow passed.'

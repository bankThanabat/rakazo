#!/usr/bin/env bash
# Real local model, app, Pi and Langflow; synthetic shop and disposable PostgreSQL.
# Start Ollama on loopback:11435 with cloud disabled and context length 65536.
# Requires the review Langflow on loopback:17860 with the customer component.
set -euo pipefail
cd "$(dirname "$0")/.."
report="${1:-test-report/deskazo-v1/checks/customer-local-model-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$(dirname "$report")"
mkdir "$report"
report="$(cd "$report" && pwd)"
python3 - "$report/source-hashes.json" <<'PYTHON'
import hashlib
import json
import sys
from pathlib import Path
files = [
    "scripts/verify-customer-local-model.sh",
    "packages/testkit/src/customer-setup-langflow.postgres.test.ts",
    "packages/adapters/src/executor.ts",
    "packages/adapters/src/customer-tools.ts",
    "packages/adapters/src/customer-conversations.ts",
    "packages/core/src/action-approval.ts",
]
Path(sys.argv[1]).write_text(json.dumps({
    name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in files
}, indent=2) + "\n")
PYTHON
VERIFY_LOCAL_MODEL=1 VERIFY_LOCAL_MODEL_ID="${2:-qwen3.5:9b}" VERIFY_LANGFLOW=1 VERIFY_CUSTOMER_LOCAL_RECEIPT="$report/result.json" \
  pnpm test:integration --spec=packages/testkit/src/customer-setup-langflow.postgres.test.ts \
  > "$report/journey.log" 2>&1
printf '%s\n' 'Local model customer setup check passed.'

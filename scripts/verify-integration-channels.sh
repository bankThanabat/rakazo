#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for project in apps/web apps/mobile; do
  pnpm exec tsc --noEmit -p "$project/tsconfig.json"
done
pnpm test:e2e --spec='(customer-channels|integration-setup).spec.ts'

#!/usr/bin/env bash
# Offline display-name regression. Native upgrade instructions are in mobile/e2e/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/rename-product-display.py
pnpm test
pnpm --filter @rakazo/auth --filter @rakazo/adapters --filter @rakazo/api \
  --filter @rakazo/desktop --filter @rakazo/web --filter @rakazo/mobile --filter @rakazo/www check
pnpm --filter @rakazo/web build
API_PORT="${API_PORT:-3211}" WEB_PORT="${WEB_PORT:-5281}" pnpm test:e2e \
  '--grep=Deskazo sign-in|logout protects bot deep links|changes and recovers an email password'

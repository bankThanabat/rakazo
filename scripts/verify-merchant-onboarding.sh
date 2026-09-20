#!/usr/bin/env bash
# Business setup entry, legacy choices, mobile controls and desktop/narrow browser behavior.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm test
pnpm --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/web check
pnpm --filter @rakazo/mobile check
pnpm exec biome check apps/api/src/onboarding.ts apps/api/src/onboarding.test.ts packages/adapters/src/executor.ts apps/mobile/components/ChoiceCard.tsx apps/mobile/components/ChoiceCard.test.tsx apps/mobile/components/AskActions.tsx apps/mobile/app/thread.tsx apps/web/e2e/onboarding-conversation.spec.ts apps/web/e2e/message-hover-actions.spec.ts apps/web/e2e/new-bot-ux.spec.ts
API_PORT="${API_PORT:-3211}" WEB_PORT="${WEB_PORT:-5281}" pnpm test:e2e '--grep=merchant setup|choice refresh|message hover shows|More exposes actions|later bot waits|create opens form'

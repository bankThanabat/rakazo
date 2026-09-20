CREATE TABLE learning_feeds (
  id TEXT PRIMARY KEY,
  "spaceId" TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  "botId" TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "connectionId" TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  "providerRef" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  label TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('space', 'bot')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  cursor TEXT,
  "visitedCursors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  cycle INTEGER NOT NULL DEFAULT 1,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "lastCheckedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  error TEXT,
  "summarizedAt" TIMESTAMP(3),
  accepted INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CHECK ("windowStart" <= "windowEnd")
);
CREATE UNIQUE INDEX "learning_feeds_botId_connectionId_key" ON learning_feeds("botId", "connectionId");
CREATE INDEX "learning_feeds_enabled_nextAttemptAt_idx" ON learning_feeds(enabled, "nextAttemptAt");
CREATE INDEX "learning_feeds_userId_idx" ON learning_feeds("userId");
CREATE TABLE learning_feed_items (
  "feedId" TEXT NOT NULL REFERENCES learning_feeds(id) ON DELETE CASCADE,
  "externalId" TEXT NOT NULL,
  digest TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("feedId", "externalId", digest)
);
ALTER TABLE learning_imports ADD COLUMN "feedRevision" INTEGER, ADD COLUMN "feedId" TEXT REFERENCES learning_feeds(id) ON DELETE CASCADE;
CREATE INDEX "learning_imports_feedId_idx" ON learning_imports("feedId");
ALTER TABLE learning_tasks ALTER COLUMN "conversationId" DROP NOT NULL;
ALTER TABLE learning_tasks ADD COLUMN "importId" TEXT REFERENCES learning_imports(id) ON DELETE CASCADE;
ALTER TABLE learning_tasks ADD CONSTRAINT learning_tasks_one_source CHECK (num_nonnulls("conversationId", "importId") = 1);
CREATE INDEX "learning_tasks_importId_idx" ON learning_tasks("importId");

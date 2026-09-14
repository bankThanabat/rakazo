CREATE TABLE "customer_behaviors" (
  "botId" TEXT PRIMARY KEY REFERENCES "bots"("id") ON DELETE CASCADE,
  "credentialId" TEXT NOT NULL,
  "flowId" TEXT NOT NULL,
  "knowledgeFilterId" TEXT,
  "instructions" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
ALTER TABLE "customer_channels"
  ADD COLUMN "connectionId" TEXT,
  ADD COLUMN "binding" JSONB,
  ADD COLUMN "cursor" JSONB,
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "nextPollAt" TIMESTAMP(3),
  ADD COLUMN "pollError" TEXT,
  ADD COLUMN "pollToken" TEXT,
  ADD COLUMN "pollUntil" TIMESTAMP(3);
CREATE UNIQUE INDEX "customer_channels_connectionId_key" ON "customer_channels"("connectionId");
CREATE INDEX "customer_channels_nextPollAt_idx" ON "customer_channels"("nextPollAt");
ALTER TABLE "customer_messages"
  ADD COLUMN "inReplyToSeq" INTEGER,
  ADD COLUMN "behaviorRevision" INTEGER,
  ADD COLUMN "sentAt" TIMESTAMP(3);

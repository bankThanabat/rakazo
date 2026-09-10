ALTER TABLE "customer_conversations"
  ADD COLUMN "avatarUrl" TEXT,
  ADD COLUMN "profileRefreshAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "customer_conversations_profileRefreshAt_idx"
  ON "customer_conversations"("profileRefreshAt");

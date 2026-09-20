CREATE TABLE "customer_alert_deliveries" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "conversationId" TEXT NOT NULL REFERENCES "customer_conversations"("id") ON DELETE CASCADE,
  "attentionId" TEXT NOT NULL,
  "stage" INTEGER NOT NULL,
  "recipientId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'sending',
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "claimToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "retryable" BOOLEAN NOT NULL DEFAULT false,
  "reference" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "customer_alert_deliveries_attentionId_stage_key" UNIQUE ("attentionId", "stage")
);
CREATE INDEX "customer_alert_deliveries_conversationId_createdAt_idx"
  ON "customer_alert_deliveries"("conversationId", "createdAt");

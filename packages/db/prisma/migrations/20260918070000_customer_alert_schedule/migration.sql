ALTER TABLE "customer_conversations"
  ADD COLUMN "attentionId" TEXT,
  ADD COLUMN "attentionStartedAt" TIMESTAMP(3),
  ADD COLUMN "attentionAlertStage" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttentionAlertAt" TIMESTAMP(3),
  ADD COLUMN "ownerAttentionAlertAt" TIMESTAMP(3);

-- Preserve delivered initial alerts. Old rows have no issue start timestamp, so
-- use their last recorded activity when scheduling the remaining reminders.
UPDATE "customer_conversations"
SET "attentionId" = gen_random_uuid()::text,
    "attentionStartedAt" = "updatedAt",
    "attentionAlertStage" = CASE WHEN "notifiedGeneration" = -1 THEN 0 ELSE 1 END,
    "ownerAttentionAlertAt" = "updatedAt" + INTERVAL '30 minutes',
    "nextAttentionAlertAt" = "updatedAt" + CASE
      WHEN "notifiedGeneration" = -1 THEN INTERVAL '0 minutes'
      ELSE INTERVAL '10 minutes' END
WHERE "needsHuman" AND "acknowledgedAt" IS NULL AND "state" <> 'resolved';

ALTER TABLE "customer_conversations" DROP COLUMN "notifiedGeneration";
CREATE INDEX "customer_conversations_nextAttentionAlertAt_idx"
  ON "customer_conversations"("nextAttentionAlertAt");
CREATE INDEX "customer_conversations_ownerAttentionAlertAt_idx"
  ON "customer_conversations"("ownerAttentionAlertAt");

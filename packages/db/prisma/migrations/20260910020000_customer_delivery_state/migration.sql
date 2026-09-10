-- Earlier local installations already applied the customer-channel migration
-- before these fields were added. Also allow databases created from its current version.
ALTER TABLE "customer_conversations"
  ADD COLUMN IF NOT EXISTS "needsHuman" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "customer_messages"
  ADD COLUMN IF NOT EXISTS "sendAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3);

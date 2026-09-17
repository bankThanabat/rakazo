-- Existing connections remain internal until their owner configures sharing.
ALTER TABLE "connections" ADD COLUMN "actionPolicy" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "customer_tool_calls" ADD COLUMN "connectionId" TEXT,
  ADD COLUMN "actionId" TEXT, ADD COLUMN "replyBody" TEXT;

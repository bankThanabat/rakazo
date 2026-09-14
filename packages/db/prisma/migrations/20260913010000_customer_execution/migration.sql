ALTER TABLE "customer_behaviors" ADD COLUMN "actions" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "customer_messages" ADD COLUMN "executionKeyHash" TEXT, ADD COLUMN "executionUntil" TIMESTAMP(3);
CREATE TABLE "customer_tool_calls" (
  "messageId" TEXT NOT NULL REFERENCES "customer_messages"("id") ON DELETE CASCADE,
  "callId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("messageId", "callId")
);
CREATE UNIQUE INDEX "customer_tool_calls_messageId_requestHash_key" ON "customer_tool_calls"("messageId", "requestHash");
ALTER TABLE "customer_messages" ADD COLUMN "executionPolicyHash" TEXT;

ALTER TABLE "customer_messages" ADD COLUMN "senderId" TEXT;

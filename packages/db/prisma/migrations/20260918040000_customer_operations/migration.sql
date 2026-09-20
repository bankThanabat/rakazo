CREATE TABLE "customer_operations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "requestHash" TEXT NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('executing', 'completed', 'uncertain')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "customer_operations_spaceId_idx" ON "customer_operations"("spaceId");

CREATE INDEX "customer_operations_status_updatedAt_idx" ON "customer_operations"("status", "updatedAt");
CREATE TABLE "customer_operation_receipts" (
  "operationId" TEXT NOT NULL PRIMARY KEY REFERENCES "customer_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "conversationId" TEXT NOT NULL REFERENCES "customer_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "connectionId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "recordKey" TEXT NOT NULL,
  "mapping" JSONB NOT NULL,
  "result" JSONB,
  "reviewedByUserId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewReason" TEXT,
  "providerReference" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "customer_operation_receipts_conversationId_idx" ON "customer_operation_receipts"("conversationId");
CREATE INDEX "customer_operation_receipts_createdAt_idx" ON "customer_operation_receipts"("createdAt");

CREATE TABLE "customer_purchases" (
  "id" TEXT PRIMARY KEY,
  "conversationId" TEXT NOT NULL REFERENCES "customer_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "customerId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "providerRef" TEXT NOT NULL,
  "activeKey" TEXT,
  "requestHash" TEXT NOT NULL,
  "paymentMethods" JSONB NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('creating', 'open', 'updating', 'submitting', 'submitted', 'uncertain', 'closed')),
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "ciphertext" TEXT,
  "summary" JSONB NOT NULL DEFAULT '{}',
  "history" JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof("history") = 'array' AND jsonb_array_length("history") <= 102),
  "actionId" TEXT,
  "actionHash" TEXT,
  "actionKind" TEXT,
  "actionStartedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "customer_purchases_activeKey_key" ON "customer_purchases"("activeKey");
CREATE INDEX "customer_purchases_conversationId_idx" ON "customer_purchases"("conversationId");
CREATE INDEX "customer_purchases_connectionId_idx" ON "customer_purchases"("connectionId");

CREATE TABLE "customer_identities" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL REFERENCES "customer_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "customerId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "providerRef" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
    "history" JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof("history") = 'array' AND jsonb_array_length("history") <= 32),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CHECK (jsonb_typeof("value") IN ('string', 'number', 'null'))
);
CREATE UNIQUE INDEX "customer_identities_conversationId_customerId_connectionId_key"
  ON "customer_identities"("conversationId", "customerId", "connectionId");
CREATE INDEX "customer_identities_connectionId_idx" ON "customer_identities"("connectionId");

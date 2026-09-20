ALTER TABLE "customer_conversations" ADD COLUMN "acknowledgedAt" TIMESTAMP(3);
CREATE TABLE "customer_acknowledgements" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "conversationId" TEXT NOT NULL REFERENCES "customer_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "customerSeq" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "customer_acknowledgements_conversationId_createdAt_idx"
  ON "customer_acknowledgements"("conversationId", "createdAt");
